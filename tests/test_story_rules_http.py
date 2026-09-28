"""Real Flask routes with scripted generation and isolated save data."""
import json
import copy

import pytest

from test_story_tree_full_flow import flow  # shared isolated Flask fixture
from story_outline import normalize_outline
from world_book import WorldBookEntry


@pytest.fixture
def story(flow):
    session = flow["session"]
    book = session.scene_manager._worldbook_manager.load(session.overlay.get_worldbook_id())
    book.stat_fields = [{"key": "trust", "label": "信任", "type": "number", "default": 2, "min": 0, "max": 10}]
    book.entries.append(WorldBookEntry(uid="proof", name="凭证", content="用于核对记录", category_id="items"))
    session.scene_manager._worldbook_manager.save(book)
    session.overlay.set_story_outline(normalize_outline({"plot_id": "fixture_plot", "chapters": [{
        "id": "first", "beats": [{"id": "beat_gate", "choice_required": True, "branches": [
            {"label": "交付凭证", "target_beat_id": "beat_end",
             "conditions": [{"kind": "stat", "key": "trust", "op": "gte", "value": 2}],
             "effects": [{"kind": "item", "item_id": "proof", "op": "remove"},
                         {"kind": "stat", "key": "trust", "op": "add", "value": 1}]},
            {"label": "保留凭证离开", "target_beat_id": "beat_end"}]},
            {"id": "beat_end", "branches": []}]}]}))
    session.scene_manager.add_item("proof", {"name": "凭证"})
    flow["script_round"]("来到门前", title="门前", summary="门前", branches=[])
    first = flow["play"]()
    flow["choice"] = next(b for x in [first] for b in x["branches"] if b["label"] == "交付凭证")
    flow["root_id"] = session.overlay.get_story_tree()["root_id"]
    return flow


def test_post_rules_prompt_panel_and_node_rollback(story):
    session, client, sid = story["session"], story["client"], story["sid"]
    choice = story["choice"]
    assert choice["available"] and "消耗凭证" in choice["effect_summary"]
    story["script_round"]("已经核对凭证", title="通过", summary="通过", branches=[])
    response = client.post(f"/api/sessions/{sid}/narrate-continue", json={"branch_id": choice["id"]})
    assert response.status_code == 200, response.get_json()
    assert session.overlay.get_current_beat_id() == "beat_end"
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 3
    assert client.get(f"/api/sessions/{sid}/items").get_json()["items"] == []
    assert "信任 3/10" in session.scene_manager._build_stats_block(None)
    assert client.post(f"/api/sessions/{sid}/narrate-continue", json={"branch_id": choice["id"]}).status_code == 409
    # History-only rollback must not leave effects behind while pretending success.
    assert client.post(f"/api/sessions/{sid}/rollback", json={"round": 1}).status_code == 409
    rolled = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": story["root_id"]})
    assert rolled.status_code == 200, rolled.get_json()
    assert session.overlay.get_current_beat_id() == "beat_gate"
    assert client.get(f"/api/sessions/{sid}/items").get_json()["items"][0]["id"] == "proof"
    assert session.overlay.get_character_stats(session.player_identity) == {}
    # Worldbook-only item entries can be opened in the inventory detail panel.
    detail = client.get(f"/api/sessions/{sid}/overrides/items/proof")
    assert detail.status_code == 200 and "核对" in detail.get_json()["content"]


def test_sse_rechecks_before_stream_and_guards_mutation(story):
    session, client, sid = story["session"], story["client"], story["sid"]
    choice = story["choice"]
    session.scene_manager.remove_item("proof")
    rejected = client.get(f"/api/sessions/{sid}/narrate", query_string={"branch_id": choice["id"]})
    assert rejected.status_code == 409
    assert session.narration_count == 1
    session.scene_manager.add_item("proof", {"name": "凭证"})
    session.scene_manager.narrate_stream = lambda *a, **k: iter([
        ("token", "核对"), ("done", ("核对完成", {}, None))])
    response = client.get(f"/api/sessions/{sid}/narrate", query_string={"branch_id": choice["id"]}, buffered=False)
    assert response.status_code == 200
    assert client.post(f"/api/sessions/{sid}/items/remove", json={"item_id": "proof"}).status_code == 409
    for action in ("switch", "load", "unload"):
        assert client.post(f"/api/sessions/{sid}/characters/{action}", json={"character": "角色"}).status_code == 409
    assert client.put(f"/api/sessions/{sid}/identity", json={"identity": "其他角色"}).status_code == 409
    assert client.delete(f"/api/sessions/{sid}").status_code == 409
    assert client.put(f"/api/sessions/{sid}/character-stats/玩家", json={"values": {"trust": 8}}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": story["root_id"]}).status_code == 409
    events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
    response.close()
    assert not any(e["type"] == "error" for e in events), events
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 3
    assert not session.overlay._narration_lock.locked()


def test_failed_generation_retry_does_not_repeat_effects(story):
    session, client, sid = story["session"], story["client"], story["sid"]
    choice = story["choice"]
    def fail(*a, **k):
        raise RuntimeError("scripted provider failure")
    session.scene_manager.narrate = fail
    failed = client.post(f"/api/sessions/{sid}/narrate-continue", json={"branch_id": choice["id"]})
    assert failed.status_code == 500
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 3
    assert client.post(f"/api/sessions/{sid}/deviation-check", json={}).status_code == 409
    deviation = session.overlay.apply_deviation_result({"deviated": True, "confidence": 1,
        "branch": {"title": "不能偏离已付费选择", "beats": [{"title": "错误落点"}]}})
    assert not deviation["applied"]
    assert session.overlay.get_current_beat_id() == "beat_end"
    story["script_round"]("重试后的叙述", title="已通过", summary="通过", branches=[])
    recovered = client.post(f"/api/sessions/{sid}/narrate-continue", json={"action": "继续推进剧情"})
    assert recovered.status_code == 200, recovered.get_json()
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 3
    assert not session.overlay._data.get("pending_story_choice")
    assert session.overlay.get_current_tree_node()["ref_beat_id"] == "beat_end"
    assert session.overlay.get_story_tree()["current_id"] != story["root_id"]
    root = session.overlay.get_tree_node(story["root_id"])
    assert root["state"]["scene_items"][0]["id"] == "proof"


def test_restore_scene_without_npcs_keeps_inventory_without_llm_probe(story):
    from session_manager import Session
    session = story["session"]
    assert session.scene_manager.get_scene_characters() == []
    session.scene_manager._scene_items = {}
    session._llm = None
    session.refresh_llm = lambda: pytest.fail("empty NPC roster must not probe the LLM")
    Session._restore_scene(session)
    assert session.scene_manager.get_scene_items()[0]["id"] == "proof"
    session.scene_manager._persist_scene()
    assert session.overlay.get_scene_state()["items"][0]["id"] == "proof"


@pytest.mark.parametrize("target_kind", ["incomplete_tree", "incomplete_history", "removed_beat"])
def test_rollback_preflight_never_truncates_history_or_resources(story, monkeypatch, target_kind):
    session, client, sid = story["session"], story["client"], story["sid"]
    story["script_round"]("选择之后", title="之后", summary="之后", branches=[])
    story["play"](branch_id=story["choice"]["id"])
    snapshot = copy.deepcopy(session.overlay.get_tree_node(story["root_id"])["state"])
    if target_kind == "incomplete_tree":
        del session.overlay.get_tree_node(story["root_id"])["state"]["scene_items"]
        target = story["root_id"]
    else:
        target = "beat_removed" if target_kind == "removed_beat" else "beat_gate"
        if target_kind == "incomplete_history":
            del snapshot["scene_items"]
        monkeypatch.setattr(session.overlay, "get_node_snapshot", lambda _: snapshot)
    before = (copy.deepcopy(session._narration_history), session.narration_count,
              copy.deepcopy(session.overlay._data), session.scene_manager.get_scene_items())
    rejected = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": target})
    assert rejected.status_code == 400, rejected.get_json()
    after = (session._narration_history, session.narration_count,
             session.overlay._data, session.scene_manager.get_scene_items())
    assert after == before
