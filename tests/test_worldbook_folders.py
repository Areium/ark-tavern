"""A complete worldbook folder is the unit of installation and sharing."""

import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from world_book import WorldBookManager
from worldbook_folder_store import _relative, validate_folder


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


def test_bookshelf_ignores_loose_json_and_inbox(tmp_path):
    manager = WorldBookManager(tmp_path / "worldbooks")
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Old copy")
    payload = source._path(book.id).read_bytes()
    (manager._books_dir / f"{book.id}.json").write_bytes(payload)
    inbox = manager._dir / "inbox"
    inbox.mkdir()
    (inbox / "old.json").write_bytes(payload)

    assert manager.list_books() == []
    assert not manager._path(book.id).exists()
    assert (inbox / "old.json").is_file()


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


def test_mismatched_or_incomplete_folder_is_rejected(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    book = source.create_book("Conflict")
    target = WorldBookManager(tmp_path / "target")
    folder = target._path(book.id).parent
    shutil.copytree(source._path(book.id).parent, folder)
    with pytest.raises(FileExistsError):
        shutil.copytree(source._path(book.id).parent, folder)
    assert [item["id"] for item in target.list_books()] == [book.id]

    wrong = target._books_dir / "wrong"
    shutil.copytree(source._path(book.id).parent, wrong)
    with pytest.raises(ValueError, match="name and book ID"):
        validate_folder(wrong)
    assert [item["id"] for item in target.list_books()] == [book.id]

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
