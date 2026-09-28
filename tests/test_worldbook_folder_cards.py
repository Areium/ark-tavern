"""Card JSON reads and edits use the selected installed worldbook folder."""

import json
import sys
from pathlib import Path

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import data_paths
from blueprints import cards as cards_bp
from combat_engine import card_json_loader


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _book(root, book_id, name):
    folder = root / "data" / "worldbooks" / "books" / book_id
    _write(folder / "book.json", {"id": book_id, "enabled": True})
    _write(folder / "classes" / "Guard" / "cards.json", {"cards": [{
        "card_id": "c1", "name": name, "description": "", "damage_type": "physical",
        "min_damage": 1, "max_damage": 1, "atk_scale": 0, "target": "SINGLE",
        "range": 1, "cost": 1, "tier": "basic"}]})
    _write(folder / "characters" / "Hero" / "combat.json", {
        "class_name": "Guard", "exclusive_cards": [{"card_id": "x1", "name": name}]})
    return folder


def test_folder_cards_binding_editor_and_original_file_writes(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    first = _book(tmp_path, "first", "First")
    second = _book(tmp_path, "second", "Second")
    card_json_loader.clear_cache()
    app = Flask(__name__)
    cards_bp.register(app, {})
    app.config["TESTING"] = True
    client = app.test_client()

    assert card_json_loader.load_class_cards("Guard", book_ids=["second", "first"])[0].name == "Second"
    assert card_json_loader.load_class_cards("Guard", book_ids=[]) == []
    assert card_json_loader.load_all_class_cards(book_ids=[]) == {}
    assert card_json_loader.load_class_cards("Guard", book_ids=["first"])[0].name == "First"
    assert client.get("/api/cards/tree?worldbook_id=second").json["worldbook_map"]["classes"] == {"Guard": "second"}
    assert client.get("/api/cards/classes/Guard?worldbook_id=second").json["cards"][0]["name"] == "Second"
    assert client.get("/api/cards/Hero?worldbook_id=second").json["exclusive_cards"][0]["name"] == "Second"
    assert client.put("/api/cards/Hero?worldbook_id=second", json={
        "class_name": "Guard", "exclusive_cards": [{"card_id": "x1", "name": "Edited"}]
    }).status_code == 200
    assert json.loads((second / "characters" / "Hero" / "combat.json").read_text(
        encoding="utf-8"))["exclusive_cards"][0]["name"] == "Edited"
    assert json.loads((first / "characters" / "Hero" / "combat.json").read_text(
        encoding="utf-8"))["exclusive_cards"][0]["name"] == "First"

    response = client.post("/api/cards/classes/Guard/cards?worldbook_id=second",
                           json={"card_id": "c2", "name": "New"})
    assert response.status_code == 200
    assert len(json.loads((second / "classes" / "Guard" / "cards.json").read_text(encoding="utf-8"))["cards"]) == 2
    assert len(json.loads((first / "classes" / "Guard" / "cards.json").read_text(encoding="utf-8"))["cards"]) == 1
    assert client.delete("/api/cards/classes/Guard/cards/c2?worldbook_id=second").status_code == 200
    assert client.delete("/api/cards/Hero/cards/x1?worldbook_id=second").status_code == 200
    assert json.loads((second / "characters" / "Hero" / "combat.json").read_text(encoding="utf-8"))["exclusive_cards"] == []

    _write(second / "book.json", {"id": "second", "enabled": False})
    assert card_json_loader.load_class_cards("Guard", book_ids=["second"]) == []
    assert client.get("/api/cards/classes/Guard?worldbook_id=second").status_code == 404
    assert client.put("/api/cards/classes/Guard?worldbook_id=second", json={"cards": []}).status_code == 404
    card_json_loader.clear_cache()


def test_explicit_personal_cards_do_not_write_same_named_book(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(cards_bp, "CHAR_DIR", tmp_path / "data" / "characters")
    monkeypatch.setattr(cards_bp, "CLASS_DIR", tmp_path / "data" / "classes")
    book = _book(tmp_path, "owned", "Book")
    local_card = tmp_path / "data" / "characters" / "Hero" / "combat.json"
    _write(local_card, {"exclusive_cards": [{"card_id": "x1", "name": "Personal"}]})
    app = Flask(__name__)
    cards_bp.register(app, {})
    client = app.test_client()

    assert client.get("/api/cards/Hero?worldbook_id=").json["exclusive_cards"][0]["name"] == "Personal"
    assert client.put("/api/cards/Hero?worldbook_id=", json={
        "exclusive_cards": [{"card_id": "x1", "name": "Edited personal"}]
    }).status_code == 200
    assert json.loads(local_card.read_text(encoding="utf-8"))["exclusive_cards"][0]["name"] == "Edited personal"
    assert json.loads((book / "characters" / "Hero" / "combat.json").read_text(
        encoding="utf-8"))["exclusive_cards"][0]["name"] == "Book"
