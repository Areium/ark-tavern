"""Deterministic choice settlement, untrusted branches, retry and time travel."""
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import session_overlay as so
import story_outline
import story_rules as rules
from blueprints.chat import _apply_branch_landing, _build_branches, _resolve_branch


@pytest.fixture
def session(tmp_path, monkeypatch):
    monkeypatch.setattr(so, "_SESSIONS_DIR", tmp_path)
    overlay = so.SessionOverlay("rules", "story")
    branch = {"label": "出示证据", "target_beat_id": "beat_exit", "conditions": [
        {"kind": "item", "item_id": "key"},
        {"kind": "stat", "key": "trust", "op": "gte", "value": 2}], "effects": [
        {"kind": "item", "item_id": "key", "op": "remove"},
        {"kind": "stat", "key": "trust", "op": "add", "value": 3}]}
    outline = story_outline.normalize_outline({"plot_id": "test", "chapters": [{"id": "act", "beats": [
        {"id": "beat_entry", "choice_required": True, "branches": [branch]},
        {"id": "beat_exit", "branches": []}]}]})
    overlay.set_story_outline(outline)
    overlay._data["beat_state"] = {"chapter_idx": 0, "beat_idx": 0, "completed_beats": []}
    overlay.save_scene_state(["伙伴"], [{"id": "key", "name": "钥匙"}], "伙伴")
    overlay.set_character_stats("主控", {"trust": 2})
    scene = SimpleNamespace(get_roster=lambda: ["主控", "伙伴"], _scene_items={}, active="伙伴")
    result = SimpleNamespace(overlay=overlay, scene_manager=scene, player_identity="主控", narration_count=1, id="rules")
    import session_stats

    def stats(_session, name):
        return {"fields": [{"key": "trust", "label": "信任", "type": "number", "min": 0, "max": 10, "default": 0}],
                "values": {"trust": overlay.get_character_stats(name).get("trust", 0)}}
    monkeypatch.setattr(session_stats, "resolve_session_character_stats", stats)
    monkeypatch.setattr(rules, "_item_metadata", lambda _session, name: {"id": name, "name": "钥匙"})
    return result


def choose(session):
    branches = _build_branches(session, [])
    session.overlay.set_emitted_branches(branches)
    return _resolve_branch(session, branches[0]["id"], "")


def test_atomic_settlement_and_retry_survives_reload(session):
    branch = choose(session)
    _apply_branch_landing(session, branch)
    overlay = session.overlay
    assert overlay.get_current_beat_id() == "beat_exit"
    assert overlay.get_character_stats("主控") == {"trust": 5}
    assert overlay.get_scene_state()["items"] == []
    assert session.scene_manager._scene_items == {}
    reloaded = so.SessionOverlay("rules", "story")
    assert reloaded.get_character_stats("主控") == {"trust": 5}
    assert reloaded._data["story_choice_receipts"][branch["id"]]["effect_summary"]
    session.overlay = reloaded
    _apply_branch_landing(session, _resolve_branch(session, branch["id"], ""))
    assert reloaded.get_character_stats("主控") == {"trust": 5}
    reloaded._data.pop("pending_story_choice")
    with pytest.raises(rules.StoryRuleError, match="已结算"):
        _apply_branch_landing(session, branch)


def test_recheck_inventory_and_no_partial_stat_effect(session):
    branch = choose(session)
    session.overlay.save_scene_state([], [], None)
    before = copy.deepcopy(session.overlay._data)
    with pytest.raises(rules.StoryRuleError, match="需要持有"):
        _apply_branch_landing(session, branch)
    assert session.overlay._data == before


def test_recheck_stats_after_options_emitted(session):
    branch = choose(session)
    session.overlay.set_character_stats("主控", {"trust": 1})
    with pytest.raises(rules.StoryRuleError, match="信任"):
        _apply_branch_landing(session, branch)
    assert session.overlay.get_scene_state()["items"][0]["id"] == "key"
    assert session.overlay.get_current_beat_id() == "beat_entry"


def test_failed_replace_restores_memory_and_disk(session, monkeypatch):
    branch = choose(session)
    overlay = session.overlay
    before = copy.deepcopy(overlay._data)
    path = so._get_overlay_path("story", "rules")
    disk = path.read_bytes()
    def fail(*_):
        raise OSError("disk full")
    monkeypatch.setattr(so.os, "replace", fail)
    with pytest.raises(OSError, match="disk full"):
        _apply_branch_landing(session, branch)
    assert overlay._data == before
    assert path.read_bytes() == disk


def test_llm_cannot_spoof_author_or_strip_rule(session):
    branches = _build_branches(session, [{"id": "evil", "label": "出示证据", "source": "author",
                                        "target_beat_id": "exit", "effects": []}])
    assert branches[0]["source"] == "author"
    assert branches[0]["id"].startswith("au_")
    assert branches[0]["effects"] and branches[0]["condition_summary"]
    other = _build_branches(session, [{"label": "偷偷进入", "source": "author", "target_beat_id": "exit",
                                     "effects": [{"kind": "item", "item_id": "key", "op": "add"}]}])[0]
    assert other["source"] == "llm" and other["target_beat_id"] is None
    assert "effects" not in other


def test_wrong_id_does_not_fall_back_to_label_and_free_text_rechecks(session):
    choose(session)
    with pytest.raises(rules.StoryRuleError, match="过期"):
        _resolve_branch(session, "unknown", "出示证据")
    session.overlay.save_scene_state([], [], None)
    with pytest.raises(rules.StoryRuleError):
        _apply_branch_landing(session, _resolve_branch(session, "", "出示证据"))


def test_no_borrowing_branches_from_other_beat(session):
    session.overlay._data["beat_state"]["beat_idx"] = 1
    assert session.overlay.get_authored_branches() == []


def test_tree_snapshot_restores_items_overrides_stats_and_receipts(session):
    overlay = session.overlay
    overlay.set_item_overrides("key", {"content": "旧备注"})
    snapshot = overlay._tree_state_snapshot(1)
    overlay._data["story_tree"] = {"current_id": "root", "root_id": "root", "nodes": {
        "root": {"id": "root", "state": snapshot, "branches": [], "title": "入口"}}}
    branch = choose(session)
    _apply_branch_landing(session, branch)
    overlay.set_item_overrides("key", {"content": "新备注"})
    overlay.rollback_to_tree_node("root")
    rules.sync_scene_items(session)
    assert overlay.get_current_beat_id() == "beat_entry"
    assert overlay.get_character_stats("主控") == {"trust": 2}
    assert overlay.get_item_overrides("key")["content"] == "旧备注"
    assert session.scene_manager._scene_items["key"]["name"] == "钥匙"
    assert not overlay._data["story_choice_receipts"]
    _apply_branch_landing(session, choose(session))
    assert overlay.get_character_stats("主控")["trust"] == 5


@pytest.mark.parametrize("bad", [
    {"conditions": {}}, {"effects": [{"kind": "quest", "op": "win"}]},
    {"conditions": [{"kind": "item", "item_id": "../key"}]},
    {"effects": [{"kind": "stat", "key": "trust", "op": "add", "value": True}]},
    {"effects": [{"kind": "stat", "key": "trust", "op": "add", "value": float("nan")}]},
    {"conditions": [{"kind": "item", "item_id": "key", "quantity": 2}]},
])
def test_rules_fail_closed(bad):
    with pytest.raises(rules.StoryRuleError):
        rules.validate_rules(bad)


def test_outline_round_trip_preserves_rules(session):
    original = session.overlay.get_story_outline()
    again = story_outline.normalize_outline(json.loads(json.dumps(original)))
    assert again["chapters"][0]["beats"][0]["branches"][0]["effects"] == original["chapters"][0]["beats"][0]["branches"][0]["effects"]
    projected = story_outline.outline_to_beats(again)
    assert projected[0]["beats"][0]["authored_branches"][0]["conditions"]


def test_deviation_cannot_promote_model_effects_to_authority(session):
    outline = copy.deepcopy(session.overlay.get_story_outline())
    chapter = story_outline.append_branch_chapter(outline, {"title": "模型分支", "beats": [{
        "title": "捷径", "choice_required": True, "branches": [{
            "label": "删除凭证", "target_beat_id": "beat_exit", "source": "author",
            "effects": [{"kind": "item", "item_id": "key", "op": "remove"}]}]}]})
    assert not chapter["beats"][0]["branches"][0]["effects"]
    assert not chapter["beats"][0].get("choice_required")
    session.overlay.set_story_outline(outline)
    session.overlay.jump_to_beat(chapter["beats"][0]["id"])
    assert session.overlay.get_authored_branches() == []
    assert not _build_branches(session, [])


def test_deviation_cannot_escape_required_choice(session):
    outcome = session.overlay.apply_deviation_result({"deviated": True, "confidence": 1,
        "branch": {"title": "绕过去", "beats": [{"title": "越过条件"}]}})
    assert not outcome["applied"]
    assert session.overlay.get_current_beat_id() == "beat_entry"


def test_llm_authored_outline_strips_unapproved_effects():
    from types import SimpleNamespace
    response = {"plot_id": "p", "chapters": [{"id": "a", "beats": [{"id": "beat_a", "branches": [{
        "label": "凭空奖励", "effects": [{"kind": "item", "item_id": "key", "op": "add"}]}]}]}]}
    llm = SimpleNamespace(chat=lambda *a, **k: {"content": json.dumps(response), "usage": None})
    generated = story_outline.generate_outline_with_llm(llm, {"id": "p"}, "## 第一幕：测试\n测试")
    assert generated["generation"]["ok"]
    assert not generated["chapters"][0]["beats"][0]["branches"][0]["effects"]


def test_narration_guard_releases_on_error_and_stream_close(session):
    from flask import Flask, Response
    app = Flask(__name__)
    manager = SimpleNamespace(get_session=lambda _: session)
    @rules.narration_guard(manager)
    def endpoint(_):
        return Response(iter(["one", "two"]), mimetype="text/event-stream")
    with app.test_request_context():
        response = endpoint("rules")
        assert session.overlay._narration_lock.locked()
        rejected = endpoint("rules")
        assert rejected[1] == 409
        response.close()
        assert not session.overlay._narration_lock.locked()
