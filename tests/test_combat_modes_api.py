import io
from pathlib import Path
import sys

from flask import Flask
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from blueprints.combat_modes import register
from combat_mode_packages import CombatModePackages, read_archive
from test_combat_mode_packages import archive, package_files


@pytest.fixture
def client(tmp_path):
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"combat_modes": CombatModePackages(tmp_path)})
    return app.test_client()


def test_management_lifecycle(client):
    assert [m["id"] for m in client.get("/api/combat-modes").json["modes"]] == [
        "narrative", "tactical", "sideview"]
    response = client.post("/api/combat-modes/install", data={
        "file": (io.BytesIO(archive(package_files())), "test.zip")})
    assert response.status_code == 201
    digest = response.json["digest"]
    assert client.get("/api/combat-modes").json["modes"][-1]["runtime"] == "browser"
    assert client.put("/api/combat-modes/test-mode/enabled", json={"enabled": False}).status_code == 200
    result = client.get("/api/combat-modes/test-mode/export")
    assert result.status_code == 200
    assert read_archive(result.data).digest == digest
    removed = client.delete("/api/combat-modes/test-mode")
    assert removed.status_code == 200
    assert Path(removed.json["archived_to"]).is_dir()
    assert client.get("/api/combat-modes/test-mode/export").status_code == 404


def test_bad_requests_and_builtin_protection(client):
    assert client.post("/api/combat-modes/install").status_code == 400
    assert client.put("/api/combat-modes/x/enabled", json=[]).status_code == 400
    assert client.put("/api/combat-modes/x/enabled", json={"enabled": "false"}).status_code == 400
    assert client.delete("/api/combat-modes/tactical").status_code == 400
    # Electron's file:// renderer also has an opaque origin. Runtime isolation
    # must use CSP/capabilities, not break the desktop client with an Origin ban.
    assert client.get("/api/combat-modes", headers={"Origin": "null"}).status_code == 200
