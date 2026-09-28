"""Asset URLs resolve installed book files without copying them into content."""

import json
import sys
from io import BytesIO
from pathlib import Path

import pytest
from flask import Flask


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints import assets
from document_manager import DocumentManager


@pytest.fixture
def asset_client(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n"
        "  characters: characters/\n"
        "  locations: environment/Location/\n",
        encoding="utf-8",
    )
    app = Flask(__name__)
    app.config.update(TESTING=True)
    assets.register(app, {"document": DocumentManager(str(tmp_path))})
    return app.test_client(), tmp_path


def _book(root, book_id, path, payload):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "book.json").write_text(
        json.dumps({"id": book_id, "enabled": True}), encoding="utf-8")
    image = folder / path
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(payload)
    return folder


def test_book_image_is_served_and_hidden_when_disabled(asset_client):
    client, root = asset_client
    folder = _book(root, "one", "characters/Hero/avatar.png", b"book-one")
    url = "/api/assets/characters/Hero/avatar.png"
    assert client.get(url).data == b"book-one"
    assert client.get(url + "?worldbook_id=one").data == b"book-one"
    (folder / "book.json").write_text(
        json.dumps({"id": "one", "enabled": False}), encoding="utf-8")
    assert client.get(url).status_code == 404
    assert client.get(url + "?worldbook_id=one").status_code == 404


def test_same_path_can_be_selected_by_book_id(asset_client):
    client, root = asset_client
    _book(root, "one", "characters/Hero/avatar.png", b"one")
    _book(root, "two", "characters/Hero/avatar.png", b"two")
    url = "/api/assets/characters/Hero/avatar.png"
    assert client.get(url).data == b"one"
    assert client.get(url + "?worldbook_id=two").data == b"two"
    assert client.get(url + "?worldbook_id=missing").status_code == 404


def test_category_uses_configured_physical_path(asset_client):
    client, root = asset_client
    _book(root, "one", "environment/Location/Ship/map.png", b"map")
    assert client.get("/api/assets/locations/Ship/map.png").data == b"map"


def test_empty_bookshelf_has_no_assets(asset_client):
    client, _ = asset_client
    assert client.get("/api/assets/characters/Hero/avatar.png").status_code == 404
    assert client.get("/api/assets/images").json == []
    assert client.get("/api/assets/spine-variants").json == {"variants": {}}


def test_traversal_and_symlink_are_rejected(asset_client):
    client, root = asset_client
    folder = _book(root, "one", "characters/Hero/avatar.png", b"public")
    outside = root / "secret.png"
    outside.write_bytes(b"secret")
    assert client.get("/api/assets/characters/../secret.png?worldbook_id=one").status_code == 404
    assert client.get("/api/assets/characters/%2e%2e/secret.png?worldbook_id=one").status_code == 404
    assert client.get("/api/assets/characters/Hero/avatar.png?worldbook_id=../one").status_code == 404
    link = folder / "characters" / "Hero" / "link.png"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    assert client.get("/api/assets/characters/Hero/link.png?worldbook_id=one").status_code == 404


def test_book_asset_write_endpoints_stay_in_selected_book(asset_client):
    client, root = asset_client
    folder = _book(root, "one", "characters/Hero/avatar/old.png", b"old")
    entity = folder / "characters" / "Hero"
    (entity / "index.md").write_text("---\nname: Hero\n---\n", encoding="utf-8")

    uploaded = client.post(
        "/api/assets/characters/upload",
        data={"worldbook_id": "one", "subdir": "Hero/avatar",
              "file": (BytesIO(b"new"), "new.png")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201
    assert uploaded.json["url"].endswith("?worldbook_id=one")
    assert (entity / "avatar" / "new.png").read_bytes() == b"new"
    assert client.get(uploaded.json["url"]).data == b"new"

    setting = client.put(
        "/api/assets/characters/Hero/default-image?worldbook_id=one",
        json={"type": "avatar", "filename": "new.png"},
    )
    assert setting.status_code == 200
    assert client.get("/api/assets/characters/Hero/default-image?worldbook_id=one").json[
        "default_avatar"] == "new.png"
    assert client.delete("/api/assets/characters/Hero/avatar/new.png?worldbook_id=one").status_code == 200
    assert not (entity / "avatar" / "new.png").exists()
    assert (folder / "characters" / "Hero" / "avatar" / "old.png").is_file()


def test_upload_and_delete_require_worldbook_id(asset_client):
    client, root = asset_client
    folder = _book(root, "one", "characters/Hero/avatar.png", b"old")
    upload = client.post(
        "/api/assets/characters/upload",
        data={"subdir": "Hero", "file": (BytesIO(b"new"), "new.png")},
        content_type="multipart/form-data",
    )
    assert upload.status_code == 400
    assert not (folder / "characters" / "Hero" / "new.png").exists()
    assert client.delete("/api/assets/characters/Hero/avatar.png").status_code == 400
    assert (folder / "characters" / "Hero" / "avatar.png").read_bytes() == b"old"


def test_book_writes_reject_unsafe_paths(asset_client):
    client, root = asset_client
    folder = _book(root, "one", "characters/Hero/avatar.png", b"public")
    (folder / "characters" / "Hero" / "index.md").write_text("---\n---\n", encoding="utf-8")
    response = client.post(
        "/api/assets/characters/upload",
        data={"worldbook_id": "one", "subdir": "Hero/../Elsewhere",
              "file": (BytesIO(b"bad"), "bad.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code in (400, 403)
    assert client.delete("/api/assets/characters/../secret.png?worldbook_id=one").status_code in (403, 404)
    assert client.put(
        "/api/assets/characters/Hero/default-image?worldbook_id=one",
        json={"type": "card_face", "filename": "../avatar.png"},
    ).status_code == 400


def test_image_library_lists_book_images_with_scoped_urls(asset_client):
    client, root = asset_client
    one = _book(root, "one", "characters/Hero/avatar.png", b"one")
    two = _book(root, "two", "characters/Hero/avatar.png", b"two")
    for folder in (one, two):
        (folder / "characters" / "Hero" / "index.md").write_text(
            "---\nname: Hero\n---\n", encoding="utf-8")
    groups = client.get("/api/assets/images").json
    assert [group["worldbook_id"] for group in groups] == ["one", "two"]
    assert [client.get(group["images"][0]["url"]).data for group in groups] == [b"one", b"two"]
    assert [group["worldbook_id"] for group in client.get(
        "/api/assets/images?worldbook_id=two").json] == ["two"]

    (one / "book.json").write_text(json.dumps({"id": "one", "enabled": False}),
                                   encoding="utf-8")
    assert [group["worldbook_id"] for group in client.get("/api/assets/images").json] == ["two"]


def test_spine_variants_use_same_book_as_character(asset_client):
    client, root = asset_client
    one = _book(root, "one", "characters/Hero/index.md", b"# Hero")
    two = _book(root, "two", "characters/Hero/index.md", b"# Hero")
    (one / "spine_variants.json").write_text(
        json.dumps({"Hero": "one/default", "Missing": "bad"}), encoding="utf-8")
    (two / "spine_variants.json").write_text(
        json.dumps({"Hero": "two/default"}), encoding="utf-8")
    assert client.get("/api/assets/spine-variants").json == {"variants": {"Hero": "one/default"}}
    assert client.get("/api/assets/spine-variants?worldbook_id=two").json == {
        "variants": {"Hero": "two/default"}}
    (one / "book.json").write_text(json.dumps({"id": "one", "enabled": False}),
                                   encoding="utf-8")
    assert client.get("/api/assets/spine-variants").json == {"variants": {"Hero": "two/default"}}
