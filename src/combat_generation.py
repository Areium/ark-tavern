"""按剧情场景现场生成战斗节点（LLM 给处境 → 程序编排 → 校验 → 试跑 → 入库）。

服务两条链路：

1. **叙述中触发**（`blueprints/chat.py`）：战术模式下 Call 2 提取到 `combat_scene`
   （叙述里明确出现交手场面）但没有可复用的现成节点时，按场景描述、敌人名与
   阶段带生成一个新的战斗节点并绑定到当前剧情 / 章节 / 节拍。
2. **参考大纲落地**（`blueprints/story.py` 的大纲生成接口）：大纲里标了
   `combat.required` 的节拍在保存前物化成战斗节点，`combat.node_id` 回填后节拍内容
   自动带 `[COMBAT:node_id]`，战术会话推进到该节拍时确定性开战。

硬性纪律与 skill `combat-designer` 一致：只产出数据、先校验（`validate_node`）
再试跑（`perf_tests/simulate_combat`，固定种子少量 runs）再入库（`save_node`）；
校验不过或试跑不可玩的候选不落盘，返回 None 并记录原因。生成器只从注册表里
**已存在**的敌人中选（LLM 给的名字不存在就按阶段带从目录里凑），不编造敌人。
"""

from __future__ import annotations

import logging
import random
import re
import sys
import time
from pathlib import Path

from combat_balance import classify_enemy, node_budget_report
from combat_data_loader import CombatDataLoader
from combat_nodes import NodeError, node_exists, save_node, validate_node
from combat_rules import band_config
from data_paths import PROJECT_ROOT

logger = logging.getLogger(__name__)

_PERF_TESTS_DIR = Path(PROJECT_ROOT) / "perf_tests"

#: 试跑阈值（与 combat-designer 的推荐口径一致但更宽：现场生成优先保证「能打且不必死」）
SIM_RUNS = 6
MIN_WIN_RATE = 0.5
MAX_HP_LOSS = 0.85


class CombatGenerationError(RuntimeError):
    """生成失败（校验 / 试跑 / 落盘）。"""


def _slug_id(text: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", str(text or "")).strip("_").lower()
    return slug or fallback


def make_node_id(plot_id: str, beat_id: str, scene_name: str = "") -> str:
    """节点 id：`enc_<plot>_<beat|scene>`，冲突时追加序号。"""
    base = "enc_" + _slug_id(plot_id, "plot")
    tail = _slug_id(beat_id or scene_name, "") or f"s{int(time.time()) % 100000}"
    node_id = f"{base}_{tail}"[:60]
    n = 2
    while node_exists(node_id):
        node_id = f"{base}_{tail}_{n}"[:60]
        n += 1
    return node_id


# ── 敌人编排 ──

def _enemy_catalog(loader: CombatDataLoader) -> dict[str, float]:
    """敌人名 → 威胁点（缺 hp 的条目跳过）。"""
    out: dict[str, float] = {}
    for entry in loader.list_enemy_catalog():
        stats = entry.get("combat_stats") or {}
        if not stats.get("hp"):
            continue
        info = classify_enemy(stats, level=entry.get("level", 1),
                              declared_role=entry.get("role", ""),
                              declared_tier=entry.get("power_tier", ""))
        out[entry["name"]] = float(info["threat_points"])
    return out


def plan_enemies(scene_enemies: list[str], band: str, catalog: dict[str, float],
                 rng: random.Random, *, scale: float = 1.0) -> list[dict]:
    """按阶段带预算把敌人凑成一波：优先用场景点名的敌人，缺位再按目录补。

    scale < 1 用于试跑不过时收缩规模。
    """
    cfg = band_config(band)
    lo, hi = (cfg.get("threat_range") or [3.0, 6.0])
    target = rng.uniform(float(lo) * 1.05, float(hi) * 0.95) * max(0.3, scale)
    picked: list[str] = []
    remaining = target
    named = [n for n in scene_enemies if n in catalog]
    if named:
        # 轮流分配点名敌人，直到预算用尽（至少每种一个）
        for name in named:
            picked.append(name)
            remaining -= catalog[name]
        i = 0
        guard = 0
        while remaining > 0 and guard < 30:
            guard += 1
            name = named[i % len(named)]
            if catalog[name] <= remaining + 1e-6:
                picked.append(name)
                remaining -= catalog[name]
            i += 1
            if all(catalog[n] > remaining + 1e-6 for n in named):
                break
    else:
        rows = sorted(catalog.items(), key=lambda kv: kv[1])
        guard = 0
        while remaining > 0 and guard < 30 and rows:
            guard += 1
            affordable = [r for r in rows if r[1] <= remaining + 1e-6]
            if not affordable:
                break
            name, threat = affordable[rng.randint(max(0, len(affordable) - 3), len(affordable) - 1)]
            picked.append(name)
            remaining -= threat
        if not picked:
            picked = [rows[0][0]]
    merged: dict[str, int] = {}
    for name in picked:
        merged[name] = merged.get(name, 0) + 1
    return [{"enemy": name, "count": count} for name, count in merged.items()]


# ── 地图 ──

def build_map(rng: random.Random, *, rows: int = 7, cols: int = 9) -> dict:
    """开阔布局 + 少量掩体/高台；中央横向通路保持畅通（避免部署区被隔断）。"""
    grid = [["ground" for _ in range(cols)] for _ in range(rows)]
    mid = rows // 2
    keep_clear = {mid - 1, mid, mid + 1}
    for _ in range(max(2, (rows * cols) // 14)):
        r, c = rng.randrange(rows), rng.randrange(2, cols - 2)
        if r in keep_clear and rng.random() < 0.6:
            continue
        grid[r][c] = rng.choice(["cover", "cover", "high_ground", "wall"])
    return {
        "rows": rows, "cols": cols, "tiles": grid, "tile_defs": {},
        "deploy": {
            "player": {"rect": [max(0, mid - 1), 0, min(rows - 1, mid + 1), 1]},
            "enemy": {"rect": [max(0, mid - 1), cols - 2, min(rows - 1, mid + 1), cols - 1]},
            "enemy_random_shift": False,
        },
    }


def place_enemies(battle_map: dict, waves: list[dict], rng: random.Random) -> None:
    rows, cols = battle_map["rows"], battle_map["cols"]
    grid = battle_map["tiles"]
    cells = [(r, c) for r in range(rows) for c in range(cols - 3, cols)
             if grid[r][c] in ("ground", "cover", "high_ground")]
    rng.shuffle(cells)
    idx = 0
    for wave in waves:
        for entry in wave["enemies"]:
            positions = []
            for _ in range(entry["count"]):
                if idx >= len(cells):
                    break
                positions.append(list(cells[idx]))
                idx += 1
            if positions:
                entry["positions"] = positions


# ── 组装 / 校验 / 试跑 ──

def build_candidate(scene: dict, *, node_id: str, plot_id: str, chapter_id: str,
                    beat_id: str, worldbook_id: str, seed: int, loader: CombatDataLoader,
                    catalog: dict[str, float], scale: float = 1.0) -> dict:
    rng = random.Random(seed)
    band = str(scene.get("band") or "T1").upper()
    if band not in ("T0", "T1", "T2", "T3", "T4"):
        band = "T1"
    battle_map = build_map(rng)
    waves = [{"enemies": plan_enemies(list(scene.get("enemies") or []), band, catalog, rng, scale=scale)}]
    place_enemies(battle_map, waves, rng)
    name = str(scene.get("name") or "").strip() or f"遭遇：{(scene.get('description') or '')[:12]}"
    node = {
        "schema_version": 1,
        "node_id": node_id,
        "name": name[:30],
        "summary": str(scene.get("description") or "")[:200],
        "description": str(scene.get("description") or "")[:600],
        "bind": {"plot_id": plot_id or "", "chapter_id": chapter_id or "", "beat_id": beat_id or ""},
        "worldbook_id": worldbook_id or "",
        "rules": {"range_metric": "manhattan", "allow_corner_cut": False},
        "map": battle_map,
        "waves": waves,
        "conditions": {"max_rounds": 8, "escape_enabled": True},
        "rewards": {"xp": 0, "items": [], "unlock": []},
        "difficulty": {
            "category": "story", "encounter_type": "normal", "band": band,
            "threat_budget": 0, "target_rounds": 4, "difficulty": 1,
            "apply_band_scaling": False,
        },
        "background": "default",
        "balance_version": 1,
        "generated": {"by": "story_scene", "seed": seed, "at": time.time(),
                      "scene": {k: scene.get(k) for k in ("name", "description", "enemies", "band")}},
    }
    report = node_budget_report(node, loader=loader)
    node["difficulty"]["threat_budget"] = report["total"]
    node["difficulty"]["target_rounds"] = max(3, min(10, int(round(report["total"] / 1.4))))
    node["rewards"]["xp"] = int(round(20 + report["total"] * 8))
    return node


def simulate_candidate(node: dict, loader: CombatDataLoader, *, runs: int = SIM_RUNS,
                       seed_base: int = 20260923) -> dict | None:
    """固定种子试跑；模拟器不可用（如部署包不含 perf_tests）返回 None。"""
    try:
        if str(_PERF_TESTS_DIR) not in sys.path:
            sys.path.insert(0, str(_PERF_TESTS_DIR))
        import simulate_combat  # noqa: WPS433
    except Exception:
        logger.warning("战斗模拟器不可用，跳过试跑", exc_info=True)
        return None
    rows = [simulate_combat.simulate_battle(node, "standard", seed_base + i, loader) for i in range(runs)]
    summary = simulate_combat.summarise(rows)
    summary.pop("issues", None)
    return summary


def generate_combat_node_for_scene(scene: dict, *, plot_id: str = "", chapter_id: str = "",
                                   beat_id: str = "", worldbook_id: str = "",
                                   node_id: str = "", seed: int | None = None,
                                   attempts: int = 4, simulate: bool = True,
                                   loader: CombatDataLoader | None = None) -> dict | None:
    """场景 → 合法、可玩、已入库的战斗节点；失败返回 None（原因写日志）。

    scene: {"name", "description", "enemies": [...], "band": "T1"}。
    每次尝试换种子；试跑不达标则收缩规模再试；全部失败不落盘。
    """
    scene = dict(scene or {})
    if not str(scene.get("description") or "").strip():
        logger.info("战斗节点生成跳过：场景缺少描述")
        return None
    loader = loader or CombatDataLoader()
    catalog = _enemy_catalog(loader)
    if not catalog:
        logger.warning("战斗节点生成失败：敌人目录为空")
        return None
    enemy_names = set(loader.list_enemy_names())
    node_id = node_id or make_node_id(plot_id, beat_id, scene.get("name") or "")
    base_seed = int(seed if seed is not None else (hash((plot_id, beat_id, scene.get("description"))) & 0xFFFF))
    last_reason = ""
    scale = 1.0
    for attempt in range(max(1, attempts)):
        candidate = build_candidate(
            scene, node_id=node_id, plot_id=plot_id, chapter_id=chapter_id, beat_id=beat_id,
            worldbook_id=worldbook_id, seed=base_seed + attempt, loader=loader,
            catalog=catalog, scale=scale)
        report = validate_node(candidate, enemy_names=enemy_names)
        if report["errors"]:
            last_reason = "校验失败：" + "；".join(report["errors"][:3])
            logger.info("战斗节点候选 %s 第 %d 次%s", node_id, attempt + 1, last_reason)
            continue
        summary = simulate_candidate(candidate, loader) if simulate else None
        if summary is not None:
            candidate["generated"]["simulation"] = {
                "runs": SIM_RUNS, "win_rate": summary.get("win_rate"),
                "median_rounds": summary.get("median_rounds"),
                "hp_loss_rate": summary.get("hp_loss_rate"),
            }
            if summary.get("win_rate", 0) < MIN_WIN_RATE or summary.get("hp_loss_rate", 0) > MAX_HP_LOSS:
                last_reason = (f"试跑不达标：胜率 {summary.get('win_rate', 0):.0%}，"
                               f"血损 {summary.get('hp_loss_rate', 0):.0%}")
                logger.info("战斗节点候选 %s 第 %d 次%s，收缩规模重试", node_id, attempt + 1, last_reason)
                scale *= 0.7
                continue
        try:
            saved = save_node(candidate, enemy_names=enemy_names)
        except NodeError as exc:
            last_reason = f"落盘校验失败：{exc}"
            logger.warning("战斗节点候选 %s %s", node_id, last_reason)
            continue
        logger.info("战斗节点已生成并入库：%s（%s，威胁 %.1f，band %s）",
                    node_id, saved.get("name"), saved["difficulty"]["threat_budget"],
                    saved["difficulty"]["band"])
        return saved
    logger.warning("战斗节点生成放弃：%s（%s）", node_id, last_reason or "未知原因")
    return None


def materialize_outline_combat(outline: dict, *, worldbook_id: str = "",
                               simulate: bool = True, loader: CombatDataLoader | None = None) -> list[dict]:
    """把大纲里 `combat.required` 且未绑定节点的节拍物化成战斗节点，回填 node_id。

    返回 [{"beat_id", "node_id" | None, "error"}]，就地修改 outline。
    """
    results: list[dict] = []
    loader = loader or CombatDataLoader()
    plot_id = str(outline.get("plot_id") or "")
    for ch in outline.get("chapters", []):
        for beat in ch.get("beats", []):
            combat = beat.get("combat")
            if not combat or not combat.get("required"):
                continue
            if combat.get("node_id") and node_exists(combat["node_id"]):
                continue
            scene = {
                "name": (beat.get("title") or "")[:8],
                "description": combat.get("description") or beat.get("summary") or "",
                "enemies": combat.get("enemies") or [],
                "band": combat.get("band") or "T1",
            }
            node = generate_combat_node_for_scene(
                scene, plot_id=plot_id, chapter_id=ch.get("id") or "", beat_id=beat["id"],
                worldbook_id=worldbook_id or outline.get("worldbook_id") or "",
                simulate=simulate, loader=loader)
            if node:
                combat["node_id"] = node["node_id"]
                results.append({"beat_id": beat["id"], "node_id": node["node_id"], "error": None})
            else:
                results.append({"beat_id": beat["id"], "node_id": None, "error": "生成失败（见日志）"})
    return results
