"""Combat files belong to enabled worldbook folders and honor binding order."""

import json

import pytest
from flask import Flask

import data_paths
import content_scope
from combat_data_loader import CombatDataLoader
from combat_nodes import (NodeError, create_node, delete_node, load_node_file,
                          node_bindings, node_exists,
                          node_graph, node_overview, plot_flows, template_data)
from combat_rules import difficulty_rules
from combat_session import CombatSession


def test_combat_session_uses_bound_scaling_method():
    session = CombatSession("scaling", book_ids=[])
    assert session._resolve_band_scaling({"difficulty": {
        "band": "T2", "apply_band_scaling": False}}) == (1.0, 1.0)


def _book(root, book_id, *, enabled=True, hp=30, marker=""):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(
        json.dumps({"id": book_id, "enabled": enabled}), encoding="utf-8")
    nodes = folder / "combat" / "nodes"
    nodes.mkdir(parents=True)
    (nodes / "same.json").write_text(
        json.dumps({"node_id": "same", "name": marker, "worldbook_id": book_id}),
        encoding="utf-8")
    enemies = folder / "enemies"
    enemies.mkdir()
    (enemies / "same.md").write_text(
        f"---\nname: {marker}\ncombat_stats:\n  hp: {hp}\n---\n",
        encoding="utf-8")
    rules = folder / "combat" / "rules"
    rules.mkdir()
    (rules / "difficulty.json").write_text(
        json.dumps({"marker": marker}), encoding="utf-8")
    return folder


def test_bound_combat_files_use_binding_order_and_disable(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    first = _book(tmp_path, "first", marker="first", hp=31)
    _book(tmp_path, "second", marker="second", hp=42)

    loader = CombatDataLoader(book_ids=["second", "first"])
    assert loader.load_node("same")["name"] == "second"
    assert loader.load_enemy("same").max_hp == 42
    assert difficulty_rules(book_ids=["second", "first"])["marker"] == "second"
    assert load_node_file("same", book_ids=["second", "first"])["name"] == "second"
    assert CombatDataLoader(book_id="first").load_node("same")["name"] == "first"
    assert not CombatDataLoader(book_ids=[]).load_node("same")
    assert not node_exists("same", book_ids=[])

    (first / "book.json").write_text(
        json.dumps({"id": "first", "enabled": False}), encoding="utf-8")
    assert CombatDataLoader(book_id="first").load_node("same") is None
    assert CombatDataLoader(book_id="first").load_enemy("same") is None
    assert load_node_file("same", book_id="first") is None
    assert "marker" not in difficulty_rules(book_id="first")


def test_editor_create_writes_inside_named_book(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    folder = _book(tmp_path, "owned", marker="owned")
    create_node("new", "New", from_template=False, worldbook_id="owned")
    assert (folder / "combat" / "nodes" / "new.json").is_file()
    assert load_node_file("new", book_id="owned")["worldbook_id"] == "owned"


def test_legacy_shared_combat_is_not_a_runtime_source(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    books = tmp_path / "data" / "worldbooks" / "books"
    books.mkdir(parents=True)
    (books / "legacy.json").write_text(
        json.dumps({"id": "legacy", "enabled": True}), encoding="utf-8")
    shared = tmp_path / "data" / "worldbooks" / "content"
    monkeypatch.setattr(content_scope, "CONTENT_ROOT", shared)
    monkeypatch.setattr(content_scope, "WORLDBOOKS_ROOT", shared.parent)
    node = shared / "combat" / "nodes" / "legacy_node.json"
    node.parent.mkdir(parents=True)
    node.write_text(json.dumps({"node_id": "legacy_node"}), encoding="utf-8")
    enemy = shared / "enemies" / "legacy_enemy.md"
    enemy.parent.mkdir()
    enemy.write_text("---\nname: legacy_enemy\ncombat_stats:\n  hp: 30\n---\n",
                     encoding="utf-8")
    rule = shared / "combat" / "rules" / "difficulty.json"
    rule.parent.mkdir()
    rule.write_text(json.dumps({"marker": "legacy"}), encoding="utf-8")
    plot = shared / "plots" / "legacy_plot" / "index.md"
    plot.parent.mkdir(parents=True)
    plot.write_text("---\nname: Legacy plot\n---\n"
                    "## 章节 1：旧书\n#### beat_old\n[COMBAT:legacy_node]\n",
                    encoding="utf-8")
    (shared.parent / "content_manifest.json").write_text(json.dumps({
        "directories": {"combat/": ["legacy"], "enemies/": ["legacy"],
                        "plots/": ["legacy"]},
        "files": {}
    }), encoding="utf-8")

    for bound in ([], ["other"], ["legacy"]):
        loader = CombatDataLoader(book_ids=bound)
        assert loader.load_node("legacy_node") is None
        assert loader.load_enemy("legacy_enemy") is None
        assert loader.list_enemy_names() == []
        assert not loader._visible(node)
        assert load_node_file("legacy_node", book_ids=bound) is None
        assert node_bindings(book_ids=bound) == {}
        assert plot_flows(book_ids=bound) == []
        assert "marker" not in difficulty_rules(book_ids=bound)



def test_background_and_location_follow_bound_book(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    for book_id in ("one", "two"):
        folder = _book(tmp_path, book_id, marker=book_id)
        background = folder / "combat" / "backgrounds" / "square"
        background.mkdir(parents=True)
        (background / "index.md").write_text(
            "---\nimage: scene.png\n---\n", encoding="utf-8")
        (background / "scene.png").write_bytes(book_id.encode())
        location = folder / "environment" / "Location" / "Square"
        location.mkdir(parents=True)
        (location / "index.md").write_text(
            f"---\nname: Square\ncombat_bg: {book_id}_scene\n---\n",
            encoding="utf-8")

    loader = CombatDataLoader(book_ids=["two", "one"])
    assert loader.list_background_ids() == ["square"]
    assert loader.load_background("square")["image"] == "scene.png"
    assert loader.background_image_url("square") == (
        "/api/assets/combat_backgrounds/square/scene.png?worldbook_id=two")
    assert loader.location_background_id("Square") == "two_scene"
    assert CombatDataLoader(book_id="one").background_image_url("square").endswith(
        "?worldbook_id=one")
    assert CombatDataLoader(book_ids=[]).background_image_url("square") is None
    assert CombatDataLoader(book_ids=[]).location_background_id("Square") == ""


def test_node_graph_keeps_same_id_in_each_book_and_reads_own_plot(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    for book_id in ("one", "two"):
        folder = _book(tmp_path, book_id, marker=book_id)
        plot = folder / "plots" / "same_plot" / "index.md"
        plot.parent.mkdir(parents=True)
        plot.write_text(
            f"---\nname: {book_id} story\n---\n"
            f"## 章节 1：{book_id}\n#### beat_open\n[COMBAT:same]\n",
            encoding="utf-8")

    one_rows, _ = node_overview(book_id="one")
    two_rows, _ = node_overview(book_id="two")
    assert [row["name"] for row in one_rows] == ["one"]
    assert [row["name"] for row in two_rows] == ["two"]
    assert node_bindings(book_id="one")["same"][0]["worldbook_id"] == "one"
    assert node_bindings(book_id="two")["same"][0]["worldbook_id"] == "two"
    assert plot_flows(book_id="two")[0]["name"] == "two story"
    assert node_graph("two")["plots"][0]["worldbook_id"] == "two"
    assert node_graph("one")["nodes"][0]["markers"][0]["plot_id"] == "same_plot"
    with pytest.raises(NodeError, match="节点被剧情引用"):
        delete_node("same", book_id="one")

    folder = tmp_path / "data" / "worldbooks" / "books" / "two"
    (folder / "book.json").write_text(
        json.dumps({"id": "two", "enabled": False}), encoding="utf-8")
    assert node_overview(book_id="two")[0] == []
    assert plot_flows(book_id="two") == []


def test_node_crud_routes_select_same_id_by_book(tmp_path, monkeypatch):
    from blueprints import combat_nodes as nodes_api

    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    _book(tmp_path, "one", marker="one")
    _book(tmp_path, "two", marker="two")
    app = Flask(__name__)
    app.config["TESTING"] = True
    nodes_api.register(app, {"session": object()})
    client = app.test_client()
    url = "/api/combat/nodes/same"

    assert client.get(url + "?book_id=one").json["node"]["name"] == "one"
    assert client.get(url + "?book_id=two").json["node"]["name"] == "two"
    assert client.get(url + "/worldbook?book_id=two").json["entry"]["name"] == "节点：two"

    payload = template_data()
    payload.update({"node_id": "same", "name": "updated", "worldbook_id": "two",
                    "enemies_def": {"grunt": {"combat_stats": {"hp": 10}}},
                    "waves": [{"enemies": [{"enemy": "grunt"}]}]})
    assert client.put(url + "?book_id=one", json=payload).status_code == 400
    response = client.put(url + "?book_id=two", json=payload)
    assert response.status_code == 200, response.json
    assert client.get(url + "?book_id=two").json["node"]["name"] == "updated"
    assert client.get(url + "?book_id=one").json["node"]["name"] == "one"

    assert client.delete(url + "?book_id=two").status_code == 200
    assert client.get(url + "?book_id=two").status_code == 404
    assert client.get(url + "?book_id=one").status_code == 200
    created = client.post("/api/combat/nodes?book_id=two",
                          json={"node_id": "new", "name": "new"})
    assert created.status_code == 201
    assert load_node_file("new", book_id="two")["worldbook_id"] == "two"
