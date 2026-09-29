"""Deterministic work budgets and safety regressions for shelf loading."""

import json
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import world_book
import worldbook_folder_store as store
from world_book import WorldBookManager


@pytest.fixture
def folder(tmp_path):
    manager = WorldBookManager(tmp_path)
    book = manager.create_book("Performance fixture")
    return manager, manager._path(book.id).parent


def test_validation_visits_resources_without_rechecking_ancestors(folder, monkeypatch):
    _, root = folder
    for i in range(40):
        resource = root / "characters" / str(i) / "media" / "image.png"
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b"image")
    original = Path.stat
    calls = []

    def counted(path, *args, **kwargs):
        calls.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", counted)
    assert store.validate_folder(root)["id"] == root.name
    # Resource metadata comes from DirEntry, never Path.stat per ancestor.
    assert len(calls) <= 4


def test_load_reuses_the_validated_payload(folder, monkeypatch):
    manager, root = folder
    manager._cache.clear()
    payload = store.validate_folder(root)
    payload["name"] = "Validated exactly once"
    monkeypatch.setattr(world_book, "validate_folder", lambda _: payload)
    assert manager.load(root.name).name == "Validated exactly once"


@pytest.mark.parametrize("limit,value,error", [
    ("_MAX_FOLDER_FILES", 1, "folder exceeds"),
    ("_MAX_FOLDER_TOTAL_SIZE", 1, "folder exceeds"),
    ("_MAX_FOLDER_FILE_SIZE", 1, "resource exceeds"),
    ("MAX_BOOK_SIZE", 1, "metadata exceeds"),
])
def test_validation_keeps_size_and_count_limits(folder, monkeypatch, limit, value, error):
    _, root = folder
    (root / "resource.bin").write_bytes(b"resource")
    monkeypatch.setattr(store, limit, value)
    with pytest.raises(ValueError, match=error):
        store.validate_folder(root)


@pytest.mark.parametrize("mode,attributes,error", [
    (stat.S_IFLNK, 0, "Symlink"),
    (stat.S_IFDIR, stat.FILE_ATTRIBUTE_REPARSE_POINT, "junction"),
    (stat.S_IFIFO, 0, "Unsupported"),
])
def test_links_junctions_and_special_files_are_not_followed(folder, monkeypatch, mode, attributes, error):
    _, root = folder
    entry = SimpleNamespace(name="outside", path=str(root / "outside"),
                            stat=lambda **_: SimpleNamespace(st_mode=mode, st_file_attributes=attributes))
    scans = []

    @contextmanager
    def scan(path):
        scans.append(path)
        yield iter([entry])

    monkeypatch.setattr(store.os, "scandir", scan)
    with pytest.raises(ValueError, match=error):
        store.validate_folder(root)
    assert scans == [root]


def test_duplicate_metadata_keys_still_rejected(folder):
    _, root = folder
    (root / "book.json").write_text('{"id":"a","id":"b"}', encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate"):
        store.validate_folder(root)


def test_refresh_reads_external_edits_and_rechecks_new_resources(folder, monkeypatch):
    manager, root = folder
    assert manager.list_books()[0]["name"] == "Performance fixture"
    metadata = root / "book.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    data["name"] = "Edited outside app"
    metadata.write_text(json.dumps(data), encoding="utf-8")
    assert manager.list_books()[0]["name"] == "Edited outside app"
    (root / "new-resource.bin").write_bytes(b"too large")
    monkeypatch.setattr(store, "_MAX_FOLDER_FILE_SIZE", 1)
    assert manager.list_books() == []
