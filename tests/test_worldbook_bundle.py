"""A copied worldbook archive restores its book and owned resources."""

import io
import json
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from content_scope import is_content_visible
from blueprints.worldbook import register
from world_book import WorldBookManager


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_complete_bundle_round_trip_and_visibility(tmp_path):
    source = tmp_path / "source" / "worldbooks"
    manager = WorldBookManager(source)
    book = manager.create_book("可搬运的世界")
    common = source / "content" / "combat" / "nodes" / "fight.json"
    private = source / "content" / "characters" / "Hero" / "avatar" / "hero.png"
    _write(common, b'{"node_id":"fight"}')
    _write(private, b"image bytes")
    _write(private.parent.parent / "index.md",
           f"---\nworldbook_id: {book.id}\n---\nHero\n".encode())
    _write(source / "content" / "world" / "setting.md",
           f"---\nworldbook_id: {book.id}\n---\nSetting\n".encode())
    (source / "content_manifest.json").write_text(json.dumps({
        "directories": {}, "files": {"combat/nodes/fight.json": [book.id]},
    }), encoding="utf-8")

    archive, manifest = manager.export_bundle(book.id)
    assert archive.is_file()
    assert {item["path"] for item in manifest["resources"]} == {
        "combat/nodes/fight.json", "characters/Hero/index.md",
        "characters/Hero/avatar/hero.png", "world/setting.md",
    }
    with zipfile.ZipFile(archive) as zipped:
        book_data = zipped.read("book.json")
        assert json.loads(book_data)["id"] == book.id

    target = tmp_path / "target" / "worldbooks"
    installed = WorldBookManager(target).install_bundle_file(archive)
    assert installed.id == book.id
    assert (target / "books" / f"{book.id}.json").is_file()
    assert (target / "content" / "combat" / "nodes" / "fight.json").read_bytes() == common.read_bytes()
    actor = target / "content" / "characters" / "Hero" / "index.md"
    target_manager = WorldBookManager(target)
    assert is_content_visible(actor, content_base=target / "content")
    installed.enabled = False
    target_manager.save(installed)
    assert not is_content_visible(actor, content_base=target / "content")
    target_manager.delete_book(book.id)
    assert not is_content_visible(actor, content_base=target / "content")
    # A later, unrelated book using the same ID must not inherit old assets.
    _write(target / "books" / f"{book.id}.json", book_data)
    assert not is_content_visible(actor, content_base=target / "content")


def test_bundle_conflict_preserves_existing_files(tmp_path):
    source = tmp_path / "source" / "worldbooks"
    manager = WorldBookManager(source)
    book = manager.create_book("冲突测试")
    relative = Path("world") / "story.md"
    _write(source / "content" / relative, b"source")
    (source / "content_manifest.json").write_text(json.dumps({
        "directories": {}, "files": {relative.as_posix(): [book.id]},
    }), encoding="utf-8")
    archive, _ = manager.export_bundle(book.id)
    target = tmp_path / "target" / "worldbooks"
    existing = target / "content" / relative
    _write(existing, b"different")
    with pytest.raises(FileExistsError):
        WorldBookManager(target).install_bundle_file(archive)
    assert existing.read_bytes() == b"different"
    assert not (target / "books" / f"{book.id}.json").exists()
    assert not (target / "local_content_manifest.json").exists()


def test_inbox_imports_once_and_legacy_books_migrate(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    native = manager.create_book("旧书")
    current = root / "books" / f"{native.id}.json"
    legacy = root / f"{native.id}.json"
    current.replace(legacy)
    assert manager.migrate_legacy_books() == [native.id]
    assert current.is_file() and not legacy.exists()

    inbox = root / "inbox" / "copied.json"
    inbox.write_text(json.dumps({"entries": {"0": {
        "uid": 1, "key": ["sample"], "content": "copied content",
    }}}), encoding="utf-8")
    first = manager.list_books()
    assert len(first) == 2
    assert manager.inbox_results()[0]["status"] == "imported"
    assert len(WorldBookManager(root).list_books()) == 2


def test_inbox_native_json_preserves_book_identity_and_metadata(tmp_path):
    source = WorldBookManager(tmp_path / "source")
    original = source.create_book("完整原生书")
    original.description = "复制后仍保留"
    source.save(original)
    target_root = tmp_path / "target"
    target = WorldBookManager(target_root)
    inbox = target_root / "inbox" / "copied.json"
    inbox.write_bytes((tmp_path / "source" / "books" / f"{original.id}.json").read_bytes())

    target.list_books()

    installed = target.load(original.id)
    assert installed is not None
    assert installed.description == "复制后仍保留"
    assert target.inbox_results()[0]["status"] == "imported"


def test_layout_migration_keeps_unsupported_book_and_moves_valid_one(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    valid = manager.create_book("可迁移")
    (root / "books" / f"{valid.id}.json").replace(root / f"{valid.id}.json")
    unsupported = root / "unsupported.json"
    unsupported.write_text(json.dumps({"id": "unsupported", "entries": []}), encoding="utf-8")

    assert manager.migrate_legacy_books() == [valid.id]
    assert (root / "books" / f"{valid.id}.json").exists()
    assert unsupported.exists()


def test_inbox_sillytavern_v2_json_uses_lorebook_parser(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    (root / "inbox" / "v2.json").write_text(json.dumps({
        "id": "source-id", "name": "酒馆书", "entries": [{
            "keys": ["触发词"], "content": "正文", "enabled": True,
        }],
    }), encoding="utf-8")

    books = manager.list_books()

    assert len(books) == 1
    imported = manager.load(books[0]["id"])
    assert imported is not None
    assert imported.entries[0].trigger_keys == ["触发词"]


@pytest.mark.parametrize("unsafe_name", ["../escape.txt", "CON.txt", "trailing. "])
def test_bundle_rejects_unsafe_windows_paths(tmp_path, unsafe_name):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    archive = tmp_path / "unsafe.arkwb"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("book.json", json.dumps({"id": "unsafe", "name": "bad", "entries": []}))
        zipped.writestr("manifest.json", json.dumps({
            "format": "arkwb", "version": 1, "book_id": "unsafe", "resources": [],
        }))
        zipped.writestr("content/" + unsafe_name, "escaped")
    with pytest.raises(ValueError):
        manager.install_bundle_file(archive)
    assert not (tmp_path / "escape.txt").exists()


def test_local_owner_makes_distributed_parent_directory_visible(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("复制的角色")
    actor = root / "content" / "characters" / "Hero" / "index.md"
    _write(actor, b"# Hero")
    (root / "content_manifest.json").write_text(json.dumps({
        "directories": {"characters/Hero/": ["original"]}, "files": {},
    }), encoding="utf-8")
    (root / "local_content_manifest.json").write_text(json.dumps({
        "files": {"characters/Hero/index.md": [book.id]},
    }), encoding="utf-8")
    assert is_content_visible(actor.parent, content_base=root / "content")
    assert is_content_visible(actor, content_base=root / "content")
    book.enabled = False
    manager.save(book)
    assert not is_content_visible(actor.parent, content_base=root / "content")


def test_delete_removes_both_current_and_legacy_copy(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("双路径")
    current = root / "books" / f"{book.id}.json"
    legacy = root / f"{book.id}.json"
    legacy.write_bytes(current.read_bytes())
    assert manager.delete_book(book.id)
    assert not current.exists() and not legacy.exists()
    assert WorldBookManager(root).list_books() == []


def test_inbox_retries_failed_install_after_conflict_is_removed(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("重新导入")
    archive, _ = manager.export_bundle(book.id)
    inbox = root / "inbox" / "copy.arkwb"
    inbox.write_bytes(archive.read_bytes())
    manager.list_books()
    assert manager.inbox_results()[0]["status"] == "error"
    manager.delete_book(book.id)
    manager.list_books()
    assert manager.inbox_results()[0]["status"] == "imported"
    assert manager.load(book.id) is not None


def test_bad_archive_upload_returns_client_error(tmp_path):
    manager = WorldBookManager(tmp_path / "worldbooks")
    app = Flask(__name__)
    register(app, {"worldbook": manager})
    response = app.test_client().post("/api/worldbook/import", data={
        "file": (io.BytesIO(b"not a zip"), "bad.arkwb"),
    })
    assert response.status_code == 400


def test_parallel_installs_keep_both_owners(tmp_path):
    archives = []
    for index in range(2):
        source = tmp_path / f"source-{index}" / "worldbooks"
        maker = WorldBookManager(source)
        book = maker.create_book(f"并行 {index}")
        key = f"world/{index}.md"
        _write(source / "content" / key, b"# story")
        (source / "content_manifest.json").write_text(json.dumps({
            "directories": {}, "files": {key: [book.id]},
        }), encoding="utf-8")
        archives.append((book.id, maker.export_bundle(book.id)[0]))
    target = tmp_path / "target" / "worldbooks"
    with ThreadPoolExecutor(max_workers=2) as pool:
        installed = list(pool.map(lambda item: WorldBookManager(target).install_bundle_file(item[1]), archives))
    assert {book.id for book in installed} == {item[0] for item in archives}
    owners = json.loads((target / "local_content_manifest.json").read_text(encoding="utf-8"))["files"]
    assert len(owners) == 2


def test_large_book_and_unmanifested_story_resource_round_trip(tmp_path):
    source = tmp_path / "source" / "worldbooks"
    maker = WorldBookManager(source)
    book = maker.create_book("大容量世界书")
    book.description = "剧情" * (9 * 1024 * 1024)
    maker.save(book)
    story = source / "content" / "plots" / "large.json"
    _write(story, json.dumps({
        "worldbook_id": book.id, "text": "剧情" * (9 * 1024 * 1024),
    }, ensure_ascii=False).encode("utf-8"))

    archive, manifest = maker.export_bundle(book.id)
    assert {item["path"] for item in manifest["resources"]} == {"plots/large.json"}
    target = tmp_path / "target" / "worldbooks"
    installed = WorldBookManager(target).install_bundle_file(archive)
    assert installed.description == book.description
    assert (target / "content" / "plots" / "large.json").read_bytes() == story.read_bytes()


def test_download_uses_immutable_snapshot_during_later_export(tmp_path):
    root = tmp_path / "worldbooks"
    manager = WorldBookManager(root)
    book = manager.create_book("下载快照")
    app = Flask(__name__)
    register(app, {"worldbook": manager})
    client = app.test_client()

    first = client.get(f"/api/worldbook/{book.id}/bundle")
    assert first.status_code == 200
    book.description = "第二版"
    manager.save(book)
    second = client.get(f"/api/worldbook/{book.id}/bundle")
    assert second.status_code == 200

    def description(response):
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            return json.loads(archive.read("book.json"))["description"]

    assert description(first) == ""
    assert description(second) == "第二版"
    first.close()
    second.close()
    assert not list((root / "exports").glob(".download-*.arkwb"))
