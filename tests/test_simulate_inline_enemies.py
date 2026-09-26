"""The battle simulator must spawn self-contained node enemies like CombatSession."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "perf_tests"))

import simulate_combat  # noqa: E402
from combat_data_loader import CombatDataLoader  # noqa: E402
from combat_session import CombatSession  # noqa: E402


def test_inline_enemy_takes_priority_and_applies_instance_stats(monkeypatch):
    loader = CombatDataLoader()
    enemy_name = "整合运动士兵"
    inline = {
        "name": enemy_name,
        "role": "minion",
        "action_slots": 1,
        "ai_behavior": "defensive",
        "combat_stats": {
            "hp": 57, "patk": 13, "matk": 8, "defense": 4,
            "resist": 4, "spd": 8, "hit": 5, "eva": 3, "max_ap": 3,
        },
    }
    node = {
        "map": {"rows": 7, "cols": 7, "tiles": "ground",
                "deploy": {"player": {"rect": [1, 0, 4, 1]},
                           "enemy": {"rect": [1, 5, 4, 6]}}},
        "enemies_def": {enemy_name: inline},
        "waves": [
            {"enemies": [{"enemy": enemy_name, "count": 1,
                          "positions": [[2, 5]], "stats": {"hp": 63}}]},
            {"enemies": [{"enemy": enemy_name, "count": 1,
                          "positions": [[3, 5]]}]},
        ],
        "conditions": {"max_rounds": 6, "escape_enabled": True},
    }

    def reject_global_lookup(*_args, **_kwargs):
        raise AssertionError("inline enemy must take priority over global lookup")

    monkeypatch.setattr(loader, "load_enemy", reject_global_lookup)
    engine = simulate_combat.build_engine(node, "standard", loader)

    enemies = [unit for unit in engine.units.values() if unit.team == "enemy"]
    assert len(enemies) == 1
    assert enemies[0].name == enemy_name
    assert enemies[0].max_hp == 63
    assert enemies[0].PATK == 13
    assert enemies[0].ai_behavior == "defensive"
    assert not engine.is_battle_over()
    assert len(engine.pending_waves) == 1
    assert engine.pending_waves[0][0][0].max_hp == 57


@pytest.mark.parametrize(
    ("node_id", "first_wave_count", "pending_waves"),
    [
        ("enc_grey_checkpoint", 2, 0),
        ("enc_grey_warehouse", 3, 0),
        ("enc_grey_bridge", 2, 1),
    ],
)
def test_registered_grey_lantern_nodes_start_with_enemies(
    node_id, first_wave_count, pending_waves,
):
    meta = {
        "name": "演练近卫", "class": "近卫",
        "attributes": {
            "物理强度": 6, "战场机动": 6, "生理耐受": 8,
            "战术规划": 6, "战斗技巧": 6, "源石技艺适应性": 6,
            "情绪稳定性": 6,
        },
    }
    combat = CombatSession("grey-lantern-smoke")
    combat.start(node_id, character_metas=[meta])

    assert sum(unit.team == "enemy" for unit in combat.engine.units.values()) == first_wave_count
    assert len(combat.engine.pending_waves) == pending_waves
    assert combat.engine.escape_enabled
    if node_id == "enc_grey_warehouse":
        archers = [unit for unit in combat.engine.units.values()
                   if unit.team == "enemy" and unit.name == "灰灯仓库弩手"]
        assert len(archers) == 2
        assert archers[0].ai_skills == ["enemy_shot", "enemy_barrage"]
    if node_id == "enc_grey_bridge":
        assert all(unit.max_hp == 62 for unit, _ in combat.engine.pending_waves[0])
