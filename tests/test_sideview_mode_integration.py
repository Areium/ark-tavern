"""The new mode must remain separate from the legacy turn based API."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from app import create_app  # noqa: E402
from blueprints.chat import _require_no_combat  # noqa: E402


def test_sideview_session_routes_and_resume_summary():
    app = create_app()
    app.config.update(TESTING=True)
    client = app.test_client()
    created = client.post("/api/sessions", json={
        "mode": "free", "combat_mode": "sideview", "identity": "临光",
    })
    assert created.status_code == 201
    session_id = created.get_json()["id"]
    base = f"/api/sessions/{session_id}"
    try:
        assert client.post(f"{base}/characters/load", json={"character": "临光"}).status_code == 200
        missing_encounter = client.post(f"{base}/sideview/start", json={})
        assert missing_encounter.status_code == 400
        assert "encounter_id" in missing_encounter.get_json()["error"]

        hidden_encounter = client.post(f"{base}/sideview/start", json={"encounter_id": "enc_not_installed"})
        assert hidden_encounter.status_code == 404

        started = client.post(f"{base}/sideview/start", json={"encounter_id": "enc_quick_test_1"})
        assert started.status_code == 200, started.get_json()
        state = started.get_json()["state"]
        summary = client.get(base).get_json()
        assert summary["in_combat"] is True
        assert summary["combat_resumable"] is True
        assert client.post(f"{base}/combat/start", json={"encounter_id": "enc_quick_test_1"}).status_code == 409
        assert client.post(f"{base}/combat/complete", json={}).status_code == 409
        assert client.post(f"{base}/combat/settlement", json={}).status_code == 409
        session = app._managers["session"].get_session(session_id)
        with app.app_context():
            assert _require_no_combat(session)[1] == 423

        suspended = client.post(f"{base}/sideview/save", json={
            "runId": state["runId"], "snapshot": state["snapshot"], "suspended": True,
        })
        assert suspended.status_code == 200
        summary = client.get(base).get_json()
        assert summary["in_combat"] is False
        assert summary["combat_resumable"] is True
        assert summary["combat_resume"]["engine"] == "sideview"
        assert summary["combat_resume"]["encounter_id"] == "enc_quick_test_1"
        with app.app_context():
            assert _require_no_combat(session)[1] == 423
        assert client.post(f"{base}/sideview/abandon", json={"runId": state["runId"]}).status_code == 200
        assert client.get(base).get_json()["combat_resumable"] is False
    finally:
        client.delete(base)
