"""
CombatDataLoader — 加载战斗节点（JSON）与统一敌人库（`data/enemies/*.md`）。

数据布局（批次 1 起）::

    data/combat/nodes/<node_id>.json   战斗节点：地图/波形/条件/奖励/打法/绑定
    data/combat/tiles/<tile_id>.json   格子类型注册表（可选，内置 ground/wall/cover/...）
    data/enemies/<name>.md             敌人：叙事属性 attributes + 战斗字段 combat_stats
    data/combat/backgrounds/<id>/      战斗背景

敌人既可写绝对 `combat_stats`（设计者直接调血量），也可只写 `attributes`
（引擎按与玩家同一套公式派生战斗数值）。
"""

import json
import logging
import re
from pathlib import Path
from urllib.parse import quote

from data_paths import CONTENT_ROOT
from content_scope import is_content_visible
from worldbook_content import category_roots

import frontmatter

from combat_engine.entity import CombatUnit

logger = logging.getLogger(__name__)

_DATA_DIR = CONTENT_ROOT / "combat"

# 敌人可写字段 → CombatUnit 属性（战斗数值覆盖用）
_ENEMY_STAT_FIELDS = {
    "hp": ("max_hp", "hp"),
    "patk": ("PATK",),
    "matk": ("MATK",),
    "heal": ("HEAL",),
    "defense": ("DEF",),
    "resist": ("RES",),
    "spd": ("SPD",),
    "hit": ("HIT",),
    "eva": ("EVA",),
    "max_ap": ("AP", "MAX_AP"),
}
# 敌人可写字段 → CombatUnit 元数据
_ENEMY_META_FIELDS = (
    "class", "level", "power_tier", "role", "action_slots", "threat_points",
    "ai_behavior", "ai_skills", "drop_items", "drop_rate", "xp_reward",
)


def apply_enemy_overrides(unit: CombatUnit, overrides: dict | None) -> CombatUnit:
    """把（会话/节点级的）敌人覆盖应用到单位实例，返回同一实例。

    `overrides` 可含 `combat_stats` 子字典或直接平铺数值键，
    外加 `class/level/ai_behavior/ai_skills/action_slots/threat_points/...`。
    """
    if not overrides:
        return unit
    stats = dict(overrides.get("combat_stats") or {})
    for key, value in overrides.items():
        if key in _ENEMY_STAT_FIELDS:
            stats[key] = value

    for key, value in stats.items():
        fields = _ENEMY_STAT_FIELDS.get(key)
        if not fields or value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            logger.warning("敌人覆盖 %s=%r 非数值，已忽略", key, value)
            continue
        if key in ("hp",):
            number = int(number)
        for field in fields:
            setattr(unit, field, int(number) if field in ("max_hp", "hp", "DEF", "RES",
                                                          "HIT", "EVA", "AP", "MAX_AP")
                    else number)

    for key in _ENEMY_META_FIELDS:
        if key in overrides and overrides[key] is not None:
            value = overrides[key]
            if key == "class":
                unit.char_class = str(value)
            elif key == "ai_skills":
                unit.ai_skills = list(value or [])
            elif key == "action_slots":
                unit.action_slots = max(0, int(value))
            elif key == "threat_points":
                unit.threat_points = int(value)
            else:
                setattr(unit, key, value if not isinstance(value, str) else value)
    return unit


class CombatDataLoader:
    """加载战斗节点、敌人、格子注册表与背景。"""

    def __init__(self, data_dir: str = "", *, book_id: str | None = None,
                 book_ids: list[str] | None = None, project_root: str | Path | None = None):
        if book_id is not None and book_ids is not None:
            raise ValueError("Specify book_id or book_ids")
        self._root = Path(data_dir) if data_dir else _DATA_DIR
        self._custom_dir = bool(data_dir)
        self._book_ids = [book_id] if book_id is not None else book_ids
        self._project_root = project_root
        self._enemy_dir = self._root.parent / "enemies"
        self._node_dir = self._root / "nodes"
        self._tiles_dir = self._root / "tiles"
        self._node_index_cache: dict | None = None
        self._enemy_cache: dict[str, dict] = {}

    def _visible(self, path: Path) -> bool:
        if self._custom_dir:
            return True
        return is_content_visible(path, project_root=self._project_root,
                                  allowed_book_ids=self._book_ids)

    def _roots(self, category: str) -> list[Path]:
        return [path for _, path in self._owned_roots(category)]

    def _owned_roots(self, category: str) -> list[tuple[str | None, Path]]:
        if self._custom_dir:
            root = self._root if category == "combat" else self._root.parent / category
            return [(None, root)]
        return category_roots(category, book_ids=self._book_ids,
                              project_root=self._project_root)

    def _paths(self, category: str, relative: str) -> list[Path]:
        if self._custom_dir:
            return [self._root.parent / category / relative]
        return [root / relative for root in self._roots(category)]

    # ── Enemy loading ──

    def enemy_path(self, name: str) -> Path:
        paths = self._paths("enemies", f"{name}.md")
        return next((path for path in paths if path.is_file() and self._visible(path)),
                    self._enemy_dir / f"{name}.md")

    def load_enemy(self, name: str, stat_overrides: dict | None = None) -> CombatUnit | None:
        """按名字加载敌人（`data/enemies/<name>.md`），可选逐实例数值覆盖。"""
        path = self.enemy_path(name)
        meta = self._read_enemy_meta(name)
        if meta is None:
            logger.warning("Enemy file not found: %s", path)
            return None
        return self.load_enemy_from_meta(meta, stat_overrides=stat_overrides)

    def _read_enemy_meta(self, name: str) -> dict | None:
        path = self.enemy_path(name)
        if not self._visible(path):
            return None
        if self._custom_dir and name in self._enemy_cache:
            return self._enemy_cache[name]
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                meta = dict(frontmatter.load(f).metadata)
        except (OSError, ValueError) as e:
            logger.error("Failed to load enemy %s: %s", path, e)
            return None
        if self._custom_dir:
            self._enemy_cache[name] = meta
        return meta

    @staticmethod
    def load_enemy_from_meta(meta: dict, stat_overrides: dict | None = None) -> CombatUnit | None:
        """由敌人元数据构建战斗单位。

        有 `combat_stats` 时用绝对值；否则按 `attributes` 派生（与玩家同一套公式），
        因此纯叙事条目也能直接上战场。
        """
        if not meta:
            return None
        name = meta.get("name", "未知")
        stats = meta.get("combat_stats") or {}
        role = str(meta.get("role", "") or "")
        declared_slots = meta.get("action_slots")
        if declared_slots is None:
            action_slots = 2 if role in ("elite", "boss", "精英", "首领", "队长") else 1
        else:
            action_slots = int(declared_slots)

        if stats:
            unit = CombatUnit.create_enemy(
                name=name,
                char_class=meta.get("class", ""),
                hp=int(stats.get("hp", 80) or 80),
                patk=float(stats.get("patk", 8) or 8),
                matk=float(stats.get("matk", 8) or 8),
                defense=int(stats.get("defense", 4) or 4),
                resist=int(stats.get("resist", 4) or 4),
                spd=float(stats.get("spd", 8) or 8),
                hit=int(stats.get("hit", 4) or 4),
                eva=int(stats.get("eva", 4) or 4),
                max_ap=int(stats.get("max_ap", 3) or 3),
                ai_behavior=meta.get("ai_behavior", "aggressive"),
                ai_skills=meta.get("ai_skills"),
                action_slots=action_slots,
                power_tier=str(meta.get("power_tier", "") or ""),
                role=role,
                threat_points=int(meta.get("threat_points", 0) or 0),
            )
        else:
            unit = CombatUnit.from_character_metadata(meta, team="enemy")
            unit.name = name
            unit.unit_id = name
            if meta.get("class"):
                unit.char_class = str(meta["class"])
            unit.ai_behavior = str(meta.get("ai_behavior", "aggressive") or "aggressive")
            unit.ai_skills = list(meta.get("ai_skills") or [])
            unit.action_slots = action_slots
            unit.power_tier = str(meta.get("power_tier", "") or "")
            unit.role = role
            unit.threat_points = int(meta.get("threat_points", 0) or 0)

        return apply_enemy_overrides(unit, stat_overrides)

    def load_enemy_meta(self, name: str) -> dict | None:
        """敌人奖励元数据（掉落/掉率/经验）；缺省视为无奖励。"""
        meta = self._read_enemy_meta(name)
        if meta is None:
            return None
        return {
            "drop_items": meta.get("drop_items", []),
            "drop_rate": float(meta.get("drop_rate", 0.0) or 0.0),
            "xp_reward": int(meta.get("xp_reward", 0) or 0),
        }

    def list_enemy_names(self) -> list[str]:
        names: dict[str, None] = {}
        for root in self._roots("enemies"):
            for path in sorted(root.glob("*.md")):
                if path.stem != "TEMPLATE" and self._visible(path):
                    names.setdefault(path.stem, None)
        return list(names)

    def list_enemy_catalog(self) -> list[dict]:
        """敌人图鉴（编辑器/选择器用）：叙事字段 + 战斗数值 + 是否纯派生。"""
        catalog: list[dict] = []
        for name in self.list_enemy_names():
            meta = self._read_enemy_meta(name) or {}
            stats = meta.get("combat_stats") or {}
            derived = not stats
            unit = self.load_enemy_from_meta(meta)
            catalog.append({
                "name": name,
                "summary": meta.get("summary", ""),
                "race": meta.get("race", ""),
                "faction": meta.get("faction", ""),
                "class": meta.get("class", ""),
                "level": int(meta.get("level", 1) or 1),
                "power_tier": meta.get("power_tier", ""),
                "role": meta.get("role", ""),
                "action_slots": int(meta.get("action_slots", 1) or 1),
                "threat_points": float(meta.get("threat_points", 0) or 0),
                "ai_behavior": meta.get("ai_behavior", "aggressive"),
                "ai_skills": list(meta.get("ai_skills") or []),
                "drop_items": list(meta.get("drop_items") or []),
                "drop_rate": float(meta.get("drop_rate", 0) or 0),
                "xp_reward": int(meta.get("xp_reward", 0) or 0),
                "derived_from_attributes": derived,
                "combat_stats": {
                    "hp": getattr(unit, "max_hp", 0),
                    "patk": getattr(unit, "PATK", 0),
                    "matk": getattr(unit, "MATK", 0),
                    "defense": getattr(unit, "DEF", 0),
                    "resist": getattr(unit, "RES", 0),
                    "spd": getattr(unit, "SPD", 0),
                    "hit": getattr(unit, "HIT", 0),
                    "eva": getattr(unit, "EVA", 0),
                    "max_ap": getattr(unit, "MAX_AP", 0),
                } if unit else {},
            })
        return catalog

    # ── Item loading ──

    def load_item_meta(self, name: str) -> dict | None:
        """Load an item's frontmatter (name, category, combat_effect) from data/items/."""
        base = self._root.parent / "items"
        for path in (base / name / "index.md", base / f"{name}.md"):
            if path.exists() and self._visible(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        return dict(frontmatter.load(f).metadata)
                except (OSError, ValueError) as e:
                    logger.error("Failed to load item %s: %s", path, e)
                    return None
        return None

    # ── Node loading（战斗节点 JSON）──

    def _node_index(self) -> dict:
        """node_id / 文件名 / 中文名 → 文件路径（首次调用构建并缓存）。"""
        if self._custom_dir and self._node_index_cache is not None:
            return self._node_index_cache

        index: dict = {}
        for root in self._roots("combat"):
            for path in sorted((root / "nodes").glob("*.json")):
                if path.stem.upper().startswith("TEMPLATE") or not self._visible(path):
                    continue
                index.setdefault(path.stem, path)
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                for key in ("node_id", "name", "alias"):
                    value = str(data.get(key) or "").strip()
                    if value:
                        index.setdefault(value, path)
        if self._custom_dir:
            self._node_index_cache = index
        return index

    def resolve_node_path(self, node_id: str):
        """解析节点引用（node_id / 文件名 / 中文名）到文件路径。"""
        if not node_id or not re.fullmatch(r"[^/\\.][^/\\]*", str(node_id)):
            return None
        for root in self._roots("combat"):
            direct = root / "nodes" / f"{node_id}.json"
            if direct.is_file() and self._visible(direct):
                return direct
            for path in sorted((root / "nodes").glob("*.json")):
                if path.stem.upper().startswith("TEMPLATE") or not self._visible(path):
                    continue
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if node_id in (data.get("node_id"), data.get("name"), data.get("alias")):
                    return path
        indexed = self._node_index().get(str(node_id).strip())
        return indexed if indexed is not None and self._visible(indexed) else None

    def load_node(self, node_id: str) -> dict | None:
        """加载战斗节点（id / 文件名 / 中文名均可）。"""
        path = self.resolve_node_path(node_id)
        if path is None:
            logger.warning("战斗节点不存在: %s", node_id)
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            logger.error("战斗节点解析失败 %s: %s", path, e)
            return None
        data.setdefault("node_id", path.stem)
        return data

    def list_nodes(self) -> list[dict]:
        """节点摘要列表（下拉选择 / 编辑器用）。"""
        summaries: list[dict] = []
        seen: set[Path] = set()
        for path in self._node_index().values():
            if path in seen:
                continue
            seen.add(path)
            if self.resolve_node_path(path.stem) != path:
                continue
            data = self.load_node(path.stem)
            if not data:
                continue
            battle_map = (data.get("map") or {})
            waves = data.get("waves") or []
            unit_total = sum(int(e.get("count", 1) or 1)
                             for wave in waves for e in (wave.get("enemies") or []))
            summaries.append({
                "node_id": data.get("node_id", path.stem),
                "name": data.get("name", path.stem),
                "summary": data.get("summary", ""),
                "rows": battle_map.get("rows"),
                "cols": battle_map.get("cols"),
                "unit_total": unit_total,
                "wave_count": len(waves),
                "category": (data.get("difficulty") or {}).get("category", ""),
                "band": (data.get("difficulty") or {}).get("band", ""),
                "bind": data.get("bind", {}),
                "background": data.get("background", ""),
            })
        return summaries

    def load_map(self, node: dict):
        """解析节点的 `map` 段为 BattleMap（校验失败抛 MapError）。"""
        from combat_map import resolve_map
        owner = (node or {}).get("worldbook_id")
        roots = self._roots("combat") if not owner or self._custom_dir else [
            path for _, path in category_roots("combat", book_ids=[owner],
                                              project_root=self._project_root)]
        tiles_dir = roots[0] / "tiles" if roots else self._tiles_dir
        return resolve_map((node or {}).get("map"), tiles_dir=tiles_dir)

    def load_tile_registry(self):
        """格子类型注册表（内置 + `data/combat/tiles/*.json`）。"""
        from combat_map import load_tile_registry
        roots = self._roots("combat")
        return load_tile_registry(roots[0] / "tiles" if roots else self._tiles_dir)

    def rules_of(self, node: dict | None) -> dict:
        """节点规则开关（度量/切角）；缺省为统一曼哈顿 + 禁止切角。"""
        rules = dict((node or {}).get("rules") or {})
        rules.setdefault("range_metric", "manhattan")
        rules.setdefault("allow_corner_cut", False)
        return rules

    # ── Background loading ──

    _BG_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
    _DEFAULT_BG_ID = "default"

    def load_background(self, bg_id: str) -> dict | None:
        """Load background metadata from data/combat/backgrounds/<bg_id>/index.md."""
        for root in self._roots("combat"):
            path = root / "backgrounds" / bg_id / "index.md"
            if not path.is_file() or not self._visible(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return dict(frontmatter.load(f).metadata)
            except (OSError, ValueError) as e:
                logger.error("Failed to load background %s: %s", bg_id, e)
                return None
        return None

    def list_background_ids(self) -> list[str]:
        """枚举全局可用战斗背景 ID（目录含 index.md）。"""
        found: dict[str, None] = {}
        for root in self._roots("combat"):
            backgrounds = root / "backgrounds"
            if not backgrounds.is_dir():
                continue
            for path in sorted(backgrounds.iterdir()):
                if (path.is_dir() and (path / "index.md").is_file()
                        and self._visible(path / "index.md")):
                    found.setdefault(path.name, None)
        return list(found)

    def background_image_url(self, bg_id: str) -> str | None:
        """Return the asset URL of a background's image file, or None if absent.

        The image is the frontmatter `image` field when set, otherwise the
        first image file found in the background directory.
        """
        for owner, root in self._owned_roots("combat"):
            bg_dir = root / "backgrounds" / bg_id
            index = bg_dir / "index.md"
            if not index.is_file() or not self._visible(index):
                continue
            try:
                with open(index, "r", encoding="utf-8") as source:
                    meta = frontmatter.load(source).metadata
            except (OSError, ValueError) as exc:
                logger.error("Failed to load background %s: %s", bg_id, exc)
                continue
            candidates: list[str] = []
            if meta.get("image"):
                candidates.append(str(meta["image"]))
            try:
                candidates.extend(sorted(
                    p.name for p in bg_dir.iterdir()
                    if p.is_file() and p.suffix.lower() in self._BG_IMAGE_EXTS
                    and self._visible(p)))
            except OSError:
                continue
            for name in candidates:
                image = bg_dir / name
                if (Path(name).name == name and image.is_file() and not image.is_symlink()
                        and self._visible(image)):
                    url = (f"/api/assets/combat_backgrounds/{quote(bg_id, safe='')}/"
                           f"{quote(name, safe='')}")
                    return url + (f"?worldbook_id={quote(owner, safe='')}" if owner else "")
        return None

    def resolve_background(self, encounter: dict | None,
                           location_name: str = "",
                           session_dir: str | Path | None = None,
                           session_id: str = "") -> str | None:
        """Pick the combat background image URL.

        Priority: encounter `background` field → location doc `combat_bg`
        field → the "default" background. At each level, a session-local
        override (<session_dir>/backgrounds/<bg_id>.<ext>) wins over the
        global image. Returns None when no candidate has an image
        (frontend falls back to the solid background color).
        """
        bg_id = str((encounter or {}).get("background") or "")
        if not bg_id and location_name:
            bg_id = self._location_combat_bg(location_name)

        candidates = [bg_id] if bg_id else []
        if self._DEFAULT_BG_ID not in candidates:
            candidates.append(self._DEFAULT_BG_ID)

        for cand in candidates:
            if session_dir and session_id:
                url = self._session_background_url(Path(session_dir), session_id, cand)
                if url:
                    return url
            url = self.background_image_url(cand)
            if url:
                return url
        return None

    def _session_background_url(self, session_dir: Path, session_id: str,
                                bg_id: str) -> str | None:
        """Session-local override: <session_dir>/backgrounds/<bg_id>.<ext>."""
        bg_dir = session_dir / "backgrounds"
        for ext in self._BG_IMAGE_EXTS:
            f = bg_dir / f"{bg_id}{ext}"
            if f.is_file():
                return f"/api/sessions/{session_id}/backgrounds/{f.name}"
        return None

    def location_background_id(self, location_name: str) -> str:
        """地点文档声明的背景 id（`combat_bg`）；对话舞台与战斗共用这一约定。"""
        return self._location_combat_bg(location_name)

    def _location_combat_bg(self, location_name: str) -> str:
        """Find `combat_bg` in a directory-style or flat location document."""
        for root in self._roots("environment"):
            loc_base = root / "Location"
            if not loc_base.is_dir():
                continue
            location_docs = sorted([*loc_base.rglob("index.md"), *loc_base.glob("*.md")])
            for location_md in location_docs:
                if not self._visible(location_md):
                    continue
                try:
                    with open(location_md, "r", encoding="utf-8") as f:
                        meta = frontmatter.load(f).metadata
                except (OSError, ValueError):
                    continue
                fallback_name = (location_md.parent.name if location_md.name == "index.md"
                                 else location_md.stem)
                if location_name in (meta.get("name"), meta.get("alias"), fallback_name):
                    return str(meta.get("combat_bg") or "")
        return ""

