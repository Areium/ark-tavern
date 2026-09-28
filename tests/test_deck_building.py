# -*- coding: utf-8 -*-
"""卡组构建：战后 1 选 1 候选生成 + 持久化卡组奖励卡。

运行：python -m pytest tests/test_deck_building.py -v
"""

import os
import json
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from combat_session import CombatSession  # noqa: E402
from combat_engine.card_data import get_cards_for_class  # noqa: E402
from combat_settlement import generate_card_choices, squad_card_pool  # noqa: E402
from combat_engine import card_json_loader  # noqa: E402
from test_combat_resume import prepare_combat_book  # noqa: E402


@pytest.fixture(autouse=True)
def combat_cards(tmp_path, monkeypatch):
    folder = prepare_combat_book(tmp_path, monkeypatch)
    classes = folder / "classes"
    for class_name, card_ids in (("近卫", ("guard_slash", "guard_block", "guard_charge", "guard_rally")),
                                 ("医疗", ("medic_heal",))):
        path = classes / class_name / "cards.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"cards": [{
            "card_id": card_id, "name": card_id, "description": "",
            "damage_type": "physical", "min_damage": 1, "max_damage": 1,
            "atk_scale": 0, "target": "SINGLE", "range": 1, "cost": 1,
            "tier": "basic", "class_required": class_name,
        } for card_id in card_ids]}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(card_json_loader, "_CLASS_DIR", classes)
    card_json_loader.clear_cache()
    yield
    card_json_loader.clear_cache()


class _FakeOverlay:
    def __init__(self):
        self._data = {}


class _FakeSession:
    def __init__(self):
        self.overlay = _FakeOverlay()


def test_squad_card_pool_aggregates_classes():
    metas = [{"class": "近卫"}, {"class": "医疗"}]
    pool = squad_card_pool(metas)
    ids = {c["card_id"] for c in pool}
    assert "guard_slash" in ids
    assert "medic_heal" in ids
    assert len(pool) == len(get_cards_for_class("近卫")) + len(get_cards_for_class("医疗"))


def test_generate_card_choices_excludes_owned():
    s = _FakeSession()
    s.overlay._data["combat_deck"] = [{"card_id": "guard_slash"}]
    choices = generate_card_choices(s, [{"class": "近卫"}], count=3)
    assert len(choices) == 3
    assert all(c["card_id"] != "guard_slash" for c in choices)


def test_generate_card_choices_empty_when_all_owned():
    s = _FakeSession()
    all_ids = [{"card_id": c.card_id} for c in get_cards_for_class("近卫")]
    s.overlay._data["combat_deck"] = all_ids
    choices = generate_card_choices(s, [{"class": "近卫"}], count=3)
    assert choices == []


def _bonus_card(card_id="test_bonus_card", class_required="近卫"):
    return {
        "card_id": card_id, "name": "测试卡", "description": "",
        "damage_type": "physical", "min_damage": 5, "max_damage": 9,
        "atk_scale": 0.5, "target": "SINGLE", "range": 1, "cost": 1,
        "tier": "basic", "class_required": class_required, "owner": None, "effects": [],
    }


def test_bonus_cards_appended_with_owner():
    cs = CombatSession("deck-test")
    cs.start("enc_training", character_metas=[
        {"name": "Medic", "class": "医疗", "combat_stats": {"hp": 80}},
        {"name": "Guard", "class": "近卫", "combat_stats": {"hp": 80}}],
             bonus_cards=[_bonus_card()])
    pool = cs.engine.shared_pool
    all_cards = pool.deck + pool.hand + pool.discard + pool.exhaust
    bonus = [c for c in all_cards if c.card_id == "test_bonus_card"]
    assert len(bonus) == 1
    assert bonus[0].owner == "Guard"


def test_bonus_card_unmatched_class_uses_first_player():
    cs = CombatSession("deck-test3")
    cs.start("enc_training", character_metas=[
        {"name": "Medic", "class": "医疗", "combat_stats": {"hp": 80}},
        {"name": "Guard", "class": "近卫", "combat_stats": {"hp": 80}}],
             bonus_cards=[_bonus_card(card_id="test_sniper_card", class_required="狙击")])
    pool = cs.engine.shared_pool
    all_cards = pool.deck + pool.hand + pool.discard + pool.exhaust
    added = [c for c in all_cards if c.card_id == "test_sniper_card"]
    assert len(added) == 1
    assert added[0].owner == "Medic"  # 无匹配 → 第一个角色
