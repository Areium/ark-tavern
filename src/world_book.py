"""
世界书（SillyTavern Lorebook 兼容）核心模块。

职责：
- WorldBookEntry / WorldBook — 规范化条目与书的数据模型
- parse_lorebook() — 解析酒馆世界书的 4 种来源：
    1. 世界书导出 JSON（v1，顶层 entries map）
    2. v2 规格（entries[].keys / extensions）
    3. 角色卡内嵌世界书（data.character_book / data.extensions.world）
    4. 聊天备份 .jsonl（逐行提取内嵌世界书数据）
- 触发匹配：主/副关键词正则扫描 + selective / 概率 / 常驻语义
- format_injection() — 按 position / group_weight / depth 排序并格式化注入文本，
  支持 token 预算与 {{user}} / {{char}} 宏替换
- WorldBookManager — data/worldbooks/ 目录 CRUD + 会话绑定解析 + 全局默认书

与酒馆的语义映射（见计划文档）：
    key/keysecondary → trigger_keys/secondary_keys
    constant → always_active；insertion_order/position → position(0=卡前/1=卡后)
    depth → depth；scanDepth → scan_depth；probability → probability
    caseSensitive/matchWholeWords → case_sensitive/match_whole_words
    excludeRecursion/preventRecursion → 简化为「每轮每条目最多注入一次」
    extensions/automationId/displayIndex → raw 原样保留，导出时可回灌酒馆
"""

import copy
import hashlib
import json
import logging
import random
import re
import threading
import time
import uuid
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from worldbook_scope import (
    EXTENSION_KEY, UNCLASSIFIED, validate_categories, validate_policy,
    expand_sources, find_scope_extension,
    ACTIVATION_ALWAYS, ACTIVATION_MANUAL, ACTIVATION_ROSTER_ANY,
    EXPANSION_NONE, EXPANSION_REQUIRES_CLOSURE, EXPANSION_LEGACY_DEPTH,
    SCHEMA_VERSION_V3, resolve_v3_scope, validate_v3_rules,
    v2_rules_from_import_config, equivalent_v3_roots,
)
from worldbook_classify import classify_entries, needs_classification

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_WORLDBOOKS_DIR = _PROJECT_ROOT / "data" / "worldbooks"

# 整合包分发源（随程序分发，git 跟踪）：首次启动自动安装到 _WORLDBOOKS_DIR
_PACKS_DIR = _PROJECT_ROOT / "data" / "packs"
# 未显式配置全局默认书时，按此顺序回退到已安装且启用的预装包（无则跳过）
_PACK_FALLBACK_IDS = ["arknights"]

# 旧安装副本刷新前的留存后缀：`<id>.json.pre-refresh.bak`
# （不以 .json 结尾，避免被 list_books 当成一本书；去掉后缀即可还原）
_PACK_BACKUP_SUFFIX = ".pre-refresh.bak"

# 支持探测的来源格式标签
SOURCE_V1 = "sillytavern_v1"
SOURCE_V2 = "sillytavern_v2"
SOURCE_CARD = "character_card"
SOURCE_JSONL = "chat_backup_jsonl"
SOURCE_MANUAL = "manual"
SOURCE_PREINSTALLED = "preinstalled"

# ── 书用途（book_type）──
# story     ：剧情世界书，可绑定会话、设为默认并参与解析
# reference ：资料库，只供浏览 / 检索 / 摘录，不参与任何会话解析
BOOK_TYPE_STORY = "story"
BOOK_TYPE_REFERENCE = "reference"
BOOK_TYPES = (BOOK_TYPE_STORY, BOOK_TYPE_REFERENCE)

# 旧数据缺字段时一律按 story 读取（既有世界书、会话快照与导出保持兼容）
DEFAULT_BOOK_TYPE = BOOK_TYPE_STORY


def normalize_book_type(value, default: str = DEFAULT_BOOK_TYPE) -> str:
    """把外部传入的用途值规范化为合法取值；非法值抛 ValueError。

    `None` / 空串代表「未指定」，回落到 default —— 这是缺字段的兼容路径。
    非空但不在白名单内的值一律拒绝，不静默降级成 story（否则用户会以为
    一本资料库已经变成剧情书）。
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    if not isinstance(value, str):
        raise ValueError("book_type 必须是字符串")
    value = value.strip()
    if value not in BOOK_TYPES:
        raise ValueError(f"book_type 必须是 {' 或 '.join(BOOK_TYPES)}")
    return value

DEFAULT_CATEGORIES = [
    {"id": "worldview", "parent_id": None, "name": "世界观设定", "scope_type": "worldview", "sort_order": 10},
    {"id": "characters", "parent_id": None, "name": "角色", "scope_type": "character", "sort_order": 20},
    {"id": "other", "parent_id": None, "name": "其他", "scope_type": "other", "sort_order": 30},
]


def _pack_rev(data: dict) -> str:
    """整合包内容指纹（版本号）。

    只覆盖影响注入结果的字段（id / name / entries），忽略 created_at / updated_at /
    source / pack_rev 这类易变字段——否则每次重新生成分发包都会「看起来变了」，
    导致每次启动都白刷一遍。
    """
    payload = json.dumps(
        {
            "id": data.get("id", ""),
            "name": data.get("name", ""),
            "entries": data.get("entries", []),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


@dataclass
class ImportReport:
    """导入结果报告。"""
    source_format: str = ""
    imported: int = 0
    skipped: int = 0
    warnings: list = field(default_factory=list)
    entry_uids: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "source_format": self.source_format,
            "imported": self.imported,
            "skipped": self.skipped,
            "warnings": self.warnings,
        }


@dataclass
class WorldBookEntry:
    """规范化后的世界书条目。

    字段与酒馆的映射见模块 docstring。`raw` 保留原始条目字典，
    用于导出时无损回灌酒馆。
    """
    uid: str
    content: str
    name: str = ""
    trigger_keys: list = field(default_factory=list)       # key / keys
    secondary_keys: list = field(default_factory=list)     # keysecondary / secondary_keys
    always_active: bool = False                            # constant
    selective: bool = True                                 # 主键命中后才检查副键
    enabled: bool = True
    position: int = 0                                      # 0=卡前 1=卡后
    depth: int = 4
    scan_depth: int = 4
    probability: int = 100
    group: str = ""
    group_weight: int = 100
    case_sensitive: bool = False
    match_whole_words: bool = False
    # 应用私有元数据；不参与酒馆匹配语义，仅用于会话按需载入。
    category_id: str = ""
    character_id: str = ""
    # 摘录来源追踪：从资料库（或其它书）摘录入口条目时保留可追溯来源。
    # 只在本项目的 book JSON 与项目扩展命名空间内往返，不写进酒馆标准字段。
    excerpt_source: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        data = {
            "uid": self.uid,
            "name": self.name,
            "content": self.content,
            "trigger_keys": self.trigger_keys,
            "secondary_keys": self.secondary_keys,
            "always_active": self.always_active,
            "selective": self.selective,
            "enabled": self.enabled,
            "position": self.position,
            "depth": self.depth,
            "scan_depth": self.scan_depth,
            "probability": self.probability,
            "group": self.group,
            "group_weight": self.group_weight,
            "case_sensitive": self.case_sensitive,
            "match_whole_words": self.match_whole_words,
            "category_id": self.category_id,
            "character_id": self.character_id,
            "raw": self.raw,
        }
        # 只有真的摘录过的条目才带来源，普通条目序列化形态保持不变
        if self.excerpt_source:
            data["excerpt_source"] = copy.deepcopy(self.excerpt_source)
        return data

    @staticmethod
    def from_dict(data: dict) -> "WorldBookEntry":
        return WorldBookEntry(
            uid=str(data.get("uid", "")),
            content=str(data.get("content", "")),
            name=str(data.get("name", "")),
            trigger_keys=list(data.get("trigger_keys") or []),
            secondary_keys=list(data.get("secondary_keys") or []),
            always_active=bool(data.get("always_active", False)),
            selective=bool(data.get("selective", True)),
            enabled=bool(data.get("enabled", True)),
            position=int(data.get("position", 0)),
            depth=int(data.get("depth", 4)),
            scan_depth=int(data.get("scan_depth", 4)),
            probability=int(data.get("probability", 100)),
            group=str(data.get("group", "")),
            group_weight=int(data.get("group_weight", 100)),
            case_sensitive=bool(data.get("case_sensitive", False)),
            match_whole_words=bool(data.get("match_whole_words", False)),
            category_id=str(data.get("category_id", "") or ""),
            character_id=str(data.get("character_id", "") or ""),
            excerpt_source=_normalize_excerpt_source(data.get("excerpt_source")),
            raw=dict(data.get("raw") or {}),
        )


#: 摘录来源追踪的最小字段集（round-trip 不丢失）
EXCERPT_SOURCE_FIELDS = ("source_book_id", "source_entry_uid", "source_content_hash")


def _normalize_excerpt_source(value) -> dict:
    """规范化摘录来源；缺关键字段时返回空 dict（视作没有来源）。"""
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in EXCERPT_SOURCE_FIELDS:
        text = str(value.get(key) or "").strip()
        if not text:
            return {}
        result[key] = text
    for key in ("source_book_name", "source_entry_name", "excerpted_at"):
        if value.get(key) not in (None, ""):
            result[key] = value[key]
    return result


# ─────────────────────────────────────────────────────────────
# 解析器
# ─────────────────────────────────────────────────────────────

def _first(data: dict, *names, default=None):
    """按优先级取第一个存在的字段（兼容 v1/v2 命名差异）。"""
    for n in names:
        if n in data and data[n] is not None:
            return data[n]
    return default


def _as_str_list(value) -> list[str]:
    """把关键词字段规范化为字符串列表（酒馆部分版本用逗号分隔字符串）。"""
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",")]
        return [p for p in parts if p]
    if isinstance(value, (list, tuple)):
        result = []
        for item in value:
            if isinstance(item, str):
                result.append(item.strip())
        return [p for p in result if p]
    return []


def _to_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _parse_position(entry: dict, extensions: dict) -> int:
    """解析插入位置：insertion_order / position / extensions.position。

    酒馆取值：0/1 整数，或 "before_char"/"after_char"（v2），
    旧版还有 "before"/"after"。统一映射为 0=卡前 / 1=卡后。
    """
    value = _first(entry, "insertion_order", "position",
                   default=_first(extensions, "position", default=0))
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("before_char", "before", "before_char_defs"):
            return 0
        if v in ("after_char", "after", "after_char_defs"):
            return 1
        return _to_int(v, 0) if v.isdigit() else 0
    return 0 if _to_int(value, 0) == 0 else 1


def _normalize_entry(raw_entry: dict, index: int, warnings: list) -> Optional[WorldBookEntry]:
    """把一条酒馆条目规范化为 WorldBookEntry。

    返回 None 表示跳过（如 content 为空）。
    """
    extensions = raw_entry.get("extensions")
    extensions = extensions if isinstance(extensions, dict) else {}

    scope_meta = extensions.get(EXTENSION_KEY, {})
    scope_meta = scope_meta if isinstance(scope_meta, dict) else {}

    content = _first(raw_entry, "content", default="")
    if not isinstance(content, str) or not content.strip():
        warnings.append(f"条目 #{index} 内容为空，已跳过")
        return None

    trigger_keys = _as_str_list(_first(raw_entry, "key", "keys", "trigger_keys"))
    secondary_keys = _as_str_list(
        _first(raw_entry, "keysecondary", "secondary_keys", "trigger_secondary_keys"))
    always_active = _to_bool(_first(raw_entry, "constant", default=False), False)

    if not trigger_keys and not secondary_keys and not always_active:
        warnings.append(
            f"条目 #{index}（{content[:20]}…）无关键词且非常驻，永远不会被触发")

    uid = str(_first(raw_entry, "uid", "id",
                     default=_first(extensions, "id", default=f"entry_{index}")))
    use_probability = _to_bool(_first(raw_entry, "useProbability", default=True), True)
    probability = _to_int(
        _first(raw_entry, "probability",
               default=_first(extensions, "probability", default=100)), 100)
    if not use_probability:
        probability = 100

    # enabled 兼容两种写法：显式 enabled 字段 / 旧版酒馆的 disable 字段
    if "enabled" in raw_entry or "enabled" in extensions:
        enabled = _to_bool(_first(raw_entry, "enabled", default=True), True)
    elif "disable" in raw_entry:
        enabled = not _to_bool(raw_entry.get("disable"), False)
    else:
        enabled = True

    return WorldBookEntry(
        uid=uid,
        name=str(_first(raw_entry, "comment", "name",
                        default=_first(extensions, "display_name", default="")) or ""),
        content=content,
        trigger_keys=trigger_keys,
        secondary_keys=secondary_keys,
        always_active=always_active,
        selective=_to_bool(_first(raw_entry, "selective", default=True), True),
        enabled=enabled,
        position=_parse_position(raw_entry, extensions),
        depth=_to_int(_first(raw_entry, "depth",
                             default=_first(extensions, "depth", default=4)), 4),
        scan_depth=_to_int(_first(raw_entry, "scanDepth", default=4), 4),
        probability=probability,
        group=str(_first(raw_entry, "group", default="") or ""),
        group_weight=_to_int(_first(raw_entry, "groupWeight", default=100), 100),
        case_sensitive=_to_bool(_first(raw_entry, "caseSensitive", "case_sensitive",
                                       default=False), False),
        match_whole_words=_to_bool(_first(raw_entry, "matchWholeWords", "match_whole_words",
                                          default=False), False),
        category_id=str(scope_meta.get("category_id", "") or ""),
        character_id=str(scope_meta.get("character_id", "") or ""),
        excerpt_source=_normalize_excerpt_source(scope_meta.get("excerpt_source")),
        raw=copy.deepcopy(raw_entry),
    )


def _extract_entry_collections(obj) -> list[list[dict]]:
    """从任意 JSON 对象中递归提取世界书条目集合。

    返回 list[list[dict]]——每个内层 list 是一组原始条目
    （可能来自多本书的合并场景，如 .jsonl 聊天备份）。
    """
    if not isinstance(obj, dict):
        return []

    # 1. 顶层 entries map/list（v1 导出 / v2 直接结构）
    entries = obj.get("entries")
    if entries is not None:
        if isinstance(entries, dict):
            # map 的 key 常作为条目身份（部分导出没有 uid 字段），兜底注入
            result = []
            for k, v in entries.items():
                if isinstance(v, dict) and "uid" not in v and "id" not in v:
                    v = dict(v, uid=k)
                result.append(v)
            return [result]
        if isinstance(entries, list):
            return [entries]

    # 2. character_book（v2 角色卡 / 独立 v2 书）
    cb = obj.get("character_book")
    if isinstance(cb, dict):
        cb_entries = cb.get("entries")
        if isinstance(cb_entries, (dict, list)):
            found = _extract_entry_collections({"entries": cb_entries})
            if found:
                return found

    # 3. 旧版内嵌 world（extensions.world 或 world 字段）
    for world_key in ("world",):
        world = obj.get(world_key)
        if isinstance(world, dict):
            found = _extract_entry_collections(world)
            if found:
                return found

    ext = obj.get("extensions")
    if isinstance(ext, dict):
        world = ext.get("world")
        if isinstance(world, dict):
            found = _extract_entry_collections(world)
            if found:
                return found

    # 4. 角色卡 data 子结构（v1/v2 卡内嵌）
    data = obj.get("data")
    if isinstance(data, dict):
        found = _extract_entry_collections(data)
        if found:
            return found

    # 5. 单个条目对象（有 content 且有 key/keys）
    if "content" in obj and ("key" in obj or "keys" in obj):
        return [[obj]]

    return []


def _dedupe_entries(entries: list[WorldBookEntry]) -> list[WorldBookEntry]:
    """按 uid 去重（.jsonl 多消息可能重复携带同一本书）。"""
    seen: dict[str, WorldBookEntry] = {}
    for e in entries:
        key = e.uid
        if key in seen:
            # 内容相同直接跳过；不同则加后缀保留
            if seen[key].content == e.content:
                continue
            key = f"{key}__dup_{len(seen)}"
        seen[key] = e
    return list(seen.values())


def parse_lorebook(source) -> tuple[list[WorldBookEntry], ImportReport]:
    """解析世界书数据，返回 (条目列表, 导入报告)。

    Args:
        source: dict（已 json.loads 的对象）或 str（JSON 文本，
                多行时按 .jsonl 逐行解析）。

    自动探测来源：v1 导出 / v2 规格 / 角色卡内嵌 / 聊天备份。
    """
    warnings: list[str] = []
    raw_collections: list[list[dict]] = []
    source_format = SOURCE_MANUAL

    if isinstance(source, str):
        text = source.strip()
        if not text:
            return [], ImportReport(SOURCE_MANUAL, 0, 0, ["内容为空"])
        # 先尝试整体 JSON，失败则按 .jsonl 逐行解析
        try:
            obj = json.loads(text)
            collections = _extract_entry_collections(obj)
            if collections:
                source_format = SOURCE_V1
                raw_collections.extend(collections)
            else:
                warnings.append("未在其中发现世界书条目（无 entries/character_book/world 结构）")
        except json.JSONDecodeError:
            jsonl_count = 0
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    warnings.append(f"跳过无法解析的行: {line[:60]}…")
                    continue
                jsonl_count += 1
                collections = _extract_entry_collections(obj)
                raw_collections.extend(collections)
            if jsonl_count:
                source_format = SOURCE_JSONL
            if not raw_collections:
                warnings.append("聊天备份中未发现世界书数据")
    elif isinstance(source, dict):
        # 角色卡内嵌（data.character_book / data.extensions.world）优先标记
        data = source.get("data") if isinstance(source.get("data"), dict) else {}
        if isinstance(data.get("character_book"), dict) or (
                isinstance(data.get("extensions"), dict)
                and isinstance(data["extensions"].get("world"), dict)):
            source_format = SOURCE_CARD
        collections = _extract_entry_collections(source)
        if not collections:
            warnings.append("未在数据中发现世界书条目")
        raw_collections.extend(collections)
        # v2 特征：条目使用 keys 字段；否则视为 v1 导出
        if raw_collections and any(
                ("keys" in e and "key" not in e) for c in raw_collections for e in c):
            if source_format == SOURCE_MANUAL:
                source_format = SOURCE_V2
        elif raw_collections and source_format == SOURCE_MANUAL:
            source_format = SOURCE_V1
    else:
        return [], ImportReport(SOURCE_MANUAL, 0, 0, ["不支持的数据类型"])

    entries: list[WorldBookEntry] = []
    skipped = 0
    idx = 0
    for collection in raw_collections:
        for raw_entry in collection:
            idx += 1
            if not isinstance(raw_entry, dict):
                skipped += 1
                warnings.append(f"条目 #{idx} 不是对象，已跳过")
                continue
            entry = _normalize_entry(raw_entry, idx, warnings)
            if entry is None:
                skipped += 1
            else:
                entries.append(entry)

    entries = _dedupe_entries(entries)
    report = ImportReport(
        source_format=source_format,
        imported=len(entries),
        skipped=skipped,
        warnings=warnings,
        entry_uids=[e.uid for e in entries],
    )
    return entries, report


# ─────────────────────────────────────────────────────────────
# 书
# ─────────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """粗略 token 估算：CJK 字符按 1 token，其余按 4 字符 1 token。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = len(text) - cjk
    return cjk + other // 4


# 解析器版本：随解析语义变更递增。会话快照记录它，用于判断旧快照是否需重算。
RESOLVER_VERSION = 3
# 每个书保留的策略版本快照上限（不可变历史，供会话恢复绑定版本）。
MAX_POLICY_REVISIONS = 40


class EligibleSet(set):
    """eligible_uids 集合 + 节点作用域元数据（随集合传递，注入调用点零改动）。

    - forced_uids: 节点绑定 inject="always" 钉入的条目，collect_matches 对其
      跳过关键词匹配与 probability 掷骰（仍受 enabled / 预算约束、仍进动态层）。
    - position_overrides: per-target 的 position/depth/group_weight 覆盖，
      collect_matches 排序与 format_injection 分层时用覆盖值。
    普通 set 没有这两个属性——旧调用方传入的集合一律按空处理，向后兼容。
    详见 docs/design/worldbook/node-scoped-worldbook-loading.md（v2.1）。
    """

    def __init__(self, it=(), forced_uids=frozenset(), position_overrides=None):
        super().__init__(it)
        self.forced_uids = frozenset(forced_uids)
        self.position_overrides = dict(position_overrides or {})


def content_revision(entries) -> str:
    """条目正文指纹：只覆盖 uid + 正文哈希。

    用于标记「分析证据是否过期」——正文变了，旧证据就不再可信；
    它**不是**正文快照，正文仍按实时语义读取。
    """
    payload = sorted(
        (str(getattr(e, "uid", "") or (e.get("uid") if isinstance(e, dict) else "")),
         hashlib.sha256(
             (str(getattr(e, "content", "") or (e.get("content") if isinstance(e, dict) else "")))
             .encode("utf-8")).hexdigest())
        for e in entries
    )
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _compile_pattern(key: str, case_sensitive: bool, whole_words: bool):
    """把酒馆关键词编译为正则（酒馆 key 本身就是正则）。

    非法正则降级为字面量匹配；whole_words 用 ASCII 词边界 lookaround
    （对 CJK 关键词自然失效，即不施加边界约束）。
    """
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        re.compile(key, flags)
        pattern = key
    except re.error:
        pattern = re.escape(key)
    if whole_words:
        pattern = rf"(?<![A-Za-z0-9_])(?:{pattern})(?![A-Za-z0-9_])"
    try:
        return re.compile(pattern, flags)
    except re.error:
        return None


def _entry_matches(entry: WorldBookEntry, scan_text: str) -> bool:
    """判断条目是否被触发（酒馆语义）。"""
    if entry.always_active:
        return True

    primaries = [_compile_pattern(k, entry.case_sensitive, entry.match_whole_words)
                 for k in entry.trigger_keys]
    primaries = [p for p in primaries if p is not None]
    secondaries = [_compile_pattern(k, entry.case_sensitive, entry.match_whole_words)
                   for k in entry.secondary_keys]
    secondaries = [p for p in secondaries if p is not None]

    if entry.selective:
        # 必须命中主键；若存在副键则还需命中至少一个副键
        if not primaries:
            return False
        if not any(p.search(scan_text) for p in primaries):
            return False
        if secondaries and not any(p.search(scan_text) for p in secondaries):
            return False
        return True

    # 非 selective：副键等价于主键
    for p in primaries + secondaries:
        if p.search(scan_text):
            return True
    return False


def _matched_keys(entry: WorldBookEntry, scan_text: str) -> list[str]:
    """只读辅助：返回该条目在 scan_text 上**实际命中了哪些键**（供预览解释用）。

    与 `_entry_matches` 共用同一套编译/匹配口径（同一个 `_compile_pattern`，
    主键与副键分别试），但**只报告命中键名，不参与触发判定**：
    `_entry_matches` 的实现与所有调用点不受影响。常驻条目不靠关键词触发，
    因此返回空列表。
    """
    if entry.always_active:
        return []
    hits: list[str] = []
    for key in list(entry.trigger_keys) + list(entry.secondary_keys):
        if not isinstance(key, str) or not key:
            continue
        pattern = _compile_pattern(key, entry.case_sensitive, entry.match_whole_words)
        if pattern is not None and pattern.search(scan_text) and key not in hits:
            hits.append(key)
    return hits


def _substitute_macros(content: str, identity: str, active_char: Optional[str]) -> str:
    """替换 {{user}} / {{char}} 宏。"""
    content = content.replace("{{user}}", identity or "")
    if active_char is not None:
        content = content.replace("{{char}}", active_char)
    else:
        content = content.replace("{{char}}", "")
    return content


def _preview_drop_reason(entry: WorldBookEntry, scan_text: str, scoped_uids: set,
                         demoted_uids: set, stopped_uids: set) -> Optional[str]:
    """未插入原因：按 R-2 九类**自上而下取第一个成立者**（R-3），每条只报一个。

    调用方保证该条目没有进 `order[]`，因此这里只需回答「它为什么没进去」。
    判定顺序（不可调换，逐条对齐 `_entry_matches` / `eligible_uids_for` /
    `format_injection` 的真实分支）：

    1. `not_in_scope`         —— 不在书的候选范围内（含「范围解析阶段就被排除」的
       条目，见调用方 `scoped_uids`：v2 会把停用 / 空正文条目从候选里过滤掉，
       它们要走下面第 3/4 条的真实原因，不能被掩成 `not_in_scope`）；
    2. `node_binding_demoted` —— 在书范围内，但被当前节点作用域排除；
    3. `disabled`             —— 条目停用；
    4. `empty_content`        —— 正文为空白；
    5. `selective_reject`     —— selective 且主键为空 / 全部非法正则编译失败；
    6. `keyword_miss`         —— 主键全部未命中（非 selective 时主副键全未命中）；
    7. `secondary_miss`       —— selective 主键命中但副键全未命中；
    8. `probability_miss`     —— 关键词通过但 `probability < 100` 抽签未中；
    9. `budget_exceeded`      —— 已通过触发，但被 `format_injection` 的预算跳过
       （`trace` 里 `included=False`）。
    """
    if entry.uid not in scoped_uids:
        return "not_in_scope"
    if entry.uid in demoted_uids:
        return "node_binding_demoted"
    if not entry.enabled:
        return "disabled"
    if not (entry.content or "").strip():
        return "empty_content"
    if not entry.always_active:
        primaries = [_compile_pattern(k, entry.case_sensitive, entry.match_whole_words)
                     for k in entry.trigger_keys if isinstance(k, str) and k]
        primaries = [p for p in primaries if p is not None]
        secondaries = [_compile_pattern(k, entry.case_sensitive, entry.match_whole_words)
                       for k in entry.secondary_keys if isinstance(k, str) and k]
        secondaries = [p for p in secondaries if p is not None]
        if entry.selective:
            # 必须命中主键；若存在副键则还需命中至少一个副键
            if not primaries:
                return "selective_reject"
            if not any(p.search(scan_text) for p in primaries):
                return "keyword_miss"
            if secondaries and not any(p.search(scan_text) for p in secondaries):
                return "secondary_miss"
        elif not any(p.search(scan_text) for p in primaries + secondaries):
            return "keyword_miss"
    # 关键词通过（或条目常驻）：要么输在概率抽签上，要么被预算跳过。
    if entry.uid in stopped_uids:
        return "budget_exceeded"
    if entry.probability < 100:
        return "probability_miss"
    # 兜底（关键词通过、概率 100 且未被预算跳过时理论上不可达）：
    # 宁可报「被预算跳过」也不让条目在 dropped[] / order[] 里都没有解释。
    return "budget_exceeded"


def _preview_sites(mode: str) -> list[dict]:
    """宿主插入点（Prompt 预览 `sites[]`）。

    块名逐条对齐真实代码，不是提案里的简写：
    - 剧情（`SceneManager.py`）：稳定层进 `<reference>` 内、`<worldview>` 之后、
      玩家身份档案之前（`ref_parts` 的追加顺序）；动态层就是 `<world_book>` 块，
      在 `<scene_events>` 之后、收尾 MUST 指令之前。
    - 自由（`CharacterAgent.py`）：稳定层在 `system_parts` 里紧跟角色卡之后、
      `<worldview>` 之前；动态层在 situation 之后、记忆上下文 `memory_context` 之前。
    """
    if mode == "free":
        return [
            {"layer": "stable", "host": "system_parts",
             "after_block": "character_card", "before_block": "worldview",
             "description": "稳定层紧跟角色卡之后、世界观之前插入。"},
            {"layer": "dynamic", "host": "system_parts",
             "after_block": "situation", "before_block": "memory_context",
             "description": "动态层插在情境之后、记忆上下文之前，紧贴末尾利用 recency。"},
        ]
    return [
        {"layer": "stable", "host": "reference",
         "after_block": "worldview", "before_block": "player_identity",
         "description": "稳定层插在 <reference> 内、世界观之后、玩家身份档案之前。"},
        {"layer": "dynamic", "host": "world_book",
         "after_block": "scene_events", "before_block": "closing_must",
         "description": "动态层就是 <world_book> 块，插在场景事件之后、收尾指令之前。"},
    ]


def _preview_skeleton(mode: str) -> list[dict]:
    """宿主提示词骨架（Prompt 预览 `skeleton[]`）：块的先后插入顺序。

    世界书相关的两块标 `is_worldbook: True`：稳定层插在 `reference` 之前
    （`insert="before"`），动态层落在 `world_book` 之后（`insert="after"`）。
    其余块 `is_worldbook: False`、`insert` 为 null。
    """
    if mode == "free":
        blocks = [
            ("character_card", "角色卡"), ("reference", "世界观"), ("identity", "身份档案"),
            ("knowledge", "知识资料"), ("custom_instruction", "自定义指令"),
            ("length_rule", "长度约束"), ("situation", "当前情境"),
            ("world_book", "世界书（动态层）"), ("memory", "记忆与历史"),
        ]
        worldbook = {"reference": "before", "world_book": "after"}
    else:
        blocks = [
            ("system", "系统指令"), ("reference", "参考层"), ("characters", "场景角色"),
            ("story_context", "剧情上下文"), ("scene_state", "场景状态"),
            ("conversation_history", "对话历史"), ("player", "玩家"),
            ("scene_events", "场景事件"), ("world_book", "世界书（动态层）"),
            ("closing", "收尾指令"),
        ]
        worldbook = {"reference": "before", "world_book": "after"}
    return [{"id": block_id, "label": label, "is_worldbook": block_id in worldbook,
             "insert": worldbook.get(block_id)} for block_id, label in blocks]


class _PromptPreviewOverlay:
    """Prompt 预览用的一次性合成 overlay：**绝不触碰真实会话**。

    `WorldBook.eligible_uids_for` 只依赖 `get_worldbook_scope` /
    `set_worldbook_scope` / `get_active_lore_scope` 三个方法，这里把它们落在
    自己的字段上：`set_worldbook_scope` 不会转发到 SessionManager，也不落盘，
    因此预览既能看到与线上完全相同的候选裁剪，又没有任何会话副作用。
    """

    def __init__(self, scope, lore_scope=None):
        self._scope = copy.deepcopy(scope) if isinstance(scope, dict) else scope
        self._lore_scope = copy.deepcopy(lore_scope) if isinstance(lore_scope, dict) else None

    def get_worldbook_scope(self):
        return self._scope

    def set_worldbook_scope(self, value):
        self._scope = value          # 只写本地字段

    def get_active_lore_scope(self):
        return self._lore_scope


class WorldBook:
    """一本世界书：id + 元信息 + 条目集合 + 触发/格式化逻辑。

    source: "preinstalled"（随程序分发的整合包安装副本）| "imported"（用户导入/新建）
    enabled: 书级启用开关，停用的书不参与解析。
    book_type: "story"（剧情世界书，可绑定会话/设为默认/参与解析）|
               "reference"（资料库，只供浏览、检索与摘录，不参与任何解析）。
               缺字段的旧数据一律按 story 读取。
    pack_rev: 预装包内容指纹（安装/刷新时写入）。用于判断安装副本是否落后于分发源；
              随书持久化，这样用户在界面上编辑预装书后不会被下次启动误判成「旧版本」而覆盖。
    所有书统一管理、统一可写；预装包删除后可从分发源一键重装。
    """

    def __init__(self, book_id: str, name: str = "", entries: list = None,
                 source_format: str = SOURCE_MANUAL, budget_tokens: int = 0,
                 source: str = "imported", enabled: bool = True,
                 pack_rev: str = "", schema_version: int = 2,
                 categories: list = None, dependency_edges: list = None,
                 import_config: dict = None, scope_mode: str = None,
                 dependency_rules: dict = None, related_edges: list = None,
                 policy_revisions: list = None, book_type: str = DEFAULT_BOOK_TYPE):
        self.id = book_id
        self.name = name or book_id
        self.source_format = source_format
        self.budget_tokens = budget_tokens  # 0 = 不限制
        self.book_type = normalize_book_type(book_type)
        # source: "preinstalled"（随程序分发的整合包，安装副本）| "imported"（用户导入）
        self.source = source if source in (SOURCE_PREINSTALLED, "imported") else "imported"
        self.enabled = bool(enabled)
        self.created_at = time.time()
        self.updated_at = time.time()
        self.pack_rev = str(pack_rev or "")
        self.entries: list[WorldBookEntry] = list(entries or [])
        self.schema_version = 3 if dependency_rules else 2
        self.scope_mode = scope_mode or ("selective" if schema_version >= 2 and categories else "legacy")
        if self.scope_mode not in ("legacy", "selective"):
            raise ValueError("scope_mode 必须是 legacy 或 selective")
        self.categories = self._normalize_categories(categories)
        for entry in self.entries:
            entry.category_id = entry.category_id or "unclassified"
        self.dependency_edges = self._normalize_edges(dependency_edges)
        self.import_config = self._normalize_import_config(import_config)
        # ── v3：全书底层有向图 + 条件起点（分类只负责组织，不决定候选）──
        known = {e.uid for e in self.entries}
        self.related_edges = []
        self.dependency_rules = None
        if dependency_rules is not None:
            # 关联补充边可能随规则集一起序列化，也可能独立存放（旧写入路径）。
            # 两处都要认，否则「保存一次再读回」会把 related 边丢掉。
            payload = dict(dependency_rules)
            if related_edges and not payload.get("related_edges"):
                payload["related_edges"] = list(related_edges)
            rules, requires, related = validate_v3_rules(
                known, payload, self.dependency_edges)
            self.dependency_rules = rules
            self.dependency_edges = requires
            self.related_edges = related
        elif related_edges:
            _, _, self.related_edges = validate_v3_rules(
                known, {"roots": [], "requires_edges": [], "related_edges": related_edges})
        # 不可变策略版本历史：会话可据此恢复「它创建时绑定的规则」，而不只是版本号。
        self.policy_revisions = self._normalize_revisions(policy_revisions)

    def _normalize_revisions(self, value) -> list[dict]:
        result = []
        for raw in value if isinstance(value, list) else []:
            if not isinstance(raw, dict):
                continue
            revision = raw.get("revision")
            if type(revision) is not int or revision < 1:
                continue
            result.append({
                "revision": revision,
                "resolver_version": int(raw.get("resolver_version", RESOLVER_VERSION) or RESOLVER_VERSION),
                "scope_mode": raw.get("scope_mode", "selective"),
                "rules": copy.deepcopy(raw.get("rules")) if isinstance(raw.get("rules"), dict) else None,
                "requires_edges": copy.deepcopy(raw.get("requires_edges") or []),
                "related_edges": copy.deepcopy(raw.get("related_edges") or []),
                "fixed_entry_uids": list(raw.get("fixed_entry_uids") or []),
                "dependency_sources": copy.deepcopy(raw.get("dependency_sources") or []),
                "created_at": float(raw.get("created_at", time.time())),
            })
        result.sort(key=lambda item: item["revision"])
        return result[-MAX_POLICY_REVISIONS:]

    @property
    def v3_enabled(self) -> bool:
        """是否按 v3 规则解析（否则沿用 v2 语义，旧会话不受影响）。"""
        return self.dependency_rules is not None

    @property
    def is_reference(self) -> bool:
        """资料库：只浏览、检索、摘录，不参与会话解析，也不能设为默认或被绑定。"""
        return self.book_type == BOOK_TYPE_REFERENCE

    def rules_snapshot(self, revision: int = None) -> dict:
        """返回可恢复的规则快照：优先取指定修订的不可变版本，否则用当前规则。"""
        if revision is not None:
            for item in reversed(self.policy_revisions):
                if item["revision"] == revision:
                    return copy.deepcopy(item)
            if revision != self.import_config["revision"]:
                raise ValueError("请求的规则版本不存在；请重新预览当前版本")
        return {
            "revision": self.import_config["revision"],
            "resolver_version": RESOLVER_VERSION,
            "scope_mode": self.scope_mode,
            "rules": copy.deepcopy(self.dependency_rules),
            "requires_edges": copy.deepcopy(self.dependency_edges),
            "related_edges": copy.deepcopy(self.related_edges),
            "fixed_entry_uids": list(self.import_config["fixed_entry_uids"]),
            "dependency_sources": copy.deepcopy(self.import_config["dependency_sources"]),
            "created_at": time.time(),
        }

    def record_policy_revision(self):
        """把当前策略固化为一个不可变版本（同一修订号只记一次）。"""
        snapshot = self.rules_snapshot()
        for item in self.policy_revisions:
            if item["revision"] == snapshot["revision"]:
                return
        self.policy_revisions.append(snapshot)
        self.policy_revisions = self.policy_revisions[-MAX_POLICY_REVISIONS:]

    def equivalent_v3_rules(self, extra_roots=None, requires_edges=None,
                            related_edges=None) -> dict:
        """把当前 v2 配置映射成**范围等价**的 v3 规则集。

        这是显式迁移（用户在界面上确认「启用按需规则」）时用的：
        - legacy → 每条 always + none；
        - selective → 世界观分类 always + none，角色分类 roster_any + none；
        - 固定导入 → always + none；导入源 → always + legacy_depth（保留 max_depth）。
        结果与旧语义逐条等价，不会因为「保存一次」就悄悄少载入一堆条目。
        """
        rules, requires, related = v2_rules_from_import_config(
            self.import_config, requires_edges if requires_edges is not None else self.dependency_edges)
        known = {r["entry_uid"] for r in rules["roots"]}
        roots = list(rules["roots"])
        for root in equivalent_v3_roots(self.entries, self.categories, self.scope_mode,
                                        self.category_scope_type):
            if root["entry_uid"] in known:
                continue
            known.add(root["entry_uid"])
            roots.append(root)
        for root in extra_roots or []:
            if isinstance(root, dict) and root.get("entry_uid") in known:
                continue
            if isinstance(root, dict) and root.get("entry_uid"):
                known.add(root["entry_uid"])
                roots.append(root)
        return {"roots": roots,
                "root_rule": {"entry_uids": sorted(known)},
                "requires_edges": requires,
                "related_edges": related if related_edges is None else related_edges,
                "rejected": [], "edge_meta": {}}

    def adopt_v2_as_v3(self):
        """把现有 v2 配置无损升级为 v3 起点（范围等价，不改候选）。

        只显式调用：旧书/旧会话不会因为读一次就悄悄改变语义。
        """
        payload = self.equivalent_v3_rules()
        rules, requires, related = validate_v3_rules(
            {e.uid for e in self.entries}, payload, self.dependency_edges)
        self.dependency_rules = rules
        self.dependency_edges = requires
        self.related_edges = related
        self.schema_version = 3
        return self

    @staticmethod
    def _normalize_categories(categories) -> list[dict]:
        return validate_categories(categories if categories is not None else [])

    def _normalize_edges(self, edges) -> list[dict]:
        known = {e.uid for e in self.entries}
        result, seen = [], set()
        for raw in edges if isinstance(edges, list) else []:
            if not isinstance(raw, dict):
                continue
            source, target = str(raw.get("from_uid", "") or ""), str(raw.get("to_uid", "") or "")
            key = (source, target)
            if source in known and target in known and source != target and key not in seen:
                seen.add(key)
                result.append({"from_uid": source, "to_uid": target})
        return result

    def _normalize_import_config(self, config) -> dict:
        config = config if isinstance(config, dict) else {}
        known = {e.uid for e in self.entries}
        fixed = []
        for uid in config.get("fixed_entry_uids", []) if isinstance(config.get("fixed_entry_uids", []), list) else []:
            uid = str(uid)
            if uid in known and uid not in fixed:
                fixed.append(uid)
        sources = []
        for raw in config.get("dependency_sources", []) if isinstance(config.get("dependency_sources", []), list) else []:
            if not isinstance(raw, dict):
                continue
            uid = str(raw.get("entry_uid", "") or "")
            depth = raw.get("max_depth", 0)
            if uid in known and type(depth) is int and 0 <= depth <= 32:
                sources.append({"entry_uid": uid, "max_depth": depth})
        return {"fixed_entry_uids": fixed, "dependency_sources": sources,
                "revision": max(1, _to_int(config.get("revision", 1), 1))}

    # ── 序列化 ──

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "name": self.name,
            "source_format": self.source_format,
            "budget_tokens": self.budget_tokens,
            "source": self.source,
            "enabled": self.enabled,
            "book_type": self.book_type,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "entries": [e.to_dict() for e in self.entries],
            "schema_version": self.schema_version,
            "scope_mode": self.scope_mode,
            "categories": self.categories,
            "dependency_edges": self.dependency_edges,
            "import_config": self.import_config,
        }
        if self.dependency_rules is not None:
            data["dependency_rules"] = self.dependency_rules
        # related_edges 独立持久化：v3 书与「已配置关联补充但尚未启用 v3」的书都要能往返
        if self.related_edges:
            data["related_edges"] = self.related_edges
        if self.policy_revisions:
            data["policy_revisions"] = copy.deepcopy(self.policy_revisions)
        # 仅预装包携带指纹，用户导入/新建的书序列化形态保持不变
        if self.pack_rev:
            data["pack_rev"] = self.pack_rev
        return data

    @staticmethod
    def from_dict(data: dict) -> "WorldBook":
        book = WorldBook(
            book_id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            entries=[WorldBookEntry.from_dict(e) for e in data.get("entries", [])],
            source_format=str(data.get("source_format", SOURCE_MANUAL)),
            budget_tokens=int(data.get("budget_tokens", 0)),
            source=str(data.get("source", "imported")),
            enabled=bool(data.get("enabled", True)),
            pack_rev=str(data.get("pack_rev", "")),
            schema_version=int(data.get("schema_version", 1) or 1),
            categories=data.get("categories"),
            dependency_edges=data.get("dependency_edges"),
            import_config=data.get("import_config"),
            scope_mode=data.get("scope_mode"),
            dependency_rules=data.get("dependency_rules"),
            related_edges=data.get("related_edges"),
            policy_revisions=data.get("policy_revisions"),
            # 缺字段 → story（既有世界书 / 会话快照 / 导出全部照旧）
            book_type=data.get("book_type"),
        )
        book.created_at = float(data.get("created_at", time.time()))
        book.updated_at = float(data.get("updated_at", time.time()))
        # 预装整合包由内置生成器写出，uid 前缀 / group / 名称后缀都是可靠来源元数据；
        # 外部书没有这类元数据时保持原样，不按名字或关键词猜测。
        if book.source == SOURCE_PREINSTALLED and needs_classification(data.get("categories")):
            apply_auto_classification(book, first_install="categories" not in data)
        return book

    def category_scope_type(self, category_id: str) -> str:
        """返回分类的有效类型；父链异常时安全回落 other。"""
        by_id = {c["id"]: c for c in self.categories}
        seen = set()
        current = by_id.get(category_id)
        while current and current["id"] not in seen:
            seen.add(current["id"])
            kind = current.get("scope_type")
            if kind in ("worldview", "character"):
                return kind
            current = by_id.get(current.get("parent_id"))
        return "other"

    def resolve_import_scope(self, roster_character_ids: list[str] = None) -> dict:
        """固定候选 UID 快照；不改变条目的关键词、常驻位置或预算。"""
        if roster_character_ids is None:
            roster_character_ids = []
        if not isinstance(roster_character_ids, list) or any(
                not isinstance(x, str) or not x.strip() for x in roster_character_ids):
            raise ValueError("roster_character_ids 必须是非空字符串组成的数组")
        roster = {x.strip() for x in roster_character_ids}
        known = {e.uid: e for e in self.entries}
        legacy = self.scope_mode == "legacy"
        reasons = {"legacy": set(known) if legacy else set(), "worldview": set(),
                   "roster": set(), "fixed": set(self.import_config["fixed_entry_uids"]),
                   "dependency": expand_sources(self.import_config["dependency_sources"], self.dependency_edges)}
        if not legacy:
            for entry in self.entries:
                kind = self.category_scope_type(entry.category_id)
                if kind == "worldview":
                    reasons["worldview"].add(entry.uid)
                elif kind == "character" and entry.character_id in roster:
                    reasons["roster"].add(entry.uid)
        selected = set().union(*reasons.values())
        resolved = [e.uid for e in self.entries if e.uid in selected and self.enabled and e.enabled and e.content.strip()]
        return {"book_id": self.id, "policy_revision": self.import_config["revision"],
                "roster_character_ids": sorted(roster), "resolved_entry_uids": resolved,
                "legacy_full_scope": legacy, "resolved_at": time.time(),
                "selection_reasons": {uid: [reason for reason, uids in reasons.items() if uid in uids]
                                      for uid in sorted(selected)},
                "excluded_entries": [{"uid": e.uid, "name": e.name,
                                      "reason": "世界书已停用" if not self.enabled else "条目已停用" if not e.enabled else "内容为空"}
                                     for e in self.entries if e.uid in selected and e.uid not in resolved]}

    def preview_scope(self, roster_character_ids=None) -> dict:
        scope = self.resolve_import_scope(roster_character_ids)
        resolved = set(scope["resolved_entry_uids"])
        full = [e for e in self.entries if e.enabled and e.content.strip()]
        costs = {e.uid: estimate_tokens(e.content) for e in full}
        total, selected = sum(costs.values()), sum(costs.get(uid, 0) for uid in resolved)
        warnings = []
        pending = sum(e.category_id == "unclassified" for e in full)
        if pending:
            warnings.append(f"{pending} 条尚未分类；按需模式下不会自动导入，可归类或设为固定导入。")
        unlinked = sum(self.category_scope_type(e.category_id) == "character" and not e.character_id for e in full)
        if unlinked:
            warnings.append(f"{unlinked} 条角色设定未关联角色，不能随阵容自动导入。")
        entry_names = {entry.uid: entry.name for entry in self.entries}
        source_expansions = []
        for source in self.import_config["dependency_sources"]:
            expanded = expand_sources([source], self.dependency_edges) & resolved
            source_expansions.append({
                "entry_uid": source["entry_uid"],
                "name": entry_names.get(source["entry_uid"], source["entry_uid"]),
                "max_depth": source["max_depth"],
                "entries": [{"uid": entry.uid, "name": entry.name}
                            for entry in self.entries if entry.uid in expanded],
            })
        return {"scope": scope, "entry_count": len(resolved), "full_entry_count": len(full),
                "full_estimated_tokens": total, "resolved_estimated_tokens": selected,
                "saved_estimated_tokens": total - selected,
                "saved_percent": round(100 * (total - selected) / total, 1) if total else 0,
                "breakdown": {reason: {"entry_count": sum(reason in scope["selection_reasons"].get(uid, []) for uid in resolved),
                                       "estimated_tokens": sum(costs.get(uid, 0) for uid in resolved if reason in scope["selection_reasons"].get(uid, []))}
                              for reason in ("worldview", "roster", "fixed", "dependency", "legacy")},
                "source_expansions": source_expansions,
                "warnings": warnings}

    # ── v3 解析 ──

    def resolve_v3_import_scope(self, roster_character_ids=None, revision=None,
                                manual_entry_uids=None):
        """按 v3 规则解析候选范围。

        revision 指定时使用该修订的**不可变规则版本**（会话恢复用），
        否则使用当前规则。manual_entry_uids 是「只作用于本次会话」的手动追加。
        """
        snapshot = self.rules_snapshot(revision) if revision is not None else None
        rules = (snapshot or {}).get("rules") or self.dependency_rules
        requires = (snapshot or {}).get("requires_edges")
        related = (snapshot or {}).get("related_edges")
        if requires is None:
            requires = self.dependency_edges
        if related is None:
            related = self.related_edges
        if rules is None:
            raise ValueError("这本书没有 v3 依赖规则")

        # 手动追加作为临时起点进入**同一次**解析：它会沿 requires 闭包补齐、
        # 带上 manual 选用原因并进入展示树。解析完再并集会漏掉依赖，也没有解释。
        manual = [uid for uid in (manual_entry_uids or [])
                  if isinstance(uid, str) and any(e.uid == uid for e in self.entries)]

        result = resolve_v3_scope(
            self.entries, rules, requires, related,
            roster_character_ids=roster_character_ids,
            policy_revision=(snapshot or {}).get("revision", self.import_config["revision"]),
            content_revision=content_revision(self.entries),
            book_id=self.id,
            manual_entry_uids=manual,
        )
        result["resolver_version"] = RESOLVER_VERSION
        if (snapshot or {}).get("scope_mode", self.scope_mode) == "legacy":
            uids = sorted(e.uid for e in self.entries
                          if self.enabled and e.enabled and e.content.strip())
            result.update(resolved_entry_uids=uids, legacy_full_scope=True,
                          selection_reasons={uid: ["legacy"] for uid in uids})
        return result

    def preview_v3_scope(self, roster_character_ids=None, manual_entry_uids=None,
                         revision=None, full_scope=False):
        """v3 预览：候选范围 + 解释 + 与草稿绑定的一致性指纹。

        `full_scope=True` 表示「本次会话显式全量兼容」：预览结果与创建会话时一致，
        因此这里必须真的把范围换成全量，而不是只加一句提示。
        """
        scope = self.resolve_v3_import_scope(roster_character_ids, revision, manual_entry_uids)
        full = [e for e in self.entries if e.enabled and e.content.strip()]
        if full_scope:
            uids = sorted(e.uid for e in full)
            scope = {**scope, "resolved_entry_uids": uids,
                     "selection_reasons": {uid: ["full_scope"] for uid in uids},
                     "active_roots": [], "resolved_edges": [], "display_tree": [],
                     "cross_references": [], "issues": [], "legacy_full_scope": True}
        resolved = set(scope["resolved_entry_uids"])
        costs = {e.uid: estimate_tokens(e.content) for e in self.entries}
        total = sum(costs.get(e.uid, 0) for e in full)
        selected = sum(costs.get(uid, 0) for uid in resolved)
        by_uid = {e.uid: e for e in self.entries}

        warnings = []
        if full_scope:
            warnings.append("已选择「本次会话全量兼容」：这次会载入全部启用条目，"
                            "只影响本会话，不改变这本书的规则。")
        pending = sum(e.category_id == "unclassified" for e in full)
        if pending:
            warnings.append(f"{pending} 条尚未分类；未分类条目不会被任何起点激活，"
                            "可归类、设为起点或手动追加。")
        unlinked = sum(self.category_scope_type(e.category_id) == "character"
                       and not e.character_id for e in full)
        if unlinked:
            warnings.append(f"{unlinked} 条角色设定未关联角色，不能随阵容激活。")

        unselected = [{"uid": e.uid, "name": e.name, "category_id": e.category_id}
                      for e in full if e.uid not in resolved]
        return {
            "scope": scope,
            "schema_version": SCHEMA_VERSION_V3,
            "scope_mode": self.scope_mode,
            "resolver_version": RESOLVER_VERSION,
            "full_scope": bool(full_scope),
            "entry_count": len(resolved),
            "full_entry_count": len(full),
            "full_estimated_tokens": total,
            "resolved_estimated_tokens": selected,
            "saved_estimated_tokens": total - selected,
            "saved_percent": round(100 * (total - selected) / total, 1) if total else 0,
            "active_roots": scope["active_roots"],
            "resolved_edges": scope["resolved_edges"],
            "selection_reasons": scope["selection_reasons"],
            "display_tree": scope["display_tree"],
            "cross_references": scope["cross_references"],
            "issues": scope["issues"],
            "draft_hash": self.policy_draft_hash(roster_character_ids, manual_entry_uids,
                                                 revision, full_scope),
            "policy_revision": scope["policy_revision"],
            "content_revision": scope["content_revision"],
            "breakdown": {
                reason: {"entry_count": sum(reason in scope["selection_reasons"].get(uid, [])
                                            for uid in resolved),
                         "estimated_tokens": sum(costs.get(uid, 0) for uid in resolved
                                                 if reason in scope["selection_reasons"].get(uid, []))}
                for reason in ("always", "roster", "requires", "manual", "full_scope")},
            "manual_entry_uids": scope["manual_entry_uids"],
            "unselected_entries": unselected[:200],
            "unselected_count": len(unselected),
            "entry_names": {uid: (by_uid[uid].name or uid) for uid in scope["resolved_entry_uids"]
                            if uid in by_uid},
            "warnings": warnings,
        }

    def policy_draft_hash(self, roster_character_ids=None, manual_entry_uids=None,
                          revision=None, full_scope=False) -> str:
        """草稿指纹：规则 + 边 + 阵容 + 手动追加 + 是否显式全量兼容。

        用于「预览与创建必须一致」：只要其中任何一项不同，指纹就不同，
        创建会话时校验失败而不是静默换一套范围。
        """
        snapshot = self.rules_snapshot(revision) if revision is not None else None
        payload = {
            "book_id": self.id,
            "revision": (snapshot or {}).get("revision", self.import_config["revision"]),
            "rules": (snapshot or {}).get("rules") or self.dependency_rules,
            "requires_edges": (snapshot or {}).get("requires_edges") or self.dependency_edges,
            "related_edges": (snapshot or {}).get("related_edges") or self.related_edges,
            "roster": sorted({c.strip() for c in (roster_character_ids or []) if isinstance(c, str)}),
            "manual": sorted(set(manual_entry_uids or [])),
            "full_scope": bool(full_scope),
            "content_revision": content_revision(self.entries),
        }
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def session_scope_snapshot(self, roster_character_ids=None, manual_entry_uids=None,
                               revision=None, full_scope=False) -> dict:
        """生成会话要持久化的 v3 范围快照。

        绑定的是**完整规则/关联/边的不可变版本**（不只是版本号），并记录解析器版本、
        阵容、手动追加、激活根、UID、原因、参与边与展示路径。正文仍按实时语义读取，
        因此这里保存的是规则与解析结果，不是条目正文副本。

        `full_scope=True` 是**显式**的全量兼容：本次会话载入全部启用且有正文的条目，
        不改动这本书的规则，也不影响别的会话。
        """
        scope = self.resolve_v3_import_scope(roster_character_ids, revision, manual_entry_uids)
        snapshot = self.rules_snapshot(scope["policy_revision"])
        result = {
            "scope_mode": snapshot.get("scope_mode", self.scope_mode),
            "book_id": self.id,
            "schema_version": SCHEMA_VERSION_V3,
            "resolver_version": RESOLVER_VERSION,
            "policy_revision": scope["policy_revision"],
            "content_revision": scope["content_revision"],
            "rules": snapshot.get("rules"),
            "requires_edges": snapshot.get("requires_edges"),
            "related_edges": snapshot.get("related_edges"),
            "roster_character_ids": sorted(scope["roster_character_ids"]),
            "manual_entry_uids": scope["manual_entry_uids"],
            "active_roots": scope["active_roots"],
            "resolved_entry_uids": scope["resolved_entry_uids"],
            "selection_reasons": scope["selection_reasons"],
            "resolved_edges": [e for e in scope["resolved_edges"] if e.get("active")],
            "display_tree": scope["display_tree"],
            "issues": scope["issues"],
            "legacy_full_scope": False,
            "full_scope": False,
            "resolved_at": scope["resolved_at"],
        }
        result.update({
            "inheritance": {
                "policy_revision": scope["policy_revision"],
                "content_revision": scope["content_revision"],
                "resolver_version": RESOLVER_VERSION,
                "rules": copy.deepcopy(snapshot.get("rules")),
                "requires_edges": copy.deepcopy(snapshot.get("requires_edges") or []),
                "related_edges": copy.deepcopy(snapshot.get("related_edges") or []),
                "captured_at": scope["resolved_at"],
            },
            "local_overrides": {"requires_edges": [], "related_edges": []},
            "suppressed_edges": [], "inheritance_conflicts": [], "scope_revision": 1,
        })
        if not full_scope:
            return result
        uids = sorted(e.uid for e in self.entries if e.enabled and (e.content or "").strip())
        result.update({
            "resolved_entry_uids": uids,
            "selection_reasons": {uid: ["full_scope"] for uid in uids},
            "active_roots": [],
            "resolved_edges": [],
            "display_tree": [],
            "issues": [],
            "legacy_full_scope": True,
            "full_scope": True,
        })
        return result

    def refresh_session_scope(self, existing_scope, roster_character_ids=None) -> dict:
        """按会话**已绑定**的规则版本重算范围（角色入队 / 离队时调用）。

        关键：不能拿「这本书现在长什么样」去覆盖会话快照，否则
        - 绑定的不可变规则版本会被换成最新版本；
        - 手动追加（本会话作用域）会消失；
        - 显式全量兼容会被悄悄取消；
        - 选用原因 / 参与边 / 展示树会退化成一份没有解释的 UID 列表。

        v3 快照沿用绑定的 revision / manual / full_scope 重算；
        v2 快照沿用旧语义，不静默升级。
        """
        if not isinstance(existing_scope, dict):
            existing_scope = {}
        if existing_scope.get("schema_version") != SCHEMA_VERSION_V3:
            refreshed = self.resolve_import_scope(roster_character_ids)
            manual = [uid for uid in (existing_scope.get("manual_entry_uids") or [])
                      if isinstance(uid, str)]
            by_uid = {entry.uid: entry for entry in self.entries}
            if existing_scope.get("full_scope"):
                resolved = sorted(uid for uid, entry in by_uid.items()
                                  if self.enabled and entry.enabled and (entry.content or "").strip())
                refreshed.update({"resolved_entry_uids": resolved,
                                  "selection_reasons": {uid: ["full_scope"] for uid in resolved},
                                  "legacy_full_scope": True, "full_scope": True})
            else:
                resolved = list(refreshed.get("resolved_entry_uids") or [])
                reasons = dict(refreshed.get("selection_reasons") or {})
                for uid in manual:
                    entry = by_uid.get(uid)
                    if entry and self.enabled and entry.enabled and (entry.content or "").strip():
                        if uid not in resolved:
                            resolved.append(uid)
                        reasons.setdefault(uid, []).append("manual")
                refreshed.update({"resolved_entry_uids": resolved,
                                  "selection_reasons": reasons,
                                  "full_scope": False})
            # 保留 v2 会话级覆盖字段；解析器版本仍保持 v2，不静默升级。
            return {**existing_scope, **refreshed,
                    "manual_entry_uids": manual,
                    "roster_character_ids": sorted(set(roster_character_ids or []))}
        # 会话自带完整规则；即使书的历史版本被移除也能恢复。
        from session_worldbook_dependencies import effective_graph, effective_rules, normalize_scope
        managed = normalize_scope(existing_scope)
        graph = effective_graph(managed)
        bound = copy.deepcopy(self)
        bound.dependency_rules = effective_rules(managed)
        bound.dependency_edges = copy.deepcopy(graph["requires_edges"])
        bound.related_edges = copy.deepcopy(graph["related_edges"])
        bound.scope_mode = existing_scope.get("scope_mode", "selective")
        bound.import_config["revision"] = managed["inheritance"].get("policy_revision", 1)
        bound.policy_revisions = []
        refreshed = bound.session_scope_snapshot(
            roster_character_ids,
            existing_scope.get("manual_entry_uids") or [],
            None,
            bool(existing_scope.get("full_scope")),
        )
        refreshed.update({
            "inheritance": managed["inheritance"],
            "local_overrides": managed["local_overrides"],
            "suppressed_edges": managed["suppressed_edges"],
            "inheritance_conflicts": managed.get("inheritance_conflicts") or [],
            "scope_revision": managed["scope_revision"],
            "rules": copy.deepcopy(bound.dependency_rules),
            "requires_edges": copy.deepcopy(bound.dependency_edges),
            "related_edges": copy.deepcopy(bound.related_edges),
        })
        return refreshed

    def eligible_uids_for(self, overlay, *, with_reasons: bool = False):
        """会话候选集 = 会话范围 ∩ 节点作用域（窄化白名单）。

        节点作用域来自 overlay.get_active_lore_scope()（冻结在剧情树节点快照里，
        见 docs/design/worldbook/node-scoped-worldbook-loading.md）。返回 None / 无作用域时行为与
        旧版一致：None 表示不过滤（collect_matches 对 eligible_uids=None 不过滤）；
        无节点作用域（书内无 lore_bindings / 自由模式 / 老会话）返回全量会话范围。
        with_reasons=True 时返回 (集合, 解释 dict)，供编辑器/调试接口用。
        """
        scope = getattr(overlay, "get_worldbook_scope", lambda: None)()
        if scope is None:
            if not hasattr(overlay, "set_worldbook_scope"):
                return (None, {"node_scope": None, "legacy": True}) if with_reasons else None
            # 首次使用时为旧会话留存全量兼容快照，之后新增条目不悄悄扩张旧剧情。
            scope = {"book_id": self.id, "policy_revision": self.import_config["revision"],
                     "resolved_entry_uids": [e.uid for e in self.entries if e.enabled and e.content.strip()],
                     "legacy_full_scope": True, "resolved_at": time.time()}
            overlay.set_worldbook_scope(scope)
        base = set(scope.get("resolved_entry_uids", [])) if scope.get("book_id") == self.id else set()

        node_scope = None
        getter = getattr(overlay, "get_active_lore_scope", None)
        if getter is not None:
            candidate = getter()
            if (isinstance(candidate, dict)
                    and isinstance(candidate.get("allowed"), list)
                    and candidate.get("book_id") in (None, "", self.id)):
                node_scope = candidate
        if node_scope is None:
            result = EligibleSet(base)
            if not with_reasons:
                return result
            return result, {"node_scope": None}

        allowed = base & set(node_scope["allowed"])
        pinned = set(node_scope.get("pinned") or []) & allowed
        overrides = {u: o for u, o in (node_scope.get("overrides") or {}).items()
                     if u in allowed}
        result = EligibleSet(allowed, forced_uids=pinned, position_overrides=overrides)
        if not with_reasons:
            return result
        return result, {
            "node_id": node_scope.get("node_id"),
            "node_scope": node_scope,
            # 仅为调试/编辑器解释，注入路径不构造（with_reasons=False 时零成本）
            "dropped_by_scope": sorted(base - allowed),
            "missing_uids": sorted(set(node_scope["allowed"]) - base),
        }

    # ── 触发 ──

    def collect_matches(self, recent_text: str, current_input: str,
                        rng: random.Random = None, eligible_uids: set[str] | None = None) -> list[WorldBookEntry]:
        """扫描最近对话 + 当前输入，返回被触发的条目（按注入顺序排序）。

        Args:
            recent_text: 最近对话文本（由调用方按 scan_depth 组装）。
            current_input: 当前用户输入。
            rng: 可注入随机源（测试用），默认使用全局 random。

        eligible_uids 若携带节点作用域元数据（EligibleSet，见
        eligible_uids_for）：forced_uids 内的条目跳过关键词与掷骰
        （inject="always" 钉入）；position_overrides 在排序/分层时生效。
        """
        scan_text = f"{recent_text or ''}\n{current_input or ''}"
        if not scan_text.strip():
            scan_text = current_input or ""

        forced = frozenset(getattr(eligible_uids, "forced_uids", None) or ())
        overrides = getattr(eligible_uids, "position_overrides", None) or {}

        matched: list[WorldBookEntry] = []
        for entry in self.entries:
            if eligible_uids is not None and entry.uid not in eligible_uids:
                continue
            if not entry.enabled:
                continue
            if entry.uid not in forced:
                if not _entry_matches(entry, scan_text):
                    continue
                if entry.probability < 100:
                    roll = (rng or random).random() * 100
                    if roll >= entry.probability:
                        continue
            matched.append(entry)

        # 节点位置覆盖：轻量拷贝后替换排序/分层字段，不改 self.entries 原条目
        if overrides:
            patched: list[WorldBookEntry] = []
            for entry in matched:
                ov = overrides.get(entry.uid)
                if not ov:
                    patched.append(entry)
                    continue
                e = copy.copy(entry)
                for field_name in ("position", "depth", "group_weight"):
                    if field_name in ov:
                        try:
                            setattr(e, field_name, int(ov[field_name]))
                        except (TypeError, ValueError):
                            pass
                # 兜底钳制：绑定条目绝不落稳定层（校验器已拒 always_active 绑定）
                if e.position == 0 and e.always_active:
                    e.position = 1
                patched.append(e)
            matched = patched

        # 排序：position（卡前/卡后）→ group_weight 降序 → depth 升序
        matched.sort(key=lambda e: (e.position, -e.group_weight, e.depth, e.uid))
        return matched

    # ── 格式化 ──

    def format_injection(self, entries: list[WorldBookEntry], identity: str = "博士",
                         active_char: Optional[str] = None,
                         trace: list = None) -> tuple[str, str]:
        """格式化注入文本。

        Returns:
            (before, after)：稳定层与动态层条目文本。

        前缀缓存纪律（对齐 DSH）：稳定层只收「position=0 且常驻」的条目——
        它们在会话内字节不变，可安全留在请求前缀；**触发型条目即使声明
        position=0 也一律进动态层**，否则每次触发的不同注入会破坏前缀缓存。
        应用 {{user}}/{{char}} 宏替换与 token 预算（budget_tokens>0 时截断）。

        `trace`（可选，契约 R-19）只用于**只读预览**：传了就在同一次循环里追加
        `{"uid", "included", "layer", "text", "tokens"}`（被预算跳过的
        `included=False`，不带 `layer`/`text`）。线上调用点（`SceneManager` /
        `CharacterAgent`）不传它，参数默认 None，行为与返回值字节不变。
        """
        before_parts: list[str] = []
        after_parts: list[str] = []
        used = 0
        included_any = False

        for entry in entries:
            text = _substitute_macros(entry.content, identity, active_char)
            if entry.name:
                text = f"### {entry.name}\n{text}"
            cost = estimate_tokens(text)
            # 预算：超限跳过；但至少保留一条，避免全部被截断
            if self.budget_tokens > 0 and included_any and used + cost > self.budget_tokens:
                if trace is not None:
                    trace.append({"uid": entry.uid, "included": False, "tokens": cost})
                continue
            used += cost
            included_any = True
            if entry.position == 0 and entry.always_active:
                before_parts.append(text)
                layer = "stable"
            else:
                after_parts.append(text)
                layer = "dynamic"
            if trace is not None:
                trace.append({"uid": entry.uid, "included": True, "layer": layer,
                              "text": text, "tokens": cost})

        before = "\n\n".join(before_parts)
        after = "\n\n".join(after_parts)
        if before:
            before = f"【世界书】\n{before}"
        if after:
            after = f"【世界书】\n{after}"
        return before, after

    # ── 只读 Prompt 预览（A-2 / §3.2）──

    def preview_prompt_injection(self, *, mode="narrative", input_text="", recent_text="",
                                 roster_character_ids=None, manual_entry_uids=None,
                                 full_scope=False, identity="博士", active_char=None,
                                 seed=0, lore_scope=None) -> dict:
        """只读预览：这一轮**真正会插进提示词**的文本、顺序、位置与未插入原因。

        与线上注入复用**同一条执行路径**（不新写分支、不重放第二遍预算循环）：

            eligible_uids_for(overlay) → collect_matches(rng=Random(seed))
              → format_injection(trace=trace)

        预算跳过点由 `format_injection(trace=...)` 在**同一次循环**里回报，
        因此预览看到的顺序、文本与截断与线上逐字一致；唯一的差异是概率抽签改用
        独立的 `random.Random(seed)`（可复现，且**不污染全局 random**）。

        本方法不写盘、不动候选缓存、不创建/修改会话，也不修改 `self`：
        token 预算覆盖由调用方在**候选书副本**上设置（`candidate.budget_tokens`）。
        """
        if mode not in ("narrative", "free"):
            raise ValueError("mode 必须是 narrative 或 free")
        roster = [c.strip() for c in (roster_character_ids or [])
                  if isinstance(c, str) and c.strip()]
        manual = sorted({u for u in (manual_entry_uids or []) if isinstance(u, str) and u})

        # 1) 候选范围：与 scope-preview 走同一入口（v3 用 v3 规则，v2 书不静默升级）
        if self.v3_enabled:
            scope = self.preview_v3_scope(roster, manual, None, bool(full_scope))["scope"]
        else:
            scope = self.preview_scope(roster)["scope"]

        # 2) 合成 overlay（一次性、不触碰真实会话）：候选范围 ∩ 节点作用域
        overlay = _PromptPreviewOverlay(scope, lore_scope)
        eligible, reasons = self.eligible_uids_for(overlay, with_reasons=True)

        # 3) 触发 → 格式化：线上同一个 collect_matches / format_injection
        scan_text = f"{recent_text or ''}\n{input_text or ''}"
        if not scan_text.strip():
            scan_text = input_text or ""
        rng = random.Random(seed if isinstance(seed, int) and not isinstance(seed, bool) else 0)
        matched = self.collect_matches(recent_text or "", input_text or "",
                                       rng=rng, eligible_uids=eligible)
        trace: list[dict] = []
        stable_text, dynamic_text = self.format_injection(matched, identity, active_char,
                                                          trace=trace)

        # 4) order[]：trace 里真正插进去的条目，顺序就是 format_injection 的循环顺序
        matched_by_uid = {entry.uid: entry for entry in matched}
        included = [item for item in trace if item["included"]]
        stopped_uids = {item["uid"] for item in trace if not item["included"]}
        included_uids = {item["uid"] for item in included}
        scope_reasons = scope.get("selection_reasons") or {}
        overrides = getattr(eligible, "position_overrides", None) or {}
        node_id = reasons.get("node_id")
        manual_set = set(manual)

        order = []
        for seq, item in enumerate(included):
            uid = item["uid"]
            entry = matched_by_uid.get(uid)
            entry_reasons = [r for r in (scope_reasons.get(uid) or []) if isinstance(r, str)]
            if uid in manual_set and "manual" not in entry_reasons:
                entry_reasons.append("manual")
            if full_scope and "full_scope" not in entry_reasons:
                entry_reasons.append("full_scope")
            override = None
            patch = overrides.get(uid)
            if isinstance(patch, dict) and patch:
                override = {"node_id": node_id}
                for field_name in ("position", "depth", "group_weight"):
                    if field_name in patch:
                        try:
                            override[field_name] = int(patch[field_name])
                        except (TypeError, ValueError):
                            pass
            order.append({
                "uid": uid,
                # position / group_weight / depth 取 collect_matches 打过节点覆盖补丁后的值
                "name": (entry.name or uid) if entry is not None else uid,
                "seq": seq,
                "layer": item["layer"],
                "position": int(getattr(entry, "position", 0) or 0),
                "group_weight": int(getattr(entry, "group_weight", 0) or 0),
                "depth": int(getattr(entry, "depth", 0) or 0),
                "estimated_tokens": item["tokens"],
                "reasons": entry_reasons,
                "matched_keys": _matched_keys(entry, scan_text) if entry is not None else [],
                "override_from_node": override,
            })

        # 5) dropped[]：全书条目（书内顺序）各报一个原因；已进 order[] 的不再出现
        scope_uids = set(scope.get("resolved_entry_uids") or [])
        # `not_in_scope` 只对**根本没进过候选范围**的条目成立。范围解析阶段就被排除的
        # 条目（典型是 v2 的停用 / 空正文——v2 的 `resolve_import_scope` 会把它们从
        # `resolved_entry_uids` 里过滤掉，因为它们确实不该注入）必须走它们**真正的**
        # 原因 `disabled` / `empty_content`：它们往往已经在起点里，
        # 报 `not_in_scope` 会把用户引向错误的修复入口（「去分类与载入把它设为起点」——
        # 它已经是起点了）。
        scoped_uids = set(scope_uids)
        for item in scope.get("excluded_entries") or []:      # v2：{"uid","name","reason"}
            if isinstance(item, dict) and isinstance(item.get("uid"), str):
                scoped_uids.add(item["uid"])
        for issue in scope.get("issues") or []:               # v3：防御性并集
            # v3 的 `best` 本就包含停用 / 空正文条目（只以 issues 形式报告），
            # 因此这一步通常不会新增 uid；留在这里是为了让两套解析器的口径一致，
            # 将来若 v3 也改成过滤式解析，原因分类不会退化成 not_in_scope。
            if (isinstance(issue, dict)
                    and issue.get("code") in ("disabled_entry", "empty_content")
                    and isinstance(issue.get("uid"), str)):
                scoped_uids.add(issue["uid"])
        demoted_uids = set(reasons.get("dropped_by_scope") or [])
        dropped = []
        for entry in self.entries:
            if entry.uid in included_uids:
                continue
            reason = _preview_drop_reason(entry, scan_text, scoped_uids, demoted_uids,
                                          stopped_uids)
            if reason:
                dropped.append({"uid": entry.uid, "name": entry.name or entry.uid,
                                "reason": reason})

        return {
            "mode": mode,
            "order": order,
            "stable_text": stable_text,
            "dynamic_text": dynamic_text,
            "sites": _preview_sites(mode),
            "skeleton": _preview_skeleton(mode),
            "dropped": dropped,
            "totals": {
                "stable_tokens": sum(item["tokens"] for item in included
                                     if item["layer"] == "stable"),
                "dynamic_tokens": sum(item["tokens"] for item in included
                                      if item["layer"] == "dynamic"),
                "budget_tokens": int(self.budget_tokens or 0),
                # 截断 = trace 里存在被预算跳过的条目
                "truncated": bool(stopped_uids),
                # 「候选」= 范围解析后真正会被考虑注入的条数（v2 的停用 / 空正文
                # 条目不在其中，它们由 dropped[] 的 disabled / empty_content 解释）。
                "candidate_count": len(scope_uids),
                "matched_count": len(matched),
            },
        }

    # ── 回灌酒馆导出 ──

    def export_st(self) -> dict:
        """导出为酒馆 v1 世界书格式（entries map）。

        优先使用条目 raw 原始字段并同步已编辑的值，保证回灌酒馆无损；
        本应用新建的条目（无 raw）按酒馆字段合成。
        """
        entries_map: dict[str, dict] = {}
        for i, entry in enumerate(self.entries):
            out = dict(entry.raw) if entry.raw else {}
            # 同步可能被编辑过的字段
            out["uid"] = entry.uid
            out["key"] = entry.trigger_keys
            out["keysecondary"] = entry.secondary_keys
            out["comment"] = entry.name
            out["content"] = entry.content
            out["constant"] = entry.always_active
            out["selective"] = entry.selective
            if "disable" in out:
                # 旧版酒馆用 disable 表示停用，保持同一写法
                out["disable"] = not entry.enabled
                out.pop("enabled", None)
            else:
                out["enabled"] = entry.enabled
            out["insertion_order"] = entry.position
            out["depth"] = entry.depth
            out["scanDepth"] = entry.scan_depth
            out["probability"] = entry.probability
            out["useProbability"] = entry.probability < 100
            out["group"] = entry.group
            out["groupWeight"] = entry.group_weight
            out["caseSensitive"] = entry.case_sensitive
            out["matchWholeWords"] = entry.match_whole_words
            out["displayIndex"] = out.get("displayIndex", i)
            extensions = out.get("extensions")
            meta = {"category_id": entry.category_id, "character_id": entry.character_id}
            # 摘录来源只进项目扩展命名空间：酒馆标准字段保持干净，
            # 本应用再次导入时可原样回灌（见 export_st 顶部的兼容说明）。
            if entry.excerpt_source:
                meta["excerpt_source"] = copy.deepcopy(entry.excerpt_source)
            out["extensions"] = {**(extensions if isinstance(extensions, dict) else {}),
                                 EXTENSION_KEY: meta}
            key = str(out.get("uid", i))
            entries_map[key] = out
        extension = {EXTENSION_KEY: {
            "schema_version": self.schema_version, "scope_mode": self.scope_mode,
            "book_type": self.book_type,
            "categories": copy.deepcopy(self.categories),
            "dependency_edges": copy.deepcopy(self.dependency_edges),
            "import_config": copy.deepcopy(self.import_config),
        }}
        if self.dependency_rules is not None:
            extension[EXTENSION_KEY]["dependency_rules"] = copy.deepcopy(self.dependency_rules)
            extension[EXTENSION_KEY]["related_edges"] = copy.deepcopy(self.related_edges)
            extension[EXTENSION_KEY]["policy_revisions"] = copy.deepcopy(self.policy_revisions)
        return {"entries": entries_map, "extensions": extension}


def auto_classification_patch(book: WorldBook, result) -> dict:
    """把一次分类结果折算成**统一草稿补丁**（分类 + 条目归属 + 角色关联）。

    统一草稿模式下，自动分类不能绕过草稿直接写盘（否则会丢掉用户正在编辑的其它改动）。
    服务端把结论算成一份可以直接 `patch` 进草稿的补丁，前端并入后照常走
    `PUT /configuration` 一次原子提交 —— 校验口径与直接应用完全一致。
    """
    categories = validate_categories(result.categories(existing=book.categories))
    known = {c["id"] for c in categories}
    scope_of = {c["id"]: c.get("scope_type") for c in categories}
    moves: dict[str, str] = {}
    updates: dict[str, dict] = {}
    for entry in book.entries:
        target = result.assignments.get(entry.uid)
        if not target or target not in known:
            target = entry.category_id if entry.category_id in known else UNCLASSIFIED["id"]
        character_id = ""
        if scope_of.get(target) == "character":
            character_id = result.character_ids.get(entry.uid) or entry.character_id or ""
            if not character_id:
                # 角色分类必须带角色目录名，否则保存会被 _validate_entry_scope 拒绝。
                target = UNCLASSIFIED["id"]
        if target != entry.category_id:
            moves[entry.uid] = target
        if character_id != (entry.character_id or ""):
            updates[entry.uid] = {"character_id": character_id}
    return {"categories": categories, "entry_moves": moves, "entry_updates": updates}


def apply_auto_classification(book: WorldBook, first_install: bool = False):
    """按条目自带的可信元数据重建分类与角色关联。

    只改「条目属于哪一类」和随之而来的角色关联，**不碰载入模式、固定导入与依赖策略**。
    调用方负责决定时机：`from_dict` 只在分类形同未分类时自动调用（用户编辑过的分类不会被
    覆盖），接口则用于用户显式点击「自动分类」。

    first_install 仅供预装包首次安装使用：沿用「预装包直接进入按需载入」的既有语义。
    已存在的旧书只修分类，不隐式切换载入模式（旧书仅编辑分类不自动启用按需载入）。
    """
    result = classify_entries(book.entries)
    if not result.matched:
        return result
    patch = auto_classification_patch(book, result)
    book.categories = patch["categories"]
    known = {c["id"] for c in book.categories}
    for entry in book.entries:
        if entry.uid in patch["entry_moves"]:
            entry.category_id = patch["entry_moves"][entry.uid]
        if entry.uid in patch["entry_updates"]:
            entry.character_id = patch["entry_updates"][entry.uid]["character_id"]
        elif entry.category_id in known and book.category_scope_type(entry.category_id) != "character":
            entry.character_id = ""
    if first_install:
        book.scope_mode = "selective"
    return result


# ─────────────────────────────────────────────────────────────
# 摘录（资料库 → 剧情世界书）
# ─────────────────────────────────────────────────────────────

#: 摘录时允许覆盖的编辑字段（其余字段一律沿用来源条目）
EXCERPT_EDITABLE_FIELDS = (
    "name", "content", "trigger_keys", "secondary_keys", "always_active",
    "selective", "enabled", "position", "depth", "scan_depth", "probability",
    "group", "group_weight", "case_sensitive", "match_whole_words",
    "category_id", "character_id",
)


def _coerce_excerpt_list(value, field: str, index: int) -> list[str]:
    """把摘录请求里的关键词字段规范化为字符串数组；类型不对就报错。

    接口契约是数组：这里**不接受**逗号分隔的字符串 —— 关键词里含逗号是完全合法的
    （正则触发词很常见），把字符串当分隔符切开会静默改掉用户的触发词。
    """
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"第 {index + 1} 条摘录的 {field} 必须是字符串数组")
    result = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(f"第 {index + 1} 条摘录的 {field} 只能包含字符串")
        text = item.strip()
        if text:
            result.append(text)
    return result


def _coerce_excerpt_text(value, field: str, index: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"第 {index + 1} 条摘录的 {field} 必须是字符串")
    return value


def _coerce_excerpt_int(value, field: str, index: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"第 {index + 1} 条摘录的 {field} 必须是整数")
    return value


def _coerce_excerpt_bool(value, field: str, index: int) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"第 {index + 1} 条摘录的 {field} 必须是布尔值")
    return value


def _build_excerpt_entry(target: WorldBook, source_book: WorldBook,
                         source_entry: WorldBookEntry, request: dict,
                         index: int) -> WorldBookEntry:
    """按「原文照搬 + 可选编辑字段」构造一条属于目标书的新条目。

    新条目总是拿新 UID；来源不被修改；来源追踪三要素（source_book_id /
    source_entry_uid / source_content_hash）取自**来源条目的当前正文**，
    因此摘录之后来源被改动时能比对出「这条摘录已过期」。
    """
    entry = WorldBookEntry(uid="", content=source_entry.content)
    for field_name in EXCERPT_EDITABLE_FIELDS:
        if field_name in request and request[field_name] is not None:
            setattr(entry, field_name, request[field_name])
        else:
            setattr(entry, field_name, copy.deepcopy(getattr(source_entry, field_name)))

    # ── 逐字段校验（构造阶段一口气验完，不留半成品） ──
    entry.name = _coerce_excerpt_text(entry.name, "name", index)
    entry.content = _coerce_excerpt_text(entry.content, "content", index)
    entry.trigger_keys = _coerce_excerpt_list(entry.trigger_keys, "trigger_keys", index)
    entry.secondary_keys = _coerce_excerpt_list(entry.secondary_keys, "secondary_keys", index)
    entry.group = _coerce_excerpt_text(entry.group, "group", index)
    entry.category_id = _coerce_excerpt_text(entry.category_id or "", "category_id", index)
    entry.character_id = _coerce_excerpt_text(entry.character_id or "", "character_id", index)
    for bool_field in ("always_active", "selective", "enabled",
                       "case_sensitive", "match_whole_words"):
        setattr(entry, bool_field, _coerce_excerpt_bool(getattr(entry, bool_field), bool_field, index))
    for int_field in ("position", "depth", "scan_depth", "probability",
                      "group_weight"):
        setattr(entry, int_field, _coerce_excerpt_int(getattr(entry, int_field), int_field, index))

    if not entry.content.strip():
        raise ValueError(f"第 {index + 1} 条摘录的正文不能为空")
    if entry.probability < 0 or entry.probability > 100:
        raise ValueError(f"第 {index + 1} 条摘录的 probability 必须在 0–100 之间")
    if entry.position not in (0, 1):
        raise ValueError(f"第 {index + 1} 条摘录的 position 只能是 0 或 1")
    for int_field in ("depth", "scan_depth", "group_weight"):
        if getattr(entry, int_field) < 0:
            raise ValueError(f"第 {index + 1} 条摘录的 {int_field} 不能为负数")

    # 分类必须在目标书里真实存在；否则退回未分类（不把条目放进不存在的分类）
    known_categories = {c["id"] for c in target.categories}
    if entry.category_id not in known_categories:
        entry.category_id = "unclassified"
    if target.category_scope_type(entry.category_id) != "character":
        # 非角色分类不得带角色关联（与 _validate_entry_scope 同口径）
        entry.character_id = ""
    elif not entry.character_id.strip():
        raise ValueError(f"第 {index + 1} 条摘录落在角色分类，必须指定关联角色")

    entry.uid = uuid.uuid4().hex[:12]
    entry.raw = copy.deepcopy(source_entry.raw)
    entry.excerpt_source = {
        "source_book_id": source_book.id,
        "source_book_name": source_book.name,
        "source_entry_uid": source_entry.uid,
        "source_entry_name": source_entry.name,
        "source_content_hash": hashlib.sha256(
            source_entry.content.encode("utf-8")).hexdigest(),
        "excerpted_at": time.time(),
    }
    return entry


# ─────────────────────────────────────────────────────────────
# 管理器
# ─────────────────────────────────────────────────────────────

class WorldBookManager:
    """世界书存储管理器：统一管理 data/worldbooks/（全部可写）。

    整合包（Content Pack）机制：
    - data/packs/<id>.json 为随程序分发的整合包（git 跟踪，分发源）。
    - 首次启动自动安装：把分发源复制到 data/worldbooks/<id>.json（source=preinstalled），
      与用户导入的书在同一列表、同一套规则下管理（启用/停用、编辑、删除、重装）。
    - 预装包被删除后，可通过 reinstall_book() 从分发源一键重装还原。

    绑定解析规则：会话 overlay 显式绑定的书 > 全局默认书 > 已安装且启用的预装包 > None。
    """

    def __init__(self, data_dir: Path | str = None):
        self._dir = Path(data_dir) if data_dir else _WORLDBOOKS_DIR
        self._dir.mkdir(parents=True, exist_ok=True)
        self._packs_dir = _PACKS_DIR
        self._cache: dict[str, WorldBook] = {}
        # 按书锁：覆盖「读修订 → 校验 → 提交」整段，避免原子替换仍然丢更新。
        self._book_locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        # 仅默认数据目录自动安装整合包（自定义目录用于测试/隔离，不注入预装内容）
        if data_dir is None:
            self._ensure_packs_installed()

    def book_lock(self, book_id: str) -> threading.RLock:
        """取这本书的写锁（可重入）。同一本书的读-改-写必须整体持锁。"""
        with self._locks_guard:
            lock = self._book_locks.get(book_id)
            if lock is None:
                lock = threading.RLock()
                self._book_locks[book_id] = lock
            return lock

    # ── 整合包安装 ──

    def _ensure_packs_installed(self):
        """启动时把 data/packs/ 下的整合包安装/刷新到 data/worldbooks/。

        按内容指纹（`pack_rev`）判断版本，而不是「存在就跳过」：

        - 目标不存在 → 安装（source=preinstalled，写入指纹）
        - 目标存在、source=preinstalled、指纹落后 → 刷新为新版本；
          刷新前把旧副本留存为 `<id>.json.pre-refresh.bak`（用户对预装书的编辑可恢复）
        - 目标存在、内容其实与分发源一致（旧副本只是缺 pack_rev 字段）→ 只补指纹，不动数据
        - 目标存在但 source 非 preinstalled（用户导入/自建的同名书）→ 不动
        """
        if not self._packs_dir.is_dir():
            return
        for path in sorted(self._packs_dir.glob("*.json")):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                book_id = str(data.get("id", "")).strip()
                if not book_id:
                    continue
                data["source"] = SOURCE_PREINSTALLED
                data.setdefault("enabled", True)
                rev = _pack_rev(data)
                target = self._path(book_id)

                if not target.is_file():
                    self._write_pack(target, data, rev)
                    logger.info("已安装预装整合包: %s (%s)", data.get("name", book_id), book_id)
                    continue

                old = self._read_json(target)
                if old is None:
                    self._write_pack(target, data, rev)
                    logger.warning("预装整合包副本无法解析，已按分发源重装: %s", book_id)
                    continue
                if str(old.get("source") or "") not in (SOURCE_PREINSTALLED, "builtin"):
                    continue  # 同名用户书，不覆盖
                if str(old.get("pack_rev") or "") == rev:
                    continue  # 已是最新
                if _pack_rev(old) == rev:
                    # 内容一致，只是旧副本没有指纹字段 → 补上即可，不改数据、不留备份
                    self._write_pack(target, {**old, "source": SOURCE_PREINSTALLED}, rev)
                    continue

                backup = target.with_name(target.name + _PACK_BACKUP_SUFFIX)
                try:
                    backup.write_bytes(target.read_bytes())
                except OSError as e:
                    logger.warning("留存旧副本失败 %s: %s", backup.name, e)
                self._write_pack(target, data, rev)
                logger.info("已刷新预装整合包: %s (%s) → %d 条；旧副本留存于 %s",
                            data.get("name", book_id), book_id,
                            len(data.get("entries", [])), backup.name)
            except Exception as e:
                logger.warning("安装整合包 %s 失败: %s", path.name, e)

    @staticmethod
    def _read_json(path: Path) -> Optional[dict]:
        """读 JSON 对象；解析失败或不是对象时返回 None。"""
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
        return data if isinstance(data, dict) else None

    def _write_pack(self, target: Path, data: dict, rev: str):
        """把整合包内容写入安装副本（统一补 source/enabled/pack_rev）。"""
        payload = dict(data)
        payload["source"] = SOURCE_PREINSTALLED
        payload.setdefault("enabled", True)
        payload["pack_rev"] = rev
        self._cache.pop(target.stem, None)
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def is_preinstalled(self, book_id: str) -> bool:
        """该书是否存在分发源（可一键重装）。"""
        return (self._packs_dir / f"{book_id}.json").is_file()

    # ── 路径 ──

    def _path(self, book_id: str) -> Path:
        """统一存储路径（预装包安装副本与导入书同目录）。"""
        return self._dir / f"{book_id}.json"

    def _pack_path(self, book_id: str) -> Path:
        """整合包分发源路径。"""
        return self._packs_dir / f"{book_id}.json"

    def _settings_path(self) -> Path:
        return self._dir / "settings.json"

    def _load_settings(self) -> dict:
        path = self._settings_path()
        if path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return data
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("读取世界书设置失败: %s", e)
        return {"default_book_id": None}

    def _save_settings(self, settings: dict):
        path = self._settings_path()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
            f.write("\n")

    # ── 默认书 ──

    def get_default_book_id(self) -> Optional[str]:
        return self._load_settings().get("default_book_id")

    def set_default_book_id(self, book_id: Optional[str]):
        """设置全局默认书。

        资料库不得成为默认书（它不参与解析）。读取旧 settings 时也做防御性校验：
        即便默认指针指向一本资料库（历史数据 / 手工编辑），这里也只记录下来，
        真正的拦截在 `resolve()` —— 见那里的说明。
        """
        if book_id:
            book = self.load(book_id)
            if book is not None and book.is_reference:
                raise ValueError("资料库不能设为全局默认书；请在剧情世界书中选择")
        settings = self._load_settings()
        settings["default_book_id"] = book_id
        self._save_settings(settings)

    # ── CRUD ──

    def list_books(self) -> list[dict]:
        """列出所有书（统一列表）：预装包在前，导入书按创建时间倒序。"""
        default_id = self.get_default_book_id()
        books = []

        preinstalled = []
        imported = []
        for path in sorted(self._dir.glob("*.json"),
                           key=lambda p: p.stat().st_mtime, reverse=True):
            if path.name == "settings.json":
                continue
            try:
                book = self.load(path.stem)
            except Exception as e:
                logger.warning("加载世界书 %s 失败: %s", path.name, e)
                continue
            summary = self._summary(book, default_id)
            (preinstalled if book.source == SOURCE_PREINSTALLED else imported).append(summary)

        # 预装包固定顺序在前（与分发源顺序一致），导入书按时间倒序
        preinstalled.sort(key=lambda s: s["name"])
        books.extend(preinstalled)
        books.extend(imported)
        return books

    def _summary(self, book: "WorldBook", default_id: Optional[str]) -> dict:
        return {
            "id": book.id,
            "name": book.name,
            "source_format": book.source_format,
            "source": book.source,
            "book_type": book.book_type,
            "is_reference": book.is_reference,
            "is_preinstalled": self.is_preinstalled(book.id),
            "enabled": book.enabled,
            "budget_tokens": book.budget_tokens,
            "entry_count": len(book.entries),
            "created_at": book.created_at,
            "updated_at": book.updated_at,
            "is_default": book.id == default_id,
        }

    def load(self, book_id: str) -> Optional[WorldBook]:
        if book_id in self._cache:
            return self._cache[book_id]
        path = self._path(book_id)
        if not path.is_file():
            return None
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        book = WorldBook.from_dict(data)
        if self.is_preinstalled(book_id):
            # 有分发源的书一律视为预装包安装副本（防旧数据缺字段）
            book.source = SOURCE_PREINSTALLED
        self._cache[book_id] = book
        return book

    def save(self, book: WorldBook):
        """统一保存（预装包安装副本与导入书同样可写）。"""
        book.updated_at = time.time()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self._dir,
                                             prefix=".worldbook-", suffix=".tmp", delete=False) as f:
                temporary = Path(f.name)
                json.dump(book.to_dict(), f, ensure_ascii=False, indent=2)
                f.write("\n")
            temporary.replace(self._path(book.id))
            self._cache[book.id] = book
        finally:
            if temporary and temporary.exists():
                temporary.unlink()

    def create_book(self, name: str, entries: list = None,
                    source_format: str = SOURCE_MANUAL,
                    budget_tokens: int = 0,
                    book_type: str = DEFAULT_BOOK_TYPE) -> WorldBook:
        book_id = uuid.uuid4().hex[:12]
        book = WorldBook(book_id, name=name, entries=entries,
                         source_format=source_format, budget_tokens=budget_tokens,
                         source="imported", categories=copy.deepcopy(DEFAULT_CATEGORIES),
                         book_type=book_type)
        self.save(book)
        return book

    def import_book(self, name: str, source,
                    book_type: str = None) -> tuple[WorldBook, ImportReport]:
        """解析并创建一本书。source 为 dict 或 str（JSON/JSONL 文本）。

        用途（`book_type`）优先级：**显式传入 > 导入物项目扩展 > 默认 story**。
        显式传入是用户在这次导入里做出的选择（前端「用于剧情 / 存入资料库」），必须
        压过文件里写死的用途；只有调用方**没有表态**（`None` 或空串）时，才把导入物
        扩展里的 `book_type` 当作这本书自己的声明。
        """
        entries, report = parse_lorebook(source)
        obj = source
        if isinstance(source, str):
            try:
                obj = json.loads(source)
            except ValueError:
                obj = None
        extension = find_scope_extension(obj)
        requested = str(book_type).strip() if book_type is not None else ""
        payload_type = extension.get("book_type") if extension else None
        if requested:
            # 调用方（前端导入选择）明确表态：以它为准，压过文件里写死的用途
            resolved_type = normalize_book_type(requested)
        elif payload_type is not None:
            # 调用方未表态：把导入物扩展里的用途当作这本书自己的声明
            resolved_type = normalize_book_type(payload_type)
        else:
            # 两边都没有：旧数据缺字段，按剧情世界书处理
            resolved_type = DEFAULT_BOOK_TYPE
        book = WorldBook(uuid.uuid4().hex[:12], name or "导入的世界书", entries,
                         source_format=report.source_format, scope_mode="legacy",
                         book_type=resolved_type)
        if extension:
            if not isinstance(extension.get("import_config", {}), dict):
                raise ValueError("导入的 import_config 必须是对象")
            book.categories = validate_categories(extension.get("categories", []))
            mode = extension.get("scope_mode", "legacy")
            if mode not in ("legacy", "selective"):
                raise ValueError("导入的范围模式无效")
            book.scope_mode = mode
            config, edges = validate_policy({e.uid for e in entries}, {
                **extension.get("import_config", {}), "dependency_edges": extension.get("dependency_edges", [])})
            config["revision"] = max(1, _to_int(extension.get("import_config", {}).get("revision"), 1))
            book.import_config, book.dependency_edges = config, edges
            if any(e.category_id not in {c["id"] for c in book.categories} for e in entries):
                raise ValueError("导入的条目引用了不存在的分类")
            # v3 规则随书回灌；旧书（无 dependency_rules）保持 v2 语义不变。
            rules = extension.get("dependency_rules")
            if isinstance(rules, dict):
                book.dependency_rules, book.dependency_edges, book.related_edges = (
                    validate_v3_rules({e.uid for e in entries}, {
                        **rules, "dependency_edges": extension.get("dependency_edges", []),
                        "related_edges": extension.get("related_edges", []),
                    }))
                book.schema_version = 3
                book.policy_revisions = book._normalize_revisions(extension.get("policy_revisions"))
        self.save(book)
        return book, report

    def duplicate_book(self, book_id: str, new_name: str = None) -> WorldBook:
        """复制任意书为新的导入书（做变体/备份）。"""
        book = self.load(book_id)
        if not book:
            raise ValueError("世界书不存在")
        new_id = uuid.uuid4().hex[:12]
        new_book = WorldBook(
            new_id,
            name=(new_name or f"{book.name}（副本）").strip(),
            entries=copy.deepcopy(book.entries),
            source_format=book.source_format,
            budget_tokens=book.budget_tokens,
            source="imported",
            enabled=book.enabled,
            categories=copy.deepcopy(book.categories),
            dependency_edges=copy.deepcopy(book.dependency_edges),
            import_config=copy.deepcopy(book.import_config),
            scope_mode=book.scope_mode,
            dependency_rules=copy.deepcopy(book.dependency_rules),
            related_edges=copy.deepcopy(book.related_edges),
            policy_revisions=copy.deepcopy(book.policy_revisions),
            book_type=book.book_type,
        )
        new_book.created_at = time.time()
        new_book.updated_at = time.time()
        self.save(new_book)
        return new_book

    def reinstall_book(self, book_id: str) -> WorldBook:
        """从分发源一键重装预装整合包（恢复出厂内容，覆盖现有安装副本）。"""
        pack_path = self._pack_path(book_id)
        if not pack_path.is_file():
            raise ValueError(f"{book_id} 不是预装整合包，无法重装")
        with open(pack_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["source"] = SOURCE_PREINSTALLED
        data.setdefault("enabled", True)
        # 同时写入内容指纹，避免下次启动被判定为「落后」再刷一遍
        self._write_pack(self._path(book_id), data, _pack_rev(data))
        book = self.load(book_id)
        logger.info("已重装预装整合包: %s (%s)", book.name, book_id)
        return book

    def delete_book(self, book_id: str) -> bool:
        """统一删除（预装包删除后可通过「重装」从分发源还原）。"""
        book = self.load(book_id)
        if book is None:
            return False
        if self.get_default_book_id() == book_id:
            self.set_default_book_id(None)
        self._cache.pop(book_id, None)
        path = self._path(book_id)
        if path.is_file():
            path.unlink()
            logger.info("已删除世界书: %s", book_id)
            return True
        return False

    # ── 检索 ──

    def search_books(self, q: str, limit: int = 30, book_type: str = None) -> list[dict]:
        """跨书/条目检索：书名、条目名、条目内容、触发词（仅检索已安装的书）。

        `book_type` 为空时检索全部书（旧调用行为不变）；传 `story` / `reference`
        时只返回该用途的书 —— 资料库检索是「挑条目摘录」的主要入口。
        每个命中都带来源书的完整摘要（含 `book_type`），前端据此展示来源与可用动作。
        """
        q = (q or "").strip().lower()
        wanted = normalize_book_type(book_type, default="") if book_type else None
        if wanted == "":
            wanted = None
        if not q:
            return []
        default_id = self.get_default_book_id()
        results = []
        paths = sorted(self._dir.glob("*.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for path in paths:
            if path.name == "settings.json":
                continue
            try:
                book = self.load(path.stem)
            except Exception:
                continue
            if book is None:
                continue
            if wanted is not None and book.book_type != wanted:
                continue
            matched_entries = [
                e for e in book.entries
                if q in e.name.lower()
                or q in e.content.lower()
                or any(q in k.lower() for k in e.trigger_keys)
            ]
            if q in book.name.lower() or q in book.id.lower():
                matched_entries = book.entries
            if not matched_entries:
                continue
            results.append({
                "book": self._summary(book, default_id),
                "matches": [e.to_dict() for e in matched_entries[:limit]],
                "match_count": len(matched_entries),
            })
            if len(results) >= limit:
                break
        return results

    # ── 条目摘录（资料库 → 剧情世界书） ──

    def excerpt_entries(self, target_book_id: str, items: list) -> dict:
        """把来源条目复制到目标书，**整批原子生效**。

        每条 `items[i]` 形如：
            {"source_book_id": "...", "source_entry_uid": "...",
             # 可选编辑字段，缺省即原文照搬
             "name": ..., "content": ..., "trigger_keys": [...], "secondary_keys": [...],
             "always_active": bool, "position": int, "depth": int, "probability": int,
             "category_id": ..., "character_id": ..., "enabled": bool}

        语义与校验：
        - 来源可以是 `reference`（资料库，主用途）也可以是 `story`，便于剧情书之间复用；
        - 目标必须是 `story`：资料库不接受摘录写入（否则会把资料库变成剧情内容载体）；
        - 目标条目**总是生成新 UID**，来源书不被修改；
        - 正文非空、来源书/来源 UID 必须存在、`content` 为字符串、关键词为非字符串数组时
          直接拒绝；
        - 任一条失败 → 整批不落盘（在按书锁内先全量校验，再一次性保存）。

        返回 `{"entries": [...], "target": {...摘要...}, "revision": 新修订号, "warnings": []}`。
        """
        items = items if isinstance(items, list) else None
        if not items:
            raise ValueError("excerpt 需要至少一条条目")

        target = self.load(target_book_id)
        if target is None:
            raise LookupError("目标世界书不存在")
        if target.is_reference:
            raise ValueError("资料库不能作为摘录目标；请选择一本剧情世界书")

        # 来源书按 id 缓存，避免一本多摘时重复读盘；全部解析完再动手，保证「要么全成」
        source_cache: dict[str, WorldBook] = {}
        prepared: list[dict] = []

        for index, raw in enumerate(items):
            if not isinstance(raw, dict):
                raise ValueError(f"第 {index + 1} 条摘录请求必须是对象")
            source_book_id = str(raw.get("source_book_id") or "").strip()
            source_entry_uid = str(raw.get("source_entry_uid") or "").strip()
            if not source_book_id or not source_entry_uid:
                raise ValueError(f"第 {index + 1} 条摘录缺少来源书或来源条目 UID")
            if source_book_id not in source_cache:
                book = self.load(source_book_id)
                if book is None:
                    raise LookupError(f"来源世界书不存在：{source_book_id}")
                source_cache[source_book_id] = book
            source_book = source_cache[source_book_id]
            source_entry = next(
                (e for e in source_book.entries if e.uid == source_entry_uid), None)
            if source_entry is None:
                raise LookupError(
                    f"来源条目不存在：{source_book_id} / {source_entry_uid}")
            prepared.append(
                _build_excerpt_entry(target, source_book, source_entry, raw, index))

        # ── 到这里为止都还没写盘：任一条不合法都已抛出 ──
        #
        # **在独立副本上完成变更**：`load()` 返回的是内存缓存对象本身，如果直接往它
        # 上面 append 再 save，而 save 在临时文件写入/替换时抛错（磁盘没变），缓存里
        # 却已经多了条目、revision 也更了 —— 不满足「失败不留半成品」。所以在副本上
        # 组装，`save()` 成功之后才让缓存指向新对象；失败则缓存与磁盘都保持原值。
        staged = copy.deepcopy(target)
        created = []
        for built in prepared:
            staged.entries.append(built)
            created.append(built)
        staged.import_config["revision"] = staged.import_config.get("revision", 1) + 1
        self.save(staged)

        return {
            "entries": [e.to_dict() for e in created],
            "target": self._summary(staged, self.get_default_book_id()),
            "revision": staged.import_config["revision"],
            "warnings": [],
        }

    # ── 会话绑定解析 ──

    def resolve(self, overlay=None) -> Optional[WorldBook]:
        """解析会话当前生效的世界书：会话绑定 > 全局默认书 > 已安装且启用的预装包。

        **资料库（book_type=reference）在这里被无条件排除**，无论它是不是默认书、
        有没有被会话绑定、或者是不是预装包 —— 资料库只供浏览、检索与摘录。
        正常情况下接口层已拒绝把资料库设为默认/绑定到会话；这里的判断是防御性的
        兜底（历史数据、手工改过的 settings、并发改名等），保证「不参与解析」这条
        硬约束不依赖任何一个入口的校验。

        Args:
            overlay: SessionOverlay 实例（可空）。
        """
        book_id = None
        if overlay is not None:
            # 新会话显式“不绑定”不得回退全书；已存快照的书被删除/停用也不改绑。
            scope = getattr(overlay, "get_worldbook_scope", lambda: None)()
            if scope is not None:
                book_id = scope.get("book_id")
                book = self.load(book_id) if book_id else None
                return book if book and book.enabled and not book.is_reference else None
            try:
                book_id = overlay.get_worldbook_id()
            except Exception:
                book_id = None
        if not book_id:
            book_id = self.get_default_book_id()
        if not book_id:
            return self._fallback_preinstalled()
        try:
            book = self.load(book_id)
        except Exception as e:
            logger.warning("加载会话世界书 %s 失败: %s", book_id, e)
            return None
        # 书级停用：显式绑定/默认书被停用时不生效，回退预装包
        if book is None or not book.enabled:
            logger.info("世界书 %s 不存在或已停用，回退预装包", book_id)
            return self._fallback_preinstalled()
        if book.is_reference:
            # 不静默换成另一本书：资料库被误设成默认时宁可显示「没有生效的世界书」
            logger.warning("世界书 %s 是资料库（reference），不参与解析", book_id)
            return None
        return book

    def _fallback_preinstalled(self) -> Optional[WorldBook]:
        for bid in _PACK_FALLBACK_IDS:
            book = self.load(bid)
            if (book is not None and book.source == SOURCE_PREINSTALLED
                    and book.enabled and not book.is_reference):
                return book
        return None
