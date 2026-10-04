import base64
import concurrent.futures
import io
import json
from pathlib import Path
import sys

from flask import Flask
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from combat_mode_packages import CombatModePackages, read_folder, validate_files
from combat_mode_runs import CombatModeRuns, RunConflict, json_object, runtime_bundle
from blueprints.combat_modes import register
from test_combat_mode_packages import archive, package_files


def practice_package():
    return validate_files({**package_files(practice="practice.json"),
                           "practice.json": b'{"enemies": ["guard"]}'})


def test_freeze_save_restore_disabled_uninstalled_and_upgraded(tmp_path):
    packages = CombatModePackages(tmp_path)
    package = practice_package()
    packages.install(package.archive())
    runs = CombatModeRuns(tmp_path)
    created = runs.create(packages.get("test-mode"))
    assert created["revision"] == 0 and created["snapshot"] is None
    saved = runs.update(created["runId"], 0, {"turn": 2, "hp": 42})
    assert saved["revision"] == 1
    packages.set_enabled("test-mode", False)
    packages.uninstall("test-mode")
    packages.install(archive(package_files(version="2.0.0")))
    restored = CombatModeRuns(tmp_path).get(created["runId"])
    assert restored["snapshot"] == {"turn": 2, "hp": 42}
    assert restored["bundle"]["digest"] == package.digest
    assert restored["bundle"]["version"] == "1.0.0"
    assert len(runs.list()["runs"]) == 1
    assert not (tmp_path / "data" / "memory").exists()


def test_completed_result_is_unverified_rewardless_and_idempotent(tmp_path):
    runs = CombatModeRuns(tmp_path)
    run = runs.create(practice_package())
    result = runs.update(run["runId"], 0, {"hp": 5}, "victory")
    assert result["status"] == "completed"
    assert result["result"] == {"outcome": "victory", "verified": False, "rewards": None}
    assert runs.update(run["runId"], 0, {"hp": 5}, "victory") == result
    for outcome, snapshot in [(None, {"hp": 5}), ("defeat", {"hp": 5}), ("victory", {"hp": 6})]:
        with pytest.raises(RunConflict):
            runs.update(run["runId"], 1, snapshot, outcome)
    assert runs.list()["runs"] == []


def test_concurrent_updates_are_compare_and_swap(tmp_path):
    runs = CombatModeRuns(tmp_path)
    run = runs.create(practice_package())
    def save(turn):
        try:
            return runs.update(run["runId"], 0, {"turn": turn})["revision"]
        except RunConflict:
            return "conflict"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [2, 3]))
    assert sorted(map(str, results)) == ["1", "conflict"]
    assert runs.get(run["runId"])["revision"] == 1


def test_failed_save_does_not_advance_durable_state(tmp_path, monkeypatch):
    runs = CombatModeRuns(tmp_path)
    run = runs.create(practice_package())
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(runs, "_save", fail)
    with pytest.raises(OSError):
        runs.update(run["runId"], 0, {"turn": 9})
    loaded = CombatModeRuns(tmp_path).get(run["runId"])
    assert loaded["revision"] == 0 and loaded["snapshot"] is None


def test_corrupt_frozen_package_cannot_run(tmp_path):
    runs = CombatModeRuns(tmp_path)
    run = runs.create(practice_package())
    other = validate_files(package_files(version="9.0.0"))
    (runs.root / run["runId"] / "package.zip").write_bytes(other.archive())
    with pytest.raises(ValueError, match="fingerprint"):
        runs.get(run["runId"])


def test_corrupt_run_metadata_is_reported_not_a_server_error(tmp_path):
    runs = CombatModeRuns(tmp_path)
    run = runs.create(practice_package())
    path = runs.root / run["runId"] / "run.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    state.update(status="completed", result={"outcome": "victory", "rewards": 999})
    path.write_text(json.dumps(state), encoding="utf-8")
    with pytest.raises(ValueError, match="result"):
        runs.get(run["runId"])
    assert runs.list()["errors"][0]["runId"] == run["runId"]


@pytest.mark.parametrize("value", [[], None, {"x": float("nan")}, {"x": float("inf")},
                                   {"x": "a" * 1048576}, {1: "non-string"}])
def test_invalid_snapshot(value):
    with pytest.raises(ValueError):
        json_object(value)


def test_depth_and_cycles_are_bounded():
    cyclic = {}
    cyclic["self"] = cyclic
    with pytest.raises(ValueError, match="structural"):
        json_object(cyclic)


def test_bundle_exact_script_and_declared_resource_bytes():
    package = practice_package()
    bundle = runtime_bundle(package)
    assert base64.b64decode(bundle["entry"]) == package.files["main.js"]
    assert set(bundle["resources"]) == {"art/token.svg"}
    assert base64.b64decode(bundle["resources"]["art/token.svg"].split(",", 1)[1]) == b"<svg/>"


def test_example_folder_is_directly_installable(tmp_path):
    example = Path(__file__).resolve().parents[1] / "examples" / "combat-modes" / "stance-duel"
    package = read_folder(example, "stance-duel")
    packages = CombatModePackages(tmp_path)
    packages.install(package.archive())
    run = CombatModeRuns(tmp_path).create(packages.get("stance-duel"))
    assert run["input"]["enemy"]["name"] == "训练守卫"


def test_practice_api_lifecycle_conflicts_and_validation(tmp_path):
    packages = CombatModePackages(tmp_path)
    packages.install(practice_package().archive())
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"combat_modes": packages})
    client = app.test_client()
    created = client.post("/api/combat-modes/test-mode/practice")
    assert created.status_code == 201
    path = f"/api/combat-mode-runs/{created.json['runId']}"
    assert client.get(path).json["bundle"]["digest"] == created.json["digest"]
    assert client.put(path, json={"revision": 0, "snapshot": {"turn": 1}}).status_code == 200
    assert client.put(path, json={"revision": 0, "snapshot": {"turn": 2}}).status_code == 409
    assert client.put(path, json={"revision": 1, "snapshot": []}).status_code == 400
    assert client.put(path, json={"revision": True, "snapshot": {}}).status_code == 400
    assert client.put(path, json={"revision": 1, "snapshot": {}, "outcome": "cheat"}).status_code == 400
    assert client.put(path, json={"revision": 1, "snapshot": {}, "rewards": 999}).status_code == 400
    assert client.put(path, json={"revision": 1, "snapshot": {}, "outcome": "retreat"}).status_code == 200
    assert client.get("/api/combat-mode-runs").json["runs"] == []
    packages.set_enabled("test-mode", False)
    assert client.post("/api/combat-modes/test-mode/practice").status_code == 400
    assert client.get(path).status_code == 200
    assert client.get("/api/combat-mode-runs/not-a-run").status_code == 400
