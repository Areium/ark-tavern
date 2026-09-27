"""Card catalogs and runtime cache honor installed worldbook ownership."""

import json
import sys
from pathlib import Path

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from blueprints import cards as cards_bp
from combat_engine import card_json_loader


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _card(name):
    return {"card_id": "c1", "name": name, "description": "", "damage_type": "physical",
            "min_damage": 1, "max_damage": 1, "atk_scale": 0, "target": "SINGLE",
            "range": 1, "cost": 1, "tier": "basic"}


@pytest.fixture
def scoped_cards(tmp_path, monkeypatch):
    books = tmp_path / "data" / "worldbooks"
    content = books / "content"
    classes = content / "classes"
    chars = content / "characters"
    for base in (classes, chars):
        (base / "Owned").mkdir(parents=True)
        (base / "Custom").mkdir()
    _write_json(classes / "Owned" / "cards.json", {"cards": [_card("Owned card")]})
    _write_json(classes / "Custom" / "cards.json", {"cards": [_card("Custom card")]})
    _write_json(chars / "Owned" / "combat.json", {"exclusive_cards": [_card("Owned card")]})
    _write_json(chars / "Custom" / "combat.json", {"exclusive_cards": [_card("Custom card")]})
    _write_json(books / "content_manifest.json", {
        "directories": {"classes/Owned/": ["owner"], "characters/Owned/": ["owner"]},
        "files": {},
    })
    monkeypatch.setattr(cards_bp, "CLASS_DIR", classes)
    monkeypatch.setattr(cards_bp, "CHAR_DIR", chars)
    monkeypatch.setattr(card_json_loader, "_CLASS_DIR", classes)
    card_json_loader.clear_cache()
    app = Flask(__name__)
    cards_bp.register(app, {})
    app.config.update(TESTING=True)
    yield app.test_client(), books, classes, chars
    card_json_loader.clear_cache()


def test_card_api_filters_lists_tree_and_direct_reads(scoped_cards):
    client, books, _, _ = scoped_cards
    assert client.get("/api/cards").json["characters"] == ["Custom"]
    assert client.get("/api/cards/classes").json["classes"] == ["Custom"]
    assert client.get("/api/cards/tree").json["classes"] == ["Custom"]
    assert client.get("/api/cards/Owned").status_code == 404
    assert client.get("/api/cards/classes/Owned").status_code == 404
    assert client.get("/api/cards/classes/Custom").status_code == 200

    _write_json(books / "owner.json", {"enabled": True})
    assert client.get("/api/cards/Owned").status_code == 200
    assert client.get("/api/cards/classes/Owned").status_code == 200
    assert "Owned" in client.get("/api/cards/tree").json["characters"]
    _write_json(books / "owner.json", {"enabled": False})
    assert client.get("/api/cards/Owned").status_code == 404
    assert "Owned" not in client.get("/api/cards/tree").json["classes"]


def test_card_api_rejects_hidden_writes_and_escaping_names(scoped_cards):
    client, books, classes, chars = scoped_cards
    class_path = classes / "Owned" / "cards.json"
    char_path = chars / "Owned" / "combat.json"
    before = class_path.read_bytes(), char_path.read_bytes()
    requests = [
        client.put("/api/cards/classes/Owned", json={"cards": []}),
        client.post("/api/cards/classes/Owned/cards", json={"card_id": "new"}),
        client.delete("/api/cards/classes/Owned/cards/c1"),
        client.put("/api/cards/Owned", json={"exclusive_cards": []}),
        client.post("/api/cards/Owned/cards", json={"card_id": "new"}),
        client.delete("/api/cards/Owned/cards/c1"),
    ]
    assert all(response.status_code == 404 for response in requests)
    assert (class_path.read_bytes(), char_path.read_bytes()) == before
    assert client.get("/api/cards/classes/..").status_code == 404
    assert client.put("/api/cards/classes/..", json={"cards": []}).status_code == 404

    _write_json(books / "owner.json", {"enabled": True})
    assert client.post("/api/cards/classes/Owned/cards", json={"card_id": "new"}).status_code == 200
    _write_json(books / "owner.json", {"enabled": False})
    assert client.delete("/api/cards/classes/Owned/cards/new").status_code == 404


def test_runtime_cache_evicts_disabled_book_and_custom_data_dir_works(scoped_cards, tmp_path):
    _, books, classes, _ = scoped_cards
    assert card_json_loader.load_class_cards("Owned") == []
    _write_json(books / "owner.json", {"enabled": True})
    assert card_json_loader.load_class_cards("Owned")[0].name == "Owned card"
    _write_json(books / "owner.json", {"enabled": False})
    assert card_json_loader.load_class_cards("Owned") == []
    assert "Owned" not in card_json_loader.load_all_class_cards()

    _write_json(classes / "Owned" / "cards.json", {"cards": [_card("Reenabled card")]})
    _write_json(books / "owner.json", {"enabled": True})
    assert card_json_loader.load_class_cards("Owned")[0].name == "Reenabled card"
    assert card_json_loader.load_class_cards("..") == []

    fixture_dir = tmp_path / "fixture_classes"
    (fixture_dir / "Fixture").mkdir(parents=True)
    _write_json(fixture_dir / "Fixture" / "cards.json", {"cards": [_card("Fixture card")]})
    assert card_json_loader.load_class_cards("Fixture", fixture_dir)[0].name == "Fixture card"
