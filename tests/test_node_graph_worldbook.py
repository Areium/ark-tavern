"""Worldbook combat-node import stamps ownership without bundled nodes."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import combat_nodes  # noqa: E402
from combat_nodes import (  # noqa: E402
    decode_worldbook_entry, encode_node_for_worldbook, import_worldbook_nodes,
)


@pytest.fixture()
def no_write(monkeypatch):
    captured: dict = {}

    def fake_save_node(data, expected_hash="", *, enemy_names=None):
        captured[data["node_id"]] = data
        return data

    monkeypatch.setattr(combat_nodes, "save_node", fake_save_node)
    return captured


def test_import_worldbook_nodes_stamps_worldbook_id(no_write):
    node = {
        "node_id": "enc_wb_import", "name": "导入测试",
        "map": {"rows": 5, "cols": 5, "tiles": "ground",
                "deploy": {"player": {"rect": [0, 0, 4, 0]},
                           "enemy": {"rect": [0, 4, 4, 4]}}},
        "waves": [{"enemies": [{"enemy": "整合运动士兵", "count": 1, "positions": [[2, 4]]}]}],
    }
    entry = encode_node_for_worldbook(node)
    assert decode_worldbook_entry(entry)["node_id"] == "enc_wb_import"

    result = import_worldbook_nodes([entry], book_id="fixture-book")
    assert result["errors"] == []
    assert result["imported"] == [{"node_id": "enc_wb_import", "book_id": "fixture-book"}]
    stamped = no_write["enc_wb_import"]
    assert stamped["worldbook_id"] == "fixture-book"
    assert stamped["source"] == {
        "type": "worldbook", "book_id": "fixture-book", "entry_uid": entry["uid"],
    }
