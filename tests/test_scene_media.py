"""Presentation persistence, book ownership, authored events and real HTTP rollback."""
import copy
import sys
from pathlib import Path
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from test_story_tree_full_flow import flow
from plot_graphs import validate_graph, save_graph, load_graph
from scene_media import initialize_presentation, valid_scene_asset, validate_visual
from story_outline import normalize_outline
from story_rules import rule_key


def visual(asset="plots/fixture_plot/art/room.png", role="background"):
    return {"kind": "image", "asset": asset, "role": role, "fit": "cover",
            "position": [50, 50], "portraits": "hide" if role == "cg" else "show"}


def node(nid, beat, media, chapter=1):
    return {"id": nid, "type": "beat", "title": nid, "ref": {"chapter_idx": chapter, "beat_id": beat},
            "x": 0, "y": 0, "scene_media": media}


def event(eid, image, kind="enter", **trigger):
    return {"id": eid, "trigger": {"kind": kind, **trigger}, "repeat": "entry", "priority": 10,
            "actions": [{"kind": "set_visual", "visual": visual(image, "cg")}]}


@pytest.fixture
def media(flow):
    session = flow["session"]
    mgr = session.scene_manager._worldbook_manager
    book_id = session.overlay.get_worldbook_id()
    book = mgr.load(book_id)
    book.stat_fields = [{"key": "trust", "label": "信任", "type": "number", "default": 0}]
    mgr.save(book)
    # The fixture's temporary book root is exposed by the manager.
    import world_book
    art = Path(world_book._WORLDBOOKS_DIR) / "books" / book_id / "plots" / "fixture_plot" / "art"
    art.mkdir(parents=True, exist_ok=True)
    for name, color in (("room.png", "blue"), ("meeting.png", "red"), ("office.png", "green")):
        Image.new("RGB", (16, 9), color).save(art / name)
    def configure(nodes):
        graph = {"plot_id": "fixture_plot", "nodes": nodes, "edges": []}
        save_graph(mgr, book_id, graph)
        initialize_presentation(session, mgr)
    flow.update(configure=configure, art=art, manager=mgr, book_id=book_id)
    return flow


def test_asset_validation_and_reserved_actions():
    for bad in ("../secret.png", "plots/p/../s.png", "plots/p/%2e%2e/s.png",
                "/api/assets/plots/p/cg.png", "plots/p/cg.png?worldbook_id=other", "plots\\p\\a.png"):
        assert not valid_scene_asset(bad)
    assert valid_scene_asset("plots/彼岸双生/art/雨夜.png")
    with pytest.raises(ValueError, match="视频"):
        validate_visual({**visual(), "kind": "video"})
    doc = {"plot_id": "p", "nodes": [node("n", "b", {"events": [
        {**event("e", "plots/p/x.png"), "actions": [{"kind": "set_bgm", "asset": "audio/music.mp3"}]}]})], "edges": []}
    assert any("BGM" in e for e in validate_graph(doc))


def test_enter_cg_holds_across_empty_nodes_until_explicit_background(media):
    session, client, sid = media["session"], media["client"], media["sid"]
    media["configure"]([
        node("first", "beat_arrival", {"background": visual()}),
        node("meeting", "beat_intro_tension", {"events": [event("meeting", "plots/fixture_plot/art/meeting.png")]}),
        node("office", "beat_ch_2", {"background": visual("plots/fixture_plot/art/office.png")}, chapter=2)])
    def play(beat):
        session.overlay.jump_to_beat(beat)
        media["script_round"]("这是一段测试对白。", title="测试", summary="测试", branches=[])
        media["play"]()
        return client.get(f"/api/sessions/{sid}/stage?round={session.narration_count}").json
    room = play("beat_arrival")
    cg = play("beat_intro_tension")
    held = play("beat_convoy_fight")
    assert room["background"]["role"] == "background"
    assert cg["background"]["role"] == "cg" and cg["background"]["portraits"] == "hide"
    assert held["background"] == cg["background"]
    assert "stage-cg" not in held
    assert client.get(cg["background"]["url"]).status_code == 200
    media["art"].joinpath("meeting.png").unlink()
    save_graph(media["manager"], media["book_id"], {"plot_id": "fixture_plot", "nodes": [], "edges": []})
    assert client.get(f"/api/sessions/{sid}/stage?round=2").json["background"] == cg["background"]
    assert client.get(cg["background"]["url"]).status_code == 200
    office = play("beat_ch_2")
    assert office["background"]["role"] == "background" and office["background"]["portraits"] == "show"
    assert office["background"]["url"] != cg["background"]["url"]
    future_node = session.overlay.get_story_tree()["current_id"]
    rolled = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": "beat_intro_tension"})
    assert rolled.status_code == 200, rolled.json
    assert client.get(f"/api/sessions/{sid}/stage").json["background"] == cg["background"]
    revisited = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": future_node})
    assert revisited.status_code == 200, revisited.json
    assert client.get(f"/api/sessions/{sid}/stage").json["background"] == office["background"]


def test_choice_atomicity_retry_condition_edge_and_rollback(media):
    session, client, sid = media["session"], media["client"], media["sid"]
    outline = normalize_outline({"plot_id": "fixture_plot", "chapters": [{"id": "c", "beats": [
        {"id": "beat_gate", "choice_required": True, "branches": [
            {"label": "接受邀请", "target_beat_id": "beat_end",
             "effects": [{"kind": "stat", "key": "trust", "op": "add", "value": 1}]}]},
        {"id": "beat_end", "branches": []}]}]})
    session.overlay.set_story_outline(outline)
    key = rule_key(session.overlay.get_current_beat()["authored_branches"][0])
    choice_event = event("invitation", "plots/fixture_plot/art/meeting.png", "choice", choice_key=key)
    choice_event["repeat"] = "session"
    condition_event = event("trust", "plots/fixture_plot/art/office.png", "condition")
    condition_event["conditions"] = [{"kind": "stat", "key": "trust", "op": "gte", "value": 1}]
    condition_event["priority"] = 20
    media["configure"]([node("gate", "beat_gate", {"background": visual(), "events": [choice_event]}),
                        node("end", "beat_end", {"events": [condition_event]})])
    media["script_round"]("来到门前。", title="门前", summary="门前", branches=[])
    first = media["play"]()
    selected = next(b for b in first["branches"] if b["label"] == "接受邀请")
    def fail(*a, **k):
        raise RuntimeError("provider failure")
    session.scene_manager.narrate = fail
    failed = client.post(f"/api/sessions/{sid}/narrate-continue", json={"branch_id": selected["id"]})
    assert failed.status_code == 500
    runtime = copy.deepcopy(session.overlay._data["presentation"]["runtime"])
    assert set(runtime["receipts"]) == {"invitation", "trust:1"}
    assert runtime["visual"]["asset"].endswith("office.png")
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 1
    # Pending generation leaves the last playable frame visible.
    assert client.get(f"/api/sessions/{sid}/stage").json["background"]["role"] == "background"
    media["script_round"]("邀请已接受。", title="邀请", summary="邀请", branches=[])
    recovered = media["play"]("继续推进剧情")
    assert recovered
    assert session.overlay._data["presentation"]["runtime"]["receipts"] == runtime["receipts"]
    assert session.overlay.get_character_stats(session.player_identity)["trust"] == 1
    frame = client.get(f"/api/sessions/{sid}/stage?round=2").json
    assert frame["background"]["role"] == "cg"
    assert set(frame["scene_media"]["event_ids"]) == {"invitation", "trust"}
    root = session.overlay.get_story_tree()["root_id"]
    assert client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": root}).status_code == 200
    assert session.overlay._data["presentation"]["runtime"]["receipts"] == {}
    assert session.overlay.get_character_stats(session.player_identity) == {}


def test_graph_cas_and_duplicate_events(media):
    client = media["client"]
    url = "/api/plot-graphs/fixture_plot"
    media["configure"]([node("first", "beat_arrival", {"background": visual()})])
    doc = client.get(url, query_string={"book_id": media["book_id"]}).json["graph"]
    first = client.put(url, json={"book_id": media["book_id"], "graph": doc})
    assert first.status_code == 200, first.json
    stale = client.put(url, json={"book_id": media["book_id"], "graph": doc})
    assert stale.status_code == 409
    options = client.get(url + "/media-options", query_string={"book_id": media["book_id"]})
    assert options.status_code == 200 and "choices" in options.json
    cg_event = event("same", "plots/fixture_plot/art/meeting.png")
    errors = validate_graph({"plot_id": "fixture_plot", "nodes": [
        node("a", "beat_arrival", {"events": [cg_event]}),
        node("b", "beat_intro_tension", {"events": [cg_event]})], "edges": []})
    assert any("事件 ID 重复" in e for e in errors)


def test_chapter_repeat_counts_chapter_entries_and_future_roster_is_inactive(media):
    session = media["session"]
    chapter_event = event("chapter_trust", "plots/fixture_plot/art/meeting.png", "condition")
    chapter_event["conditions"] = [{"kind": "stat", "key": "trust", "op": "gte", "value": 1}]
    future_event = event("future_actor", "plots/fixture_plot/art/office.png", "condition")
    future_event["conditions"] = [{"kind": "stat", "actor": "未来角色", "key": "trust", "op": "gte", "value": 1}]
    media["configure"]([{"id": "chapter", "type": "chapter", "ref": {"chapter_idx": 1},
                         "title": "第一章", "x": 0, "y": 0,
                         "scene_media": {"events": [chapter_event, future_event]}}])
    def play(value, beat):
        session.overlay.set_character_stats(session.player_identity, {"trust": value})
        session.overlay.jump_to_beat(beat)
        media["script_round"]("测试。", title="测试", summary="测试", branches=[])
        media["play"]()
    play(1, "beat_arrival")
    play(0, "beat_arrival")
    play(1, "beat_intro_tension")
    receipts = session.overlay._data["presentation"]["runtime"]["receipts"]
    assert list(receipts) == ["chapter_trust:1"]


def test_pending_media_only_choice_requires_complete_node_rollback(media):
    session, client, sid = media["session"], media["client"], media["sid"]
    session.overlay.set_story_outline(normalize_outline({"plot_id": "fixture_plot", "chapters": [
        {"id": "c", "beats": [{"id": "beat_gate", "choice_required": True,
         "branches": [{"label": "接受邀请", "target_beat_id": "beat_end"}]}, {"id": "beat_end", "branches": []}]}]}))
    key = rule_key(session.overlay.get_current_beat()["authored_branches"][0])
    media["configure"]([node("gate", "beat_gate", {"background": visual(), "events": [
        event("choice", "plots/fixture_plot/art/meeting.png", "choice", choice_key=key)]})])
    media["script_round"]("门前。", title="门前", summary="门前", branches=[])
    selected = next(b for b in media["play"]()["branches"] if b["label"] == "接受邀请")
    session.scene_manager.narrate = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("provider failure"))
    assert client.post(f"/api/sessions/{sid}/narrate-continue", json={"branch_id": selected["id"]}).status_code == 500
    assert client.post(f"/api/sessions/{sid}/rollback", json={"round": 1}).status_code == 409
    media["script_round"]("已接受。", title="邀请", summary="邀请", branches=[])
    media["play"]("继续推进剧情")
    assert client.get(f"/api/sessions/{sid}/stage?round=2").json["background"]["role"] == "cg"


def test_export_import_rebinds_picture_to_new_session_id(media, tmp_path, monkeypatch):
    import session_export
    session, client, sid = media["session"], media["client"], media["sid"]
    media["configure"]([node("first", "beat_arrival", {"background": visual()})])
    media["script_round"]("抵达。", title="抵达", summary="抵达", branches=[])
    media["play"]()
    monkeypatch.setattr(session_export, "_SESSIONS_DIR", session.data_dir.parent.parent)
    monkeypatch.setattr(session_export, "_REPO_ROOT", media["manager"]._dir.parent.parent)
    bundle = tmp_path / "session.zip"
    session_export.export_session_zip(session.data_dir, session.to_dict(), bundle)
    media["art"].joinpath("room.png").unlink()
    result = session_export.import_session_zip(bundle, client.application._managers["session"])
    imported_id = result["id"]
    assert imported_id != sid
    frame = client.get(f"/api/sessions/{imported_id}/stage?round=1").json
    url = frame["background"]["url"]
    assert url.startswith(f"/api/sessions/{imported_id}/presentation-assets/")
    assert client.get(url).status_code == 200
    assert frame["scene_media"]["visual"]["asset"] == "plots/fixture_plot/art/room.png"
