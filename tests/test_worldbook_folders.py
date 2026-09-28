"""Directly copied worldbook folders are complete installation units."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from world_book import WorldBookManager
from worldbook_bundle import _relative
from worldbook_folder_store import copy_folder, validate_folder


def test_copied_folder_is_found_on_refresh_with_local_resources(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Copied")
    folder = source._path(book.id).parent
    resource = folder / "characters" / "Hero" / "index.md"
    resource.parent.mkdir(parents=True)
    resource.write_text("# Hero", encoding="utf-8")

    target = WorldBookManager(tmp_path / "target")
    assert target.list_books() == []
    shutil.copytree(folder, target._path(book.id).parent)
    assert [item["id"] for item in target.list_books()] == [book.id]
    assert target.load(book.id).name == "Copied"
    assert (target._path(book.id).parent / "characters" / "Hero" / "index.md").read_text(encoding="utf-8") == "# Hero"


def test_migration_copies_owned_resources_and_keeps_legacy_source(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("Legacy")
    old = root / "books" / f"{book.id}.json"
    manager._path(book.id).replace(old)
    manager._path(book.id).parent.rmdir()
    owned = root / "content" / "combat" / "nodes" / "fight.json"
    owned.parent.mkdir(parents=True)
    owned.write_text('{"node_id":"fight"}', encoding="utf-8")
    (root / "content_manifest.json").write_text(json.dumps({
        "directories": {}, "files": {"combat/nodes/fight.json": [book.id]},
    }), encoding="utf-8")

    assert manager.load(book.id) is None
    assert manager.list_books() == []
    assert manager.migrate_legacy_books() == [book.id]
    assert old.is_file()
    assert manager._path(book.id).is_file()
    assert (manager._path(book.id).parent / "combat" / "nodes" / "fight.json").read_bytes() == owned.read_bytes()
    owned.unlink()
    assert manager.load(book.id).id == book.id
    assert manager.migrate_legacy_books() == []


def test_runtime_ignores_legacy_json_and_save_does_not_migrate_resources(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("Legacy edit")
    old = root / f"{book.id}.json"
    manager._path(book.id).replace(old)
    manager._path(book.id).parent.rmdir()
    resource = root / "content" / "plots" / "opening.json"
    resource.parent.mkdir(parents=True)
    resource.write_text(json.dumps({"worldbook_id": book.id, "text": "scene"}), encoding="utf-8")

    assert manager.load(book.id) is None
    assert manager.list_books() == []
    manager.save(book)

    assert old.is_file()
    assert manager._path(book.id).is_file()
    assert not (manager._path(book.id).parent / "plots" / "opening.json").exists()
    assert resource.is_file()
    assert [item["id"] for item in manager.list_books()] == [book.id]
    assert manager.delete_book(book.id)
    assert old.is_file() and resource.is_file()
    assert manager.list_books() == []


def test_migration_cli_previews_then_copies_without_removing_source(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("CLI")
    legacy = root / "books" / f"{book.id}.json"
    manager._path(book.id).replace(legacy)
    manager._path(book.id).parent.rmdir()
    script = Path(__file__).resolve().parents[1] / "scripts" / "migrate_worldbook_layout.py"
    command = [sys.executable, str(script), "--worldbooks-dir", str(root)]

    preview = subprocess.run(command, capture_output=True, text=True, check=True)
    assert json.loads(preview.stdout)[0]["status"] == "ready"
    assert not manager._path(book.id).exists()
    applied = subprocess.run([*command, "--apply"], capture_output=True, text=True, check=True)
    assert json.loads(applied.stdout)[0]["status"] == "copied"
    assert legacy.is_file() and manager._path(book.id).is_file()


def test_inbox_folder_keeps_source_and_imports_once(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Inbox")
    target = WorldBookManager(tmp_path / "target")
    inbox = target._inbox_dir / book.id
    shutil.copytree(source._path(book.id).parent, inbox)

    assert [item["id"] for item in target.list_books()] == [book.id]
    assert target.inbox_results()[0]["status"] == "imported"
    assert inbox.is_dir()
    assert [item["id"] for item in target.list_books()] == [book.id]
    assert target.inbox_results()[0]["status"] == "imported"
    assert [item["id"] for item in WorldBookManager(target._dir).list_books()] == [book.id]


def test_archive_exchange_uses_only_book_folder_resources(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Archive")
    local = source._path(book.id).parent / "plots" / "intro.md"
    local.parent.mkdir()
    local.write_text("intro", encoding="utf-8")
    global_file = source._dir / "content" / "plots" / "old.md"
    global_file.parent.mkdir(parents=True)
    global_file.write_text("old", encoding="utf-8")

    archive, manifest = source.export_bundle(book.id)
    assert [item["path"] for item in manifest["resources"]] == ["plots/intro.md"]
    target = WorldBookManager(tmp_path / "target")
    assert target.install_bundle_file(archive).id == book.id
    assert (target._path(book.id).parent / "plots" / "intro.md").read_text(encoding="utf-8") == "intro"
    assert not (target._path(book.id).parent / "plots" / "old.md").exists()


def test_deleting_one_book_keeps_other_book_with_same_character_name(tmp_path):
    manager = WorldBookManager(tmp_path / "worldbooks")
    first = manager.create_book("First")
    second = manager.create_book("Second")
    for book in (first, second):
        book.character_profiles = {"Hero": "# Hero"}
        manager.save(book)
        actor = manager._path(book.id).parent / "characters" / "Hero" / "index.md"
        actor.parent.mkdir(parents=True)
        actor.write_text("# Hero", encoding="utf-8")

    assert manager.delete_book(first.id)
    assert not manager._path(first.id).parent.exists()
    assert manager._path(second.id).parent.joinpath("characters", "Hero", "index.md").is_file()
    assert manager.load(second.id) is not None


def test_duplicate_id_and_mismatched_folder_are_rejected(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Conflict")
    target = WorldBookManager(tmp_path / "target")
    target.create_book("Other")
    copy_folder(source._path(book.id).parent, target._books_dir)
    with pytest.raises(FileExistsError):
        copy_folder(source._path(book.id).parent, target._books_dir)
    wrong = tmp_path / "wrong"
    shutil.copytree(source._path(book.id).parent, wrong)
    with pytest.raises(ValueError, match="name and book ID"):
        validate_folder(wrong)
    incomplete = target._books_dir / "incomplete"
    incomplete.mkdir()
    with pytest.raises(FileExistsError):
        target.save(type(book).from_dict({**book.to_dict(), "id": "incomplete"}))


def test_folder_rejects_links_and_unsafe_resource_paths(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Safety")
    folder = source._path(book.id).parent
    with pytest.raises(ValueError):
        _relative("characters/../escape.png")
    with pytest.raises(ValueError):
        _relative("characters/CON.txt")
    link = folder / "outside"
    try:
        link.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pytest.skip("Symlink creation unavailable")
    with pytest.raises(ValueError, match="Symlink"):
        validate_folder(folder)


def test_install_pack_copies_its_owned_resources_into_book_folder(tmp_path):
    donor = WorldBookManager(tmp_path / "donor")
    book = donor.create_book("Pack")
    manager = WorldBookManager(tmp_path / "installed")
    pack_dir = tmp_path / "packs"
    pack_dir.mkdir()
    (pack_dir / f"{book.id}.json").write_text(
        json.dumps(book.to_dict()), encoding="utf-8")
    manager._packs_dir = pack_dir
    resource = manager._dir / "content" / "characters" / "Hero" / "avatar.png"
    resource.parent.mkdir(parents=True)
    resource.write_bytes(b"hero")
    (manager._dir / "content_manifest.json").write_text(json.dumps({
        "directories": {},
        "files": {"characters/Hero/avatar.png": [book.id]},
    }), encoding="utf-8")

    manager.install_pack(book.id)
    installed_resource = manager._path(book.id).parent / "characters" / "Hero" / "avatar.png"
    assert installed_resource.read_bytes() == b"hero"
    resource.unlink()
    assert installed_resource.read_bytes() == b"hero"


def test_broken_link_in_inbox_reports_error_without_hiding_books(tmp_path):
    manager = WorldBookManager(tmp_path / "installed")
    book = manager.create_book("Available")
    folder = manager._inbox_dir / "broken"
    folder.mkdir()
    try:
        (folder / "bad-link").symlink_to(tmp_path / "missing")
    except OSError:
        pytest.skip("Symlink creation unavailable")
    assert [item["id"] for item in manager.list_books()] == [book.id]
    assert manager.inbox_results()[0]["status"] == "error"
