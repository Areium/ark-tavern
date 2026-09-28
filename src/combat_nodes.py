"""战斗节点注册表：JSON 读写、校验、剧情节拍绑定与世界书编解码。

战斗节点是"一场战斗"的唯一真相源（`data/combat/nodes/<node_id>.json`）：

- **地图**：`map.{rows,cols,tiles,tile_defs,deploy}`（校验见 `combat_map.resolve_map`）
- **敌人**：`waves[].enemies[]`（`enemy`/`count`/`positions`/可选 `stats` 数值覆盖），
  或 `enemies_def` 内联定义（节点自包含，随世界书一起搬家）
- **归属**：`worldbook_id` —— 节点归属于某本世界书（编辑器按书筛选，世界书
  导入的节点自动带上归属）
- **绑定**：`bind.{plot_id,chapter_id,beat_id}` —— 剧情节拍里用 `[COMBAT:<node_id>]` 引用
- **世界书**：节点可编码为一条世界书条目（```json combat-node 围栏块），
  导入世界书即落地为节点文件，导出时从注册表回灌

剧情流程（`plot_flows`）：解析 `data/plots/<plot_id>/index.md` 的章节/节拍结构与
`[COMBAT:<node_id>]` 引用，作为节点图里"剧情节点"的数据源；剧情文件 frontmatter
可选 `worldbook_id` 标注归属。没有 `## 章节 N` 骨架的护栏式剧情（`## 第N幕：`，
如彼岸双生）改用参考大纲（`story_outline`：书内已生成的 LLM 大纲 > 启发式切幕），
与会话创建时的节拍骨架口径一致。

写盘走 `compute_json_hash` 冲突检测（409），与卡牌编辑一致。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from data_paths import CONTENT_ROOT
from content_scope import is_content_visible
from worldbook_content import book_directory, category_roots, enabled_book_ids, resolve_content

from combat_map import MapError, resolve_map
from shared.json_hash import compute_json_hash

logger = logging.getLogger(__name__)

NODE_DIR = CONTENT_ROOT / "combat" / "nodes"
TILES_DIR = CONTENT_ROOT / "combat" / "tiles"
PLOT_DIR = CONTENT_ROOT / "plots"
_DEFAULT_NODE_DIR = NODE_DIR
_DEFAULT_PLOT_DIR = PLOT_DIR


def _visible(path: Path) -> bool:
    """Use the manifest for runtime content, not isolated test registries."""
    if ((NODE_DIR != _DEFAULT_NODE_DIR and path.is_relative_to(NODE_DIR))
            or (PLOT_DIR != _DEFAULT_PLOT_DIR and path.is_relative_to(PLOT_DIR))):
        return True
    return is_content_visible(path)

TEMPLATE_STEM = "TEMPLATE_node"

# 规模上限（与 combat_map 的尺寸上限配套，防止一屏塞几百个单位）
MAX_WAVES = 6
MAX_UNITS_PER_WAVE = 12
MAX_TOTAL_UNITS = 48

# 世界书条目承载战斗节点时的围栏标记
WORLD_BOOK_FENCE = "combat-node"
_ENTRY_TYPE = "combat_node"
_EXT_NAMESPACE = "arknights_tavern"
_FENCE_RE = re.compile(r"```json\s+combat-node\s*\n(.*?)\n```", re.DOTALL)


class NodeError(ValueError):
    """节点校验失败（`errors` 为可读原因列表）。"""

    def __init__(self, errors: list[str] | str):
        if isinstance(errors, str):
            errors = [errors]
        self.errors = list(errors)
        super().__init__("；".join(self.errors))


class NodeConflictError(NodeError):
    """`_hash` 不匹配：文件已被其他进程/窗口修改，拒绝覆盖。"""


# ── 路径与读取 ──

def node_path(node_id: str, *, book_id: str | None = None) -> Path:
    if book_id:
        if book_id in enabled_book_ids():
            return book_directory(book_id) / "combat" / "nodes" / f"{node_id}.json"
        if (book_directory(book_id) / "book.json").is_file():
            raise NodeError("节点所属世界书未安装或已停用")
    return NODE_DIR / f"{node_id}.json"


def node_exists(node_id: str, *, book_id: str | None = None,
                book_ids: list[str] | None = None) -> bool:
    return _read_path(node_id, book_id=book_id, book_ids=book_ids) is not None


def _read_path(node_id: str, *, book_id: str | None = None,
               book_ids: list[str] | None = None) -> Path | None:
    if book_id is not None and book_ids is not None:
        raise ValueError("Specify book_id or book_ids")
    selected = [book_id] if book_id is not None else book_ids
    if NODE_DIR != _DEFAULT_NODE_DIR:
        path = node_path(node_id)
        return path if path.is_file() and _visible(path) else None
    return resolve_content(f"combat/nodes/{node_id}.json", book_ids=selected)


def load_node_file(node_id: str, *, book_id: str | None = None,
                   book_ids: list[str] | None = None) -> dict | None:
    """直接读节点文件（不经过 loader 的别名索引，编辑器保存前校验用）。"""
    path = _read_path(node_id, book_id=book_id, book_ids=book_ids)
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise NodeError(f"节点文件解析失败 {path.name}: {e}") from e
    data.setdefault("node_id", path.stem)
    return data


def list_node_files(*, book_id: str | None = None,
                    book_ids: list[str] | None = None) -> list[Path]:
    if book_id is not None and book_ids is not None:
        raise ValueError("Specify book_id or book_ids")
    selected = [book_id] if book_id is not None else book_ids
    roots = [(None, NODE_DIR)] if NODE_DIR != _DEFAULT_NODE_DIR else [
        (owner, root / "nodes") for owner, root in category_roots("combat", book_ids=selected)]
    files: dict[str, Path] = {}
    for owner, root in roots:
        for path in sorted(root.glob("*.json")):
            visible = (_visible(path) if NODE_DIR != _DEFAULT_NODE_DIR else
                       is_content_visible(path, allowed_book_ids=selected))
            if not path.stem.upper().startswith("TEMPLATE") and visible:
                files.setdefault(path.stem, path)
    return list(files.values())


def template_data() -> dict:
    """模板节点（新建时的默认骨架）；模板缺失时给内置最小骨架。"""
    path = NODE_DIR / f"{TEMPLATE_STEM}.json"
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data.pop("_hash", None)
            return data
        except (OSError, ValueError):
            logger.warning("模板节点解析失败，使用内置骨架: %s", path)
    return {
        "schema_version": 1,
        "node_id": "",
        "name": "",
        "summary": "",
        "bind": {"plot_id": "", "chapter_id": "", "beat_id": ""},
        "rules": {"range_metric": "manhattan", "allow_corner_cut": False},
        "map": {
            "rows": 7, "cols": 7, "tiles": "ground",
            "deploy": {"player": {"rect": [3, 0, 5, 1]},
                       "enemy": {"rect": [3, 5, 5, 6]}},
        },
        "waves": [{"enemies": []}],
        "conditions": {"max_rounds": 8, "escape_enabled": True},
        "rewards": {"xp": 0, "items": [], "unlock": []},
        "difficulty": {"category": "test", "encounter_type": "normal",
                       "band": "T1", "threat_budget": 0, "target_rounds": 4},
        "balance_version": 1,
    }


# ── 校验 ──

def validate_node(data: dict, *, enemy_names: set[str] | None = None,
                  include_balance: bool = True) -> dict:
    """校验节点规格。

    返回 `{"errors": [...], "warnings": [...], "metrics": {...}}`；不抛异常，
    便于编辑器实时提示。`metrics.threat` 为威胁/预算/阶段带对照（设计者调难度用）。
    """
    errors: list[str] = []
    warnings: list[str] = []
    metrics: dict = {}
    data = data or {}

    node_id = str(data.get("node_id") or "").strip()
    if not node_id:
        errors.append("缺少 node_id")
    elif not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff-]{1,64}", node_id):
        errors.append(f"node_id '{node_id}' 含非法字符（允许中英文/数字/下划线/连字符）")
    if not str(data.get("name") or "").strip():
        errors.append("缺少 name")

    # 地图（尺寸/格子/部署区/软锁）
    try:
        owner = str(data.get("worldbook_id") or "")
        tiles_dir = (book_directory(owner) / "combat" / "tiles"
                     if owner and owner in enabled_book_ids() else TILES_DIR)
        battle_map = resolve_map(data.get("map"), tiles_dir=tiles_dir)
        warnings.extend(battle_map.warnings)
    except MapError as e:
        battle_map = None
        errors.extend(e.errors)

    inline_enemies = set((data.get("enemies_def") or {}).keys())
    known = set(enemy_names or set()) | inline_enemies

    waves = data.get("waves") or []
    if not isinstance(waves, list) or not waves:
        errors.append("至少需要 1 个波次（waves）")
        waves = []
    if len(waves) > MAX_WAVES:
        errors.append(f"波次数 {len(waves)} 超过上限 {MAX_WAVES}")

    total_units = 0
    for wi, wave in enumerate(waves):
        entries = (wave or {}).get("enemies")
        if not isinstance(entries, list):
            errors.append(f"wave[{wi}] 缺少 enemies 数组")
            continue
        units = 0
        used_positions: set[tuple[int, int]] = set()
        for ei, entry in enumerate(entries):
            if not isinstance(entry, dict):
                errors.append(f"wave[{wi}].enemies[{ei}] 不是对象")
                continue
            name = str(entry.get("enemy") or entry.get("name") or "").strip()
            label = f"wave[{wi}].enemies[{ei}]"
            if not name:
                errors.append(f"{label} 缺少 enemy 名称")
                continue
            if known and name not in known:
                errors.append(f"{label} 引用了未知敌人 '{name}'（既不在地图词典也不在 enemies_def）")
            try:
                count = int(entry.get("count", 1) or 1)
            except (TypeError, ValueError):
                errors.append(f"{label}.count 非整数")
                continue
            if not 1 <= count <= MAX_UNITS_PER_WAVE:
                errors.append(f"{label}.count {count} 超出 1..{MAX_UNITS_PER_WAVE}")
            units += count

            positions = entry.get("positions") or []
            if positions and len(positions) != count:
                warnings.append(f"{label} 站位 {len(positions)} 个与数量 {count} 不符，缺的会自动落位")
            if battle_map:
                for pos in positions:
                    try:
                        cell = (int(pos[0]), int(pos[1]))
                    except (TypeError, ValueError, IndexError):
                        errors.append(f"{label} 站位 {pos} 非法")
                        continue
                    if not battle_map.in_bounds(cell):
                        errors.append(f"{label} 站位 {cell} 越界（地图 {battle_map.rows}×{battle_map.cols}）")
                    elif battle_map.is_blocked(cell):
                        errors.append(f"{label} 站位 {cell} 落在不可通行格")
                    elif cell in used_positions:
                        warnings.append(f"{label} 站位 {cell} 与同波次其它单位重复，会顺延落位")
                    used_positions.add(cell)
            stats = entry.get("stats") or entry.get("combat_stats")
            if stats is not None and not isinstance(stats, dict):
                errors.append(f"{label}.stats 应为对象（数值覆盖）")
        if units > MAX_UNITS_PER_WAVE:
            errors.append(f"wave[{wi}] 单位数 {units} 超过上限 {MAX_UNITS_PER_WAVE}")
        total_units += units

    if total_units == 0 and not errors:
        errors.append("没有任何敌人：至少配置 1 个单位")
    if total_units > MAX_TOTAL_UNITS:
        errors.append(f"敌人总数 {total_units} 超过上限 {MAX_TOTAL_UNITS}")

    conditions = data.get("conditions") or {}
    try:
        max_rounds = int(conditions.get("max_rounds", 0) or 0)
        if max_rounds < 0:
            errors.append("conditions.max_rounds 不能为负")
    except (TypeError, ValueError):
        errors.append("conditions.max_rounds 非整数")

    rewards = data.get("rewards") or {}
    try:
        if int(rewards.get("xp", 0) or 0) < 0:
            errors.append("rewards.xp 不能为负")
    except (TypeError, ValueError):
        errors.append("rewards.xp 非整数")

    difficulty = data.get("difficulty") or {}
    band = str(difficulty.get("band") or "")
    if band and band not in ("T0", "T1", "T2", "T3", "T4"):
        warnings.append(f"difficulty.band '{band}' 不在 T0–T4 之内")

    rules = data.get("rules") or {}
    metric = str(rules.get("range_metric") or "manhattan")
    if metric not in ("manhattan", "chebyshev"):
        warnings.append(f"rules.range_metric '{metric}' 未知，将按 manhattan 处理")

    # 威胁 / 预算 / 阶段带对照（只警告不阻断：设计者可能有意做难关卡）
    if include_balance and not errors:
        try:
            from combat_balance import node_budget_report
            from combat_data_loader import CombatDataLoader
            report = node_budget_report(data, loader=CombatDataLoader())
            warnings.extend(w for w in report.pop("warnings", []) if w not in warnings)
            metrics["threat"] = report
        except Exception as exc:  # 数值模型异常不应阻断结构性校验
            logger.warning("威胁预算计算失败: %s", exc)

    return {"errors": errors, "warnings": warnings, "metrics": metrics}


# ── 写入 ──

def save_node(data: dict, expected_hash: str = "",
              *, enemy_names: set[str] | None = None) -> dict:
    """校验并写入节点（`_hash` 冲突检测）；返回落盘后的节点。"""
    data = dict(data or {})
    node_id = str(data.get("node_id") or "").strip()
    report = validate_node(data, enemy_names=enemy_names)
    if report["errors"]:
        raise NodeError(report["errors"])

    book_id = str(data.get("worldbook_id") or "")
    path = node_path(node_id, book_id=book_id)
    if path.is_file() and path.is_relative_to(NODE_DIR) and not _visible(path):
        raise NodeError("节点所属世界书未安装或已停用")
    if path.is_file():
        current = json.loads(path.read_text(encoding="utf-8"))
        current_hash = str(current.get("_hash") or "")
        if expected_hash and current_hash and expected_hash != current_hash:
            raise NodeConflictError(
                "保存冲突：节点文件已被其他进程/窗口修改，请刷新后重试")

    data.pop("_hash", None)
    data["_hash"] = compute_json_hash(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    logger.info("战斗节点已保存: %s", path.name)
    data["warnings"] = report["warnings"]
    return data


def create_node(node_id: str, name: str = "", *, from_template: bool = True,
                worldbook_id: str = "") -> dict:
    """按模板新建节点（已存在则报错）。

    刻意**不做完整校验**：新建时波次通常是空的，编辑器随后填充；但开战前
    `CombatSession.start` 会拒绝"没有敌人"的节点，因此不会出现空战场。
    """
    node_id = str(node_id or "").strip()
    if not node_id:
        raise NodeError("缺少 node_id")
    if not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff-]{1,64}", node_id):
        raise NodeError(f"node_id '{node_id}' 含非法字符（允许中英文/数字/下划线/连字符）")
    path = node_path(node_id, book_id=worldbook_id)
    if path.is_file():
        raise NodeError(f"节点已存在: {node_id}")
    data = template_data() if from_template else {}
    data.update({"node_id": node_id, "name": name or node_id,
                 "worldbook_id": str(worldbook_id or "")})
    data.setdefault("waves", [{"enemies": []}])

    data.pop("_hash", None)
    data["_hash"] = compute_json_hash(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info("战斗节点已创建: %s", node_id)
    return data


def delete_node(node_id: str, *, force: bool = False, book_id: str | None = None,
                bindings: dict | None = None) -> dict:
    """删除节点。被剧情节拍引用时默认拒绝（避免剧情打不开战斗）。"""
    path = _read_path(node_id, book_id=book_id)
    if path is None:
        raise NodeError(f"节点不存在: {node_id}")
    refs = (bindings if bindings is not None else node_bindings(book_id=book_id)).get(node_id, [])
    if refs and not force:
        where = "、".join(f"{r['plot_id']}/{r.get('beat_id') or '?'}" for r in refs[:3])
        raise NodeError(f"节点被剧情引用（{where}），如需删除请显式确认")
    path.unlink()
    logger.info("战斗节点已删除: %s", node_id)
    return {"deleted": node_id, "referenced_by": refs}


# ── 剧情节拍绑定与进度 ──

def _plot_files(*, book_id: str | None = None,
                book_ids: list[str] | None = None) -> list[tuple[str | None, Path]]:
    if book_id is not None and book_ids is not None:
        raise ValueError("Specify book_id or book_ids")
    selected = [book_id] if book_id else book_ids
    roots = [(None, PLOT_DIR)] if PLOT_DIR != _DEFAULT_PLOT_DIR else category_roots(
        "plots", book_ids=selected)
    files: list[tuple[str | None, Path]] = []
    for owner, root in roots:
        files.extend((owner or book_id, path) for path in sorted(root.glob("*/index.md"))
                     if (_visible(path) if PLOT_DIR != _DEFAULT_PLOT_DIR else
                         is_content_visible(path, allowed_book_ids=selected)))
    return files


def node_bindings(*, book_id: str | None = None,
                  book_ids: list[str] | None = None) -> dict[str, list[dict]]:
    """扫描 plot 文档，返回 node_id → [{plot_id, chapter_id, beat_id}]。"""
    bindings: dict[str, list[dict]] = {}
    for owner, path in _plot_files(book_id=book_id, book_ids=book_ids):
        plot_id = path.parent.name
        chapter_id = ""
        beat_id = ""
        for line in path.read_text(encoding="utf-8").splitlines():
            ch = re.match(r"^## 章节\s*(\d+)[：:]\s*(.+)$", line)
            if ch:
                chapter_id = ""
                beat_id = ""
                continue
            if not chapter_id:
                id_m = re.match(r"^\*\*ID\*\*[：:]\s*`?(\w+)`?", line)
                if id_m:
                    chapter_id = id_m.group(1)
                    continue
            beat_m = re.match(r"^####\s+(beat_\w+)", line)
            if beat_m:
                beat_id = beat_m.group(1)
                continue
            for node_id in re.findall(r"\[COMBAT:([\w-]+)\]", line):
                if node_id == "ID":
                    continue
                bindings.setdefault(node_id, []).append({
                    "plot_id": plot_id,
                    "chapter_id": chapter_id,
                    "beat_id": beat_id,
                    "worldbook_id": owner or "",
                })
    return bindings


def node_progress(session) -> tuple[dict[str, dict], dict]:
    """读取会话的节拍进度，返回 (node_id → 进度, 会话剧情上下文)。

    进度状态：`done`（已完成节拍）/ `current`（当前节拍）/ `locked`（尚未到达）。
    没有剧情或没有节拍状态时返回空字典（编辑器据此只显示"未绑定"）。
    """
    overlay = getattr(session, "overlay", None)
    if overlay is None:
        return {}, {}
    beat_state = overlay.get_beat_state() or {}
    plot_id = overlay.get_plot_id() or ""
    if not plot_id or not beat_state:
        return {}, {"plot_id": plot_id, "chapter_idx": None, "beat_idx": None}

    from session_overlay import parse_narrative_beats  # 复用同一套节拍解析器

    text = overlay._load_narrative_text(plot_id) if hasattr(overlay, "_load_narrative_text") else ""
    chapters = parse_narrative_beats(text) if text else []
    ci = int(beat_state.get("chapter_idx", 0) or 0)
    bi = int(beat_state.get("beat_idx", 0) or 0)
    completed = set(beat_state.get("completed_beats") or [])

    progress: dict[str, dict] = {}
    for chi, chapter in enumerate(chapters):
        for bti, beat in enumerate(chapter.get("beats") or []):
            ids = re.findall(r"\[COMBAT:([\w-]+)\]", beat.get("content", "") or "")
            if not ids:
                continue
            if beat["id"] in completed:
                state = "done"
            elif chi == ci and bti == bi:
                state = "current"
            else:
                state = "locked"
            for node_id in ids:
                if node_id == "ID":
                    continue
                progress[node_id] = {
                    "state": state,
                    "plot_id": plot_id,
                    "chapter_idx": chi + 1,
                    "chapter_id": chapter.get("id", ""),
                    "chapter_title": chapter.get("title", ""),
                    "beat_id": beat["id"],
                    "beat_summary": (beat.get("summary") or "")[:80],
                }
    return progress, {"plot_id": plot_id, "chapter_idx": ci + 1, "beat_idx": bi + 1}


def node_overview(session=None, *, book_id: str | None = None) -> tuple[list[dict], dict]:
    """编辑器用的节点总览：注册表 + 剧情节拍绑定 + 会话进度 + 是否有配置。

    `book_id` 非 None 时只返回归属于该世界书的节点（含其剧情引用的"待创建"
    节点）；None 表示不过滤（全部节点）。
    """
    from combat_data_loader import CombatDataLoader

    loader = CombatDataLoader(book_id=book_id) if book_id else CombatDataLoader()
    bindings = node_bindings(book_id=book_id) if book_id else node_bindings()
    progress, plot_ctx = node_progress(session) if session is not None else ({}, {})
    plot_book = {p["plot_id"]: p.get("worldbook_id", "")
                 for p in (plot_flows(book_id=book_id) if book_id else plot_flows())}

    def _in_book(row: dict) -> bool:
        if book_id is None:
            return True
        if row.get("worldbook_id"):
            return row["worldbook_id"] == book_id
        # 未标注归属的节点：跟随其剧情引用的剧情归属（无剧情引用时归入"未标注"书）
        plots = {m.get("plot_id", "") for m in row.get("markers", [])}
        return any(plot_book.get(pid, "") == book_id for pid in plots) or \
            (not plots and book_id == "")

    rows: list[dict] = []
    seen: set[str] = set()
    for path in (list_node_files(book_id=book_id) if book_id else list_node_files()):
        node = (json.loads(path.read_text(encoding="utf-8"))
                if path.is_file() else load_node_file(path.stem) or {})
        node_id = node.get("node_id", path.stem)
        seen.add(node_id)
        summary = next((n for n in loader.list_nodes() if n["node_id"] == node_id), {})
        row = {
            "node_id": node_id,
            "name": node.get("name", node_id),
            "summary": node.get("summary", ""),
            "rows": (node.get("map") or {}).get("rows"),
            "cols": (node.get("map") or {}).get("cols"),
            "wave_count": len(node.get("waves") or []),
            "unit_total": summary.get("unit_total", 0),
            "bind": node.get("bind") or {},
            "markers": bindings.get(node_id, []),
            "progress": progress.get(node_id),
            "source_worldbook": (node.get("source") or {}).get("book_id", ""),
            "worldbook_id": (book_id if book_id and path.is_file()
                             and path.is_relative_to(book_directory(book_id)) else
                             str(node.get("worldbook_id", "") or "")),
            "hash": node.get("_hash", ""),
        }
        if _in_book(row):
            rows.append(row)

    # 剧情里引用但还没有配置的节点（编辑器应能提示"待创建"）
    for node_id, markers in bindings.items():
        if node_id in seen:
            continue
        row = {
            "node_id": node_id,
            "name": node_id,
            "summary": "",
            "rows": None,
            "cols": None,
            "wave_count": 0,
            "unit_total": 0,
            "bind": markers[0] if markers else {},
            "markers": markers,
            "progress": progress.get(node_id),
            "source_worldbook": "",
            "worldbook_id": "",
            "hash": "",
            "missing": True,
        }
        if _in_book(row):
            rows.append(row)

    rows.sort(key=lambda r: (r.get("missing", False), r["node_id"]))
    return rows, {"plot": plot_ctx, "bindings": len(bindings)}


# ── 剧情流程（节点图的剧情节点数据源） ──

_CHAPTER_RE = re.compile(r"^##\s*章节\s*(\d+)\s*[：:]\s*(.+)$")
_BEAT_RE = re.compile(r"^####\s+(beat_\w+)(（.*）)?\s*$")
_COMBAT_REF_RE = re.compile(r"\[COMBAT:([\w-]+)\]")


def plot_flows(book_mgr=None, *, book_id: str | None = None,
               book_ids: list[str] | None = None) -> list[dict]:
    """解析 data/plots/*/index.md，返回剧情流程（章节 → 节拍 → 战斗引用）。

    每个 plot：`{plot_id, name, summary, worldbook_id, source, combat_nodes, chapters}`；
    chapter：`{idx, id, title, label, kind, combat_nodes, beats}`；beat：`{id, title,
    keep_on_deviate, summary, combat_nodes}`。不在任何 beat 下的 `[COMBAT:]` 引用向上挂到
    chapter / plot 级（如 combat-test 这类没有标准节拍结构的测试剧情）。

    `plot_id` 用目录名（与 `node_bindings`、会话剧情一致）；只收集**剧情叙述区**
    的章节——遇到第一个非章节的 h2 标题（如「关键对话参考」「开场设置」）即停，
    忽略其后的配置区里可能重复出现的章节标题（如 near-light 的场景流程图）。

    `source`：`narrative` = 正文里的 `## 章节 N` 骨架；`outline` = 正文没有骨架，
    章节/节拍来自参考大纲（`book_mgr` 给定且书里存有 LLM 大纲时优先，否则
    `story_outline.heuristic_outline` 确定性切幕；两者都没有则保持无章节）。
    大纲章节的 `kind` 可为 `branch`（续写路线 / 偏离分支），`label` 是展示用标题
    （`第三幕：您已欠费` / `路线 A：回应`），战斗引用取大纲里已物化的
    `combat.node_id` 与节点文件 `bind` 到该节拍的节点。
    """
    import frontmatter

    flows: list[dict] = []
    for owner, path in _plot_files(book_id=book_id, book_ids=book_ids):
        plot_id = path.parent.name
        try:
            md = frontmatter.load(path)
        except Exception as exc:
            logger.warning("剧情文件解析失败 %s: %s", path, exc)
            continue
        meta = md.metadata or {}
        plot: dict = {
            "plot_id": plot_id,
            "name": str(meta.get("name") or meta.get("id") or plot_id),
            "summary": str(meta.get("summary") or "")[:120],
            "worldbook_id": owner or str(meta.get("worldbook_id") or ""),
            "source": "narrative",
            "combat_nodes": [],
            "chapters": [],
        }

        chapter: dict | None = None
        beat: dict | None = None
        narrative_done = False
        seen_refs: set[tuple[int, str]] = set()

        def _bucket() -> list:
            if beat is not None:
                return beat["combat_nodes"]
            if chapter is not None:
                return chapter["combat_nodes"]
            return plot["combat_nodes"]

        def _add_ref(node_id: str) -> None:
            if node_id == "ID":
                return
            bucket = _bucket()
            key = (id(bucket), node_id)
            if key in seen_refs:
                return
            seen_refs.add(key)
            bucket.append(node_id)

        for raw_line in (md.content or "").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            ch = _CHAPTER_RE.match(line)
            if ch:
                idx = int(ch.group(1))
                title = ch.group(2).strip()
                chapter = {"idx": idx, "id": f"ch_{idx}", "title": title,
                           "label": f"章节 {idx}：{title}", "kind": "main",
                           "combat_nodes": [], "beats": []}
                plot["chapters"].append(chapter)
                beat = None
                continue
            if line.startswith("## "):
                # 非章节的 h2：若已进入章节区则剧情叙述区结束；前置区仅重置收集位置
                if plot["chapters"]:
                    narrative_done = True
                chapter = None
                beat = None
                continue
            if narrative_done:
                break
            bt = _BEAT_RE.match(line)
            if bt and chapter is not None:
                beat = {"id": bt.group(1), "title": "",
                        "keep_on_deviate": not (bt.group(2) and "false" in bt.group(2)),
                        "summary": "", "combat_nodes": []}
                chapter["beats"].append(beat)
                continue
            if line.startswith("#"):
                continue  # h1 / beat 正文内的其它层级标题不打断收集
            for node_id in _COMBAT_REF_RE.findall(line):
                _add_ref(node_id)
            if beat is not None and not beat["summary"]:
                text = _COMBAT_REF_RE.sub("", line).strip()
                if text:
                    beat["summary"] = text[:80]

        if not plot["chapters"]:
            outline_chapters = _outline_flow_chapters(
                plot_id, meta, md.content or "", plot["worldbook_id"], book_mgr,
                book_ids=[owner] if owner else book_ids)
            if outline_chapters:
                plot["chapters"] = outline_chapters
                plot["source"] = "outline"

        flows.append(plot)
    return flows


_CN_ORDINAL = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def _cn_ordinal(n: int) -> str:
    if 0 <= n <= 10:
        return _CN_ORDINAL[n]
    if n < 20:
        return "十" + _CN_ORDINAL[n - 10]
    return str(n)


def _outline_chapter_label(chapter: dict, main_idx: int, branch_idx: int) -> str:
    """大纲章节的展示标题：主线按幕计数、分支按路线计数（与护栏式剧情原标题同款）。"""
    title = str(chapter.get("title") or chapter.get("id") or "")
    if chapter.get("kind") == "branch":
        origin = (chapter.get("origin") or {}).get("type")
        prefix = "偏离分支" if origin == "deviation" else "路线"
        mark = chr(ord("A") + branch_idx - 1) if 1 <= branch_idx <= 26 else str(branch_idx)
        return f"{prefix} {mark}：{title}"
    return f"第{_cn_ordinal(main_idx)}幕：{title}"


def _outline_flow_chapters(plot_id: str, meta: dict, body: str, worldbook_id: str,
                           book_mgr, book_ids: list[str] | None = None) -> list[dict]:
    """无节拍骨架的剧情：把参考大纲折算成节点图章节。失败（无法切幕 / 大纲损坏）返回 []。"""
    from story_outline import OutlineError, heuristic_outline, load_outline

    outline: dict | None = None
    if book_mgr is not None and worldbook_id:
        try:
            outline = load_outline(book_mgr, worldbook_id, plot_id)
        except Exception:
            logger.warning("读取剧情 %s 的世界书参考大纲失败，改用启发式切幕", plot_id, exc_info=True)
            outline = None
    if not outline or not outline.get("chapters"):
        try:
            outline = heuristic_outline({**dict(meta or {}), "id": plot_id}, body,
                                        worldbook_id=worldbook_id)
        except OutlineError:
            return []  # 正文既无章节骨架也无「第N幕」：保持无章节（如 combat-test）
        except Exception:
            logger.warning("剧情 %s 启发式切幕失败", plot_id, exc_info=True)
            return []

    # 节点文件 bind 到该剧情节拍的战斗节点（现场生成的节点回填在 bind 里，不在正文）
    bound: dict[str, list[str]] = {}
    for path in (list_node_files(book_ids=book_ids) if book_ids is not None
                 else list_node_files()):
        node = (json.loads(path.read_text(encoding="utf-8"))
                if path.is_file() else load_node_file(path.stem) or {})
        bind = node.get("bind") or {}
        if str(bind.get("plot_id") or "") == plot_id and bind.get("beat_id"):
            bound.setdefault(str(bind["beat_id"]), []).append(str(node.get("node_id") or path.stem))

    chapters: list[dict] = []
    main_idx = branch_idx = 0
    for ch in outline.get("chapters", []):
        if ch.get("kind") == "branch":
            branch_idx += 1
        else:
            main_idx += 1
        beats: list[dict] = []
        for b in ch.get("beats", []):
            combat = b.get("combat") or {}
            refs: list[str] = []
            node_id = str(combat.get("node_id") or "")
            if node_id:
                refs.append(node_id)
            for nid in bound.get(str(b.get("id") or ""), []):
                if nid not in refs:
                    refs.append(nid)
            beats.append({
                "id": str(b.get("id") or ""),
                "title": str(b.get("title") or ""),
                "keep_on_deviate": bool(b.get("must_keep")),
                "summary": str(b.get("summary") or "")[:80],
                "combat_nodes": refs,
            })
        chapters.append({
            "idx": len(chapters) + 1,
            "id": str(ch.get("id") or ""),
            "title": str(ch.get("title") or ""),
            "label": _outline_chapter_label(ch, main_idx, branch_idx),
            "kind": "branch" if ch.get("kind") == "branch" else "main",
            "combat_nodes": [],
            "beats": beats,
        })
    return chapters


def node_graph(book_id: str, session=None, book_mgr=None) -> dict:
    """节点图数据：某本世界书的剧情流程 + 战斗节点总览。

    收录的剧情 = frontmatter 归属该书的剧情 ∪ 被该书节点引用的剧情
    （跨书引用也画出连线，保证图完整）。`book_mgr` 用于读取书内已生成的参考大纲
    （护栏式剧情的章节来源，见 `plot_flows`）。
    """
    rows, meta = node_overview(session, book_id=book_id)
    flows = plot_flows(book_mgr, book_id=book_id)
    referenced_plots = {m.get("plot_id", "") for r in rows for m in r.get("markers", [])}
    referenced_plots |= {str((r.get("bind") or {}).get("plot_id") or "") for r in rows}
    referenced_plots.discard("")

    plots = [f for f in flows
             if f["worldbook_id"] == book_id or f["plot_id"] in referenced_plots]
    return {
        "book_id": book_id,
        "plots": plots,
        "nodes": rows,
        "meta": {**meta, "plot_count": len(plots), "node_count": len(rows)},
    }


# ── 世界书编解码 ──

def encode_node_for_worldbook(node: dict) -> dict:
    """把节点编码为世界书条目（content 围栏块 + raw.extensions 标记）。"""
    payload = {k: v for k, v in (node or {}).items() if k not in ("_hash", "warnings")}
    compact = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    node_id = payload.get("node_id", "")
    name = payload.get("name", node_id)
    lines = [f"```json {WORLD_BOOK_FENCE}", compact, "```"]
    if payload.get("summary"):
        lines += ["", str(payload["summary"])]
    return {
        "uid": f"combat_node_{node_id}",
        "name": f"节点：{name}",
        "content": "\n".join(lines),
        "trigger_keys": [name, node_id],
        "raw": {
            "extensions": {
                _EXT_NAMESPACE: {
                    "entry_type": _ENTRY_TYPE,
                    "node_id": node_id,
                }
            }
        },
    }


def is_combat_node_entry(entry: dict) -> bool:
    """判断世界书条目是否承载战斗节点（extensions 标记或围栏块）。"""
    raw = (entry or {}).get("raw") or {}
    ext = ((raw.get("extensions") or {}).get(_EXT_NAMESPACE) or {})
    if ext.get("entry_type") == _ENTRY_TYPE:
        return True
    if ext.get("node_id") and _FENCE_RE.search(str((entry or {}).get("content") or "")):
        return True
    return bool(_FENCE_RE.search(str((entry or {}).get("content") or "")))


def decode_worldbook_entry(entry: dict) -> dict | None:
    """从世界书条目解出节点规格；不是战斗节点条目则返回 None（不抛错）。"""
    content = str((entry or {}).get("content") or "")
    match = _FENCE_RE.search(content)
    if not match:
        if is_combat_node_entry(entry):
            raise NodeError(f"战斗节点条目 '{entry.get('name', '')}' 缺少 ```json {WORLD_BOOK_FENCE} 代码块")
        return None
    try:
        data = json.loads(match.group(1))
    except ValueError as e:
        raise NodeError(f"战斗节点条目 '{entry.get('name', '')}' 的 JSON 解析失败: {e}") from e
    if not isinstance(data, dict):
        raise NodeError(f"战斗节点条目 '{entry.get('name', '')}' 的内容应为 JSON 对象")
    raw = (entry or {}).get("raw") or {}
    ext = ((raw.get("extensions") or {}).get(_EXT_NAMESPACE) or {})
    if ext.get("node_id"):
        data.setdefault("node_id", ext["node_id"])
    return data


def import_worldbook_nodes(entries: list[dict], *, book_id: str = "",
                           overwrite: bool = True,
                           enemy_names: set[str] | None = None) -> dict:
    """把世界书里的战斗节点条目落地为节点文件。

    返回 `{"imported": [...], "skipped": [...], "errors": [...]}`；
    校验失败的条目不落盘（不产生半成品）。
    """
    imported: list[dict] = []
    skipped: list[str] = []
    errors: list[str] = []

    for entry in entries or []:
        try:
            data = decode_worldbook_entry(entry)
        except NodeError as e:
            errors.extend(e.errors)
            continue
        if data is None:
            continue
        node_id = str(data.get("node_id") or "").strip()
        if not node_id:
            errors.append(f"条目 '{entry.get('name', '')}' 缺少 node_id")
            continue
        data.setdefault("name", entry.get("name", node_id))
        if node_exists(node_id, book_id=book_id or None) and not overwrite:
            skipped.append(node_id)
            continue
        data["source"] = {"type": "worldbook", "book_id": book_id,
                          "entry_uid": entry.get("uid", "")}
        if book_id:
            data["worldbook_id"] = book_id  # 归属随导入世界书自动标注
        try:
            save_node(data, enemy_names=enemy_names)
        except NodeError as e:
            errors.extend(f"{node_id}: {msg}" for msg in e.errors)
            continue
        imported.append({"node_id": node_id, "book_id": book_id})

    return {"imported": imported, "skipped": skipped, "errors": errors}
