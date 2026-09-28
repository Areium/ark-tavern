"""固定种子模拟应可复现；不依赖已移除的捆绑战斗内容。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "perf_tests"))

import simulate_combat  # noqa: E402
from combat_data_loader import CombatDataLoader  # noqa: E402


def test_inline_battle_metrics_reproducible(tmp_path):
    enemy_name = "Fixture enemy"
    node = {
        "node_id": "enc_fixture",
        "map": {"rows": 7, "cols": 7, "tiles": "ground", "deploy": {
            "player": {"rect": [1, 0, 4, 1]},
            "enemy": {"rect": [1, 5, 4, 6]}}},
        "enemies_def": {enemy_name: {
            "name": enemy_name, "role": "minion", "action_slots": 1,
            "combat_stats": {"hp": 57, "patk": 13, "matk": 8, "defense": 4,
                             "resist": 4, "spd": 8, "hit": 5, "eva": 3, "max_ap": 3},
        }},
        "waves": [{"enemies": [{"enemy": enemy_name, "count": 1,
                                  "positions": [[2, 5]]}]}],
        "conditions": {"max_rounds": 6, "escape_enabled": True},
    }
    loader = CombatDataLoader(data_dir=str(tmp_path / "combat"))
    first = simulate_combat.simulate_battle(node, "standard", 20260912, loader)
    second = simulate_combat.simulate_battle(node, "standard", 20260912, loader)
    assert first == second
    assert first["encounter_id"] == "enc_fixture"
    assert simulate_combat.summarise([first, second])["runs"] == 2
