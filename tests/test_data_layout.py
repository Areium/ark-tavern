"""Integration checks for the worldbook-centred data layout.

These tests use temporary roots for generators, audits, and data APIs.
They never call an LLM or rewrite the installed ``arknights`` worldbook.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))


def test_plot_roster_uses_only_initial_characters():
    """剧情阵容口径只读取 `initial_characters`。

    新建向导的预选与服务端开场角色加载共用 `session_overlay.plot_initial_characters`，
    这里钉住去重保序与「非列表 / 非字符串」兜底，不依赖本地安装状态。
    """
    from session_overlay import plot_initial_characters

    assert plot_initial_characters({"initial_characters": ["临光", "瑕光"]}) == ["临光", "瑕光"]
    # 仅显式 initial_characters 参与开场阵容。
    assert plot_initial_characters({"characters": ["博士", "阿米娅", "博士"]}) == []
    # 不与其它字段合并
    assert plot_initial_characters({"initial_characters": ["A"], "characters": ["B"]}) == ["A"]
    # 显式空列表 = 没有开场角色
    assert plot_initial_characters({"initial_characters": [], "characters": ["B"]}) == []
    # 缺字段 / 类型不对：空列表，不抛异常
    assert plot_initial_characters({}) == []
    assert plot_initial_characters({"characters": "阿米娅"}) == []


def test_flat_markdown_crud_hash_and_entity_precedence(tmp_path):
    from document_manager import ConflictError, DocumentManager

    book = tmp_path / "data" / "worldbooks" / "books" / "fixture-book"
    book.mkdir(parents=True)
    (book / "book.json").write_text('{"id":"fixture-book","enabled":true}', encoding="utf-8")
    items = book / "items"
    items.mkdir(parents=True)
    (tmp_path / "data" / "categories.yaml").write_text(
        "categories:\n  items: items/\nhierarchy:\n  levels: []\n",
        encoding="utf-8",
    )
    flat = items / "flat.md"
    flat.write_text("---\nname: Flat\n---\noriginal\n", encoding="utf-8")
    asset = items / "flat.png"
    asset.write_bytes(b"asset")
    sibling = items / "sibling.md"
    sibling.write_text("sibling", encoding="utf-8")

    # If both representations exist, the entity index remains authoritative.
    (items / "same.md").write_text("flat duplicate", encoding="utf-8")
    entity = items / "same"
    entity.mkdir()
    (entity / "index.md").write_text("---\nname: Entity\n---\nentity body\n", encoding="utf-8")

    manager = DocumentManager(str(tmp_path))
    assert manager.read_document("items", "same", book_id="fixture-book")["content"].strip() == "entity body"

    original = manager.read_document("items", "flat", book_id="fixture-book")
    saved = manager.save_document(
        "items", "flat", "saved body\n", expected_hash=original["hash"], book_id="fixture-book",
    )
    assert manager.read_document("items", "flat", book_id="fixture-book")["content"].strip() == "saved body"

    flat.write_text("external edit", encoding="utf-8")
    with pytest.raises(ConflictError):
        manager.save_document(
            "items", "flat", "must not overwrite", expected_hash=saved["hash"], book_id="fixture-book",
        )
    assert flat.read_text(encoding="utf-8") == "external edit"

    manager.delete_document("items", "flat", book_id="fixture-book")
    assert not flat.exists()
    assert asset.read_bytes() == b"asset"
    assert sibling.is_file()
    assert (entity / "index.md").is_file()


def test_scene_prompt_uses_real_book_nodes_refreshes_and_never_invents(tmp_path, monkeypatch):
    import combat_nodes
    from SceneManager import SceneManager

    node_dir = tmp_path / "nodes"
    plot_dir = tmp_path / "plots"
    node_dir.mkdir()
    plot_dir.mkdir()
    monkeypatch.setattr(combat_nodes, "NODE_DIR", node_dir)
    monkeypatch.setattr(combat_nodes, "PLOT_DIR", plot_dir)

    node_path = node_dir / "enc_live.json"
    node_path.write_text(json.dumps({
        "node_id": "enc_live", "name": "初版", "worldbook_id": "book-a",
    }, ensure_ascii=False), encoding="utf-8")

    manager = SimpleNamespace(resolve=lambda _overlay: SimpleNamespace(id="book-a"))
    scene_manager = SceneManager(
        None, None, combat_mode="tactical", worldbook_manager=manager,
    )
    first = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "enc_live（初版）" in first

    # A hand-edited/imported valid node may have no _hash; it must still be offered.
    node_path.write_text(json.dumps({
        "node_id": "enc_live", "name": "编辑后", "worldbook_id": "book-a",
    }, ensure_ascii=False), encoding="utf-8")
    refreshed = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "enc_live（编辑后）" in refreshed
    assert "初版" not in refreshed

    manager.resolve = lambda _overlay: SimpleNamespace(id="empty-book")
    empty = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "可用遭遇：（无可用战斗节点）" in empty
    assert "初遇整合运动" not in empty


def test_background_tool_reads_json_node_references(tmp_path, monkeypatch):
    import tools.generate_combat_backgrounds as backgrounds

    nodes = tmp_path / "nodes"
    locations = tmp_path / "locations"
    nodes.mkdir()
    locations.mkdir()
    (nodes / "enc_json.json").write_text(
        json.dumps({"node_id": "enc_json", "background": "json_bg"}),
        encoding="utf-8",
    )
    (nodes / "broken.json").write_text("not json", encoding="utf-8")
    location = locations / "region" / "place"
    location.mkdir(parents=True)
    (location / "index.md").write_text(
        "---\nname: Test\ncombat_bg: location_bg\n---\n", encoding="utf-8",
    )
    (locations / "flat.md").write_text(
        "---\nname: Flat\ncombat_bg: flat_bg\n---\n", encoding="utf-8",
    )
    monkeypatch.setattr(backgrounds, "_NODE_ROOT", nodes, raising=False)
    monkeypatch.setattr(backgrounds, "_LOC_ROOT", locations, raising=False)

    assert backgrounds._referenced_bg_ids() == {
        "json_bg": "node:enc_json",
        "location_bg": f"location:{location / 'index.md'}",
        "flat_bg": f"location:{locations / 'flat.md'}",
    }


def test_location_background_accepts_flat_and_directory_documents(tmp_path):
    from combat_data_loader import CombatDataLoader

    combat_root = tmp_path / "combat"
    locations = tmp_path / "environment" / "Location"
    flat = locations / "旧城200室.md"
    nested = locations / "旧城小区" / "index.md"
    nested.parent.mkdir(parents=True)
    flat.write_text("---\nname: 旧城200室\ncombat_bg: room200\n---\n", encoding="utf-8")
    nested.write_text("---\nname: 旧城小区\ncombat_bg: old_block\n---\n", encoding="utf-8")

    loader = CombatDataLoader(str(combat_root))
    assert loader.location_background_id("旧城200室") == "room200"
    assert loader.location_background_id("旧城小区") == "old_block"
    assert loader.location_background_id("不存在") == ""
