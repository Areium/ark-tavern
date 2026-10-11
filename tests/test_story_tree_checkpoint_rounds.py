"""Exact-round story checkpoints; all storage belongs to temporary fixture sessions."""
import copy

import pytest

from test_story_tree_nodes import overlay
from test_story_tree_full_flow import flow
from session_overlay import SessionOverlay


def _frame(round_num, beat_id, tag):
    return {"runtime": {"anchor": tag, "event_ids": [tag]},
            "background": {"source": "graph", "bg_id": tag},
            "environment": {"location": tag, "weather": "", "time": "", "atmosphere": []},
            "scene_media": {"round": round_num, "chapter_idx": 1, "beat_id": beat_id}}


def _overlay_step(ov, round_num, tag, *, branch=None, beat_id="beat_arrival"):
    frame = _frame(round_num, beat_id, tag)
    ov._data["presentation"] = {"runtime": copy.deepcopy(frame["runtime"]),
                                "frames": {str(round_num): frame}}
    return ov.commit_tree_step(narrative=f"{tag}正文", summary=f"{tag}概要", title=tag,
                               branches=[{"label": f"{tag}选项"}], branch=branch, round_num=round_num)


def _session_step(session, tag, *, branch=None):
    ov = session.overlay
    session.environment.set_location(tag)
    session.persist_environment()
    ov._data.setdefault("scene", {})["items"] = [{"id": f"item_{tag}", "name": tag}]
    ov._data["items"] = {f"item_{tag}": {"count": session.narration_count + 1}}
    beat_id = ov.get_current_beat_id()
    chapter_idx = int(ov.get_beat_state().get("chapter_idx", 0)) + 1
    session.add_narration(f"{tag}正文", f"{tag}行动", beat_id=beat_id, chapter_idx=chapter_idx)
    ov.append_plot_log(f"{tag}日志")
    return ov.commit_tree_step(narrative=f"{tag}正文", summary=f"{tag}概要", title=tag,
                               branches=[{"label": f"{tag}选项", "intent": tag}], branch=branch,
                               round_num=session.narration_count)


def test_round_checkpoint_reload_and_real_api_restore(flow):
    session, client, sid = flow["session"], flow["client"], flow["sid"]
    a = copy.deepcopy(_session_step(session, "A"))
    a_log = session.overlay._plot_log_entries()
    session.overlay.advance_beat()
    b = copy.deepcopy(_session_step(session, "B"))  # Same runtime node, different authored beat.
    checkpoint_id = SessionOverlay._tree_checkpoint_id(a)
    b_checkpoint_id = SessionOverlay._tree_checkpoint_id(b)
    reloaded = SessionOverlay(sid, "story")
    session.overlay = reloaded
    session.scene_manager._overlay = reloaded
    session.wiki_context.overlay = reloaded
    saved = copy.deepcopy(reloaded.get_story_tree()["checkpoints"][checkpoint_id])
    assert saved["node"] == a
    before = copy.deepcopy(reloaded._data)
    view = client.get(f"/api/sessions/{sid}/story-state").get_json()["tree"]
    assert reloaded._data == before, "GET must not migrate or rewrite the saved tree"
    checkpoint = next(n for n in view["checkpoints"] if n["id"] == checkpoint_id)
    assert checkpoint["runtime_node_id"] == "n_root"
    assert checkpoint["checkpoint_id"] == checkpoint_id
    assert checkpoint["snapshot_id"] == checkpoint_id
    assert view["current_node"]["snapshot_id"] == b_checkpoint_id
    assert "checkpoint_id" not in view["current_node"]
    assert checkpoint["state"] == "path"
    assert checkpoint["presentation"] == {"round": 1, "chapter_idx": 1, "beat_id": "beat_arrival"}
    assert checkpoint["rollback_unavailable_reason"] == ""
    assert view["current_node"]["presentation"]["beat_id"] == "beat_intro_tension"

    future = _session_step(session, "Future", branch={"label": "B选项"})
    result = client.post(f"/api/sessions/{sid}/rollback-node",
                         json={"node_id": "n_root", "checkpoint_id": checkpoint_id})
    assert result.status_code == 200, result.get_json()
    data = result.get_json()
    assert data["target_round"] == data["narration_count"] == session.narration_count == 1
    assert data["checkpoint_id"] == checkpoint_id
    assert session.environment.location == "A"
    assert reloaded.get_scene_state()["items"] == a["state"]["scene_items"]
    assert reloaded._data["items"] == a["state"]["items"]
    assert reloaded.get_story_tree()["current_id"] == "n_root"
    restored = reloaded.get_tree_node("n_root")
    for field in ("title", "content", "summary", "branches", "state"):
        assert restored[field] == a[field]
    assert future["id"] in restored["children"]
    assert future["id"] in reloaded.get_story_tree()["nodes"]
    assert reloaded.get_story_tree()["checkpoints"][checkpoint_id] == saved
    assert b_checkpoint_id in reloaded.get_story_tree()["checkpoints"], "rollback also preserves displaced latest"
    assert reloaded._data["presentation"]["frames"]["1"] == a["state"]["presentation_frame"]
    assert reloaded._plot_log_entries() == a_log
    assert len(session._narration_history) == 1
    disk = SessionOverlay(sid, "story")
    assert disk.get_tree_node("n_root")["content"] == "A正文"
    assert disk.get_story_tree()["checkpoints"][checkpoint_id] == saved

    # Future records remain visible, but cannot fabricate the history already truncated above.
    before_data = copy.deepcopy(reloaded._data)
    before_files = {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()}
    for payload in ({"node_id": "n_root", "checkpoint_id": b_checkpoint_id},
                    {"node_id": future["id"]}):
        rejected = client.post(f"/api/sessions/{sid}/rollback-node", json=payload)
        assert rejected.status_code == 400
        assert rejected.get_json()["error"] == "该存档在当前进度之后，无法回档"
        assert reloaded._data == before_data
        assert session.narration_count == 1
        assert {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()} == before_files


def test_off_path_same_round_frame_is_frozen_and_revisit_does_not_pollute(overlay):
    _overlay_step(overlay, 1, "Root")
    a = copy.deepcopy(_overlay_step(overlay, 2, "A", branch={"label": "A"}))
    overlay.rollback_to_tree_node("n_root")
    _overlay_step(overlay, 2, "B", branch={"label": "B"})
    assert overlay._data["presentation"]["frames"]["2"]["runtime"]["anchor"] == "B"
    # Re-enter A without replacing its old state; freeze uses A's stored frame, never live round 2.
    overlay.get_story_tree()["current_id"] = a["id"]
    _overlay_step(overlay, 3, "Anew")
    checkpoint_id = SessionOverlay._tree_checkpoint_id(a)
    record = copy.deepcopy(overlay.get_story_tree()["checkpoints"][checkpoint_id])
    assert record["node"] == a
    returned = overlay.get_tree_node_for_rollback(a["id"], checkpoint_id)
    returned["state"]["presentation_frame"]["runtime"]["anchor"] = "corrupted caller copy"
    overlay.rollback_to_tree_node("n_root")
    view = next(n for n in overlay.build_tree_state()["checkpoints"] if n["id"] == checkpoint_id)
    assert view["state"] == "visited"
    assert view["presentation"]["round"] == 2
    _overlay_step(overlay, 4, "Revisit", branch={"label": "A"})
    assert overlay.get_story_tree()["checkpoints"][checkpoint_id] == record
    assert any(r["node_id"] == a["id"] and r["node"]["state"]["round_end"] == 3
               for r in overlay.get_story_tree()["checkpoints"].values())
    overlay.rollback_to_tree_node(a["id"], checkpoint_id=checkpoint_id)
    assert overlay.get_tree_node(a["id"])["content"] == "A正文"
    assert overlay.get_story_tree()["checkpoints"][checkpoint_id] == record


def test_same_round_repeat_and_combat_reuse_freeze_only_replaced_round(overlay):
    overlay.commit_tree_step(narrative="first", round_num=1)
    overlay.commit_tree_step(narrative="same-round revision", round_num=1)
    assert overlay.get_story_tree().get("checkpoints", {}) == {}
    root = overlay.get_tree_node("n_root")
    combat = overlay._attach_combat_node(overlay.get_story_tree(), root, "battle", "Battle", 1)
    original = copy.deepcopy(combat)
    overlay._attach_combat_node(overlay.get_story_tree(), root, "battle", "Battle", 2)
    assert overlay.get_story_tree()["checkpoints"][SessionOverlay._tree_checkpoint_id(original)]["node"] == original
    overlay._attach_combat_node(overlay.get_story_tree(), root, "battle", "Battle", 2)
    assert len(overlay.get_story_tree()["checkpoints"]) == 1


@pytest.mark.parametrize("invalid", ["unknown", "wrong_owner", "wrong_raw_id", "missing_node",
                                    "runtime", "scene_media", "background", "environment", "round", "empty"])
def test_invalid_checkpoint_rejected_before_any_file_write(flow, invalid):
    session, client, sid = flow["session"], flow["client"], flow["sid"]
    _session_step(session, "A")
    _session_step(session, "B")
    tree = session.overlay.get_story_tree()
    checkpoint_id = next(iter(tree["checkpoints"]))
    record = tree["checkpoints"][checkpoint_id]
    if invalid == "unknown":
        checkpoint_id = "n_root:missing"
    elif invalid == "wrong_owner":
        record["node_id"] = "different-node"
    elif invalid == "wrong_raw_id":
        record["node"]["id"] = "different-node"
    elif invalid == "missing_node":
        del tree["nodes"]["n_root"]
    else:
        frame = record["node"]["state"]["presentation_frame"]
        if invalid == "round":
            frame["scene_media"]["round"] = 2
        elif invalid == "empty":
            record["node"]["state"]["presentation_frame"] = {}
        else:
            del frame[invalid]
        view = next(n for n in session.overlay.build_tree_state()["checkpoints"] if n["id"] == checkpoint_id)
        assert view["rollback_unavailable_reason"]
    session.overlay._save()
    before_data = copy.deepcopy(session.overlay._data)
    before_files = {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()}
    before_history = copy.deepcopy(session._narration_history)
    result = client.post(f"/api/sessions/{sid}/rollback-node",
                         json={"node_id": "n_root", "checkpoint_id": checkpoint_id})
    assert result.status_code == 400, result.get_json()
    assert session.overlay._data == before_data
    assert session._narration_history == before_history and session.narration_count == 2
    after_files = {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()}
    assert after_files == before_files


@pytest.mark.parametrize("checkpoint_id", ["", 12, [], {}])
def test_api_requires_nonempty_checkpoint_string(flow, checkpoint_id):
    result = flow["client"].post(f"/api/sessions/{flow['sid']}/rollback-node",
                                json={"node_id": "n_root", "checkpoint_id": checkpoint_id})
    assert result.status_code == 400


def test_replayed_same_round_replaces_prior_trajectory_checkpoint(flow):
    session, client, sid = flow["session"], flow["client"], flow["sid"]
    a = copy.deepcopy(_session_step(session, "A"))
    b = copy.deepcopy(_session_step(session, "B"))
    _session_step(session, "C")
    a_id, b_id = (SessionOverlay._tree_checkpoint_id(n) for n in (a, b))
    rolled = client.post(f"/api/sessions/{sid}/rollback-node",
                         json={"node_id": "n_root", "checkpoint_id": a_id})
    assert rolled.status_code == 200, rolled.json
    d = copy.deepcopy(_session_step(session, "D"))
    _session_step(session, "E")
    d_id = SessionOverlay._tree_checkpoint_id(d)
    assert b_id != d_id
    checkpoints = session.overlay.get_story_tree()["checkpoints"]
    assert b_id not in checkpoints
    original_d = copy.deepcopy(checkpoints[d_id])
    state = client.get(f"/api/sessions/{sid}/story-state").json["tree"]
    round_two = [n for n in state["checkpoints"]
                 if n["runtime_node_id"] == "n_root" and n["round_end"] == 2]
    assert [n["snapshot_id"] for n in round_two] == [d_id]
    assert [n["checkpoint_id"] for n in round_two] == [d_id]
    before_data = copy.deepcopy(session.overlay._data)
    before_history = copy.deepcopy(session._narration_history)
    before_files = {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()}
    stale = client.post(f"/api/sessions/{sid}/rollback-node",
                        json={"node_id": "n_root", "checkpoint_id": b_id})
    assert stale.status_code == 400, stale.json
    assert session.overlay._data == before_data
    assert session._narration_history == before_history and session.narration_count == 3
    assert {str(p): p.read_bytes() for p in session.data_dir.rglob("*") if p.is_file()} == before_files
    result = client.post(f"/api/sessions/{sid}/rollback-node",
                         json={"node_id": "n_root", "checkpoint_id": d_id})
    assert result.status_code == 200, result.json
    assert result.json["target_round"] == session.narration_count == 2
    node = session.overlay.get_tree_node("n_root")
    for field in ("title", "content", "summary", "branches", "state"):
        assert node[field] == d[field]
    assert session.environment.location == "D"
    assert session._narration_history[-1]["text"] == "D正文"
    assert session.overlay._data["items"] == d["state"]["items"]
    assert session.overlay._data["presentation"]["frames"]["2"] == d["state"]["presentation_frame"]
    assert session.overlay.build_tree_state()["current_node"]["snapshot_id"] == d_id
    assert checkpoints[d_id] == original_d


def test_snapshot_identity_ignores_children_but_distinguishes_player_content(overlay):
    node = copy.deepcopy(overlay.commit_tree_step(narrative="玩家正文", title="场景", round_num=1))
    initial = SessionOverlay._tree_checkpoint_id(node)
    node["children"] = ["future-a", "future-b"]
    assert SessionOverlay._tree_checkpoint_id(node) == initial
    node["content"] = "另一条轨迹正文"
    assert SessionOverlay._tree_checkpoint_id(node) != initial


def test_replacing_one_runtime_round_preserves_other_branch_checkpoint(overlay):
    original = copy.deepcopy(overlay.commit_tree_step(narrative="分支A", round_num=2))
    original["id"] = "branch-a"
    other = copy.deepcopy(original)
    other["id"], other["content"] = "branch-b", "分支B"
    tree = {"checkpoints": {}}
    SessionOverlay._freeze_tree_checkpoint(tree, original, 3)
    SessionOverlay._freeze_tree_checkpoint(tree, other, 3)
    original_id = SessionOverlay._tree_checkpoint_id(original)
    other_id = SessionOverlay._tree_checkpoint_id(other)
    other_record = copy.deepcopy(tree["checkpoints"][other_id])
    replacement = copy.deepcopy(original)
    replacement["content"] = "分支A的新轨迹"
    SessionOverlay._freeze_tree_checkpoint(tree, replacement, 3)
    assert original_id not in tree["checkpoints"]
    assert SessionOverlay._tree_checkpoint_id(replacement) in tree["checkpoints"]
    assert tree["checkpoints"][other_id] == other_record
