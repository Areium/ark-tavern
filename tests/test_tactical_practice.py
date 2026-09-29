"""Standalone drill and book-scoped roster must not borrow other books' data."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import combat_resume
import data_paths
from blueprints import combat as combat_bp
from combat_practice import PRACTICE_ROOT, practice_party
from combat_session import CombatSession, CombatTestSessionManager


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(combat_resume, "TEST_RESUME_DIR", tmp_path / "resumes")
    app = Flask(__name__)
    app.config["TESTING"] = True
    combat_bp.register(app, {"session": SimpleNamespace(get_session=lambda _: None),
                             "document": None, "combat_test": CombatTestSessionManager()})
    return app.test_client()


def _book(root, book_id, hp=80, character="Hero"):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(json.dumps({"id": book_id, "enabled": True}), encoding="utf-8")
    node = json.loads((PRACTICE_ROOT / "combat/nodes/enc_builtin_training.json").read_text(encoding="utf-8"))
    node.update(node_id="same", name=book_id, worldbook_id=book_id)
    nodes = folder / "combat/nodes"
    nodes.mkdir(parents=True)
    (nodes / "same.json").write_text(json.dumps(node), encoding="utf-8")
    actor = folder / "characters" / character
    actor.mkdir(parents=True)
    (actor / "index.md").write_text(
        f"---\nname: {character}\nclass: 近卫\ncombat_stats:\n  hp: {hp}\n---\n", encoding="utf-8")
    cards = folder / "classes/近卫"
    cards.mkdir(parents=True)
    (cards / "cards.json").write_bytes((PRACTICE_ROOT / "classes/近卫/cards.json").read_bytes())
    return folder


def test_empty_install_drill_starts_moves_ends_turn_and_resumes(client, tmp_path):
    catalog = client.get("/api/combat/practice").get_json()
    assert catalog["books"] == []
    assert catalog["nodes"][0]["node_id"] == "enc_builtin_training"
    assert catalog["characters"] == [meta["name"] for meta in practice_party()]
    response = client.post("/api/combat/test/start", json={
        "practice_source": "builtin", "node_id": catalog["nodes"][0]["node_id"],
        "characters": catalog["characters"]})
    assert response.status_code == 200, response.get_json()
    payload = response.get_json()
    state, test_id = payload["state"], payload["test_id"]
    assert not state["battle_over"]
    assert [u["name"] for u in state["units"] if u["team"] == "player"] == catalog["characters"]
    assert len([u for u in state["units"] if u["team"] == "enemy"]) == 2
    assert state["shared_hand"]
    assert all(card["owner"] in catalog["characters"] for card in state["shared_hand"])
    moved = client.post(f"/api/combat/test/{test_id}/action", json={
        "action": "move", "unit_id": state["valid_moves_unit"], "target": state["valid_moves"][0]})
    assert moved.status_code == 200, moved.get_json()
    ended = client.post(f"/api/combat/test/{test_id}/end-turn")
    assert ended.status_code == 200, ended.get_json()
    before = client.get(f"/api/combat/test/{test_id}/state").get_json()
    assert client.post(f"/api/combat/test/{test_id}/suspend").status_code == 200
    resumed = client.post(f"/api/combat/test/{test_id}/resume")
    assert resumed.status_code == 200, resumed.get_json()
    assert resumed.get_json()["state"] == before
    assert not (tmp_path / "data/worldbooks").exists()


def test_builtin_content_is_not_implicitly_available_to_story(client):
    with pytest.raises(ValueError, match="战斗节点不存在"):
        CombatSession(book_ids=[]).start("enc_builtin_training", character_names=["近卫训练员"])


def test_each_battle_has_its_own_resource_cache_identity(client, tmp_path):
    _book(tmp_path, "first")
    first = CombatSession("same-session", book_ids=["first"])
    second = CombatSession("same-session", book_ids=["first"])
    one = first.start("same", character_names=["Hero"])
    two = second.start("same", character_names=["Hero"])
    assert one["battle_id"] != two["battle_id"]
    assert CombatSession.from_suspend_snapshot(first.suspend_snapshot()).get_state()["battle_id"] == one["battle_id"]


def test_book_catalog_does_not_require_narrative_cards_or_mix_rosters(client, tmp_path):
    _book(tmp_path, "first", character="First")
    _book(tmp_path, "second", character="Second")
    payload = client.get("/api/combat/practice?book_id=second").get_json()
    assert payload["characters"] == ["Second"]
    assert [(node["node_id"], node["worldbook_id"]) for node in payload["nodes"]] == [("same", "second")]


def test_selected_book_survives_start_and_resume_with_same_named_content(client, tmp_path):
    _book(tmp_path, "first", hp=40)
    _book(tmp_path, "second", hp=155)
    response = client.post("/api/combat/test/start", json={
        "node_id": "same", "characters": ["Hero"], "worldbook_id": "second"})
    assert response.status_code == 200, response.get_json()
    data = response.get_json()
    assert next(u for u in data["state"]["units"] if u["team"] == "player")["max_hp"] == 155
    test_id = data["test_id"]
    assert client.post(f"/api/combat/test/{test_id}/suspend").status_code == 200
    state = client.post(f"/api/combat/test/{test_id}/resume").get_json()["state"]
    assert state == data["state"]


@pytest.mark.parametrize("body", [
    {"node_id": "same", "characters": ["Hero", "Missing"], "worldbook_id": "first"},
    {"node_id": "same", "characters": ["Hero"], "worldbook_id": "disabled"},
    {"node_id": "enc_builtin_training", "characters": ["Hero"], "practice_source": "builtin"},
    {"node_id": "same", "characters": ["Hero"], "practice_source": "builtin", "worldbook_id": "first"},
])
def test_invalid_selection_fails_instead_of_silently_substituting_team(client, tmp_path, body):
    _book(tmp_path, "first")
    response = client.post("/api/combat/test/start", json=body)
    assert response.status_code in (400, 404), response.get_json()
    assert "error" in response.get_json()


def test_duplicate_selection_is_one_unit_and_inline_enemies_take_precedence(client, tmp_path):
    _book(tmp_path, "first")
    combat = CombatSession(book_ids=["first"])
    state = combat.start("same", character_names=["Hero", "Hero"], custom_enemies={
        "训练靶机": {"name": "wrong", "combat_stats": {"hp": 9999}}})
    assert len([unit for unit in state["units"] if unit["team"] == "player"]) == 1
    assert {unit["max_hp"] for unit in state["units"] if unit["team"] == "enemy"} == {70}


def test_display_name_is_not_the_identity_or_media_source(client, tmp_path):
    import frontmatter
    first = _book(tmp_path, "first", hp=40, character="actor-id")
    second = _book(tmp_path, "second", hp=155, character="actor-id")
    for folder, display, crop in ((first, "Wrong", 10), (second, "Display Name", 35)):
        path = folder / "characters/actor-id/index.md"
        meta = frontmatter.load(path)
        meta["name"] = display
        meta["worldbook_id"] = "first"  # stale pack metadata must not select the owner
        for key, value in {"x": crop, "y": 0, "w": 50, "h": 100}.items():
            meta[f"card_face_crop_{key}"] = value
        path.write_text(frontmatter.dumps(meta), encoding="utf-8")
        for kind in ("avatar", "skin"):
            (path.parent / kind).mkdir()
            (path.parent / kind / "default.png").write_bytes(b"image placeholder")
    combat = CombatSession("test-not-a-session", book_ids=["second"])
    state = combat.start("same", character_names=["actor-id"])
    unit = next(u for u in state["units"] if u["team"] == "player")
    assert (unit["unit_id"], unit["character_id"], unit["name"], unit["worldbook_id"]) == (
        "actor-id", "actor-id", "Display Name", "second")
    for key in ("skin_url", "avatar_url", "portrait_url"):
        assert unit[key].startswith("/api/characters/actor-id/")
        assert unit[key].endswith("?worldbook_id=second")
        assert "test-not-a-session" not in unit[key]
    assert unit["skin_crop"]["x"] == 35
    restored = CombatSession.from_suspend_snapshot(combat.suspend_snapshot())
    assert restored.book_ids == ["second"]
    assert restored.get_state() == state
    # Editing/removing a crop in the selected source must not revive the first book's crop.
    path = second / "characters/actor-id/index.md"
    meta = frontmatter.load(path)
    del meta["card_face_crop_x"]
    path.write_text(frontmatter.dumps(meta), encoding="utf-8")
    assert next(u for u in restored.get_state()["units"] if u["team"] == "player")["skin_crop"] is None


def test_duplicate_display_names_are_rejected_before_units_overwrite_each_other(client, tmp_path):
    _book(tmp_path, "first")
    combat = CombatSession(book_ids=["first"])
    with pytest.raises(ValueError, match="显示名重复"):
        combat.start("same", character_metas=[{"name": "Same", "character_id": "one"},
                                              {"name": "Same", "character_id": "two"}])


def test_renamed_actor_settlement_writes_to_identity_not_display_name(client, tmp_path, monkeypatch):
    import session_overlay
    from combat_settlement import build_settlement, apply_settlement
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    overlay = session_overlay.SessionOverlay("identity-test")
    overlay.set_character_overrides("actor-id", {"progress": {"level": 3, "xp": 9}})
    _book(tmp_path, "first", character="actor-id")
    session = SimpleNamespace(overlay=overlay)
    combat = CombatSession(book_ids=["first"])
    combat.start("same", character_names=["actor-id"])
    snapshot = combat.snapshot()
    snapshot["character_metas"][0]["name"] = "Displayed Name"
    snapshot["engine_state"]["winner"] = "player"
    monkeypatch.setattr("combat_settlement.roll_rewards", lambda *args, **kwargs: {
        "xp": 30, "items": [], "enemy_xp": 0})
    settlement = build_settlement(session, snapshot, loader=combat.loader)
    row = settlement["characters"][0]
    assert (row["name"], row["character_id"], row["level_before"]) == ("Displayed Name", "actor-id", 3)
    apply_settlement(session, {"data": settlement})
    assert overlay.get_character_overrides("actor-id")["progress"]["xp"] == 39
    assert not overlay.has_character_overrides("Displayed Name")


def test_production_settlement_default_and_reward_cards_use_session_book(client, tmp_path, monkeypatch):
    import session_overlay
    from combat_settlement import build_settlement
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    for owner, xp in (("first", 777), ("second", 17)):
        folder = _book(tmp_path, owner)
        path = folder / "combat/nodes/same.json"
        node = json.loads(path.read_text(encoding="utf-8"))
        node["rewards"]["xp"] = xp
        path.write_text(json.dumps(node), encoding="utf-8")
        path = folder / "classes/近卫/cards.json"
        cards = json.loads(path.read_text(encoding="utf-8"))
        for card in cards["cards"]:
            card["card_id"] = owner + "_" + card["card_id"]
        path.write_text(json.dumps(cards), encoding="utf-8")
    overlay = session_overlay.SessionOverlay("scope-rewards")
    overlay._data["worldbook_ids"] = ["second"]
    combat = CombatSession(book_ids=["second"])
    combat.start("same", character_names=["Hero"])
    snapshot = combat.snapshot()
    snapshot["engine_state"]["winner"] = "player"
    result = build_settlement(SimpleNamespace(overlay=overlay), snapshot)
    assert result["rewards"]["xp_total"] == 17
    assert result["rewards"]["cards"]
    assert all(card["card_id"].startswith("second_") for card in result["rewards"]["cards"])


def test_imported_session_restore_rebinds_all_media_urls(client, tmp_path):
    _book(tmp_path, "first")
    for sid in ("old-session", "new-session"):
        media = tmp_path / sid / "resources/characters/Hero"
        media.mkdir(parents=True)
        for kind in ("avatar", "skin", "card_face"):
            (media / f"{kind}.png").write_bytes(b"image placeholder")
    combat = CombatSession("old-session", book_ids=["first"])
    combat.start("same", character_names=["Hero"], session_dir=str(tmp_path / "old-session"))
    restored = CombatSession.from_suspend_snapshot(
        combat.suspend_snapshot(), "new-session", session_dir=str(tmp_path / "new-session"))
    unit = next(u for u in restored.get_state()["units"] if u["team"] == "player")
    for key in ("skin_url", "avatar_url", "portrait_url"):
        assert unit[key].endswith("?session_id=new-session")
