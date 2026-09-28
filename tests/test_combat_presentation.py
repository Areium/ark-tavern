"""Combat event delivery for HTTP presentation batches and SSE."""

import json
import queue
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints.combat import _build_sse_generator
from combat_engine.engine import CombatEvent
from test_combat_api import client  # noqa: F401  shared temporary book fixture


def _messages(stream):
    return [json.loads(chunk.split("data: ", 1)[1]) for chunk in stream]


def test_ended_stream_drains_damage_death_and_battle_end():
    events = queue.Queue()
    for kind in ("damage", "death", "battle_end"):
        events.put(CombatEvent(kind, {"presentation_id": kind, "winner": "enemy"}))
    combat = SimpleNamespace(engine=SimpleNamespace(is_battle_over=lambda: True,
                                                     state=SimpleNamespace(events=[])),
                             event_queue=events, suspended=False)

    messages = _messages(_build_sse_generator(combat)())
    assert [message["type"] for message in messages] == [
        "meta", "damage", "death", "battle_end", "done"]
    assert [message["data"]["presentation_id"] for message in messages[1:4]] == [
        "damage", "death", "battle_end"]

    # Late connection after another stream consumed the terminal event finishes promptly.
    assert [message["type"] for message in _messages(_build_sse_generator(combat)())] == [
        "meta", "done"]


def test_suspended_stream_exits_without_draining():
    events = queue.Queue()
    events.put(CombatEvent("suspend", {}))
    combat = SimpleNamespace(engine=SimpleNamespace(is_battle_over=lambda: False),
                             event_queue=events, suspended=True)
    assert [message["type"] for message in _messages(_build_sse_generator(combat)())] == ["meta"]
    assert events.qsize() == 1


def test_practice_batches_are_scoped_and_match_sse_queue(client):
    started = client.post("/api/combat/test/start", json={"node_id": "enc_training", "characters": ["Hero"]})
    assert started.status_code == 200, started.get_json()
    test_id = started.get_json()["test_id"]
    combat = client.application._managers["combat_test"].get(test_id)
    base = f"/api/combat/test/{test_id}"
    try:
        initial_ids = {ev.data["presentation_id"] for ev in list(combat.event_queue.queue)}
        first = client.post(f"{base}/end-turn")
        assert first.status_code == 200, first.get_json()
        first_batch = first.get_json()
        assert set(first_batch) == {"state", "events"}
        assert first_batch["events"]
        first_ids = [ev["data"]["presentation_id"] for ev in first_batch["events"]]
        assert len(first_ids) == len(set(first_ids))
        assert not initial_ids.intersection(first_ids)
        queued = list(combat.event_queue.queue)
        assert [(ev.type, ev.data["presentation_id"]) for ev in queued[-len(first_ids):]] == [
            (ev["type"], ev["data"]["presentation_id"]) for ev in first_batch["events"]]

        second = client.post(f"{base}/end-turn")
        assert second.status_code == 200, second.get_json()
        second_ids = {ev["data"]["presentation_id"] for ev in second.get_json()["events"]}
        assert not second_ids.intersection(first_ids)
        combat.engine.state.phase = "END"
        streamed = _messages(_build_sse_generator(combat)())
        streamed_ids = {message["data"]["presentation_id"] for message in streamed
                        if message["type"] not in ("meta", "done")}
        assert set(first_ids) | second_ids <= streamed_ids
    finally:
        client.delete(base)


def test_action_and_end_turn_always_return_state_and_events(client):
    started = client.post("/api/combat/test/start", json={"node_id": "enc_training", "characters": ["Hero"]})
    test_id = started.get_json()["test_id"]
    base = f"/api/combat/test/{test_id}"
    try:
        ended = client.post(f"{base}/end-turn")
        assert ended.status_code == 200, ended.get_json()
        assert set(ended.get_json()) == {"state", "events"}

        state = client.get(f"{base}/state").get_json()
        player = next(u for u in state["units"] if u["team"] == "player")
        moves = client.get(f"{base}/state?selected_unit={player['unit_id']}").get_json()["valid_moves"]
        assert moves
        action = {"action": "move", "unit_id": player["unit_id"], "target": moves[0]}
        response = client.post(f"{base}/action", json=action)
        assert response.status_code == 200, response.get_json()
        assert set(response.get_json()) == {"state", "events"}
        assert response.get_json()["events"]
    finally:
        client.delete(base)


def test_session_item_returns_heal_batch_and_actions_use_one_dto(client):
    created = client.post("/api/sessions", json={"mode": "free", "combat_mode": "tactical",
                                                  "worldbook_ids": ["combat_api"]})
    assert created.status_code in (200, 201), created.get_json()
    sid = created.get_json()["id"]
    base = f"/api/sessions/{sid}/combat"
    try:
        loaded = client.post(f"/api/sessions/{sid}/characters/load", json={"character": "Hero"})
        assert loaded.status_code == 200, loaded.get_json()
        session = client.application._managers["session"].get_session(sid)
        session.overlay._data.setdefault("inventory", []).append({"name": "急救包", "count": 2})
        session.overlay._save()
        started = client.post(f"{base}/start", json={"encounter_id": "enc_training"})
        assert started.status_code == 200, started.get_json()
        player = next(u for u in session.combat.engine.units.values() if u.team == "player")
        player.hp = max(1, player.hp - 35)
        item = {"action": "use_item", "item_name": "急救包", "unit_id": player.unit_id}

        response = client.post(f"{base}/action", json=item)
        assert response.status_code == 200, response.get_json()
        assert set(response.get_json()) == {"state", "events"}
        [heal] = response.get_json()["events"]
        assert heal["type"] == "heal" and heal["data"]["amount"] > 0
        assert heal["data"]["presentation_id"]
        assert any(ev.data["presentation_id"] == heal["data"]["presentation_id"]
                   for ev in list(session.combat.event_queue.queue))

        next_turn = client.post(f"{base}/end-turn")
        assert next_turn.status_code == 200, next_turn.get_json()
        assert set(next_turn.get_json()) == {"state", "events"}
    finally:
        client.delete(f"/api/sessions/{sid}")
