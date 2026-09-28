# -*- coding: utf-8 -*-
"""破甲（ignore_def）+ 净化（cleanse）+ 战场扫描（weaken）。

运行：python -m pytest tests/test_pierce_cleanse.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from combat_engine.dice import compute_damage, HitResult  # noqa: E402
from combat_engine.entity import CombatUnit  # noqa: E402
from combat_engine.card import Card  # noqa: E402


def test_ignore_def_reduces_resist():
    attacker = CombatUnit(unit_id="a", name="a", team="player", PATK=10)
    defender = CombatUnit(unit_id="b", name="b", team="enemy", DEF=10, RES=10)
    hit = HitResult(15, True, False, False)
    pierce = Card("pierce", "破甲", "", "physical", 10, 10, 0.0, "SINGLE", 1, 1, "basic", "any", ignore_def=0.5)
    normal = Card("normal", "普通", "", "physical", 10, 10, 0.0, "SINGLE", 1, 1, "basic", "any")
    assert compute_damage(attacker, defender, pierce, hit).final == 5   # 10 - 5
    assert compute_damage(attacker, defender, normal, hit).final == 1   # 10 - 10 → 保底 1


def test_clear_debuffs_keeps_buffs():
    u = CombatUnit(unit_id="x", name="x", team="player")
    u.apply_status("slow", 2)
    u.apply_status("bind", 1)
    u.apply_burn(4, 2)
    u.apply_status("shield", 5)  # 增益
    cleared = u.clear_debuffs()
    assert cleared == 3  # slow + bind + burn
    assert u.status_amount("slow") == 0
    assert u.status_amount("bind") == 0
    assert u.status_amount("burn") == 0
    assert u.status["burn_damage"] == 0
    assert u.status_amount("shield") == 5  # 增益保留
