"""Greybridge content + API acceptance; no real LLM calls.

Strict xfails are executable reports of known product gaps, NOT passed checks.
Remove the corresponding xfail only after implementing its documented fix.
"""

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from story_audit_support import candidate_app, create_story, scripted_round  # noqa: E402


class KnownProductGap(AssertionError):
    """Only the exact acceptance assertion may produce an expected failure."""


def require_acceptance(condition, detail):
    if not condition:
        raise KnownProductGap(detail)


@pytest.fixture
def ctx():
    with candidate_app() as value:
        yield value


def play(ctx, session, **payload):
    response = ctx["client"].post(f"/api/sessions/{session.id}/narrate-continue", json=payload)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def test_candidate_parses_all_chapters_beats_quests_and_battle_bindings(ctx):
    from combat_data_loader import CombatDataLoader
    from combat_nodes import validate_node
    from session_overlay import _parse_quests_md

    session = create_story(ctx)
    chapters = session.overlay._ensure_narrative_beats()
    spec = ctx["manifest"]
    assert len(chapters) == spec["chapters"]
    assert [b["id"] for c in chapters for b in c["beats"]] == spec["beats"]
    assert [q["id"] for q in _parse_quests_md(spec["plot_id"])] == spec["quests"]
    loader = CombatDataLoader()
    for node_id in spec["battles"]:
        node = loader.load_node(node_id)
        assert not validate_node(node, enemy_names=set(loader.list_enemy_names()))["errors"]
        assert node["bind"]["plot_id"] == spec["plot_id"]
        assert node["bind"]["beat_id"] in spec["beats"]
        assert session.overlay.jump_to_beat(node["bind"]["beat_id"])
        assert session.overlay.get_current_beat_combat_id() == node_id


@pytest.mark.parametrize("roster", [[], ["阿米娅"], ["阿米娅", "阿米娅", "博士"]])
def test_create_respects_explicit_roster_and_identity(ctx, roster):
    session = create_story(ctx, roster=roster)
    assert session.scene_manager.get_scene_characters() == list(dict.fromkeys(x for x in roster if x != "博士"))
    assert session.environment.location == "灰桥临时救护站"
    assert session.environment.time_of_day == "傍晚"


@pytest.mark.parametrize("combat_mode", ["narrative", "tactical"])
def test_scripted_full_spine_and_manual_quest_state_export(ctx, combat_mode):
    """All twelve beats via production routes; quests are EXPLICIT manual edits.

    Tactical branch uses the production avoid-combat approach. Actual battle
    simulation and suspend/resume are tested separately, not faked victories.
    """
    session = create_story(ctx, combat_mode=combat_mode)
    client = ctx["client"]
    for qid in ctx["manifest"]["quests"]:
        r = client.patch(f"/api/sessions/{session.id}/quests/{qid}", json={"status": "active"})
        assert r.status_code == 200
    visited, briefings = [], []
    for expected in ctx["manifest"]["beats"]:
        assert session.overlay.get_current_beat_id() == expected
        visited.append(expected)
        scripted_round(session, complete=True, env={"location": "灰桥交接点", "time": "夜晚"})
        body = play(ctx, session, action="核对当前目标并继续")
        assert "AUDIT_SENTINEL" in body["narrative"]
        if body.get("combat_briefing"):
            node = body["combat_briefing"]["encounter_id"]
            briefings.append(node)
            r = client.post(f"/api/sessions/{session.id}/combat/start", json={
                "encounter_id": node, "approach_id": "negotiate",
            })
            assert r.status_code == 200, r.get_json()
            assert session.combat is None
    assert visited == ctx["manifest"]["beats"]
    assert briefings == (ctx["manifest"]["battles"] if combat_mode == "tactical" else [])
    assert set(session.overlay.get_beat_state()["completed_beats"]) == set(visited)
    assert session.narration_count == 12
    assert session.environment.location == "灰桥交接点"
    for qid in ctx["manifest"]["quests"]:
        assert client.patch(f"/api/sessions/{session.id}/quests/{qid}", json={"status": "completed"}).status_code == 200
    quests = client.get(f"/api/sessions/{session.id}/quests").get_json()["quests"]
    assert len(quests) == 5 and all(q["status"] == "completed" for q in quests)
    exported = client.get(f"/api/sessions/{session.id}/export")
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
        assert any(n.endswith("overrides.json") for n in archive.namelist())
        assert any(n.endswith("plot_log.md") for n in archive.namelist())
    exported.close()


def test_archive_import_roundtrip_preserves_state_with_existing_dependencies(ctx):
    """Same-library roundtrip, NOT proof of cross-machine dependency completeness."""
    session = create_story(ctx, combat_mode="tactical", roster=["阿米娅"])
    scripted_round(session, complete=True, env={"location": "灰桥归档点", "time": "深夜"})
    play(ctx, session, action="归档本次确认的事实")
    client = ctx["client"]
    assert client.patch(f"/api/sessions/{session.id}/quests/M1-1", json={"status": "completed"}).status_code == 200
    assert client.put(f"/api/sessions/{session.id}/overrides/characters/阿米娅", json={"content": "归档隔离测试"}).status_code == 200
    with client.get(f"/api/sessions/{session.id}/export") as exported:
        assert exported.status_code == 200
        payload = exported.data
    response = client.post("/api/sessions/import", data={"file": (io.BytesIO(payload), "greybridge.zip")})
    assert response.status_code == 201, response.get_json()
    imported_id = response.get_json()["id"]
    assert imported_id != session.id, "Import must not overwrite the original session"
    imported = ctx["app"]._managers["session"].get_session(imported_id)
    assert Path(imported.data_dir).is_relative_to(ctx["root"])
    assert imported.combat_mode == "tactical"
    assert imported.scene_manager.get_scene_characters() == ["阿米娅"]
    assert client.get(f"/api/sessions/{imported_id}/environment").get_json() == client.get(f"/api/sessions/{session.id}/environment").get_json()
    assert imported.overlay.get_plot_id() == ctx["manifest"]["plot_id"]
    assert imported.overlay.get_beat_state() == session.overlay.get_beat_state()
    assert imported.overlay.get_quest_states() == session.overlay.get_quest_states()
    assert imported.overlay.get_character_overrides("阿米娅") == session.overlay.get_character_overrides("阿米娅")
    assert imported._narration_history == session._narration_history
    assert imported.overlay.get_story_tree() == session.overlay.get_story_tree()


def test_variant_generation_does_not_commit_a_new_story_round(ctx):
    session = create_story(ctx)
    scripted_round(session, complete=False)
    play(ctx, session)
    before = json.dumps(session._narration_history, ensure_ascii=False)
    scripted_round(session, narrative="AUDIT_VARIANT 备用的告别描述")
    response = ctx["client"].post(f"/api/sessions/{session.id}/narrate-variant", json={"prompt": "简洁地改写"})
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["narrative"].startswith("AUDIT_VARIANT")
    assert session.narration_count == 1
    assert json.dumps(session._narration_history, ensure_ascii=False) == before


def test_environment_item_and_character_overrides_stay_session_local(ctx):
    session = create_story(ctx, roster=["阿米娅"])
    client = ctx["client"]
    other = create_story(ctx, roster=["阿米娅"])
    env = {"location": "灰桥机房", "time": "深夜", "atmosphere": ["电台恢复"]}
    assert client.put(f"/api/sessions/{session.id}/environment", json=env).status_code == 200
    assert client.get(f"/api/sessions/{other.id}/environment").get_json()["location"] == "灰桥临时救护站"
    assert client.post(f"/api/sessions/{session.id}/items/add", json={"item_id": "博士的战术终端"}).status_code == 200
    items = client.get(f"/api/sessions/{session.id}/items").get_json()["items"]
    assert any(x["id"] == "博士的战术终端" for x in items)
    r = client.put(f"/api/sessions/{session.id}/overrides/characters/阿米娅", json={"content": "仅用于本会话的验收备注"})
    assert r.status_code == 200
    assert other.overlay.get_character_overrides("阿米娅") == {}


def test_candidate_combat_suspend_resume_and_combat_guard(ctx):
    session = create_story(ctx, combat_mode="tactical")
    client = ctx["client"]
    start = client.post(f"/api/sessions/{session.id}/combat/start", json={
        "encounter_id": "enc_gb_gate", "approach_id": "assault",
    })
    assert start.status_code == 200, start.get_json()
    before = client.get(f"/api/sessions/{session.id}/combat/state").get_json()
    # Use a real engine turn, so resume does not only compare pristine state.
    r = client.post(f"/api/sessions/{session.id}/combat/end-turn")
    assert r.status_code == 200, r.get_json()
    before = client.get(f"/api/sessions/{session.id}/combat/state").get_json()
    scripted_round(session, complete=False)
    assert client.post(f"/api/sessions/{session.id}/narrate-continue", json={}).status_code == 423
    r = client.post(f"/api/sessions/{session.id}/combat/suspend")
    assert r.status_code == 200, r.get_json()
    assert session.combat is None
    r = client.post(f"/api/sessions/{session.id}/combat/resume")
    assert r.status_code == 200, r.get_json()
    after = client.get(f"/api/sessions/{session.id}/combat/state").get_json()
    for value in (before, after):
        value.pop("valid_moves", None)
        value.pop("valid_targets", None)
    assert before == after


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-01: opening section leaks later chapters")
def test_opening_context_does_not_contain_the_epilogue(ctx):
    session = create_story(ctx)
    require_acceptance("beat_gb_epilogue" not in session.overlay.get_plot_context(), "Opening context contains the epilogue")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-02: no automatic quest transition in narration")
def test_narrated_quest_completion_is_persisted(ctx):
    session = create_story(ctx)
    scripted_round(session, narrative="M1-1：确认仍在等待的人已完成，已核对全部人员并完成初步安置。")
    play(ctx, session, action="完成救治与名册核对")
    state = session.overlay.get_quest_states()["M1-1"]["status"]
    require_acceptance(state == "completed", f"Narrated completion leaves quest status={state}")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-03: last beat does not enter a terminal state")
def test_final_beat_completion_has_a_terminal_state(ctx):
    session = create_story(ctx)
    session.overlay.jump_to_beat("beat_gb_epilogue")
    session.overlay.advance_beat()
    require_acceptance(session.overlay.get_current_beat() is None, "Final beat remains current after completion")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-04: tree rollback loses branch target_beat_id")
def test_tree_rollback_preserves_branch_destination(ctx):
    session = create_story(ctx)
    branches = [{"id": "gb_power", "label": "进入机房", "intent": "调查",
                 "source": "llm", "target_beat_id": "beat_gb_power"}]
    scripted_round(session, complete=False, branches=branches)
    play(ctx, session)
    root = session.overlay.get_story_tree()["current_id"]
    scripted_round(session, complete=False, branches=branches)
    play(ctx, session, branch_id="gb_power")
    r = ctx["client"].post(f"/api/sessions/{session.id}/rollback-node", json={"node_id": root})
    assert r.status_code == 200, r.get_json()
    branch = next(b for b in session.overlay.get_emitted_branches() if b["label"] == "进入机房")
    require_acceptance(branch.get("target_beat_id") == "beat_gb_power", f"Restored branch lost target: {branch}")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-05: restoring empty story roster reloads initial_characters")
def test_explicit_empty_roster_survives_session_reload(ctx):
    from session_manager import SessionManager
    session = create_story(ctx, roster=[])
    assert not session.scene_manager.get_scene_characters()
    managers = ctx["app"]._managers
    restored = SessionManager(managers["llm_backend"], wiki_manager=managers["wiki"],
                              worldbook_manager=managers["worldbook"]).get_session(session.id)
    assert restored is not None
    roster = restored.scene_manager.get_scene_characters()
    require_acceptance(roster == [], f"Explicit empty roster restored as {roster}")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-06: unknown quest IDs accepted by PATCH")
def test_unknown_quest_cannot_be_created_by_status_patch(ctx):
    session = create_story(ctx)
    r = ctx["client"].patch(f"/api/sessions/{session.id}/quests/does-not-exist", json={"status": "completed"})
    require_acceptance(r.status_code == 404, f"Unknown quest PATCH returned HTTP {r.status_code}")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-07: listed flat Markdown items cannot be read/added")
def test_listed_flat_item_can_be_added_to_scene(ctx):
    session = create_story(ctx, roster=["阿米娅"])
    docs = ctx["app"]._managers["document"].list_documents("items")
    assert any(d["id"] == "急救包" for d in docs), "Fixture must really be listed"
    r = ctx["client"].post(f"/api/sessions/{session.id}/items/add", json={"item_id": "急救包"})
    require_acceptance(r.status_code == 200, f"Listed flat item add returned HTTP {r.status_code}: {r.get_json()}")


@pytest.mark.xfail(strict=True, raises=KnownProductGap, reason="QA-08: narration update frontend/backend contract mismatch")
def test_variant_update_uses_frontend_contract_and_persists_selected_round(ctx):
    session = create_story(ctx)
    session.add_narration("第一轮原文")
    session.add_narration("第二轮保持不变")
    # Match deployment error handling: Flask emits HTTP 500 instead of propagating
    # the route's TypeError. All setup and unrelated errors still fail normally.
    ctx["app"].config["PROPAGATE_EXCEPTIONS"] = False
    response = ctx["client"].post(f"/api/sessions/{session.id}/narrate-update", json={
        "round": 1, "narrative": "第一轮已选变体",
    })
    require_acceptance(response.status_code == 200, f"Frontend payload returned HTTP {response.status_code}")
    assert session._narration_history[0]["text"] == "第一轮已选变体"
    assert session._narration_history[1]["text"] == "第二轮保持不变"
    from session_manager import SessionManager
    managers = ctx["app"]._managers
    restored = SessionManager(managers["llm_backend"], wiki_manager=managers["wiki"],
                              worldbook_manager=managers["worldbook"]).get_session(session.id)
    assert restored is not None
    assert restored._narration_history == session._narration_history
