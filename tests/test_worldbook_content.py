"""Content resolution follows the selected world's ordinary folder files."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from content_scope import invalidate_visibility_cache, is_content_visible
from worldbook_content import content_candidates, invalidate_content_cache, resolve_content


def _book(root: Path, book_id: str, enabled: bool = True) -> Path:
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(json.dumps({
        "id": book_id, "enabled": enabled,
    }), encoding="utf-8")
    return folder


def test_bound_books_choose_their_own_image_in_order(tmp_path):
    first = _book(tmp_path, "first")
    second = _book(tmp_path, "second")
    for folder, body in ((first, b"first"), (second, b"second")):
        avatar = folder / "characters" / "Hero" / "avatar.png"
        avatar.parent.mkdir(parents=True)
        avatar.write_bytes(body)

    key = "characters/Hero/avatar.png"
    assert resolve_content(key, book_ids=["second", "first"], project_root=tmp_path).read_bytes() == b"second"
    assert [book_id for book_id, _ in content_candidates(
        key, book_ids=["first", "second"], project_root=tmp_path)] == ["first", "second"]
    assert resolve_content(key, book_ids=[], project_root=tmp_path) is None
    assert is_content_visible(first / key, project_root=tmp_path,
                              allowed_book_ids=["first"])
    assert not is_content_visible(first / key, project_root=tmp_path,
                                  allowed_book_ids=["second"])


def test_disabled_folder_is_not_a_content_source(tmp_path):
    folder = _book(tmp_path, "disabled", False)
    image = folder / "characters" / "Hero" / "avatar.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"private")
    assert resolve_content("characters/Hero/avatar.png", book_ids=["disabled"],
                           project_root=tmp_path) is None
    assert not is_content_visible(image, project_root=tmp_path)


def test_explicit_refresh_forgets_enabled_metadata_even_when_stat_is_unchanged(tmp_path):
    folder = _book(tmp_path, "toggle", True)
    image = folder / "characters" / "Hero" / "avatar.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"private")
    metadata = folder / "book.json"
    metadata.write_text(metadata.read_text(encoding="utf-8").replace("true", "true "),
                        encoding="utf-8")
    stat = metadata.stat()
    assert resolve_content("characters/Hero/avatar.png", book_ids=["toggle"],
                           project_root=tmp_path) == image
    assert is_content_visible(image, project_root=tmp_path)
    metadata.write_text(metadata.read_text(encoding="utf-8").replace("true ", "false"),
                        encoding="utf-8")
    import os
    os.utime(metadata, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert metadata.stat().st_size == stat.st_size
    invalidate_content_cache()
    invalidate_visibility_cache()
    assert resolve_content("characters/Hero/avatar.png", book_ids=["toggle"],
                           project_root=tmp_path) is None
    assert not is_content_visible(image, project_root=tmp_path)


def test_folder_content_rejects_links_and_traversal(tmp_path):
    folder = _book(tmp_path, "safe")
    image = folder / "characters" / "image.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"ok")
    assert resolve_content("characters/image.png", book_ids=["safe"],
                           project_root=tmp_path) == image
    try:
        resolve_content("../image.png", book_ids=["safe"], project_root=tmp_path)
    except ValueError:
        pass
    else:
        raise AssertionError("path traversal was accepted")


def test_legacy_shared_file_is_never_a_worldbook_source(tmp_path):
    root = tmp_path / "data" / "worldbooks"
    books = root / "books"
    books.mkdir(parents=True)
    for book_id in ("first", "second"):
        (books / f"{book_id}.json").write_text(json.dumps({
            "id": book_id, "enabled": True,
        }), encoding="utf-8")
    image = root / "content" / "characters" / "Hero" / "avatar.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"first only")
    (root / "content_manifest.json").write_text(json.dumps({
        "directories": {}, "files": {"characters/Hero/avatar.png": ["first"]},
    }), encoding="utf-8")

    key = "characters/Hero/avatar.png"
    assert resolve_content(key, book_ids=["second"], project_root=tmp_path) is None
    assert resolve_content(key, book_ids=["first"], project_root=tmp_path) is None
    assert resolve_content(key, project_root=tmp_path) is None
    assert not is_content_visible(image, project_root=tmp_path)


def test_unowned_local_content_remains_global_only(tmp_path):
    image = tmp_path / "data" / "worldbooks" / "content" / "characters" / "Custom" / "avatar.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"custom")
    assert is_content_visible(image, project_root=tmp_path)
    assert not is_content_visible(image, project_root=tmp_path,
                                  allowed_book_ids=["book"])
    assert resolve_content("characters/Custom/avatar.png", project_root=tmp_path) is None
