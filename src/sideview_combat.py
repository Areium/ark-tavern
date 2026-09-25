"""Small, independent side view battle data and snapshot contract."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

from data_paths import DATA_ROOT

LEVEL_DIR = DATA_ROOT / "sideview_levels"
SNAPSHOT_VERSION = 1


ENEMY_KINDS = ("guard", "ranger", "elite")


def load_level(encounter_id: str) -> dict:
    """Use a matching level when present, otherwise the authored default stage."""
    safe_id = encounter_id if isinstance(encounter_id, str) and encounter_id.isidentifier() else ""
    path = LEVEL_DIR / f"{safe_id}.json" if safe_id else LEVEL_DIR / "default.json"
    if not path.is_file():
        path = LEVEL_DIR / "default.json"
    with path.open(encoding="utf-8") as stream:
        level = json.load(stream)
    validate_level(level)
    level.setdefault("victoryCondition", "clear_and_exit")
    return level


def validate_level(level: object) -> None:
    """Reject authored stages the browser simulation or settlement cannot run.

    Checks structure and bounds only; whether a layout is fun or completable is
    the author's job (the frontend simulation tests play the default stage).
    """
    def fail(message: str):
        raise ValueError(f"侧卷轴关卡配置无效：{message}")

    def rect(value, label: str, *, allow_pit_depth: bool = False) -> dict:
        if not isinstance(value, dict) or not all(_number(value.get(k), -1e9, 1e9) for k in ("x", "y", "width", "height")):
            fail(f"{label} 需要数值 x/y/width/height")
        if value["width"] <= 0 or value["height"] <= 0:
            fail(f"{label} 尺寸必须为正")
        bottom = level["height"] + (80 if allow_pit_depth else 0)
        if value["x"] < 0 or value["y"] < 0 or value["x"] + value["width"] > level["width"] or value["y"] + value["height"] > bottom:
            fail(f"{label} 超出关卡边界")
        return value

    if not isinstance(level, dict) or level.get("schemaVersion") != 1:
        fail("schemaVersion 必须为 1")
    if not isinstance(level.get("id"), str) or not level["id"] or not isinstance(level.get("name"), str):
        fail("id / name 缺失")
    if not _number(level.get("width"), 320, 20000) or not _number(level.get("height"), 240, 4000):
        fail("width / height 超出范围")
    if level.get("victoryCondition", "clear_and_exit") not in ("clear_and_exit", "reach_exit"):
        raise ValueError("侧卷轴通关条件无效")
    for key in ("platforms", "obstacles", "hazards"):
        if not isinstance(level.get(key), list):
            fail(f"{key} 必须是数组")
    if not level["platforms"]:
        fail("至少需要一个平台")
    for index, platform in enumerate(level["platforms"]):
        rect(platform, f"platforms[{index}]")
        # Omitted oneWay lets the client treat ledges up to 32 px thick as jump-through.
        if "oneWay" in platform and type(platform["oneWay"]) is not bool:
            fail(f"platforms[{index}].oneWay 必须是布尔值")
    for index, obstacle in enumerate(level["obstacles"]):
        rect(obstacle, f"obstacles[{index}]")
    for index, hazard in enumerate(level["hazards"]):
        rect(hazard, f"hazards[{index}]", allow_pit_depth=True)
        if not _number(hazard.get("damage"), 0, 999):
            fail(f"hazards[{index}].damage 需在 0–999")
    spawn = level.get("spawn")
    if not isinstance(spawn, dict) or not (_number(spawn.get("x"), 0, level["width"]) and _number(spawn.get("y"), 0, level["height"])):
        fail("spawn 超出关卡边界")
    rect(level.get("exit"), "exit")
    enemies = level.get("enemies")
    if not isinstance(enemies, list):
        fail("enemies 必须是数组")
    seen = set()
    for index, enemy in enumerate(enemies):
        label = f"enemies[{index}]"
        if not isinstance(enemy, dict) or not isinstance(enemy.get("id"), str) or not enemy["id"]:
            fail(f"{label}.id 缺失")
        if enemy["id"] in seen:
            fail(f"敌人 ID 重复：{enemy['id']}")
        seen.add(enemy["id"])
        if not isinstance(enemy.get("name"), str) or enemy.get("kind", "guard") not in ENEMY_KINDS:
            fail(f"{label} 的 name / kind 无效")
        if not (_number(enemy.get("x"), 0, level["width"]) and _number(enemy.get("y"), 0, level["height"])):
            fail(f"{label} 位置超出关卡边界")
        if not (isinstance(enemy.get("hp"), int) and not isinstance(enemy["hp"], bool) and 1 <= enemy["hp"] <= 9999):
            fail(f"{label}.hp 需为 1–9999 的整数")
        if not (_number(enemy.get("damage"), 1, 999) and _number(enemy.get("speed"), 0, 1000)
                and _number(enemy.get("range"), 1, 2000)):
            fail(f"{label} 的 damage / speed / range 超出范围")
        patrol = [enemy.get(k) for k in ("patrolMin", "patrolMax") if k in enemy]
        if any(not _number(v, 0, level["width"]) for v in patrol) or (len(patrol) == 2 and patrol[0] > patrol[1]):
            fail(f"{label} 巡逻区间无效")
    rewards = level.get("rewards")
    if (not isinstance(rewards, dict) or not isinstance(rewards.get("xp"), int) or isinstance(rewards["xp"], bool)
            or rewards["xp"] < 0 or not isinstance(rewards.get("items", []), list)):
        fail("rewards 需要非负整数 xp 与 items 数组")


def initial_snapshot(level: dict, hp: int) -> dict:
    return {
        "version": SNAPSHOT_VERSION,
        "player": {"x": level["spawn"]["x"], "y": level["spawn"]["y"],
                   "hp": hp, "facing": 1},
        "enemies": [{"id": e["id"], "x": e["x"], "y": e["y"], "hp": e["hp"]}
                    for e in level["enemies"]],
        "elapsedMs": 0,
        "exitReached": False,
    }


def apply_combat_params(level: dict, params: dict, operator_name: str) -> tuple[dict, dict]:
    """Freeze approach effects into this run's side view stage."""
    result = copy.deepcopy(level)
    try:
        scale = float(params.get("enemy_scale", 1.0))
    except (TypeError, ValueError):
        scale = 1.0
    scale = min(2.0, max(0.5, scale)) if math.isfinite(scale) else 1.0
    first_strike = params.get("first_strike") is True
    for enemy in result["enemies"]:
        enemy["hp"] = max(1, min(9999, round(int(enemy["hp"]) * scale)))
        enemy["damage"] = max(1, min(999, round(int(enemy["damage"]) * scale)))
        if first_strike:
            enemy["hp"] = max(1, enemy["hp"] - max(1, round(enemy["hp"] * 0.15)))
    effect = (params.get("status_effects") or {}).get(operator_name) or {}
    try:
        penalty = float(effect.get("hp_penalty", 0))
    except (TypeError, ValueError):
        penalty = 0.0
    penalty = min(0.9, max(0.0, penalty)) if math.isfinite(penalty) else 0.0
    return result, {"enemyScale": scale, "firstStrike": first_strike,
                    "hpPenalty": penalty}


def _number(value, minimum: float, maximum: float) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and minimum <= value <= maximum)


def validate_snapshot(snapshot: object, level: dict, initial_hp: int,
                      previous: dict | None = None) -> dict:
    """Reject malformed or impossible state before it reaches the overlay."""
    required = {"version", "player", "enemies", "elapsedMs", "exitReached"}
    optional = {"cooldowns", "damageTaken"}
    if not isinstance(snapshot, dict) or not required <= set(snapshot) or set(snapshot) - required - optional:
        raise ValueError("snapshot 结构无效")
    if snapshot["version"] != SNAPSHOT_VERSION:
        raise ValueError("snapshot 版本不支持")
    player = snapshot["player"]
    if not isinstance(player, dict) or set(player) != {"x", "y", "hp", "facing"}:
        raise ValueError("player 结构无效")
    if not (_number(player["x"], 0, level["width"])
            and _number(player["y"], 0, level["height"] + 80)
            and _number(player["hp"], 0, initial_hp)
            and type(player["facing"]) is int and player["facing"] in (-1, 1)):
        raise ValueError("主控状态超出关卡边界")
    if not (isinstance(snapshot["elapsedMs"], int) and not isinstance(snapshot["elapsedMs"], bool)
            and 0 <= snapshot["elapsedMs"] <= 24 * 60 * 60 * 1000):
        raise ValueError("战斗时长无效")
    if type(snapshot["exitReached"]) is not bool:
        raise ValueError("出口状态无效")
    if "cooldowns" in snapshot:
        cooldowns = snapshot["cooldowns"]
        if (not isinstance(cooldowns, dict) or set(cooldowns) != {"skill", "dash", "support"}
                or any(not _number(value, 0, 600000) for value in cooldowns.values())):
            raise ValueError("冷却状态无效")
    if "damageTaken" in snapshot and not _number(snapshot["damageTaken"], 0, 1000000):
        raise ValueError("受伤统计无效")
    enemies = snapshot["enemies"]
    level_enemies = {enemy["id"]: enemy for enemy in level["enemies"]}
    if not isinstance(enemies, list) or len(enemies) != len(level_enemies):
        raise ValueError("敌人集合不匹配")
    seen = set()
    old = {enemy["id"]: enemy for enemy in previous["enemies"]} if previous else {}
    for enemy in enemies:
        if not isinstance(enemy, dict) or set(enemy) != {"id", "x", "y", "hp"}:
            raise ValueError("敌人状态结构无效")
        eid = enemy["id"]
        if eid not in level_enemies or eid in seen:
            raise ValueError("敌人 ID 不匹配")
        seen.add(eid)
        if not (_number(enemy["x"], 0, level["width"])
                and _number(enemy["y"], 0, level["height"] + 80)
                and _number(enemy["hp"], 0, level_enemies[eid]["hp"])):
            raise ValueError("敌人状态超出关卡边界")
        if eid in old and enemy["hp"] > old[eid]["hp"]:
            raise ValueError("敌人生命值不可回升")
    if previous and snapshot["elapsedMs"] < previous["elapsedMs"]:
        raise ValueError("战斗时长不可倒退")
    return copy.deepcopy(snapshot)


def victory_satisfied(snapshot: dict, level: dict) -> bool:
    player = snapshot["player"]
    end = level["exit"]
    return (player["hp"] > 0 and snapshot["exitReached"]
            and player["x"] < end["x"] + end["width"]
            and player["x"] + 32 > end["x"]
            and player["y"] < end["y"] + end["height"]
            and player["y"] + 58 > end["y"]
            and (level.get("victoryCondition", "clear_and_exit") == "reach_exit"
                 or all(enemy["hp"] == 0 for enemy in snapshot["enemies"])))


def minimum_victory_ms(level: dict) -> int:
    """Loose travel floor using the frontend's 760 px/s dash top speed.

    This only rejects instant result fabrication. A client that waits can still
    forge snapshots because movement and damage remain client authoritative.
    """
    player_width = 32
    horizontal = max(0, level["exit"]["x"] - (level["spawn"]["x"] + player_width))
    return max(0, math.ceil(horizontal * 1000 / 760 - 250))
