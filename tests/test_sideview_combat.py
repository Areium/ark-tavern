"""Side view battle contract, persistence, and settlement regression tests."""

import copy
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from app import create_app  # noqa: E402
from session_overlay import SessionOverlay  # noqa: E402
from combat_resume import session_resume_path  # noqa: E402
from sideview_combat import minimum_victory_ms  # noqa: E402

ENCOUNTER = "enc_quick_test_1"


@pytest.fixture(scope="module")
def client():
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


@pytest.fixture
def battle(client):
    created = client.post("/api/sessions", json={"mode": "free", "combat_mode": "sideview"})
    assert created.status_code == 201, created.get_json()
    sid = created.get_json()["id"]
    assert client.post(f"/api/sessions/{sid}/characters/load",
                       json={"character": "临光"}).status_code == 200
    base = f"/api/sessions/{sid}/sideview"
    try:
        yield sid, base
    finally:
        client.delete(f"/api/sessions/{sid}")


def _start(client, base):
    response = client.post(f"{base}/start", json={"encounter_id": ENCOUNTER})
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["kind"] == "sideview"
    return response.get_json()["state"]


def _victory(state):
    snapshot = copy.deepcopy(state["snapshot"])
    goal = state["level"]["exit"]
    snapshot["player"].update(x=goal["x"] + 5, y=goal["y"] + 5)
    for enemy in snapshot["enemies"]:
        enemy["hp"] = 0
    snapshot.update(elapsedMs=2500, exitReached=True, damageTaken=0,
                    cooldowns={"skill": 0, "dash": 0, "support": 0})
    return snapshot


def _mature_run(client, sid):
    session = client.application._managers["session"].get_session(sid)
    session.overlay._data["sideview_run"]["createdAt"] = time.time() - 10
    session.overlay._save()


def _result(state, snapshot, outcome="victory"):
    return {"runId": state["runId"], "levelId": state["level"]["id"],
            "outcome": outcome, "durationMs": snapshot["elapsedMs"],
            "kills": sum(e["hp"] == 0 for e in snapshot["enemies"]),
            "damageTaken": snapshot.get("damageTaken", 0),
            "hpRemaining": snapshot["player"]["hp"], "snapshot": snapshot}


def test_start_save_and_disk_restore(client, battle):
    sid, base = battle
    state = _start(client, base)
    assert state["engine"] == "sideview"
    assert state["operator"]["name"] == "临光"
    assert state["operator"]["maxHp"] == state["snapshot"]["player"]["hp"]
    saved = copy.deepcopy(state["snapshot"])
    saved["player"]["x"] += 25
    saved["elapsedMs"] = 250
    saved["cooldowns"] = {"skill": 2.5, "dash": 0, "support": 1}
    response = client.post(f"{base}/save", json={"runId": state["runId"],
                                                  "snapshot": saved, "suspended": True})
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["state"]["status"] == "suspended"
    assert client.get(f"{base}/state").get_json()["state"]["snapshot"] == saved
    disk = SessionOverlay(sid, "free")._data["sideview_run"]
    assert disk["runId"] == state["runId"] and disk["snapshot"] == saved
    assert disk["status"] == "suspended"
    resumed = client.post(f"{base}/save", json={"runId": state["runId"],
                                                 "snapshot": saved, "suspended": False})
    assert resumed.get_json()["state"]["status"] == "active"
    assert client.post(f"{base}/save", json={"runId": "wrong", "snapshot": saved}).status_code == 409


def test_reject_false_goal_and_client_rewards(client, battle):
    sid, base = battle
    state = _start(client, base)
    snapshot = copy.deepcopy(state["snapshot"])
    snapshot["exitReached"] = True
    response = client.post(f"{base}/complete", json=_result(state, snapshot))
    assert response.status_code == 400
    snapshot = _victory(state)
    fake = _result(state, snapshot)
    fake["levelId"] = "fake"
    assert client.post(f"{base}/complete", json=fake).status_code == 409
    fake = _result(state, snapshot)
    fake["rewards"] = {"xp": 999999, "items": ["任意掉落"]}
    _mature_run(client, sid)
    response = client.post(f"{base}/complete", json=fake)
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["settlement"]["engine"] == "sideview"
    assert response.get_json()["settlement"]["durationMs"] == snapshot["elapsedMs"]
    assert response.get_json()["settlement"]["rewards"]["xp_total"] <= 108
    assert response.get_json()["settlement"]["rewards"]["items"] == []


def test_victory_once_and_retry_after_write_failure(client, battle, monkeypatch):
    sid, base = battle
    state = _start(client, base)
    result = _result(state, _victory(state))
    _mature_run(client, sid)
    import blueprints.sideview as sideview
    real_apply = sideview.apply_settlement
    calls = {"count": 0}

    def fail_once(session, pending):
        calls["count"] += 1
        if calls["count"] == 1:
            raise sideview.SettlementApplyError("temporary")
        return real_apply(session, pending)

    monkeypatch.setattr(sideview, "apply_settlement", fail_once)
    failed = client.post(f"{base}/complete", json=result)
    assert failed.status_code == 500
    disk = SessionOverlay(sid, "free")._data
    assert disk["pending_settlement"]["sideview_run_id"] == state["runId"]
    assert disk["sideview_run"]["status"] == "settling"
    settling = client.get(f"{base}/state").get_json()["state"]
    assert settling["outcome"] == "victory"
    success = client.post(f"{base}/complete", json=result)
    assert success.status_code == 200, success.get_json()
    repeated = client.post(f"{base}/complete", json=result)
    assert repeated.status_code == 200 and repeated.get_json() == success.get_json()
    disk = SessionOverlay(sid, "free")._data
    assert "pending_settlement" not in disk
    assert len([h for h in disk["combat_history"] if h.get("runId") == state["runId"]]) == 1
    assert disk["sideview_status"]["operatorName"] == "临光"


def test_defeat_and_abandon_have_no_rewards(client, battle):
    sid, base = battle
    state = _start(client, base)
    lost = copy.deepcopy(state["snapshot"])
    lost["player"]["hp"] = 0
    lost["elapsedMs"] = 200
    response = client.post(f"{base}/complete", json=_result(state, lost, "defeat"))
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["settlement"]["rewards"]["xp_total"] == 0
    assert SessionOverlay(sid, "free")._data["sideview_status"]["hp"] == 0
    new_state = _start(client, base)
    assert client.post(f"{base}/abandon", json={"runId": new_state["runId"]}).status_code == 200
    assert client.get(f"{base}/state").get_json()["state"]["status"] == "abandoned"
    assert client.post(f"{base}/complete", json=_result(new_state, _victory(new_state))).status_code == 409


def test_approach_and_pending_settlement_guard(client, battle):
    sid, base = battle
    prompt = client.post(f"{base}/start", json={"encounter_id": "enc_first_reunion"})
    assert prompt.status_code == 200
    assert prompt.get_json()["kind"] == "approaches"
    avoided = client.post(f"{base}/start", json={"encounter_id": "enc_first_reunion",
                                                  "approach_id": "retreat"})
    assert avoided.status_code == 200 and avoided.get_json()["kind"] == "avoid"
    session = client.application._managers["session"].get_session(sid)
    session.overlay.set_pending_settlement({"data": {"settlement_id": "existing"}})
    try:
        assert client.post(f"{base}/start", json={"encounter_id": ENCOUNTER}).status_code == 409
    finally:
        session.overlay.clear_pending_settlement()


def test_snapshot_bounds_and_enemy_identity(client, battle):
    _, base = battle
    state = _start(client, base)
    body = {"runId": state["runId"], "snapshot": copy.deepcopy(state["snapshot"])}
    body["snapshot"]["player"]["x"] = state["level"]["width"] + 1
    assert client.post(f"{base}/save", json=body).status_code == 400
    body["snapshot"]["player"]["x"] = 80
    body["snapshot"]["enemies"][0]["id"] = "forged"
    assert client.post(f"{base}/save", json=body).status_code == 400


def test_start_rejects_old_engine_and_resume_file(client, battle):
    sid, base = battle
    session = client.application._managers["session"].get_session(sid)
    session.combat = object()
    try:
        assert client.post(f"{base}/start", json={"encounter_id": ENCOUNTER}).status_code == 409
    finally:
        session.combat = None
    resume = session_resume_path(session)
    resume.write_text("{}", encoding="utf-8")
    try:
        assert client.post(f"{base}/start", json={"encounter_id": ENCOUNTER}).status_code == 409
    finally:
        resume.unlink()
    assert _start(client, base)["status"] == "active"


def test_completed_pending_cleanup_is_retryable(client, battle, monkeypatch):
    sid, base = battle
    state = _start(client, base)
    result = _result(state, _victory(state))
    _mature_run(client, sid)
    assert client.post(f"{base}/complete", json=result).status_code == 200
    session = client.application._managers["session"].get_session(sid)
    pending = {"data": {"settlement_id": "stale"}, "sideview_run_id": state["runId"]}
    session.overlay.set_pending_settlement(pending)
    real_clear = session.overlay.clear_pending_settlement
    calls = {"count": 0}

    def fail_once():
        calls["count"] += 1
        if calls["count"] == 1:
            session.overlay._data.pop("pending_settlement", None)
            raise OSError("disk unavailable")
        return real_clear()

    monkeypatch.setattr(session.overlay, "clear_pending_settlement", fail_once)
    assert client.post(f"{base}/complete", json=result).status_code == 500
    assert session.overlay.get_pending_settlement() == pending
    assert client.post(f"{base}/complete", json=result).status_code == 200
    assert SessionOverlay(sid, "free").get_pending_settlement() is None


def test_approach_effects_and_hp_inheritance(client, battle, monkeypatch):
    _, base = battle
    ambush = client.post(f"{base}/start", json={"encounter_id": "enc_first_reunion",
                                                 "approach_id": "ambush"})
    assert ambush.status_code == 200, ambush.get_json()
    state = ambush.get_json()["state"]
    assert state["appliedEffects"]["enemyScale"] == 0.8
    assert state["appliedEffects"]["firstStrike"] is True
    assert state["level"]["enemies"][0]["hp"] < 60
    lowered = copy.deepcopy(state["snapshot"])
    lowered["player"]["hp"] = 10
    lowered["elapsedMs"] = 1
    assert client.post(f"{base}/save", json={"runId": state["runId"],
                                            "snapshot": lowered}).status_code == 200
    assert client.post(f"{base}/abandon", json={"runId": state["runId"]}).status_code == 200
    inherited = _start(client, base)
    assert inherited["snapshot"]["player"]["hp"] == 10
    assert inherited["appliedEffects"]["inheritedHp"] == 10
    lost = copy.deepcopy(inherited["snapshot"])
    lost["player"]["hp"] = 0
    lost["elapsedMs"] = 2
    assert client.post(f"{base}/complete", json=_result(inherited, lost, "defeat")).status_code == 200
    recovered = _start(client, base)
    assert recovered["snapshot"]["player"]["hp"] == round(recovered["operator"]["maxHp"] * 0.25)
    assert recovered["appliedEffects"]["recoveredFromDefeat"] is True


def test_approach_hp_penalty_is_applied(client, battle, monkeypatch):
    _, base = battle
    import blueprints.sideview as sideview
    real_resolve = sideview.resolve_approach

    def penalized(encounter, approach_id):
        result = real_resolve(encounter, approach_id)
        result["combat_params"] = {"enemy_scale": 1.2,
                                   "status_effects": {"临光": {"hp_penalty": 0.1}}}
        return result

    monkeypatch.setattr(sideview, "resolve_approach", penalized)
    state = _start(client, base)
    assert state["appliedEffects"]["hpPenalty"] == 0.1
    assert state["snapshot"]["player"]["hp"] == (
        state["operator"]["maxHp"] - round(state["operator"]["maxHp"] * 0.1))
    assert state["level"]["enemies"][0]["damage"] > 8


def test_parallel_start_creates_one_run(client, battle):
    _, base = battle
    app = client.application

    def start():
        with app.test_client() as concurrent_client:
            return concurrent_client.post(f"{base}/start", json={"encounter_id": ENCOUNTER})

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: start(), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]


def test_parallel_complete_records_one_history(client, battle):
    sid, base = battle
    state = _start(client, base)
    result = _result(state, _victory(state))
    _mature_run(client, sid)
    app = client.application

    def complete():
        with app.test_client() as concurrent_client:
            return concurrent_client.post(f"{base}/complete", json=result)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: complete(), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].get_json() == responses[1].get_json()
    disk = SessionOverlay(sid, "free")._data
    assert len([h for h in disk["combat_history"] if h.get("runId") == state["runId"]]) == 1


def test_victory_requires_snapshot_and_wall_clock_travel_time(client, battle):
    sid, base = battle
    state = _start(client, base)
    snapshot = _victory(state)
    minimum = minimum_victory_ms(state["level"])
    assert minimum > 1000
    instant = client.post(f"{base}/complete", json=_result(state, snapshot))
    assert instant.status_code == 400
    _mature_run(client, sid)
    snapshot["elapsedMs"] = minimum - 1
    too_short = client.post(f"{base}/complete", json=_result(state, snapshot))
    assert too_short.status_code == 400
    snapshot["elapsedMs"] = minimum
    accepted = client.post(f"{base}/complete", json=_result(state, snapshot))
    assert accepted.status_code == 200, accepted.get_json()


def test_new_sideview_identity_can_start_without_scene_npc(client):
    created = client.post("/api/sessions", json={
        "mode": "free", "combat_mode": "sideview", "identity": "临光",
        "roster_character_ids": ["临光"]})
    assert created.status_code == 201, created.get_json()
    sid = created.get_json()["id"]
    try:
        session = client.application._managers["session"].get_session(sid)
        assert session.scene_manager.get_scene_characters() == []
        assert session.scene_manager.get_roster()[0] == "临光"
        base = f"/api/sessions/{sid}/sideview"
        state = _start(client, base)
        assert state["operator"]["name"] == "临光"
        assert state["supportName"] is None
    finally:
        client.delete(f"/api/sessions/{sid}")
