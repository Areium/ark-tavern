"""Document and Wiki lookups follow installed folder worldbooks."""

import json
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from document_manager import DocumentManager, DocumentNotFoundError
from wiki_manager import WikiManager
from blueprints import documents


def _book(root, book_id, body, *, enabled=True):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(json.dumps({
        "id": book_id, "enabled": enabled,
    }), encoding="utf-8")
    document = folder / "characters" / "Hero" / "index.md"
    document.parent.mkdir(parents=True)
    document.write_text(f"---\nname: Hero\n---\n{body}", encoding="utf-8")
    return folder, document


@pytest.fixture
def library(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: data/worldbooks/content/characters/\n",
        encoding="utf-8",
    )
    first, first_doc = _book(tmp_path, "a_first", "first body")
    second, second_doc = _book(tmp_path, "b_second", "second body")
    _book(tmp_path, "c_disabled", "disabled body", enabled=False)
    legacy = data / "worldbooks" / "content" / "characters" / "Legacy"
    legacy.mkdir(parents=True)
    (legacy / "index.md").write_text("legacy body", encoding="utf-8")
    return tmp_path, first, first_doc, second, second_doc


def test_folder_documents_are_listed_with_real_owner_and_precedence(library):
    root, _, first_doc, _, second_doc = library
    manager = DocumentManager(str(root))
    docs = {entry["id"]: entry for entry in manager.list_documents("characters")}
    assert docs["Hero"]["worldbook_id"] == "a_first"
    assert docs["Hero"]["hash"] == manager._hash_file(str(first_doc))
    assert docs["Legacy"]["worldbook_id"] == ""
    assert "c_disabled" not in {entry["worldbook_id"] for entry in docs.values()}
    assert manager.read_document("characters", "Hero")["content"] == "first body"
    assert manager.read_document("characters", "Hero", book_id="b_second")["content"] == "second body"
    assert manager.read_document("characters", "Hero", book_ids=["b_second", "a_first"])["content"] == "second body"
    with pytest.raises(DocumentNotFoundError):
        manager.read_document("characters", "Hero", book_id="c_disabled")
    assert second_doc.read_text(encoding="utf-8").endswith("second body")


def test_save_existing_folder_document_stays_in_book(library):
    root, _, first_doc, _, second_doc = library
    manager = DocumentManager(str(root))
    current = manager.read_document("characters", "Hero")
    manager.save_document("characters", "Hero", "updated", expected_hash=current["hash"])
    assert manager.read_document("characters", "Hero")["content"] == "updated"
    assert "updated" in first_doc.read_text(encoding="utf-8")
    assert "second body" in second_doc.read_text(encoding="utf-8")
    assert not (root / "data" / "worldbooks" / "content" / "characters" / "Hero").exists()


def test_wiki_refresh_tracks_new_modified_and_disabled_book_files(library):
    root, first, first_doc, _, _ = library
    wiki = WikiManager(str(root))
    assert wiki.get_document("characters", "Hero") == "first body"
    extra = first / "characters" / "New.md"
    extra.write_text("new body", encoding="utf-8")
    first_doc.write_text("changed body", encoding="utf-8")
    wiki.refresh()
    assert wiki.get_document("characters", "Hero") == "changed body"
    assert wiki.get_document("characters", "New") == "new body"
    (first / "book.json").write_text(json.dumps({
        "id": "a_first", "enabled": False,
    }), encoding="utf-8")
    wiki.refresh()
    assert wiki.get_document("characters", "Hero") == "second body"
    assert wiki.get_document("characters", "New") == ""


def test_wiki_scoped_catalog_obeys_binding_order_and_empty_binding(library):
    root, first, _, second, _ = library
    global_wiki = WikiManager(str(root))
    second_only = global_wiki.scoped(["b_second"])
    reversed_books = global_wiki.scoped(["b_second", "a_first"])
    empty = global_wiki.scoped([])

    assert global_wiki.get_document("characters", "Hero") == "first body"
    assert second_only.get_document("characters", "Hero") == "second body"
    assert reversed_books.get_document("characters", "Hero") == "second body"
    assert second_only.get_document("characters", "Legacy") == ""
    assert empty.get_document("characters", "Hero") == ""
    assert empty.query("Hero").startswith("（wiki_query: 未找到")

    (second / "characters" / "New.md").write_text("new in second", encoding="utf-8")
    second_only.refresh()
    assert second_only.get_document("characters", "New") == "new in second"
    assert global_wiki.get_document("characters", "New") == ""
    empty.refresh()
    assert empty.get_document("characters", "New") == ""
    assert (first / "characters" / "Hero" / "index.md").is_file()


def test_document_api_selects_duplicate_book_and_writes_only_that_book(library):
    root, _, first_doc, _, second_doc = library
    manager = DocumentManager(str(root))
    app = Flask(__name__)
    documents.register(app, {"document": manager, "wiki": WikiManager(str(root))})
    app.config.update(TESTING=True)
    client = app.test_client()

    response = client.get("/api/documents/characters?include_duplicates=1")
    assert response.status_code == 200
    heroes = [doc for doc in response.get_json() if doc["id"] == "Hero"]
    assert [doc["worldbook_id"] for doc in heroes] == ["a_first", "b_second"]
    assert [doc["worldbook_id"] for doc in client.get(
        "/api/documents/characters?worldbook_id=b_second").get_json()] == ["b_second"]

    selected = client.get("/api/documents/characters/Hero?worldbook_id=b_second")
    assert selected.get_json()["content"] == "second body"
    saved = client.put("/api/documents/characters/Hero", json={
        "content": "second updated", "expected_hash": selected.get_json()["hash"],
        "worldbook_id": "b_second",
    })
    assert saved.status_code == 200
    assert "second updated" in second_doc.read_text(encoding="utf-8")
    assert "first body" in first_doc.read_text(encoding="utf-8")
    conflict = client.put("/api/documents/characters/Hero", json={
        "content": "wrong target", "hash": manager._hash_file(str(first_doc)),
        "worldbook_id": "b_second",
    })
    assert conflict.status_code == 409
    assert "second updated" in second_doc.read_text(encoding="utf-8")

    missing = client.put("/api/documents/characters/Other", json={
        "content": "must not create", "worldbook_id": "b_second",
    })
    assert missing.status_code == 404
    assert not (root / "data" / "worldbooks" / "books" / "b_second" /
                "characters" / "Other").exists()
    assert client.get("/api/documents/characters/Hero?worldbook_id=../bad").status_code == 400
    assert client.put("/api/documents/characters/Hero", json={
        "content": "invalid", "worldbook_id": ["b_second"],
    }).status_code == 400

    moved = client.post("/api/documents/characters/Hero/move", json={
        "new_path": "Renamed", "worldbook_id": "b_second",
    })
    assert moved.status_code == 200
    assert client.get("/api/documents/characters/Renamed?worldbook_id=b_second").status_code == 200
    assert client.get("/api/documents/characters/Hero?worldbook_id=a_first").status_code == 200
    assert client.delete("/api/documents/characters/Renamed?worldbook_id=b_second").status_code == 200
    assert client.get("/api/documents/characters/Hero?worldbook_id=a_first").status_code == 200
