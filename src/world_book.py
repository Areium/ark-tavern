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
- WorldBookManager — data/worldbooks/ 目录 CRUD + 显式会话绑定解析

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
import shutil
import threading
import time
import uuid
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from data_paths import PACKS_ROOT, WORLDBOOKS_ROOT
from worldbook_scope import (
    EXTENSION_KEY, UNCLASSIFIED, validate_categories, find_scope_extension,
    ACTIVATION_ALWAYS, EXPANSION_NONE,
    SCHEMA_VERSION_V3, resolve_v3_scope, validate_v3_rules,
)
from worldbook_classify import classify_entries, needs_classification
from worldbook_folder_store import (
    _source_resources, _relative, _no_links, validate_folder,
)
from character_stats import normalize_stat_fields
from worldbook_media import (
    copied_character_id, materialize_character, normalize_character_media,
    normalize_character_profiles,
    snapshot_character_media, snapshot_character_profile,
)

logger = logging.getLogger(__name__)

_WORLDBOOKS_DIR = WORLDBOOKS_ROOT

# 可选内容包分发源（随程序分发，git 跟踪）；只在用户显式导入时安装。
_PACKS_DIR = PACKS_ROOT

# 支持探测的来源格式标签
SOURCE_V1 = "sillytavern_v1"
SOURCE_V2 = "sillytavern_v2"
SOURCE_CARD = "character_card"
SOURCE_JSONL = "chat_backup_jsonl"
SOURCE_MANUAL = "manual"
SOURCE_PREINSTALLED = "preinstalled"

# ── 书用途（book_type）──
# story     ：剧情世界书，可绑定会话并参与解析
# reference ：资料库，只供浏览 / 检索 / 摘录，不参与任何会话解析
BOOK_TYPE_STORY = "story"
BOOK_TYPE_REFERENCE = "reference"
BOOK_TYPES = (BOOK_TYPE_STORY, BOOK_TYPE_REFERENCE)

# 外部 SillyTavern 格式没有用途字段时的导入默认值。
DEFAULT_BOOK_TYPE = BOOK_TYPE_STORY


def normalize_book_type(value, default: str = DEFAULT_BOOK_TYPE) -> str:
    """把外部传入的用途值规范化为合法取值；非法值抛 ValueError。

    `None` / 空串代表调用方未指定，回落到该入口声明的 default。
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

    def __init__(self, it=(), forced_uids=frozenset(), position_overrides=None,
                 enabled_overrides=None):
        super().__init__(it)
        self.forced_uids = frozenset(forced_uids)
        self.position_overrides = dict(position_overrides or {})
        self.enabled_overrides = dict(enabled_overrides or {})


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

    1. `not_in_scope`         —— 不在书的候选范围内；
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
    # 安全网（**不可达**）：走到这里意味着「条目在候选范围内、启用、有正文、关键词
    # 通过（或常驻）、概率也过了，却既没进 order[] 也没有 trace 的 included=False」，
    # 按上游不变量不可能发生（候选 ⊆ 可注入集合，任何没进 order[] 的候选条目必然落在
    # keyword / secondary / probability / budget 四类之一）；**真被触发即说明上游有 bug**。
    # 这里刻意报 `not_in_scope`（「不在候选范围内」）而**不是** `budget_exceeded`：
    # 后者的语义由 `trace` 里 `included=False` 精确定义，乱报会让
    # `totals.truncated`（= trace 存在 included=False）与 `dropped[]` 自相矛盾 ——
    # 例如「整本书已停用」的边界上曾出现 2 条 budget_exceeded 而 truncated=false。
    # 保留这个分支只为守住「每条书内条目在 order[]/dropped[] 中都有解释」的不变量。
    return "not_in_scope"


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


#: 「整本书已停用」的排除原因：与条目级原因（停用 / 空正文）区分开。
#: 它只在**整本书**不参与解析时出现，因此 Prompt 预览要把它排除在
#: `not_in_scope` 的判定基准之外（见 `preview_prompt_injection`）。
EXCLUDED_REASON_BOOK_DISABLED = "世界书已停用"


def _excluded_reason(entry: WorldBookEntry) -> str:
    """条目「被选中却没进候选」的原因，取**最具体**的那个。

    条目级原因（`条目已停用` / `内容为空`）优先于书级原因（`世界书已停用`）：
    前者是「即使这本书被启用，这条也不会注入」这一更可操作的事实。
    这个区分被 Prompt 预览的未插入原因分类依赖：书级原因的条目必须落回
    `not_in_scope`（整本书不在候选范围内），条目级原因的条目要报
    `disabled` / `empty_content`。

    只对**停用**的书有影响：书启用时，被排除的条目必然命中的是条目级原因
    （`resolved` 的条件正是 `self.enabled and e.enabled and e.content.strip()`）。
    """
    if not entry.enabled:
        return "条目已停用"
    if not (entry.content or "").strip():
        return "内容为空"
    # 条目本身没问题却被排除 → 只可能是整本书被停用
    return EXCLUDED_REASON_BOOK_DISABLED


# ── 条目分层：稳定层 / 动态层 / **系统层** ──────────────────────────────
#
# 稳定层与动态层是**注入**分层（position=0 且常驻 → 稳定层，其余 → 动态层）。
# 第三类是「系统层」：条目内容不是给人看的设定，而是**编辑器 / 运行时元数据**
# —— 剧情节点图（`plot_graphs`）与节点绑定（`node_lore_scope`）。它们由各自模块
# 整条替换、空触发键且非常驻，**按设计永不注入**，只服务画布渲染与系统判定。
# 因此它们：
#   * 不计入任何 token 估算（`WorldBook.estimated_tokens` / 接口摘要）；
#   * 不出现在 Prompt 预览的 order 里（本来就不注入），也不出现在 dropped 里
#     （报「关键词未命中」会把用户引向错误的修复入口）；
#   * 在界面上作为与稳定层 / 动态层并列的独立分类展示。
#
# 判定与承载模块自己的 `is_graph_entry` / `is_lore_bindings_entry` 同构：
# extensions 标记优先、围栏块兜底。常量必须与来源模块保持一致，
# `tests/test_worldbook_system_layer.py` 直接比对它们的 `_ENTRY_TYPE` /
# `WORLD_BOOK_FENCE`，两处漂移会立刻失败。
SYSTEM_ENTRY_TYPES = ("plot_graph", "lore_bindings", "story_outline")
SYSTEM_ENTRY_FENCES = ("plot-graph", "arknights_tavern_lore_bindings", "story-outline")
_SYSTEM_EXT_NAMESPACE = "arknights_tavern"
_SYSTEM_FENCE_RE = re.compile(
    r"```json\s+(?:%s)\s*\n" % "|".join(re.escape(name) for name in SYSTEM_ENTRY_FENCES))


def _entry_field(entry, name: str, default=None):
    """按字段读条目：`WorldBookEntry` 与普通 dict 两种形态都要认。

    预览 / 摘要路径上既可能拿到数据模型对象，也可能拿到 `to_dict()` 之后的
    普通字典（接口层、测试夹具都用过），判定函数因此不能绑定其中一种。
    """
    if isinstance(entry, dict):
        return entry.get(name, default)
    return getattr(entry, name, default)


def is_system_entry(entry) -> bool:
    """系统层条目：只服务系统判定 / 编辑器，永不注入，也不计入 token 展示。"""
    raw = _entry_field(entry, "raw", None) or {}
    ext = ((raw.get("extensions") if isinstance(raw, dict) else None) or {}).get(
        _SYSTEM_EXT_NAMESPACE) or {}
    if ext.get("entry_type") in SYSTEM_ENTRY_TYPES:
        return True
    return bool(_SYSTEM_FENCE_RE.search(str(_entry_field(entry, "content", "") or "")))


def entry_layer(entry) -> str:
    """条目分层：`system` / `stable` / `dynamic`（与注入路径同一口径）。"""
    if is_system_entry(entry):
        return "system"
    position = _entry_field(entry, "position", 0)
    if position == 0 and _entry_field(entry, "always_active", False):
        return "stable"
    return "dynamic"


def entry_tokens(entry) -> int:
    """单条目展示估算：与前端 `entryTokens` / `estimated_tokens()` 同一口径。"""
    content = str(_entry_field(entry, "content", "") or "")
    name = str(_entry_field(entry, "name", "") or "")
    return estimate_tokens(f"### {name}\n{content}" if name else content)


@dataclass(frozen=True)
class WorldBookEntryStats:
    """条目统计口径：一处定义，接口摘要 / 详情 / 界面展示共用同一份规则。

    injectable 是**启用的非系统条目**数 —— 真正会进候选、真正占 token 的那批。
    停用条目与系统层条目都不计。
    """

    total: int
    injectable: int
    disabled: int
    system: int
    tokens: int


def book_entry_stats(entries) -> WorldBookEntryStats:
    """按条目列表算出统计口径（顺序无关，只做一次遍历）。"""
    total = injectable = disabled = system = tokens = 0
    for entry in entries or ():
        total += 1
        if is_system_entry(entry):
            system += 1
            continue
        if not _entry_field(entry, "enabled", True):
            disabled += 1
            continue
        injectable += 1
        tokens += entry_tokens(entry)
    return WorldBookEntryStats(total=total, injectable=injectable,
                               disabled=disabled, system=system, tokens=tokens)


def validate_entry_groups(groups, group_map, entry_uids: set[str]) -> tuple[list[dict], dict]:
    """Validate display-only folders separately from entry trigger groups."""
    if not isinstance(groups, list):
        raise ValueError("entry_groups 必须是数组")
    normalized = []
    ids = set()
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("entry_groups 的每项必须是对象")
        group_id, name = group.get("id"), group.get("name")
        if not isinstance(group_id, str) or not group_id.strip() or group_id != group_id.strip():
            raise ValueError("分组 id 必须是非空且无首尾空格的字符串")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("分组 name 必须是非空字符串")
        if group_id in ids:
            raise ValueError("分组 id 不可重复")
        ids.add(group_id)
        normalized.append({"id": group_id, "name": name.strip()})
    if not isinstance(group_map, dict):
        raise ValueError("entry_group_map 必须是对象")
    for uid, group_id in group_map.items():
        if uid not in entry_uids:
            raise ValueError(f"entry_group_map 引用了不存在的条目 UID: {uid}")
        if not isinstance(group_id, str) or group_id not in ids:
            raise ValueError(f"entry_group_map 引用了不存在的分组: {group_id}")
    return normalized, dict(group_map)


def validate_entry_layout(layout, groups, group_map, entry_uids: set[str]) -> list[dict]:
    """Require each top-level folder and ungrouped entry exactly once."""
    if not isinstance(layout, list):
        raise ValueError("entry_layout 必须是数组")
    group_ids = {group["id"] for group in groups}
    root_uids = entry_uids - set(group_map)
    seen_groups, seen_entries = set(), set()
    for item in layout:
        if not isinstance(item, dict):
            raise ValueError("entry_layout 的每项必须是对象")
        if item.get("kind") == "group" and set(item) == {"kind", "id"}:
            group_id = item["id"]
            if not isinstance(group_id, str) or group_id not in group_ids or group_id in seen_groups:
                raise ValueError("entry_layout 包含未知或重复的分组")
            seen_groups.add(group_id)
        elif item.get("kind") == "entry" and set(item) == {"kind", "uid"}:
            uid = item["uid"]
            if not isinstance(uid, str) or uid not in root_uids or uid in seen_entries:
                raise ValueError("entry_layout 包含已分组、未知或重复的条目")
            seen_entries.add(uid)
        else:
            raise ValueError("entry_layout 节点格式无效")
    if seen_groups != group_ids or seen_entries != root_uids:
        raise ValueError("entry_layout 必须完整且不重复地包含全部分组和未分组条目")
    return copy.deepcopy(layout)


def normalize_entry_layout(layout, groups, group_map, entry_order) -> list[dict]:
    """Repair stale persisted layout, retaining the order of surviving nodes."""
    group_ids = {group["id"] for group in groups}
    root_uids = set(entry_order) - set(group_map)
    result, seen_groups, seen_entries = [], set(), set()
    for item in layout if isinstance(layout, list) else []:
        if not isinstance(item, dict):
            continue
        if item.get("kind") == "group" and set(item) == {"kind", "id"}:
            group_id = item["id"]
            if isinstance(group_id, str) and group_id in group_ids and group_id not in seen_groups:
                result.append({"kind": "group", "id": group_id})
                seen_groups.add(group_id)
        elif item.get("kind") == "entry" and set(item) == {"kind", "uid"}:
            uid = item["uid"]
            if isinstance(uid, str) and uid in root_uids and uid not in seen_entries:
                result.append({"kind": "entry", "uid": uid})
                seen_entries.add(uid)
    result.extend({"kind": "entry", "uid": uid} for uid in entry_order
                  if uid in root_uids and uid not in seen_entries)
    result.extend({"kind": "group", "id": group["id"]} for group in groups
                  if group["id"] not in seen_groups)
    return result


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
                 pack_rev: str = "", schema_version: int = SCHEMA_VERSION_V3,
                 categories: list = None, dependency_edges: list = None,
                 import_config: dict = None, scope_mode: str = "selective",
                 dependency_rules: dict = None, related_edges: list = None,
                 policy_revisions: list = None, book_type: str = DEFAULT_BOOK_TYPE,
                 description: str = "", cover_image: str = "",
                 entry_order: list = None, edit_revision: int = 1,
                 stat_fields: list = None, character_media: dict = None,
                 character_profiles: dict = None,
                 entry_groups: list = None, entry_group_map: dict = None,
                 entry_layout: list = None):
        self.id = book_id
        self.name = name or book_id
        self.source_format = source_format
        self.budget_tokens = budget_tokens  # 0 = 不限制
        self.description = str(description or "")
        self.cover_image = str(cover_image or "")
        self.character_media = normalize_character_media(character_media)
        self.character_profiles = normalize_character_profiles(character_profiles)
        # 统一数值字段（角色数值的 schema）：同一本书下的角色共用，见 character_stats.py
        self.stat_fields: list[dict] = normalize_stat_fields(stat_fields)
        self.edit_revision = max(0, _to_int(edit_revision, 0))
        self.book_type = normalize_book_type(book_type)
        # source: "preinstalled"（随程序分发的整合包，安装副本）| "imported"（用户导入）
        self.source = source if source in (SOURCE_PREINSTALLED, "imported") else "imported"
        self.enabled = bool(enabled)
        self.created_at = time.time()
        self.updated_at = time.time()
        self.pack_rev = str(pack_rev or "")
        self.entries: list[WorldBookEntry] = list(entries or [])
        self.entry_groups, self.entry_group_map = validate_entry_groups(
            entry_groups if entry_groups is not None else [],
            entry_group_map if entry_group_map is not None else {},
            {entry.uid for entry in self.entries})
        known_order = {entry.uid for entry in self.entries}
        if isinstance(entry_order, list):
            normalized_order = []
            for uid in entry_order:
                uid = str(uid or "")
                if uid in known_order and uid not in normalized_order:
                    normalized_order.append(uid)
            # An explicit order is only valid when it names every entry exactly once.
            self.entry_order = normalized_order if len(normalized_order) == len(self.entries) else None
        else:
            self.entry_order = None
        self.entry_layout = (normalize_entry_layout(
            entry_layout, self.entry_groups, self.entry_group_map,
            self.effective_entry_order()) if entry_layout is not None else None)
        if schema_version != SCHEMA_VERSION_V3:
            raise ValueError(f"内部世界书仅支持 schema_version={SCHEMA_VERSION_V3}")
        if scope_mode != "selective":
            raise ValueError("内部世界书仅支持 selective 范围模式")
        self.schema_version = SCHEMA_VERSION_V3
        self.scope_mode = "selective"
        self.categories = self._normalize_categories(categories)
        for entry in self.entries:
            entry.category_id = entry.category_id or "unclassified"
        self.dependency_edges = self._normalize_edges(dependency_edges)
        self.import_config = self._normalize_import_config(import_config)
        # ── v3：全书底层有向图 + 条件起点（分类只负责组织，不决定候选）──
        known = {e.uid for e in self.entries}
        payload = dict(dependency_rules) if isinstance(dependency_rules, dict) else {
            "roots": [{"entry_uid": entry.uid, "activation": ACTIVATION_ALWAYS,
                       "expansion": EXPANSION_NONE, "character_ids": []}
                      for entry in self.entries],
            "root_rule": {"entry_uids": sorted(known)},
        }
        payload["requires_edges"] = list(payload.get("requires_edges", self.dependency_edges))
        payload["related_edges"] = list(payload.get("related_edges", related_edges or []))
        self.dependency_rules, self.dependency_edges, self.related_edges = validate_v3_rules(
            known, payload)
        # 不可变策略版本历史：会话可据此恢复「它创建时绑定的规则」，而不只是版本号。
        self.policy_revisions = self._normalize_revisions(policy_revisions)

    def _normalize_revisions(self, value) -> list[dict]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("policy_revisions 必须是数组")
        result = []
        seen = set()
        known = {entry.uid for entry in self.entries}
        for raw in value:
            if not isinstance(raw, dict):
                raise ValueError("policy_revisions 的元素必须是对象")
            revision = raw.get("revision")
            if type(revision) is not int or revision < 1 or revision in seen:
                raise ValueError("policy_revisions.revision 必须是唯一的正整数")
            if raw.get("scope_mode", "selective") != "selective":
                raise ValueError("policy_revisions 仅支持 selective 范围模式")
            if not isinstance(raw.get("rules"), dict):
                raise ValueError("policy_revisions.rules 必须是对象")
            rules, requires, related = validate_v3_rules(known, {
                **raw["rules"],
                "requires_edges": raw.get("requires_edges") or [],
                "related_edges": raw.get("related_edges") or [],
            })
            seen.add(revision)
            result.append({
                "revision": revision,
                "resolver_version": int(raw.get("resolver_version", RESOLVER_VERSION) or RESOLVER_VERSION),
                "scope_mode": "selective",
                "rules": rules,
                "requires_edges": requires,
                "related_edges": related,
                "created_at": float(raw.get("created_at", time.time())),
            })
        result.sort(key=lambda item: item["revision"])
        return result[-MAX_POLICY_REVISIONS:]

    @property
    def is_reference(self) -> bool:
        """资料库：只浏览、检索、摘录，不参与会话解析或绑定。"""
        return self.book_type == BOOK_TYPE_REFERENCE

    def bump_edit_revision(self) -> int:
        """Advance the optimistic-edit revision for UI writes."""
        self.edit_revision += 1
        return self.edit_revision

    def remove_entry_references(self, uid: str) -> dict[str, int]:
        """删除条目后同步清理当前规则与历史规则快照中的悬空引用。"""
        self.entry_group_map.pop(uid, None)
        if self.entry_order is not None:
            self.entry_order = [entry_uid for entry_uid in self.entry_order
                                if entry_uid != uid]
        if self.entry_layout is not None:
            self.entry_layout = self.effective_entry_layout()
        affected = {
            "dependency_edges": sum(
                uid in (edge["from_uid"], edge["to_uid"])
                for edge in self.dependency_edges),
            "related_edges": sum(
                uid in (edge["from_uid"], edge["to_uid"])
                for edge in self.related_edges),
            "policy_revisions": 0,
        }
        self.dependency_edges = [
            edge for edge in self.dependency_edges
            if uid not in (edge["from_uid"], edge["to_uid"])
        ]
        self.related_edges = [
            edge for edge in self.related_edges
            if uid not in (edge["from_uid"], edge["to_uid"])
        ]
        self.dependency_rules["roots"] = [
            root for root in self.dependency_rules["roots"]
            if root["entry_uid"] != uid
        ]
        self.dependency_rules["root_rule"]["entry_uids"] = [
            entry_uid for entry_uid in self.dependency_rules["root_rule"]["entry_uids"]
            if entry_uid != uid
        ]
        for snapshot in self.policy_revisions:
            rules = snapshot["rules"]
            before = (len(rules["roots"])
                      + len(snapshot["requires_edges"])
                      + len(snapshot["related_edges"]))
            rules["roots"] = [root for root in rules["roots"]
                              if root["entry_uid"] != uid]
            rules["root_rule"]["entry_uids"] = [
                entry_uid for entry_uid in rules["root_rule"]["entry_uids"]
                if entry_uid != uid
            ]
            snapshot["requires_edges"] = [
                edge for edge in snapshot["requires_edges"]
                if uid not in (edge["from_uid"], edge["to_uid"])
            ]
            snapshot["related_edges"] = [
                edge for edge in snapshot["related_edges"]
                if uid not in (edge["from_uid"], edge["to_uid"])
            ]
            after = (len(rules["roots"])
                     + len(snapshot["requires_edges"])
                     + len(snapshot["related_edges"]))
            affected["policy_revisions"] += before - after
        return affected

    @staticmethod
    def default_entry_sort_key(entry: WorldBookEntry):
        """标准注入顺序：位置、组权重、深度、UID。"""
        return (entry.position, -entry.group_weight, entry.depth, entry.uid)

    def effective_entry_order(self) -> list[str]:
        """Return the full UI/injection order without mutating stored entries."""
        if self.entry_order is not None:
            return list(self.entry_order)
        return [entry.uid for entry in sorted(self.entries, key=self.default_entry_sort_key)]

    def effective_entry_layout(self) -> list[dict]:
        return normalize_entry_layout(self.entry_layout, self.entry_groups,
                                      self.entry_group_map, self.effective_entry_order())

    def estimated_tokens(self) -> int:
        """Fixed display estimate for the complete book; never changes budget_tokens.

        口径 = **启用的非系统条目**之和：停用条目不会注入，系统层条目（节点图 /
        节点绑定）按设计永不注入，两者都不该出现在这个数里。界面上勾掉一条，
        这个数就跟着掉 —— 与前端 `bookEntryStats` 完全同口径。
        """
        return book_entry_stats(self.entries).tokens

    def entry_stats(self) -> WorldBookEntryStats:
        """条目分层统计：总数 / 会注入的 / 停用的 / 系统层，以及展示 token。"""
        return book_entry_stats(self.entries)

    def character_ids(self) -> list[str]:
        """本书的角色花名册：**启用且非系统**条目上非空的 `character_id`，去重保序。

        新建会话用它取「这本书的角色」做候选与自动选中。为什么不能拿角色卡的
        `worldbook_id` 当书内角色名单：拆分出来的剧情书（`near-light` 等）里，条目带
        `character_id`，而角色卡 frontmatter 的来源书仍记着拆分前的 `arknights` ——
        按来源书取会得到空名单（见 docs/notes.md）。停用条目与系统层条目都不算，
        与 `book_entry_stats` 同一套口径。
        """
        names: list[str] = []
        for entry in self.entries:
            if is_system_entry(entry) or not _entry_field(entry, "enabled", True):
                continue
            name = str(getattr(entry, "character_id", "") or "").strip()
            if name and name not in names:
                names.append(name)
        return names

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
            "scope_mode": "selective",
            "rules": copy.deepcopy(self.dependency_rules),
            "requires_edges": copy.deepcopy(self.dependency_edges),
            "related_edges": copy.deepcopy(self.related_edges),
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
        return {"revision": max(1, _to_int(config.get("revision", 1), 1))}

    # ── 序列化 ──

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "name": self.name,
            "source_format": self.source_format,
            "budget_tokens": self.budget_tokens,
            "description": self.description,
            "cover_image": self.cover_image,
            "edit_revision": self.edit_revision,
            "source": self.source,
            "enabled": self.enabled,
            "book_type": self.book_type,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "entries": [e.to_dict() for e in self.entries],
            "entry_groups": copy.deepcopy(self.entry_groups),
            "entry_group_map": dict(self.entry_group_map),
            "schema_version": self.schema_version,
            "scope_mode": self.scope_mode,
            "categories": self.categories,
            "dependency_edges": self.dependency_edges,
            "import_config": self.import_config,
        }
        # Persist a custom order only after an explicit reorder.
        if self.entry_order is not None:
            data["entry_order"] = list(self.entry_order)
        if self.entry_layout is not None:
            data["entry_layout"] = self.effective_entry_layout()
        # Optional payloads stay absent when unused.
        if self.stat_fields:
            data["stat_fields"] = copy.deepcopy(self.stat_fields)
        if self.character_media:
            data["character_media"] = copy.deepcopy(self.character_media)
        if self.character_profiles:
            data["character_profiles"] = copy.deepcopy(self.character_profiles)
        data["dependency_rules"] = self.dependency_rules
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
        if data.get("schema_version") != SCHEMA_VERSION_V3:
            raise ValueError(f"内部世界书仅支持 schema_version={SCHEMA_VERSION_V3}")
        if data.get("scope_mode") != "selective":
            raise ValueError("内部世界书仅支持 selective 范围模式")
        if not isinstance(data.get("dependency_rules"), dict):
            raise ValueError("内部世界书缺少 dependency_rules")
        if data.get("book_type") not in BOOK_TYPES:
            raise ValueError(f"内部世界书 book_type 必须是 {' 或 '.join(BOOK_TYPES)}")
        entries = [WorldBookEntry.from_dict(e) for e in data.get("entries", [])]
        group_map = data.get("entry_group_map")
        if isinstance(group_map, dict):
            known_uids = {entry.uid for entry in entries}
            group_map = {uid: group_id for uid, group_id in group_map.items()
                         if uid in known_uids}
        book = WorldBook(
            book_id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            entries=entries,
            source_format=str(data.get("source_format", SOURCE_MANUAL)),
            budget_tokens=int(data.get("budget_tokens", 0)),
            description=str(data.get("description", "") or ""),
            cover_image=str(data.get("cover_image", "") or ""),
            entry_order=data.get("entry_order"),
            entry_groups=data.get("entry_groups"),
            entry_group_map=group_map,
            entry_layout=data.get("entry_layout"),
            edit_revision=data.get("edit_revision", 1),
            source=str(data.get("source", "imported")),
            enabled=bool(data.get("enabled", True)),
            pack_rev=str(data.get("pack_rev", "")),
            schema_version=data["schema_version"],
            categories=data.get("categories"),
            dependency_edges=data.get("dependency_edges"),
            import_config=data.get("import_config"),
            scope_mode=data["scope_mode"],
            dependency_rules=data.get("dependency_rules"),
            related_edges=data.get("related_edges"),
            policy_revisions=data.get("policy_revisions"),
            book_type=data["book_type"],
            stat_fields=data.get("stat_fields"),
            character_media=data.get("character_media"),
            character_profiles=data.get("character_profiles"),
        )
        book.created_at = float(data.get("created_at", time.time()))
        book.updated_at = float(data.get("updated_at", time.time()))
        # 预装整合包由内置生成器写出，uid 前缀 / group / 名称后缀都是可靠来源元数据；
        # 外部书没有这类元数据时保持原样，不按名字或关键词猜测。
        if book.source == SOURCE_PREINSTALLED and needs_classification(data.get("categories")):
            apply_auto_classification(book)
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

    def _injectable_entries(self) -> list[WorldBookEntry]:
        """返回启用、有正文且不属于系统层的条目。"""
        return [e for e in self.entries
                if e.enabled and (e.content or "").strip() and not is_system_entry(e)]

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
        if not self.enabled:
            # 书级停用是候选解析的最外层门禁。编辑器仍可读取、修改这本书，
            # 但预览、会话绑定和真实注入都不得泄漏其中任何条目。
            result.update({
                "active_roots": [],
                "resolved_entry_uids": [],
                "selection_reasons": {},
                "resolved_edges": [],
                "display_tree": [],
            })
        result["resolver_version"] = RESOLVER_VERSION
        return result

    def preview_v3_scope(self, roster_character_ids=None, manual_entry_uids=None,
                         revision=None):
        """v3 预览：候选范围 + 解释 + 与草稿绑定的一致性指纹。"""
        scope = self.resolve_v3_import_scope(roster_character_ids, revision, manual_entry_uids)
        full = self._injectable_entries()
        resolved = set(scope["resolved_entry_uids"])
        costs = {e.uid: estimate_tokens(e.content) for e in self.entries}
        total = sum(costs.get(e.uid, 0) for e in full)
        selected = sum(costs.get(uid, 0) for uid in resolved)
        by_uid = {e.uid: e for e in self.entries}

        warnings = []
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
                                                 revision),
            "policy_revision": scope["policy_revision"],
            "content_revision": scope["content_revision"],
            "breakdown": {
                reason: {"entry_count": sum(reason in scope["selection_reasons"].get(uid, [])
                                            for uid in resolved),
                         "estimated_tokens": sum(costs.get(uid, 0) for uid in resolved
                                                 if reason in scope["selection_reasons"].get(uid, []))}
                for reason in ("always", "roster", "requires", "manual")},
            "manual_entry_uids": scope["manual_entry_uids"],
            "unselected_entries": unselected[:200],
            "unselected_count": len(unselected),
            "entry_names": {uid: (by_uid[uid].name or uid) for uid in scope["resolved_entry_uids"]
                            if uid in by_uid},
            "warnings": warnings,
        }

    def policy_draft_hash(self, roster_character_ids=None, manual_entry_uids=None,
                          revision=None) -> str:
        """草稿指纹：规则 + 边 + 阵容 + 手动追加。

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
            "content_revision": content_revision(self.entries),
        }
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def session_scope_snapshot(self, roster_character_ids=None, manual_entry_uids=None,
                               revision=None) -> dict:
        """生成会话要持久化的 v3 范围快照。

        绑定的是**完整规则/关联/边的不可变版本**（不只是版本号），并记录解析器版本、
        阵容、手动追加、激活根、UID、原因、参与边与展示路径。正文仍按实时语义读取，
        因此这里保存的是规则与解析结果，不是条目正文副本。

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
            "local_overrides": {"requires_edges": [], "related_edges": [],
                                "entry_enabled": {}},
            "suppressed_edges": [], "inheritance_conflicts": [], "scope_revision": 1,
        })
        return result

    def refresh_session_scope(self, existing_scope, roster_character_ids=None) -> dict:
        """按会话**已绑定**的规则版本重算范围（角色入队 / 离队时调用）。

        关键：不能拿「这本书现在长什么样」去覆盖会话快照，否则
        - 绑定的不可变规则版本会被换成最新版本；
        - 手动追加（本会话作用域）会消失；
        - 选用原因 / 参与边 / 展示树会退化成一份没有解释的 UID 列表。

        快照沿用绑定的 revision / manual 重算。
        """
        if not isinstance(existing_scope, dict):
            raise ValueError("会话世界书范围必须是对象")
        if existing_scope.get("schema_version") != SCHEMA_VERSION_V3:
            raise ValueError(f"会话世界书范围仅支持 schema_version={SCHEMA_VERSION_V3}")
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
        enabled_overrides = managed["local_overrides"].get("entry_enabled") or {}
        if enabled_overrides:
            resolved = set(refreshed.get("resolved_entry_uids") or [])
            reasons = copy.deepcopy(refreshed.get("selection_reasons") or {})
            by_uid = {entry.uid: entry for entry in self.entries}
            for uid, enabled in enabled_overrides.items():
                entry = by_uid.get(uid)
                if not entry:
                    continue
                if enabled and self.enabled and (entry.content or "").strip():
                    resolved.add(uid)
                    reasons[uid] = ["session_override"]
                else:
                    resolved.discard(uid)
                    reasons.pop(uid, None)
            refreshed["resolved_entry_uids"] = [
                entry.uid for entry in self.entries if entry.uid in resolved]
            refreshed["selection_reasons"] = reasons
        return refreshed

    def eligible_uids_for(self, overlay, *, with_reasons: bool = False):
        """会话候选集 = 会话范围 ∩ 节点作用域（窄化白名单）。

        节点作用域来自 overlay.get_active_lore_scope()（冻结在剧情树节点快照里，
        见 docs/design/worldbook/node-scoped-worldbook-loading.md）。缺少当前 v3 快照时返回空集；
        无节点作用域（书内无 lore_bindings / 自由模式）时返回完整的会话候选范围。
        with_reasons=True 时返回 (集合, 解释 dict)，供编辑器/调试接口用。
        """
        scope = getattr(overlay, "get_worldbook_scope", lambda: None)()
        if (not isinstance(scope, dict)
                or scope.get("schema_version") != SCHEMA_VERSION_V3
                or scope.get("book_id") != self.id):
            empty = EligibleSet()
            return (empty, {"node_scope": None}) if with_reasons else empty
        base = set(scope.get("resolved_entry_uids", []))
        enabled_overrides = ((scope.get("local_overrides") or {}).get("entry_enabled") or {})

        node_scope = None
        getter = getattr(overlay, "get_active_lore_scope", None)
        if getter is not None:
            candidate = getter()
            if (isinstance(candidate, dict)
                    and isinstance(candidate.get("allowed"), list)
                    and candidate.get("book_id") in (None, "", self.id)):
                node_scope = candidate
        if node_scope is None:
            result = EligibleSet(base, enabled_overrides=enabled_overrides)
            if not with_reasons:
                return result
            return result, {"node_scope": None}

        allowed = base & set(node_scope["allowed"])
        pinned = set(node_scope.get("pinned") or []) & allowed
        overrides = {u: o for u, o in (node_scope.get("overrides") or {}).items()
                     if u in allowed}
        result = EligibleSet(allowed, forced_uids=pinned, position_overrides=overrides,
                             enabled_overrides=enabled_overrides)
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
        if not self.enabled:
            return []

        scan_text = f"{recent_text or ''}\n{current_input or ''}"
        if not scan_text.strip():
            scan_text = current_input or ""

        forced = frozenset(getattr(eligible_uids, "forced_uids", None) or ())
        overrides = getattr(eligible_uids, "position_overrides", None) or {}
        enabled_overrides = getattr(eligible_uids, "enabled_overrides", None) or {}

        matched: list[WorldBookEntry] = []
        for entry in self.entries:
            if eligible_uids is not None and entry.uid not in eligible_uids:
                continue
            if not enabled_overrides.get(entry.uid, entry.enabled):
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
        if self.entry_order is None:
            matched.sort(key=self.default_entry_sort_key)
        else:
            explicit = {uid: index for index, uid in enumerate(self.entry_order)}

            def explicit_key(entry):
                # Stable-layer entries are emitted in the stable host and every other
                # entry in the dynamic host. Keep that discipline even when a node
                # position override changes an entry's layer.
                layer = 0 if entry.position == 0 and entry.always_active else 1
                return (layer, explicit.get(entry.uid, len(explicit)),
                        *self.default_entry_sort_key(entry))

            matched.sort(key=explicit_key)
        return matched

    # ── 格式化 ──

    def format_injection(self, entries: list[WorldBookEntry], identity: str = "玩家",
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

    def preview_all_entries(self, *, mode="narrative", identity="玩家", active_char=None,
                            excluded_entry_uids=None) -> dict:
        """只读全书预览：按既有注入顺序格式化全部启用条目。

        该模式用于编辑器展示整本书的最终 Prompt 文本，不模拟某一轮会话，因此不看
        候选范围、节点绑定、关键词、概率或 token 预算。排序仍复用
        :meth:`collect_matches`，正文、分层与 token 统计仍复用同一次
        :meth:`format_injection` trace。调用方可传入只承载编辑器元数据的条目 UID；
        它们不会出现在正文、order 或 dropped 中。

        方法始终在深拷贝上清零预算，绝不修改原书或原条目。

        系统层条目（节点图 / 节点绑定）**无条件排除**：它们永不注入，也不是
        「未启用所以不参与预览」——把它们列进 order 或 dropped 都会误导作者。
        调用方仍可额外传入只承载编辑器元数据的条目 UID。
        """
        if mode not in ("narrative", "free"):
            raise ValueError("mode 必须是 narrative 或 free")

        if not self.enabled:
            return {
                "mode": mode,
                "order": [],
                "stable_text": "",
                "dynamic_text": "",
                "sites": _preview_sites(mode),
                "skeleton": _preview_skeleton(mode),
                "dropped": [
                    {"uid": entry.uid, "name": entry.name or entry.uid,
                     "reason": "disabled" if not entry.enabled else "not_in_scope"}
                    for entry in self.entries if not is_system_entry(entry)
                ],
                "totals": {
                    "stable_tokens": 0,
                    "dynamic_tokens": 0,
                    "budget_tokens": 0,
                    "truncated": False,
                    "candidate_count": 0,
                    "matched_count": 0,
                },
            }

        candidate = copy.deepcopy(self)
        candidate.budget_tokens = 0
        excluded = {str(uid) for uid in (excluded_entry_uids or ())}
        excluded |= {entry.uid for entry in candidate.entries if is_system_entry(entry)}
        enabled_uids = {
            entry.uid for entry in candidate.entries
            if entry.enabled and entry.uid not in excluded
        }
        forced = EligibleSet(enabled_uids, forced_uids=enabled_uids)
        matched = candidate.collect_matches("", "", eligible_uids=forced)
        trace: list[dict] = []
        stable_text, dynamic_text = candidate.format_injection(
            matched, identity, active_char, trace=trace)

        matched_by_uid = {entry.uid: entry for entry in matched}
        included = [item for item in trace if item["included"]]
        order = []
        for seq, item in enumerate(included):
            entry = matched_by_uid[item["uid"]]
            order.append({
                "uid": entry.uid,
                "name": entry.name or entry.uid,
                "seq": seq,
                "layer": item["layer"],
                "position": int(entry.position or 0),
                "group_weight": int(entry.group_weight or 0),
                "depth": int(entry.depth or 0),
                "estimated_tokens": item["tokens"],
                "text": item["text"],
                "reasons": [],
                "matched_keys": [],
                "override_from_node": None,
            })

        dropped = [
            {"uid": entry.uid, "name": entry.name or entry.uid, "reason": "disabled"}
            for entry in candidate.entries
            if not entry.enabled and entry.uid not in excluded
        ]
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
                "budget_tokens": 0,
                "truncated": False,
                "candidate_count": len(matched),
                "matched_count": len(matched),
            },
        }

    def preview_prompt_injection(self, *, mode="narrative", input_text="", recent_text="",
                                 roster_character_ids=None, manual_entry_uids=None,
                                 identity="玩家", active_char=None, seed=0,
                                 lore_scope=None) -> dict:
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

        # 1) 候选范围：与 scope-preview 走同一 v3 解析入口。
        scope = self.preview_v3_scope(roster, manual)["scope"]

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
        # `not_in_scope` 只对根本没进过候选范围的条目成立；停用/空正文条目仍由
        # v3 issues 提供真实原因。
        scoped_uids = set(scope_uids)
        for issue in scope.get("issues") or []:
            if (isinstance(issue, dict)
                    and issue.get("code") in ("disabled_entry", "empty_content")
                    and isinstance(issue.get("uid"), str)):
                scoped_uids.add(issue["uid"])
        demoted_uids = set(reasons.get("dropped_by_scope") or [])
        dropped = []
        for entry in self.entries:
            if entry.uid in included_uids:
                continue
            # 系统层条目永不注入：它们没进 order 是设计使然，不是「未插入」。
            # 报 `keyword_miss` 会让作者去给节点图条目补触发词——完全错误的方向。
            if is_system_entry(entry):
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
                # 「候选」= 范围解析后真正会被考虑注入的条数。
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
            "description": self.description,
            "cover_image": self.cover_image,
            "entry_order": list(self.entry_order) if self.entry_order is not None else None,
            "entry_groups": copy.deepcopy(self.entry_groups),
            "entry_group_map": dict(self.entry_group_map),
            "entry_layout": self.effective_entry_layout(),
            "categories": copy.deepcopy(self.categories),
            "dependency_edges": copy.deepcopy(self.dependency_edges),
            "import_config": copy.deepcopy(self.import_config),
        }}
        if self.stat_fields:
            extension[EXTENSION_KEY]["stat_fields"] = copy.deepcopy(self.stat_fields)
        if self.character_media:
            extension[EXTENSION_KEY]["character_media"] = copy.deepcopy(self.character_media)
        if self.character_profiles:
            extension[EXTENSION_KEY]["character_profiles"] = copy.deepcopy(self.character_profiles)
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


def apply_auto_classification(book: WorldBook):
    """按条目自带的可信元数据重建分类与角色关联。

    只改「条目属于哪一类」和随之而来的角色关联，**不碰载入模式、固定导入与依赖策略**。
    调用方负责决定时机：`from_dict` 只在分类形同未分类时自动调用（用户编辑过的分类不会被
    覆盖），接口则用于用户显式点击「自动分类」。

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

class _BookOverlayView:
    """Expose one book's snapshot to the existing per-book matching code."""

    def __init__(self, overlay, book_id):
        self.overlay = overlay
        self.book_id = book_id

    def get_worldbook_scope(self):
        return self.overlay.get_worldbook_scope(self.book_id) if self.overlay else None

    def set_worldbook_scope(self, scope):
        if self.overlay:
            self.overlay.set_worldbook_scope(scope, self.book_id)

    def get_active_lore_scope(self):
        scope = self.overlay.get_active_lore_scope() if self.overlay else None
        return scope if scope and scope.get("book_id") == self.book_id else None


class WorldBookBundle:
    """Independent books, combined only after each book applies its own scope."""

    def __init__(self, books):
        self.books = books
        self.id = books[0].id
        self.name = "、".join(book.name for book in books)
        self.source = "imported" if any(book.source == "imported" for book in books) else books[0].source
        self.stat_fields = books[0].stat_fields

    def eligible_uids_for(self, overlay):
        return {book.id: book.eligible_uids_for(_BookOverlayView(overlay, book.id))
                for book in self.books}

    def collect_matches(self, recent_text, current_input, *, eligible_uids=None):
        return {book.id: book.collect_matches(
            recent_text, current_input,
            eligible_uids=(eligible_uids or {}).get(book.id)) for book in self.books}

    def format_injection(self, matched, *, identity="", active_char=None):
        before, after = [], []
        for book in self.books:
            head, tail = book.format_injection(matched.get(book.id, []),
                                               identity=identity, active_char=active_char)
            if head:
                before.append(head)
            if tail:
                after.append(tail)
        return "\n\n".join(before), "\n\n".join(after)


class WorldBookManager:
    """世界书存储管理器：统一管理 data/worldbooks/（全部可写）。

    整合包（Content Pack）机制：
    - data/worldbooks/packs/<id>.json 是可选分发源，启动不安装。
    - 用户显式安装后复制到 data/worldbooks/books/<id>/book.json（source=preinstalled），
      与用户导入的书在同一列表、同一套规则下管理（启用/停用、编辑、删除、重装）。
    - 预装包被删除后，可通过 reinstall_book() 从分发源一键重装还原。

    绑定解析规则：只解析会话 overlay 明确绑定且已启用的剧情世界书；无绑定时返回 None。
    """

    def __init__(self, data_dir: Path | str = None):
        self._dir = Path(data_dir) if data_dir else _WORLDBOOKS_DIR
        self._dir.mkdir(parents=True, exist_ok=True)
        self._books_dir = self._dir / "books"
        self._books_dir.mkdir(exist_ok=True)
        self._packs_dir = _PACKS_DIR
        self._cache: dict[str, WorldBook] = {}
        # 按书锁：覆盖「读修订 → 校验 → 提交」整段，避免原子替换仍然丢更新。
        self._book_locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        # 分发包是可选导入源；启动时不安装任何世界观内容。

    def book_lock(self, book_id: str) -> threading.RLock:
        """取这本书的写锁（可重入）。同一本书的读-改-写必须整体持锁。"""
        with self._locks_guard:
            lock = self._book_locks.get(book_id)
            if lock is None:
                lock = threading.RLock()
                self._book_locks[book_id] = lock
            return lock

    # ── 整合包安装 ──

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
        self._cache.pop(payload["id"], None)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def is_preinstalled(self, book_id: str) -> bool:
        """该书是否存在分发源（可一键重装）。"""
        return (self._packs_dir / f"{book_id}.json").is_file()

    # ── 路径 ──

    def _path(self, book_id: str) -> Path:
        """Self-contained book metadata path."""
        if (not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", book_id)
                or book_id in {"settings", "content_manifest"}
                or book_id.upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(10)],
                                       *[f"LPT{i}" for i in range(10)]}):
            raise ValueError("非法世界书 ID")
        return self._books_dir / book_id / "book.json"

    def _installed_path(self, book_id: str) -> Path:
        """Installed book location for callers that need to inspect its file."""
        current = self._path(book_id)
        if current.parent.is_symlink():
            raise ValueError("世界书文件夹不能是符号链接")
        return current

    def _id_exists(self, book_id: str) -> bool:
        folder = self._path(book_id).parent
        return folder.exists() or folder.is_symlink()

    def _book_paths(self) -> list[Path]:
        paths = [folder / "book.json" for folder in self._books_dir.iterdir()
                 if folder.is_dir() and not folder.is_symlink() and
                 re.fullmatch(r"[A-Za-z0-9_-]{1,64}", folder.name) and
                 (folder / "book.json").is_file()]
        return sorted(paths, key=lambda path: path.stat().st_mtime, reverse=True)

    def _pack_path(self, book_id: str) -> Path:
        """整合包分发源路径。"""
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", book_id):
            raise ValueError("非法世界书 ID")
        return self._packs_dir / f"{book_id}.json"

    # ── CRUD ──

    def list_books(self) -> list[dict]:
        """列出所有书（统一列表）：预装包在前，导入书按创建时间倒序。"""
        # Copied folders can change without passing through this manager.
        self._cache.clear()
        books = []

        preinstalled = []
        imported = []
        for path in self._book_paths():
            try:
                book = self.load(path.parent.name)
            except Exception as e:
                logger.warning("加载世界书 %s 失败: %s", path.name, e)
                continue
            summary = self._summary(book)
            (preinstalled if book.source == SOURCE_PREINSTALLED else imported).append(summary)

        # 预装包固定顺序在前（与分发源顺序一致），导入书按时间倒序
        preinstalled.sort(key=lambda s: s["name"])
        books.extend(preinstalled)
        books.extend(imported)
        return books

    def _summary(self, book: "WorldBook") -> dict:
        stats = book.entry_stats()
        return {
            "id": book.id,
            "name": book.name,
            "description": book.description,
            "cover_image": book.cover_image,
            "source_format": book.source_format,
            "source": book.source,
            "book_type": book.book_type,
            "is_reference": book.is_reference,
            "is_preinstalled": self.is_preinstalled(book.id),
            "enabled": book.enabled,
            "budget_tokens": book.budget_tokens,
            "estimated_tokens": stats.tokens,
            # 书内角色花名册：新建会话按它取「这本书的角色」（候选 + 自动选中），
            # 不能拿角色卡的来源书当名单（拆分剧情书的形态，见 character_ids 的说明）。
            "character_ids": book.character_ids(),
            "injectable_entry_count": stats.injectable,
            "disabled_entry_count": stats.disabled,
            "system_entry_count": stats.system,
            "edit_revision": book.edit_revision,
            "entry_count": stats.total,
            "created_at": book.created_at,
            "updated_at": book.updated_at,
        }

    def load(self, book_id: str) -> Optional[WorldBook]:
        path = self._installed_path(book_id)
        if not path.is_file():
            self._cache.pop(book_id, None)
            return None
        if book_id in self._cache:
            return self._cache[book_id]
        validate_folder(path.parent)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        book = WorldBook.from_dict(data)
        if book.id != book_id:
            raise ValueError("世界书文件名与内部 ID 不一致")
        if self.is_preinstalled(book_id):
            # 有分发源的书一律视为预装包安装副本（防旧数据缺字段）
            book.source = SOURCE_PREINSTALLED
        self._cache[book_id] = book
        return book

    def save(self, book: WorldBook):
        """统一保存（预装包安装副本与导入书同样可写）。"""
        target = self._path(book.id)
        if target.parent.exists() and not target.is_file():
            raise FileExistsError(f"世界书文件夹已存在但没有 book.json：{target.parent}")
        if target.is_file():
            validate_folder(target.parent)
        book.bump_edit_revision()
        book.updated_at = time.time()
        payload = book.to_dict()
        if target.parent.is_symlink():
            raise ValueError("世界书文件夹不能是符号链接")
        if target.parent.exists() and not target.parent.is_dir():
            raise ValueError("世界书文件夹路径已被文件占用")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                             prefix=".worldbook-", suffix=".tmp", delete=False) as f:
                temporary = Path(f.name)
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.write("\n")
            temporary.replace(target)
            if book.entry_layout is not None:
                book.entry_layout = payload["entry_layout"]
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
            # 标准 SillyTavern 格式没有项目用途字段，导入后默认作为剧情世界书。
            resolved_type = DEFAULT_BOOK_TYPE
        # SillyTavern v1/v2/角色卡只是外部传输格式；进入项目后立即规范为内部 v3。
        # 没有项目扩展时，每个条目作为 always+none 起点，保持关键词触发语义。
        book = WorldBook(uuid.uuid4().hex[:12], name or "导入的世界书", entries,
                         source_format=report.source_format, book_type=resolved_type)
        if extension:
            book.description = str(extension.get("description", "") or "")
            book.cover_image = str(extension.get("cover_image", "") or "")
            book.character_media = normalize_character_media(extension.get("character_media"))
            book.character_profiles = normalize_character_profiles(extension.get("character_profiles"))
            book.stat_fields = normalize_stat_fields(extension.get("stat_fields"))
            requested_order = extension.get("entry_order")
            imported_group_map = extension.get("entry_group_map", {})
            if isinstance(imported_group_map, dict):
                known_uids = {entry.uid for entry in entries}
                imported_group_map = {uid: group_id for uid, group_id in imported_group_map.items()
                                      if uid in known_uids}
            book.entry_groups, book.entry_group_map = validate_entry_groups(
                extension.get("entry_groups", []), imported_group_map,
                {entry.uid for entry in entries})
            if isinstance(requested_order, list):
                ordered = [str(uid) for uid in requested_order]
                known = {entry.uid for entry in entries}
                if (len(ordered) == len(known) and len(set(ordered)) == len(ordered)
                        and set(ordered) == known):
                    book.entry_order = ordered
            if "entry_layout" in extension:
                requested_layout = extension["entry_layout"]
                if requested_layout is not None:
                    book.entry_layout = normalize_entry_layout(
                        requested_layout, book.entry_groups, book.entry_group_map,
                        book.effective_entry_order())
            book.categories = validate_categories(extension.get("categories", []))
            if any(e.category_id not in {c["id"] for c in book.categories} for e in entries):
                raise ValueError("导入的条目引用了不存在的分类")
            config = extension.get("import_config")
            if isinstance(config, dict):
                book.import_config = book._normalize_import_config(config)
            # 只回灌当前项目扩展；旧内部 schema 当作普通 SillyTavern 书规范化。
            rules = extension.get("dependency_rules")
            if extension.get("schema_version") == SCHEMA_VERSION_V3 and isinstance(rules, dict):
                if extension.get("scope_mode", "selective") != "selective":
                    raise ValueError("导入的项目扩展仅支持 selective 范围模式")
                book.dependency_rules, book.dependency_edges, book.related_edges = (
                    validate_v3_rules({e.uid for e in entries}, {
                        **rules, "requires_edges": extension.get("dependency_edges", []),
                        "related_edges": extension.get("related_edges", []),
                    }))
                book.policy_revisions = book._normalize_revisions(extension.get("policy_revisions"))
        # Imported books receive new IDs; give bundled characters matching new
        # private IDs too, so an existing global character is never overwritten.
        replacements = {old_id: copied_character_id(old_id, book.id)
                        for old_id in book.character_profiles}
        if len(set(replacements.values())) != len(replacements):
            raise ValueError("导入的角色副本 ID 冲突")
        book.character_profiles = {replacements[key]: value
                                   for key, value in book.character_profiles.items()}
        book.character_media = normalize_character_media({
            replacements.get(key, key): value for key, value in book.character_media.items()})
        for entry in book.entries:
            entry.character_id = replacements.get(entry.character_id, entry.character_id)
        target_folder = self._path(book.id).parent
        try:
            self.save(book)
            for character_id, profile in book.character_profiles.items():
                materialize_character(
                    character_id, book.id, profile,
                    book.character_media.get(character_id, {}), book_folder=target_folder)
            validate_folder(target_folder)
        except Exception:
            self._cache.pop(book.id, None)
            if target_folder.exists() and target_folder.parent == self._books_dir:
                shutil.rmtree(target_folder)
            raise
        return book, report

    def duplicate_book(self, book_id: str, new_name: str = None) -> WorldBook:
        """复制任意书为新的导入书（做变体/备份）。"""
        book = self.load(book_id)
        if not book:
            raise ValueError("世界书不存在")
        source_file = self._installed_path(book_id)
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
            description=book.description,
            cover_image=book.cover_image,
            entry_order=copy.deepcopy(book.entry_order),
            entry_groups=copy.deepcopy(book.entry_groups),
            entry_group_map=dict(book.entry_group_map),
            entry_layout=copy.deepcopy(book.entry_layout),
            stat_fields=copy.deepcopy(book.stat_fields),
            character_media=copy.deepcopy(book.character_media),
            character_profiles=copy.deepcopy(book.character_profiles),
        )
        new_book.created_at = time.time()
        new_book.updated_at = time.time()
        replacements = {old_id: copied_character_id(old_id, new_id)
                        for old_id in new_book.character_profiles}
        new_book.character_profiles = {replacements[key]: value
                                       for key, value in new_book.character_profiles.items()}
        new_book.character_media = normalize_character_media({
            replacements.get(key, key): value for key, value in new_book.character_media.items()})
        for entry in new_book.entries:
            entry.character_id = replacements.get(entry.character_id, entry.character_id)
        target_folder = self._path(new_id).parent
        try:
            self.save(new_book)
            if source_file.name == "book.json":
                validate_folder(source_file.parent)
                for resource in source_file.parent.rglob("*"):
                    if not resource.is_file() or resource == source_file:
                        continue
                    relative = resource.relative_to(source_file.parent)
                    if (len(relative.parts) >= 2 and relative.parts[0] == "characters"
                            and relative.parts[1] in replacements):
                        continue
                    destination = target_folder / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(resource, destination)
            for character_id, profile in new_book.character_profiles.items():
                materialize_character(
                    character_id, new_id, profile,
                    new_book.character_media.get(character_id, {}), book_folder=target_folder)
            validate_folder(target_folder)
        except Exception:
            self._cache.pop(new_id, None)
            if target_folder.exists() and target_folder.parent == self._books_dir:
                shutil.rmtree(target_folder)
            raise
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
        target = self._path(book_id).parent
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise ValueError("世界书目标文件夹不可用")
        # Distribution packs still ship their resources in the legacy content
        # tree. Materialize those owned files in the book before exposing it.
        resources = _source_resources(book_id, self._dir, self._dir / "content")
        temporary = self._books_dir / f".install-{uuid.uuid4().hex}"
        backup = self._books_dir / f".reinstall-{uuid.uuid4().hex}"
        temporary.mkdir()
        moved_old = False
        try:
            self._write_pack(temporary / "book.json", data, _pack_rev(data))
            for name, resource in resources:
                relative = _relative(name)
                if relative.as_posix() == "book.json":
                    raise ValueError("内容资源不能覆盖世界书元数据")
                _no_links(resource, self._dir / "content")
                destination = temporary.joinpath(*relative.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(resource, destination)
            WorldBook.from_dict(validate_folder(temporary, expected_id=book_id))
            with self.book_lock(book_id):
                if target.exists():
                    target.rename(backup)
                    moved_old = True
                try:
                    temporary.rename(target)
                except Exception:
                    if moved_old:
                        backup.rename(target)
                        moved_old = False
                    raise
                self._cache.pop(book_id, None)
            book = self.load(book_id)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
            if moved_old and backup.exists():
                shutil.rmtree(backup)
        logger.info("已重装预装整合包: %s (%s)", book.name, book_id)
        return book

    def list_available_packs(self) -> list[dict]:
        """列出离线内容包，并只读检查同名安装副本是否符合当前 schema。"""
        result = []
        if not self._packs_dir.is_dir():
            return result
        for path in sorted(self._packs_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                logger.warning("忽略无法解析的内容包 %s", path.name)
                continue
            if not isinstance(data, dict) or data.get("id") != path.stem:
                continue
            installed_path = self._installed_path(path.stem)
            repair_required = False
            installed = installed_path.is_file()
            if installed:
                installed_data = self._read_json(installed_path)
                try:
                    if installed_data is None:
                        raise ValueError("安装副本不是 JSON 对象")
                    WorldBook.from_dict(installed_data)
                except (KeyError, TypeError, ValueError):
                    # 旧内部 schema 不再进入运行时；在示例页提供一次显式修复入口。
                    installed = False
                    repair_required = True
            result.append({"id": path.stem, "name": data.get("name", path.stem),
                           "description": data.get("description", ""),
                           "book_type": data.get("book_type", DEFAULT_BOOK_TYPE),
                           "entry_count": len(data.get("entries") or []),
                           "installed": installed,
                           "repair_required": repair_required})
        return result

    def install_pack(self, book_id: str) -> WorldBook:
        """显式安装内容包；不符合当前 schema 的同名副本先备份再修复。"""
        target = self._installed_path(book_id)
        if target.exists():
            try:
                installed_data = self._read_json(target)
                if installed_data is None:
                    raise ValueError("安装副本不是 JSON 对象")
                WorldBook.from_dict(installed_data)
            except (KeyError, TypeError, ValueError):
                backup = self._dir / f"{book_id}.unsupported-schema-{uuid.uuid4().hex[:8]}.bak"
                shutil.copy2(target, backup)
                logger.warning("旧内部 schema 已备份到 %s，准备从当前内容包重装", backup)
            else:
                raise ValueError("世界书已经安装；如需恢复出厂内容请使用重装")
        return self.reinstall_book(book_id)

    def delete_book(self, book_id: str) -> bool:
        """卸载自包含书文件夹；分发源仍可供再次导入。"""
        book = self.load(book_id)
        if book is None:
            return False
        folder = self._path(book_id).parent
        # Move the complete installation out of the bookshelf before cleanup.
        staging = self._dir / f".uninstall-{book_id}-{uuid.uuid4().hex[:8]}"
        if not staging.resolve().is_relative_to(self._dir.resolve()):
            raise ValueError("资源卸载路径无效")
        try:
            folder.rename(staging)
        except OSError:
            logger.exception("世界书文件夹卸载失败: %s", folder)
            raise
        self._cache.pop(book_id, None)
        if staging.exists():
            try:
                shutil.rmtree(staging)
            except OSError:
                logger.exception("世界书已卸载，文件夹清理待重试: %s", staging)
        logger.info("已删除世界书: %s", book_id)
        return True

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
        results = []
        paths = self._book_paths()
        for path in paths:
            try:
                book = self.load(path.parent.name)
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
                "book": self._summary(book),
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
        prepared: list[WorldBookEntry] = []
        media_to_copy: dict[str, dict[str, str]] = {}
        profiles_to_copy: dict[str, str] = {}
        warnings: list[str] = []

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
            built = _build_excerpt_entry(target, source_book, source_entry, raw, index)
            prepared.append(built)
            if built.character_id:
                source_character_id = built.character_id
                copied = (source_book.character_media.get(source_character_id)
                          or snapshot_character_media(source_character_id, source_book_id))
                profile = (source_book.character_profiles.get(source_character_id)
                           or snapshot_character_profile(source_character_id, source_book_id))
                if profile:
                    built.character_id = copied_character_id(source_character_id, target.id)
                    existing_profile = target.character_profiles.get(built.character_id)
                    if existing_profile is not None and existing_profile != profile:
                        raise ValueError(f"角色「{source_character_id}」在目标书已有不同的角色资料")
                    if (built.character_id in profiles_to_copy
                            and profiles_to_copy[built.character_id] != profile):
                        raise ValueError(f"本批次角色「{source_character_id}」的角色资料不一致")
                    profiles_to_copy[built.character_id] = profile
                else:
                    warnings.append(f"角色「{source_character_id}」没有可复制的角色资料，仍引用原角色")
                if not copied:
                    warnings.append(f"角色「{source_character_id}」没有可复制的头像或立绘")
                elif (built.character_id in target.character_media
                      and target.character_media[built.character_id] != copied):
                    raise ValueError(f"角色「{source_character_id}」在目标书已有不同的形象资源，请先处理冲突")
                elif (built.character_id in media_to_copy
                      and media_to_copy[built.character_id] != copied):
                    raise ValueError(f"本批次角色「{source_character_id}」的形象资源不一致")
                else:
                    if copied:
                        media_to_copy[built.character_id] = copied

        # ── 到这里为止都还没写盘：任一条不合法都已抛出 ──
        #
        # **在独立副本上完成变更**：`load()` 返回的是内存缓存对象本身，如果直接往它
        # 上面 append 再 save，而 save 在临时文件写入/替换时抛错（磁盘没变），缓存里
        # 却已经多了条目、revision 也更了 —— 不满足「失败不留半成品」。所以在副本上
        # 组装，`save()` 成功之后才让缓存指向新对象；失败则缓存与磁盘都保持原值。
        staged = copy.deepcopy(target)
        staged.character_media = normalize_character_media(
            {**staged.character_media, **media_to_copy})
        staged.character_profiles = normalize_character_profiles(
            {**staged.character_profiles, **profiles_to_copy})
        created = []
        for built in prepared:
            staged.entries.append(built)
            if staged.entry_order is not None:
                staged.entry_order.append(built.uid)
            created.append(built)
        staged.import_config["revision"] = staged.import_config.get("revision", 1) + 1
        created_paths = []
        try:
            for character_id, profile in profiles_to_copy.items():
                if character_id not in target.character_profiles:
                    created_paths.append(materialize_character(
                        character_id, target.id, profile,
                        staged.character_media.get(character_id, {}),
                        book_folder=self._path(target.id).parent))
            self.save(staged)
        except Exception:
            for path in created_paths:
                shutil.rmtree(path)
            raise

        return {
            "entries": [e.to_dict() for e in created],
            "target": self._summary(staged),
            "revision": staged.import_config["revision"],
            "warnings": warnings,
        }

    # ── 会话绑定解析 ──

    def resolve(self, overlay=None) -> Optional[WorldBook]:
        """解析会话明确绑定、已安装且启用的剧情世界书。

        **资料库（book_type=reference）在这里被无条件排除**；资料库只供浏览、
        检索与摘录。接口层会拒绝绑定，这里的判断继续作为防御性约束。

        Args:
            overlay: SessionOverlay 实例（可空）。
        """
        if overlay is None:
            return None
        ids = overlay.get_worldbook_ids()
        books = []
        for book_id in ids:
            try:
                book = self.load(book_id)
            except Exception:
                logger.warning("加载会话世界书 %s 失败", book_id, exc_info=True)
                continue
            if book and book.enabled and not book.is_reference:
                books.append(book)
        return WorldBookBundle(books) if len(books) > 1 else (books[0] if books else None)

    def character_media_for_session(self, overlay, character_id: str,
                                    kind: str) -> str | None:
        """Find a copied image in bound books, honoring their binding order."""
        if not overlay or kind not in ("avatar", "skin", "card_face"):
            return None
        ids = overlay.get_worldbook_ids()
        for book_id in ids:
            book = self.load(book_id)
            if book and book.enabled and not book.is_reference:
                images = book.character_media.get(character_id, {})
                image = images.get(kind)
                if not image and kind == "card_face":
                    image = images.get("skin") or images.get("avatar")
                if image:
                    return image
        return None
