import copy
import io
import json
from pathlib import Path
import sys
import zipfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from combat_mode_packages import CombatModePackages, read_folder
from combat_mode_sessions import session_binding, plugin_state
from test_combat_resume import ACTOR, BOOK_ID, prepare_combat_book


@pytest.fixture
def setup(tmp_path, monkeypatch):
    import app as app_module
    import session_export
    from document_manager import DocumentManager
    from wiki_manager import WikiManager
    folder = prepare_combat_book(tmp_path, monkeypatch)
    adapter_dir = folder / "combat" / "modes"
    adapter_dir.mkdir()
    adapter = {"mode": "stance-duel", "interface": {"id": "stance-encounter", "version": 1},
               "encounters": {"enc_plugin": {"name": "训练", "input": {
                   "player": {"name": "玩家", "hp": 60}, "enemy": {"name": "守卫", "hp": 75}}, "resources": {}}}}
    (adapter_dir / "stance-duel.json").write_text(json.dumps(adapter), encoding="utf-8")
    monkeypatch.setattr(app_module, "DocumentManager", lambda: DocumentManager(str(tmp_path)))
    monkeypatch.setattr(app_module, "WikiManager", lambda: WikiManager(str(tmp_path)))
    monkeypatch.setattr(app_module, "CombatModePackages", lambda: CombatModePackages(tmp_path))
    monkeypatch.setattr(session_export, "_SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    packages = CombatModePackages(tmp_path)
    example = Path(__file__).resolve().parents[1] / "examples" / "combat-modes" / "stance-duel"
    packages.install(read_folder(example).archive())
    app = app_module.create_app()
    app.config.update(TESTING=True)
    return app, app.test_client(), packages, adapter_dir


def create(client, **changes):
    preview = client.post("/api/combat-modes/stance-duel/compatibility", json={"worldbook_ids": [BOOK_ID]})
    assert preview.status_code == 200 and preview.json["compatible"], preview.json
    payload = {"mode": "free", "combat_mode": "stance-duel", "identity": ACTOR,
               "worldbook_ids": [BOOK_ID], "trust_combat_plugin": True,
               "combat_binding_digest": preview.json["binding_digest"], **changes}
    return client.post("/api/sessions", json=payload)


def test_creation_rechecks_trust_digest_and_complete_runtime(setup):
    app, client, packages, adapter_dir = setup
    assert create(client, trust_combat_plugin=False).status_code == 400
    assert create(client, combat_binding_digest="stale").status_code == 409
    assert client.get("/api/sessions").json == []
    response = create(client)
    assert response.status_code == 201, response.json
    session_id = response.json["id"]
    base = f"/api/sessions/{session_id}"
    session = app._managers["session"].get_session(session_id)
    frozen = session_binding(session)
    (adapter_dir / "stance-duel.json").write_text("{}")
    packages.set_enabled("stance-duel", False)
    packages.uninstall("stance-duel")
    started = client.post(base + "/combat-plugin/start", json={"encounter_id": "enc_plugin"})
    assert started.status_code == 200, started.json
    run = started.json["run"]
    assert started.json["bundle"]["digest"] == frozen.package.digest
    assert client.get(base).json["in_combat"] is True
    assert client.get(base).json["combat_resume"]["engine"] == "plugin"
    for endpoint in ("start", "complete", "settlement"):
        assert client.post(base + "/combat/" + endpoint, json={}).status_code == 409
    assert client.post(base + "/sideview/start", json={}).status_code == 400
    from blueprints.chat import _require_no_combat
    with app.app_context():
        assert _require_no_combat(session)[1] == 423
    snapshot = {"turn": 1, "hp": 60}
    update = {"runId": run["runId"], "revision": 0, "snapshot": snapshot}
    assert client.put(base + "/combat-plugin/state", json=update).status_code == 200
    assert client.put(base + "/combat-plugin/state", json=update).status_code == 409
    update.update(revision=1, outcome="victory")
    report = client.put(base + "/combat-plugin/state", json=update)
    assert report.status_code == 200 and report.json["status"] == "settling"
    assert client.put(base + "/combat-plugin/state", json={**update, "xp": 999}).status_code == 400
    confirm = {"runId": run["runId"], "revision": 2, "accept": True}
    accepted = client.post(base + "/combat-plugin/confirm", json=confirm)
    assert accepted.status_code == 200, accepted.json
    assert accepted.json["history"]["accepted_by_user"] is True
    assert accepted.json["history"]["rewards"] is None
    assert client.post(base + "/combat-plugin/confirm", json=confirm).json == accepted.json
    assert len(plugin_state(session)["history"]) == 1
    assert client.get(base).json["in_combat"] is False
    with app.app_context():
        assert _require_no_combat(session) is None


def test_export_import_contains_frozen_mode_and_preserves_pending_result(setup, tmp_path):
    app, client, packages, _ = setup
    created = create(client)
    assert created.status_code == 201, created.json
    base = f"/api/sessions/{created.json['id']}"
    state = client.post(base + "/combat-plugin/start", json={"encounter_id": "enc_plugin"}).json
    client.put(base + "/combat-plugin/state", json={"runId": state["run"]["runId"], "revision": 0,
                                                   "snapshot": {"turn": 3}, "outcome": "defeat"})
    exported = client.get(base + "/export")
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
        assert any(name.endswith("combat_plugin/package.zip") for name in archive.namelist())
    packages.uninstall("stance-duel")
    restored = client.post("/api/sessions/import", data={"file": (io.BytesIO(exported.data), "save.zip")})
    assert restored.status_code == 201, restored.json
    assert restored.json["id"] != created.json["id"]
    state = client.get(f"/api/sessions/{restored.json['id']}/combat-plugin").json
    assert state["run"]["status"] == "settling"
    assert state["run"]["snapshot"] == {"turn": 3}


def test_save_failure_rolls_back_memory_and_narration_blocks_start(setup, monkeypatch):
    app, client, _, _ = setup
    created = create(client)
    assert created.status_code == 201, created.json
    session = app._managers["session"].get_session(created.json["id"])
    path = f"/api/sessions/{session.id}/combat-plugin/start"
    with session.overlay._narration_lock:
        assert client.post(path, json={"encounter_id": "enc_plugin"}).status_code == 409
    before = copy.deepcopy(session.overlay._data)
    def fail(): raise OSError("disk full")
    monkeypatch.setattr(session.overlay, "_save", fail)
    assert client.post(path, json={"encounter_id": "enc_plugin"}).status_code == 400
    assert session.overlay._data == before


def test_frozen_catalogue_drives_briefing_and_rejects_unknown_beat(setup):
    app, client, _, _ = setup
    created = create(client)
    assert created.status_code == 201, created.json
    session = app._managers["session"].get_session(created.json["id"])
    from blueprints.chat import _apply_combat_briefing, _should_extract_markers
    assert _should_extract_markers(session, 0)
    assert "enc_plugin" in session.scene_manager._list_encounters()
    brief = _apply_combat_briefing(session, {"encounter_id": "enc_plugin"}, "stream")
    assert brief["engine"] == "plugin" and brief["name"] == "训练"
    assert _apply_combat_briefing(session, {"encounter_id": "unavailable"}, "stream") is None
    with pytest.raises(ValueError):
        _apply_combat_briefing(session, None, "stream", "unavailable")


def test_rollback_restores_run_and_receipt_together(setup):
    app, client, _, _ = setup
    session = app._managers["session"].get_session(create(client).json["id"])
    base = f"/api/sessions/{session.id}/combat-plugin"
    before = session.overlay.commit_tree_step(narrative="战前", round_num=1)
    run = client.post(base + "/start", json={"encounter_id": "enc_plugin"}).json["run"]
    confirmation = {"runId": run["runId"], "revision": 0, "retreat": True}
    receipt = client.post(base + "/confirm", json=confirmation)
    assert receipt.status_code == 200
    completed = session.overlay.commit_tree_step(narrative="战后", round_num=2,
                                                 branch={"label": "战斗之后"})
    assert completed["id"] != before["id"]
    session.overlay.rollback_to_tree_node(before["id"])
    assert not plugin_state(session).get("run")
    assert client.post(base + "/confirm", json=confirmation).status_code == 409
    session.overlay.rollback_to_tree_node(completed["id"])
    assert client.post(base + "/confirm", json=confirmation).json == receipt.json
    assert len(plugin_state(session)["history"]) == 1
    new_run = client.post(base + "/start", json={"encounter_id": "enc_plugin"}).json["run"]
    assert new_run["runId"] != run["runId"]
    assert client.post(base + "/confirm", json=confirmation).status_code == 409


def test_confirmation_save_failure_can_retry_once(setup, monkeypatch):
    app, client, _, _ = setup
    session = app._managers["session"].get_session(create(client).json["id"])
    base = f"/api/sessions/{session.id}/combat-plugin"
    run = client.post(base + "/start", json={"encounter_id": "enc_plugin"}).json["run"]
    payload = {"runId": run["runId"], "revision": 0, "retreat": True}
    assert client.post(base + "/confirm", json={**payload, "accept": True}).status_code == 400
    before = copy.deepcopy(session.overlay._data)
    save = session.overlay._save
    def fail(): raise OSError("disk full")
    monkeypatch.setattr(session.overlay, "_save", fail)
    assert client.post(base + "/confirm", json=payload).status_code == 400
    assert session.overlay._data == before
    monkeypatch.setattr(session.overlay, "_save", save)
    receipt = client.post(base + "/confirm", json=payload)
    assert receipt.status_code == 200
    assert client.post(base + "/confirm", json=payload).json == receipt.json
    assert len(plugin_state(session)["history"]) == 1


@pytest.mark.parametrize("corruption", ["receipt", "history", "binding", "snapshot"])
def test_corrupt_saved_state_returns_controlled_error(setup, corruption):
    app, client, _, _ = setup
    session = app._managers["session"].get_session(create(client).json["id"])
    base = f"/api/sessions/{session.id}/combat-plugin"
    run = client.post(base + "/start", json={"encounter_id": "enc_plugin"}).json["run"]
    payload = {"runId": run["runId"], "revision": 0, "retreat": True}
    assert client.post(base + "/confirm", json=payload).status_code == 200
    state = session.overlay._data["combat_plugin"]
    if corruption == "receipt":
        state["run"].pop("completion")
    elif corruption == "history":
        state["history"] = [None]
    elif corruption == "binding":
        session.overlay._data["combat_plugin_binding"] = None
    else:
        state["run"].pop("snapshot")
    assert client.get(base).status_code == 400
    assert client.post(base + "/confirm", json=payload).status_code == 400


def test_restart_uses_frozen_bytes_and_keeps_damaged_save_visible(setup):
    app, client, packages, _ = setup
    session_id = create(client).json["id"]
    base = f"/api/sessions/{session_id}"
    run = client.post(base + "/combat-plugin/start", json={"encounter_id": "enc_plugin"}).json["run"]
    assert client.put(base + "/combat-plugin/state", json={"runId": run["runId"], "revision": 0,
                                                           "snapshot": {"turn": 7}}).status_code == 200
    packages.uninstall("stance-duel")
    import app as app_module
    restored_app = app_module.create_app()
    restored = restored_app.test_client()
    assert restored.get(base + "/combat-plugin").json["run"]["snapshot"] == {"turn": 7}
    session = restored_app._managers["session"].get_session(session_id)
    (session.data_dir / "combat_plugin" / "binding.json").write_text("{}", encoding="utf-8")
    damaged = app_module.create_app().test_client()
    assert damaged.get(base).status_code == 200
    assert damaged.get(base).json["combat_plugin_error"]
    assert damaged.get(base + "/combat-plugin").status_code == 400


@pytest.mark.parametrize("target", ["manifest", "package", "binding"])
def test_tampered_import_never_publishes_session(setup, target):
    app, client, _, _ = setup
    session_id = create(client).json["id"]
    exported = client.get(f"/api/sessions/{session_id}/export")
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(exported.data)) as source, zipfile.ZipFile(output, "w") as dest:
        for name in source.namelist():
            data = source.read(name)
            if target == "manifest" and name == "manifest.json":
                metadata = json.loads(data)
                metadata["session"]["combat_mode"] = "tactical"
                data = json.dumps(metadata).encode()
            elif target == "package" and name.endswith("combat_plugin/package.zip"):
                data = b"invalid archive"
            elif target == "binding" and name.endswith("combat_plugin/binding.json"):
                data = b"{}"
            dest.writestr(name, data)
    response = client.post("/api/sessions/import", data={"file": (io.BytesIO(output.getvalue()), "save.zip")})
    assert response.status_code == 400, response.json
    assert [item["id"] for item in client.get("/api/sessions").json] == [session_id]


@pytest.mark.parametrize("streaming", [False, True])
def test_real_narration_routes_emit_plugin_briefing(setup, streaming, monkeypatch):
    app, client, _, _ = setup
    session = app._managers["session"].get_session(create(client).json["id"])
    session._llm = object()
    monkeypatch.setattr(app._managers["llm_backend"], "get_config", lambda: {
        "auto_generate_choices": False, "memory_interval": 999,
    })
    scene = session.scene_manager
    monkeypatch.setattr(scene, "narrate", lambda *a, **k: ("守卫发起挑战。", {}, None))
    monkeypatch.setattr(scene, "narrate_stream", lambda *a, **k: iter([
        ("token", "守卫发起挑战。"), ("done", ("守卫发起挑战。", {}, None))]))
    monkeypatch.setattr(scene, "extract_markers", lambda *a, **k: {
        "combat": {"encounter_id": "enc_plugin"}, "beat_complete": False,
        "choices": [], "branches": [], "combat_scene": None,
    })
    base = f"/api/sessions/{session.id}"
    if streaming:
        response = client.get(base + "/narrate")
        events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines()
                  if line.startswith("data: ")]
        assert not any(event["type"] == "error" for event in events), events
        briefing = next(event["data"] for event in events if event["type"] == "combat_briefing")
    else:
        response = client.post(base + "/narrate-continue", json={"action": "前进"})
        assert response.status_code == 200, response.json
        briefing = response.json["combat_briefing"]
    assert briefing["engine"] == "plugin"
    assert briefing["encounter_id"] == "enc_plugin"
    assert session.combat is None
    assert not plugin_state(session).get("run")
    client.post(base + "/combat-plugin/start", json={"encounter_id": "enc_plugin"})
    assert client.get(base + "/narrate").status_code == 423
    assert client.post(base + "/narrate-continue", json={}).status_code == 423
