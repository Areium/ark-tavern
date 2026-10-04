import json
from pathlib import Path
import sys
from types import SimpleNamespace

from flask import Flask
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from combat_mode_bindings import prepare_binding
from combat_mode_packages import CombatModePackages, validate_files
from blueprints.combat_modes import register
from test_combat_mode_packages import package_files


def mode(resources=()):
    return validate_files(package_files(input={"id": "test-encounter", "version": 1,
                                               "required": ["enemies"], "resources": list(resources)}))


def adapter():
    return {"mode": "test-mode", "interface": {"id": "test-encounter", "version": 1},
            "encounters": {"enc_duel": {"name": "Guard", "input": {"enemies": ["guard"]},
                                        "resources": {"background": "art/room.png"}}}}


def write_book(root, name="book-one", content=None):
    folder = root / "data" / "worldbooks" / "books" / name
    (folder / "combat" / "modes").mkdir(parents=True)
    (folder / "book.json").write_text(json.dumps({"id": name, "enabled": True, "book_type": "story"}))
    (folder / "combat" / "modes" / "test-mode.json").write_text(json.dumps(content or adapter()))
    (folder / "art").mkdir()
    (folder / "art" / "room.png").write_bytes(b"test-resource")
    return folder


def test_interface_input_and_resource_freeze(tmp_path):
    folder = write_book(tmp_path)
    package = mode(["background"])
    binding = prepare_binding(package, ["book-one"], tmp_path)
    assert binding.summary()["encounters"] == [{"id": "enc_duel", "name": "Guard", "worldbook_id": "book-one"}]
    assert binding.encounters["enc_duel"]["resources"]["background"].startswith("data:image/png;base64,")
    original_digest = binding.digest
    (folder / "art" / "room.png").write_bytes(b"changed")
    assert prepare_binding(package, ["book-one"], tmp_path).digest != original_digest
    assert binding.digest == original_digest


@pytest.mark.parametrize("fault, expected", [
    ("version", "Interface mismatch"), ("input", "Missing input"),
    ("missing-resource", "Missing resource"), ("required-resource", "missing required resources"),
    ("unsafe-resource", "Unsafe package path"), ("extra", "invalid encounter"),
])
def test_errors_locate_book_encounter_or_resource(tmp_path, fault, expected):
    data = adapter()
    encounter = data["encounters"]["enc_duel"]
    if fault == "version": data["interface"]["version"] = 2
    if fault == "input": encounter["input"] = {}
    if fault == "missing-resource": encounter["resources"]["background"] = "art/missing.png"
    if fault == "required-resource": encounter["resources"] = {}
    if fault == "unsafe-resource": encounter["resources"]["background"] = "../secret.png"
    if fault == "extra": encounter["rewards"] = 999
    write_book(tmp_path, content=data)
    with pytest.raises(ValueError, match=expected) as error:
        prepare_binding(mode(["background"]), ["book-one"], tmp_path)
    assert "book-one" in str(error.value)


def test_duplicate_encounters_and_missing_adapter_fail(tmp_path):
    with pytest.raises(ValueError, match="no .* adapter"):
        prepare_binding(mode(), [], tmp_path)
    write_book(tmp_path, "book-one")
    write_book(tmp_path, "book-two")
    with pytest.raises(ValueError, match="Duplicate encounter"):
        prepare_binding(mode(), ["book-one", "book-two"], tmp_path)


def test_runtime_package_resources_cannot_be_shadowed(tmp_path):
    data = adapter()
    data["encounters"]["enc_duel"]["resources"]["art/token.svg"] = "art/room.png"
    write_book(tmp_path, content=data)
    with pytest.raises(ValueError, match="shadows"):
        prepare_binding(mode(), ["book-one"], tmp_path)


def test_preflight_api_does_not_create_a_session_or_run(tmp_path):
    write_book(tmp_path)
    packages = CombatModePackages(tmp_path)
    packages.install(mode(["background"]).archive())
    app = Flask(__name__)
    app.config["TESTING"] = True
    manager = SimpleNamespace(load=lambda identifier: SimpleNamespace(enabled=True, is_reference=False)
                              if identifier == "book-one" else None)
    register(app, {"combat_modes": packages, "worldbook": manager})
    client = app.test_client()
    result = client.post("/api/combat-modes/test-mode/compatibility", json={"worldbook_ids": ["book-one"]})
    assert result.status_code == 200 and result.json["compatible"]
    assert result.json["encounters"][0]["id"] == "enc_duel"
    assert not (tmp_path / "data" / "memory").exists()
    assert not (tmp_path / "data" / "combat_mode_runs").exists()
    failed = client.post("/api/combat-modes/test-mode/compatibility", json={"worldbook_ids": ["missing"]})
    assert not failed.json["compatible"] and "missing" in failed.json["errors"][0]
