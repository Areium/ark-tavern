"""世界书条目工作台新增持久化契约的 API 回归。"""

import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from world_book import WorldBook, WorldBookEntry, WorldBookManager  # noqa: E402


@pytest.fixture
def api(tmp_path):
    from blueprints.worldbook import register

    manager = WorldBookManager(tmp_path)
    book = WorldBook("book", "排序测试", [
        WorldBookEntry("a", name="A", content="stable-a", always_active=True, position=0,
                       secondary_keys=["Alpha, Beta"],
                       excerpt_source={"book_id": "source", "entry_uid": "original"},
                       raw={"extensions": {"kept": True}}),
        WorldBookEntry("b", name="B", content="stable-b", always_active=True, position=0),
        WorldBookEntry("c", name="C", content="dynamic-c", trigger_keys=["hit"], position=0),
    ])
    manager.save(book)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    return app.test_client(), manager


def test_metadata_roundtrips_through_export_and_import(api):
    client, _ = api
    created = client.post("/api/worldbook", json={
        "name": "有介绍的书", "description": "用于回读的简介",
        "cover_image": "https://example.test/cover.png", "book_type": "story",
    })
    assert created.status_code == 201
    book_id = created.json["book"]["id"]
    detail = client.get(f"/api/worldbook/{book_id}").json
    assert (detail["description"], detail["cover_image"]) == (
        "用于回读的简介", "https://example.test/cover.png")

    exported = client.get(f"/api/worldbook/{book_id}/export").json["data"]
    imported = client.post("/api/worldbook/import", json={"name": "回读", "data": exported})
    assert imported.status_code == 201
    restored = client.get(f"/api/worldbook/{imported.json['book']['id']}").json
    assert (restored["description"], restored["cover_image"]) == (
        "用于回读的简介", "https://example.test/cover.png")


def test_atomic_order_requires_full_permutation_and_drives_collection(api):
    client, manager = api
    initial = client.get("/api/worldbook/book").json
    revision = initial["edit_revision"]

    rejected = client.put("/api/worldbook/book/entry-order", json={
        "entry_order": ["b", "a"], "expected_revision": revision,
    })
    assert rejected.status_code == 400
    assert manager.load("book").entry_order is None

    reordered = client.put("/api/worldbook/book/entry-order", json={
        "entry_order": ["b", "a", "c"], "expected_revision": revision,
    })
    assert reordered.status_code == 200
    assert manager.load("book").entry_order == ["b", "a", "c"]
    assert [entry.uid for entry in manager.load("book").collect_matches("hit", "")] == ["b", "a", "c"]

    appended = client.post("/api/worldbook/book/entries", json={
        "uid": "d", "name": "D", "content": "dynamic-d", "trigger_keys": ["hit"],
        "expected_revision": reordered.json["edit_revision"],
    })
    assert appended.status_code == 201
    assert manager.load("book").entry_order == ["b", "a", "c", "d"]
    assert client.get("/api/worldbook/book").json["entry_order"] == ["b", "a", "c", "d"]


def test_stale_revision_rejects_without_writing(api):
    client, manager = api
    revision = client.get("/api/worldbook/book").json["edit_revision"]
    first = client.put("/api/worldbook/book", json={
        "description": "new description", "expected_revision": revision,
    })
    assert first.status_code == 200
    before = manager._path("book").read_bytes()

    stale = client.put("/api/worldbook/book/entries/a", json={
        "content": "must not persist", "expected_revision": revision,
    })
    assert stale.status_code == 409
    assert manager._path("book").read_bytes() == before
    assert next(entry for entry in manager.load("book").entries if entry.uid == "a").content == "stable-a"


def test_partial_entry_update_preserves_hidden_fields(api):
    client, manager = api
    revision = client.get("/api/worldbook/book").json["edit_revision"]
    response = client.put("/api/worldbook/book/entries/a", json={
        "content": "edited body", "expected_revision": revision,
    })
    assert response.status_code == 200
    entry = next(item for item in manager.load("book").entries if item.uid == "a")
    assert entry.content == "edited body"
    assert entry.secondary_keys == ["Alpha, Beta"]
    assert entry.excerpt_source == {"book_id": "source", "entry_uid": "original"}
    assert entry.raw == {"extensions": {"kept": True}}
