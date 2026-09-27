# -*- coding: utf-8 -*-
"""灰灯渡口：真实 Flask 会话、作者分支和固定战斗节点的确定性回归。"""

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import session_manager as session_module  # noqa: E402
import session_overlay as overlay_module  # noqa: E402
import world_book as worldbook_module  # noqa: E402
import combat_generation  # noqa: E402
from combat_data_loader import CombatDataLoader  # noqa: E402

BOOK_ID = "grey-lantern"
PLOT_ID = "grey_lantern"
STAGES = ("arrival", "checkpoint", "fork", "warehouse", "rendezvous", "bridge", "ending")


@pytest.fixture()
def flow(tmp_path, monkeypatch):
    # Install this story pack explicitly into isolated runtime paths; app startup
    # no longer installs any pack, and even a failed test cannot touch user data.
    pack = ROOT / "data/worldbooks/packs/grey-lantern.json"
    assert pack.is_file(), "先生成真实 grey-lantern pack 再运行流程测试"
    packs_dir = tmp_path / "packs"
    packs_dir.mkdir()
    shutil.copyfile(pack, packs_dir / pack.name)
    monkeypatch.setattr(worldbook_module, "_PACKS_DIR", packs_dir)
    monkeypatch.setattr(worldbook_module, "_WORLDBOOKS_DIR", tmp_path / "worldbooks")
    sessions_dir = tmp_path / "sessions"
    monkeypatch.setattr(session_module, "_SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(overlay_module, "_SESSIONS_DIR", sessions_dir)

    from app import create_app

    app = create_app()
    app.config.update(TESTING=True)
    client = app.test_client()
    assert all(book["id"] != BOOK_ID for book in client.get("/api/worldbook").get_json()["books"])
    installed = client.post(f"/api/worldbook/available-packs/{BOOK_ID}/install")
    assert installed.status_code == 201, installed.get_json()
    app._managers["llm_backend"].get_config = lambda: {
        "auto_generate_choices": True, "choice_count": 2,
        "word_limit": 300, "dialogue_bubble_mode": False,
        "narration_reasoning_effort": "none", "max_output_tokens": 4096,
        "memory_interval": 999, "deviation_check_interval": 999,
    }
    response = client.post("/api/sessions", json={
        "mode": "story", "plot_id": PLOT_ID, "combat_mode": "tactical",
        "worldbook_ids": [BOOK_ID], "identity": "博士",
        "roster_character_ids": ["阿米娅", "临光", "闪灵"],
    })
    assert response.status_code == 201, response.get_json()
    sid = response.get_json()["id"]
    session = app._managers["session"].get_session(sid)
    session._llm = object()
    generation_calls = []

    def record_generated_scene(scene, **kwargs):
        generation_calls.append((scene, kwargs))
        return None

    monkeypatch.setattr(combat_generation, "generate_combat_node_for_scene", record_generated_scene)

    def narrate(stage, *, complete=False, combat_scene=False, branches=None, branch_id=None):
        manager = session.scene_manager
        manager.narrate = lambda *a, **kw: (f"灰灯渡口 {stage} 的确定性叙述。", {}, None)
        manager.extract_markers = lambda *a, **kw: {
            "beat_complete": complete, "combat": None,
            "combat_scene": {"name": f"{stage} 交战", "description": f"{stage} 发生交战",
                             "enemies": ["灰灯路障兵"], "band": "T1"} if combat_scene else None,
            "choices": [b["label"] for b in branches or []],
            "branches": branches or [], "node_title": stage, "summary": stage,
            "environment": None, "usage": None, "error": None,
        }
        payload = {"action": "继续"}
        if branch_id:
            payload["branch_id"] = branch_id
        result = client.post(f"/api/sessions/{sid}/narrate-continue", json=payload)
        assert result.status_code == 200, result.get_json()
        return result.get_json()

    narrate.generated_calls = generation_calls
    yield client, sid, session, narrate, tmp_path


def _beat(session):
    return getattr(session, "overlay", session).get_current_beat_id()


def _assert_bound_node(stage):
    node = CombatDataLoader().load_node(f"enc_grey_{stage}")
    assert node["worldbook_id"] == BOOK_ID
    assert node["bind"] == {
        "plot_id": PLOT_ID, "chapter_id": f"grey_{stage}",
        "beat_id": f"beat_grey_{stage}",
    }


def _finish_combat(client, sid, session, encounter_id, winner):
    start = client.post(f"/api/sessions/{sid}/combat/start", json={
        "encounter_id": encounter_id, "approach_id": "attack",
    })
    assert start.status_code == 200, start.get_json()
    assert start.get_json()["kind"] == "combat" and session.combat is not None
    # This test covers the HTTP settlement path, not AI combat tactics. Set a
    # completed engine result after a real node has successfully started.
    session.combat.engine.state.phase = "END"
    session.combat.engine.state.winner = winner
    complete = client.post(f"/api/sessions/{sid}/combat/complete", json={})
    assert complete.status_code == 200, complete.get_json()
    body = complete.get_json()
    assert body["settlement"]["winner"] == winner
    assert body["history"][-1]["encounter_id"] == encounter_id
    assert body["history"][-1]["result"] == winner
    assert session.combat is None
    return body


@pytest.mark.parametrize("route,winner", [
    ("先救泵房工人", "player"),
    ("先取注销原册", "enemy"),
    ("先救泵房工人", "escaped"),
])
def test_authored_route_combat_and_single_ending(flow, route, winner):
    client, sid, session, narrate, tmp_path = flow
    outline = session.overlay.get_story_outline()
    assert outline["source"] == "authored"
    assert [ch["beats"][0]["id"] for ch in outline["chapters"]] == [
        f"beat_grey_{stage}" for stage in STAGES
    ]
    assert session.overlay.get_worldbook_ids() == [BOOK_ID]
    assert session.player_identity == "博士"
    assert set(session.scene_manager.get_scene_characters()) == {"阿米娅", "临光", "闪灵"}
    assert _beat(session) == "beat_grey_arrival"

    narrate("arrival", complete=True)
    assert _beat(session) == "beat_grey_checkpoint"
    waiting = narrate("checkpoint", combat_scene=True, complete=False)
    assert "combat_briefing" not in waiting
    assert _beat(session) == "beat_grey_checkpoint"
    assert not narrate.generated_calls, "固定战斗未到触发轮不能现场生成替代节点"
    checkpoint = narrate("checkpoint", combat_scene=True, complete=True)
    assert _beat(session) == "beat_grey_fork"
    briefing = checkpoint["combat_briefing"]
    assert briefing["encounter_id"] == "enc_grey_checkpoint"
    assert not briefing.get("generated")
    assert not narrate.generated_calls, "固定节点触发时应直接复用作者节点"
    assert session.overlay.get_current_beat_combat_id() == "", "分叉不能继承闸口战斗"
    assert {a["id"] for a in briefing["approaches"]} >= {"attack", "retreat"}
    _assert_bound_node("checkpoint")
    _finish_combat(client, sid, session, "enc_grey_checkpoint", winner)

    # LLM 重述同名选项但不提供 target；作者的分支落点必须保留。
    fork = narrate("fork", complete=True, branches=[
        {"label": "先救泵房工人", "intent": "模型重述"},
        {"label": "先取注销原册", "intent": "模型重述"},
    ])
    assert _beat(session) == "beat_grey_fork"
    assert {b["label"]: (b["target_beat_id"], b["source"]) for b in fork["branches"]} == {
        "先救泵房工人": ("beat_grey_rendezvous", "author"),
        "先取注销原册": ("beat_grey_warehouse", "author"),
    }
    session.overlay.advance_beat(force=True)
    assert _beat(session) == "beat_grey_fork", "强制自动推进也不能替玩家选择"
    assert _beat(overlay_module.SessionOverlay(sid, "story")) == "beat_grey_fork"
    selected = next(b["id"] for b in fork["branches"] if b["label"] == route)
    landing = "rendezvous" if route == "先救泵房工人" else "warehouse"
    narrate(landing, branch_id=selected)
    assert _beat(session) == f"beat_grey_{landing}"
    assert _beat(overlay_module.SessionOverlay(sid, "story")) == f"beat_grey_{landing}"

    if landing == "warehouse":
        # The authored optional encounter is bound to this route only.
        warehouse = narrate("warehouse", combat_scene=True, complete=True)
        assert warehouse["combat_briefing"]["encounter_id"] == "enc_grey_warehouse"
        assert not warehouse["combat_briefing"].get("generated")
        assert not narrate.generated_calls
        _assert_bound_node("warehouse")
        assert _beat(session) == "beat_grey_rendezvous"
        _finish_combat(client, sid, session, "enc_grey_warehouse", winner)
    else:
        assert "enc_grey_warehouse" not in [
            row["encounter_id"] for row in session.overlay._data.get("combat_history", [])
        ]
    minimum = session.overlay.get_current_beat()["min_rounds"]
    assert minimum == 3
    for _ in range(minimum):
        before = session.overlay.get_beat_state()["narrations_on_beat"]
        rendezvous = narrate("rendezvous", complete=True)
        assert "combat_briefing" not in rendezvous
        if before + 1 < minimum:
            assert _beat(session) == "beat_grey_rendezvous"
        if _beat(session) == "beat_grey_bridge":
            break
    assert _beat(session) == "beat_grey_bridge"
    bridge = narrate("bridge", combat_scene=True, complete=True)
    assert bridge["combat_briefing"]["encounter_id"] == "enc_grey_bridge"
    assert not bridge["combat_briefing"].get("generated")
    assert not narrate.generated_calls
    _assert_bound_node("bridge")
    assert _beat(session) == "beat_grey_ending"
    assert session.overlay.get_current_beat_combat_id() == "", "尾声不能继承渡桥战斗"
    _finish_combat(client, sid, session, "enc_grey_bridge", winner)
    ending = narrate("ending", complete=True)
    assert _beat(session) == "beat_grey_ending"
    assert "combat_briefing" not in ending
    assert "combat_briefing" not in narrate("ending", complete=True)
    assert not narrate.generated_calls
    state = client.get(f"/api/sessions/{sid}/story-state")
    assert state.status_code == 200
    assert state.get_json()["outline"]["chapter_count"] == len(STAGES)
    assert sum(ch["id"] == "grey_ending" for ch in session.overlay.get_story_outline()["chapters"]) == 1

    # All mutable state stays inside pytest's temporary directory.
    assert session.data_dir.is_relative_to(tmp_path)
    assert (tmp_path / "worldbooks" / "grey-lantern.json").is_file()
    assert json.loads((tmp_path / "worldbooks" / "grey-lantern.json").read_text(encoding="utf-8"))["id"] == BOOK_ID


def test_rollback_fork_can_choose_the_other_authored_route(flow):
    client, sid, session, narrate, _ = flow
    narrate("arrival", complete=True)
    narrate("checkpoint", combat_scene=True, complete=True)
    fork = narrate("fork", complete=True)
    assert _beat(session) == "beat_grey_fork"
    fork_node = session.overlay.get_story_tree()["current_id"]
    rescue = next(b["id"] for b in fork["branches"] if b["label"] == "先救泵房工人")
    evidence = next(b["id"] for b in fork["branches"] if b["label"] == "先取注销原册")
    narrate("rendezvous", branch_id=rescue)
    assert _beat(session) == "beat_grey_rendezvous"
    rolled = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": fork_node})
    assert rolled.status_code == 200, rolled.get_json()
    assert _beat(session) == "beat_grey_fork"
    assert _beat(overlay_module.SessionOverlay(sid, "story")) == "beat_grey_fork"
    assert any(b.get("id") == evidence and b.get("target_beat_id") == "beat_grey_warehouse"
               for b in session.overlay.get_emitted_branches()), [
                   (b.get("id"), b.get("target_beat_id")) for b in session.overlay.get_emitted_branches()
               ]
    narrate("warehouse", branch_id=evidence)
    assert _beat(session) == "beat_grey_warehouse", session.overlay.get_beat_state()
    tree = session.overlay.get_story_tree()
    assert len(tree["nodes"][fork_node]["children"]) == 2
