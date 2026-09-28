"""Only enabled book folders own runtime content."""

import json
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints import assets
from content_scope import is_content_visible
from document_manager import DocumentManager, DocumentNotFoundError
from wiki_manager import WikiManager


@pytest.fixture
def bookshelf(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: characters/\n", encoding="utf-8")
    books = data / "worldbooks" / "books"
    for book_id, enabled in (("one", True), ("disabled", False)):
        actor = books / book_id / "characters" / "Hero"
        actor.mkdir(parents=True)
        (books / book_id / "book.json").write_text(
            json.dumps({"id": book_id, "enabled": enabled}), encoding="utf-8")
        (actor / "index.md").write_text(f"{book_id} body", encoding="utf-8")
        (actor / "avatar.png").write_bytes(book_id.encode())
    return tmp_path, books


def test_empty_bookshelf_has_no_documents_or_assets(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: characters/\n", encoding="utf-8")
    manager = DocumentManager(str(tmp_path))
    assert manager.list_documents("characters") == []
    assert WikiManager(str(tmp_path)).get_document("characters", "Hero") == ""
    app = Flask(__name__)
    assets.register(app, {"document": manager})
    assert app.test_client().get("/api/assets/characters/Hero/avatar.png").status_code == 404


def test_only_enabled_book_content_is_visible(bookshelf):
    root, books = bookshelf
    visible = books / "one" / "characters" / "Hero" / "index.md"
    hidden = books / "disabled" / "characters" / "Hero" / "index.md"
    assert is_content_visible(visible, project_root=root)
    assert not is_content_visible(hidden, project_root=root)
    assert not is_content_visible(root / "outside.md", project_root=root)

    manager = DocumentManager(str(root))
    docs = manager.list_documents("characters")
    assert [(doc["id"], doc["worldbook_id"]) for doc in docs] == [("Hero", "one")]
    assert manager.read_document("characters", "Hero")["content"] == "one body"
    with pytest.raises(DocumentNotFoundError):
        manager.read_document("characters", "Hero", book_id="disabled")
    app = Flask(__name__)
    assets.register(app, {"document": manager})
    client = app.test_client()
    assert client.get("/api/assets/characters/Hero/avatar.png?worldbook_id=one").data == b"one"
    assert client.get("/api/assets/characters/Hero/avatar.png?worldbook_id=disabled").status_code == 404


def test_traversal_and_symlink_content_are_hidden(bookshelf, tmp_path):
    root, books = bookshelf
    actor = books / "one" / "characters" / "Hero"
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"secret")
    app = Flask(__name__)
    assets.register(app, {"document": DocumentManager(str(root))})
    client = app.test_client()
    assert client.get("/api/assets/characters/../secret.png?worldbook_id=one").status_code == 404
    assert client.get("/api/assets/characters/Hero/avatar.png?worldbook_id=../one").status_code == 404
    link = actor / "link.png"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    assert not is_content_visible(link, project_root=root)
    assert client.get("/api/assets/characters/Hero/link.png?worldbook_id=one").status_code == 404
