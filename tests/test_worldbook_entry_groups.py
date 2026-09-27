"""Display folders are persisted independently of injection and trigger groups."""

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
    manager.save(WorldBook("book", "测试书", [
        WorldBookEntry("a", content="A", always_active=True, group="trigger"),
        WorldBookEntry("b", content="B", always_active=True),
    ]))
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    return app.test_client(), manager


def put(client, groups, group_map, revision):
    return client.put("/api/worldbook/book/entry-groups", json={
        "entry_groups": groups, "entry_group_map": group_map,
        "expected_revision": revision,
    })


def test_persistence_and_independence_from_injection(api):
    client, manager = api
    before = manager.load("book")
    assert client.get("/api/worldbook/book").json["entry_groups"] == []
    groups = [{"id": "plot", "name": "剧情"}, {"id": "people", "name": "角色"}]
    response = put(client, groups, {"a": "people"}, before.edit_revision)
    assert response.status_code == 200, response.json
    assert response.json == {"entry_groups": groups, "entry_group_map": {"a": "people"},
                             "edit_revision": before.edit_revision + 1}
    stored = manager.load("book")
    assert (stored.entry_groups, stored.entry_group_map) == (groups, {"a": "people"})
    assert stored.entry_order == before.entry_order
    assert stored.entries[0].group == "trigger"
    assert [e.uid for e in stored.collect_matches("", "")] == [
        e.uid for e in before.collect_matches("", "")]
    assert client.get("/api/worldbook/book").json["entry_group_map"] == {"a": "people"}


@pytest.mark.parametrize("groups,group_map", [
    ({}, {}), ([{"id": "", "name": "x"}], {}),
    ([{"id": "g", "name": " "}], {}),
    ([{"id": "g", "name": "x"}, {"id": "g", "name": "y"}], {}),
    ([{"id": "g", "name": "x"}], {"missing": "g"}),
    ([{"id": "g", "name": "x"}], {"a": "missing"}),
])
def test_validation_rejects_without_write(api, groups, group_map):
    client, manager = api
    revision = manager.load("book").edit_revision
    before = manager._path("book").read_bytes()
    response = put(client, groups, group_map, revision)
    assert response.status_code == 400
    assert manager._path("book").read_bytes() == before


def test_cas_and_group_delete_keeps_entries(api):
    client, manager = api
    revision = manager.load("book").edit_revision
    groups = [{"id": "g", "name": "文件夹"}]
    created = put(client, groups, {"a": "g"}, revision)
    assert created.status_code == 200
    before = manager._path("book").read_bytes()
    stale = put(client, [], {}, revision)
    assert stale.status_code == 409
    assert manager._path("book").read_bytes() == before
    removed = put(client, [], {"a": "g"}, created.json["edit_revision"])
    assert removed.status_code == 200
    assert removed.json["entry_group_map"] == {}
    assert [e.uid for e in manager.load("book").entries] == ["a", "b"]


def test_revision_is_required(api):
    client, manager = api
    before = manager._path("book").read_bytes()
    response = client.put("/api/worldbook/book/entry-groups", json={
        "entry_groups": [], "entry_group_map": {},
    })
    assert response.status_code == 400
    assert manager._path("book").read_bytes() == before


def test_folder_and_injection_order_save_together(api):
    client, manager = api
    before = manager.load("book")
    groups = [{"id": "first", "name": "前"}, {"id": "second", "name": "后"}]
    response = client.put("/api/worldbook/book/entry-groups", json={
        "entry_groups": groups, "entry_group_map": {"b": "first", "a": "second"},
        "entry_order": ["b", "a"], "expected_revision": before.edit_revision,
    })
    assert response.status_code == 200, response.json
    assert response.json["entry_order"] == ["b", "a"]
    assert response.json["edit_revision"] == before.edit_revision + 1
    stored = manager.load("book")
    assert stored.entry_order == ["b", "a"]
    assert stored.entry_group_map == {"b": "first", "a": "second"}
    assert [entry.uid for entry in stored.collect_matches("", "")] == ["b", "a"]


@pytest.mark.parametrize("order", [["a"], ["a", "a"], ["a", "missing"], "a,b", None])
def test_invalid_folder_order_rejects_all_changes(api, order):
    client, manager = api
    before = manager._path("book").read_bytes()
    revision = manager.load("book").edit_revision
    response = client.put("/api/worldbook/book/entry-groups", json={
        "entry_groups": [{"id": "g", "name": "组"}], "entry_group_map": {"a": "g"},
        "entry_order": order, "expected_revision": revision,
    })
    assert response.status_code == 400
    assert manager._path("book").read_bytes() == before


def test_stale_folder_order_rejects_all_changes(api):
    client, manager = api
    revision = manager.load("book").edit_revision
    assert put(client, [], {}, revision).status_code == 200
    before = manager._path("book").read_bytes()
    response = client.put("/api/worldbook/book/entry-groups", json={
        "entry_groups": [{"id": "g", "name": "组"}], "entry_group_map": {"a": "g"},
        "entry_order": ["b", "a"], "expected_revision": revision,
    })
    assert response.status_code == 409
    assert manager._path("book").read_bytes() == before


def test_folder_order_preserves_layer_partition_and_every_uid(api):
    client, manager = api
    manager.save(WorldBook("mixed", "混合", [
        WorldBookEntry("stable-a", "STABLE_A_BODY", always_active=True),
        WorldBookEntry("dynamic-a", "DYNAMIC_A_BODY", trigger_keys=["go"]),
        WorldBookEntry("stable-b", "STABLE_B_BODY", always_active=True),
        WorldBookEntry("dynamic-b", "DYNAMIC_B_BODY", trigger_keys=["go"]),
        WorldBookEntry("system", "S", enabled=False),
    ]))
    revision = manager.load("mixed").edit_revision
    order = ["stable-b", "dynamic-b", "system", "stable-a", "dynamic-a"]
    response = client.put("/api/worldbook/mixed/entry-groups", json={
        "entry_groups": [{"id": "b", "name": "后"}, {"id": "a", "name": "前"}],
        "entry_group_map": {"stable-b": "b", "dynamic-b": "b", "system": "b",
                            "stable-a": "a", "dynamic-a": "a"},
        "entry_order": order, "expected_revision": revision,
    })
    assert response.status_code == 200, response.json
    stored = manager.load("mixed")
    assert stored.entry_order == order
    matched = stored.collect_matches("go", "")
    assert [entry.uid for entry in matched] == [
        "stable-b", "stable-a", "dynamic-b", "dynamic-a"]
    stable_prompt, dynamic_prompt = stored.format_injection(matched)
    assert stable_prompt.index("STABLE_B_BODY") < stable_prompt.index("STABLE_A_BODY")
    assert dynamic_prompt.index("DYNAMIC_B_BODY") < dynamic_prompt.index("DYNAMIC_A_BODY")


def test_delete_entry_clears_mapping_and_export_import_duplicate(api):
    client, manager = api
    revision = manager.load("book").edit_revision
    groups = [{"id": "g", "name": "文件夹"}]
    assert put(client, groups, {"a": "g", "b": "g"}, revision).status_code == 200

    duplicate = client.post("/api/worldbook/book/duplicate", json={})
    assert duplicate.status_code == 201
    copied = manager.load(duplicate.json["book"]["id"])
    assert (copied.entry_groups, copied.entry_group_map) == (groups, {"a": "g", "b": "g"})

    exported = client.get("/api/worldbook/book/export").json["data"]
    assert exported["extensions"]["arknights_tavern"]["entry_group_map"] == {"a": "g", "b": "g"}
    imported = client.post("/api/worldbook/import", json={"name": "回读", "data": exported})
    assert imported.status_code == 201, imported.json
    restored = manager.load(imported.json["book"]["id"])
    assert (restored.entry_groups, restored.entry_group_map) == (groups, {"a": "g", "b": "g"})

    deleted = client.delete("/api/worldbook/book/entries/a")
    assert deleted.status_code == 200
    stored = manager.load("book")
    assert [e.uid for e in stored.entries] == ["b"]
    assert stored.entry_group_map == {"b": "g"}


def test_import_filters_mapping_for_skipped_entry(api):
    client, manager = api
    source = client.get("/api/worldbook/book/export").json["data"]
    ext = source["extensions"]["arknights_tavern"]
    ext["entry_groups"] = [{"id": "g", "name": "文件夹"}]
    ext["entry_group_map"] = {"a": "g", "skipped": "g"}
    source["entries"]["skipped"] = {"uid": "skipped", "content": "", "comment": "空条目"}
    response = client.post("/api/worldbook/import", json={"name": "回读", "data": source})
    assert response.status_code == 201, response.json
    restored = manager.load(response.json["book"]["id"])
    assert restored.entry_group_map == {"a": "g"}


def test_load_filters_stale_mapping_from_older_writer():
    book = WorldBook("book", "测试书", [WorldBookEntry("a", content="A")],
                     entry_groups=[{"id": "g", "name": "文件夹"}],
                     entry_group_map={"a": "g"})
    raw = book.to_dict()
    raw["entries"] = []
    restored = WorldBook.from_dict(raw)
    assert restored.entry_groups == [{"id": "g", "name": "文件夹"}]
    assert restored.entry_group_map == {}
