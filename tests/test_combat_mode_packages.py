"""Portable mode discovery and installation must not execute package code."""
import io
import json
from pathlib import Path
import shutil
import stat
import sys
import zipfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import combat_mode_packages as modes


def package_files(**overrides):
    manifest = {"id": "test-mode", "name": "测试模式", "version": "1.0.0",
                "abi": modes.ABI, "entry": "main.js",
                "input": {"id": "test-encounter", "version": 1, "required": ["enemies"]},
                "resources": ["art/token.svg"]}
    manifest.update(overrides)
    return {"manifest.json": json.dumps(manifest).encode(),
            "main.js": b"throw new Error('must never execute during install');",
            "art/token.svg": b"<svg/>"}


def archive(files, prefix=""):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as out:
        for name, raw in files.items():
            out.writestr(prefix + name, raw)
    return stream.getvalue()


def folder(path, files):
    for name, raw in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    return path


def test_folder_copy_install_export_disable_and_recoverable_remove(tmp_path):
    source = folder(tmp_path / "source", package_files())
    store = modes.CombatModePackages(tmp_path / "project")
    assert store.list() == {"modes": [], "errors": []}
    shutil.copytree(source, store.root / "test-mode")
    summary = store.list()["modes"][0]
    assert summary["enabled"] is True
    original = store.get("test-mode")
    store.set_enabled("test-mode", False)
    assert not modes.CombatModePackages(tmp_path / "project").list()["modes"][0]["enabled"]
    with pytest.raises(ValueError, match="disabled"):
        store.get("test-mode")
    assert store.get("test-mode", require_enabled=False).digest == original.digest
    result = store.uninstall("test-mode")
    assert modes.read_folder(Path(result["archived_to"])).digest == original.digest
    assert store.list()["modes"] == []
    store.install(original.archive())
    store.set_enabled("test-mode", True)
    assert store.get("test-mode").digest == original.digest


@pytest.mark.parametrize("prefix", ["", "test-mode/"])
def test_archive_layouts_and_no_overwrite(tmp_path, prefix):
    store = modes.CombatModePackages(tmp_path)
    result = store.install(archive(package_files(), prefix))
    assert result["id"] == "test-mode"
    with pytest.raises(ValueError, match="already installed"):
        store.install(archive(package_files(version="2.0.0")))
    assert store.get("test-mode").manifest["version"] == "1.0.0"
    assert not list(store.root.glob(".install-*"))


@pytest.mark.parametrize("path", ["../outside", "/root", "C:/escape", "a\\b", "NUL.js",
                                  "art/a.", "a//b", "a/./b", "a/../b", "a:stream", "a?b"])
def test_unsafe_archive_names_rejected(tmp_path, path):
    store = modes.CombatModePackages(tmp_path)
    raw = archive({**package_files(), path: b"x"})
    if "\\" in path:
        # ZipInfo normalizes backslashes while writing on Windows; patch both
        # filename headers to model an actual hostile archive from another OS.
        raw = raw.replace(path.replace("\\", "/").encode(), path.encode())
    with pytest.raises(ValueError):
        store.install(raw)
    assert not store.root.exists()


@pytest.mark.parametrize("overrides", [
    {"id": "tactical"}, {"id": "../x"}, {"id": "CON"}, {"version": "1"},
    {"abi": "ark-combat/99"}, {"entry": "missing.js"}, {"entry": "main.py"},
    {"name": " "}, {"input": {}}, {"input": {"id": "x", "version": True, "required": []}},
    {"resources": ["missing.png"]}, {"permissions": ["network"]},
])
def test_manifest_contract(overrides):
    with pytest.raises(ValueError):
        modes.validate_files(package_files(**overrides))


def test_hash_tracks_every_byte_and_folder_errors_are_visible(tmp_path):
    store = modes.CombatModePackages(tmp_path)
    store.install(archive(package_files()))
    old = store.get("test-mode").digest
    (store.root / "test-mode" / "main.js").write_bytes(b"new script")
    assert store.get("test-mode").digest != old
    folder(store.root / "wrong-id", package_files())
    errors = store.list()["errors"]
    assert len(errors) == 1 and errors[0]["id"] == "wrong-id"


def test_case_collisions_and_duplicate_json():
    with pytest.raises(ValueError, match="duplicate"):
        modes.validate_files({**package_files(), "MAIN.js": b"x"})
    with pytest.raises(ValueError, match="collision"):
        modes.validate_files({**package_files(), "ART": b"x"})
    files = package_files()
    files["manifest.json"] = b'{"id":"a","id":"b"}'
    with pytest.raises(ValueError, match="Duplicate"):
        modes.validate_files(files)


def test_symlink_archive_rejected():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as out:
        for name, raw in package_files().items():
            out.writestr(name, raw)
        info = zipfile.ZipInfo("escape")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        out.writestr(info, "../secret")
    with pytest.raises(ValueError, match="Links"):
        modes.read_archive(output.getvalue())


def test_size_limits_and_failed_install_cleanup(tmp_path, monkeypatch):
    raw = archive({**package_files(), "large.bin": b"a" * 2048})
    monkeypatch.setattr(modes, "MAX_FILE_BYTES", 1024)
    with pytest.raises(ValueError, match="size"):
        modes.CombatModePackages(tmp_path).install(raw)
    assert not (tmp_path / "data" / "combat_modes").exists()


def test_oversized_file_count(monkeypatch):
    monkeypatch.setattr(modes, "MAX_FILES", 2)
    with pytest.raises(ValueError, match="limit"):
        modes.validate_files(package_files())


def test_invalid_zip_and_empty_package():
    with pytest.raises(ValueError, match="ZIP"):
        modes.read_archive(b"not zip")
    with pytest.raises(ValueError, match="manifest"):
        modes.read_archive(archive({}))


def test_invalid_state_does_not_silently_enable_modes(tmp_path):
    store = modes.CombatModePackages(tmp_path)
    store.install(archive(package_files()))
    (store.root / ".state.json").write_text('{"test-mode":"false"}')
    with pytest.raises(ValueError, match="state"):
        store.get("test-mode")
