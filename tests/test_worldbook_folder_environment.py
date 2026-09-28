"""Environment and quest resources stay in their selected worldbooks."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

from flask import Flask


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import content_scope
import data_paths
import environment_state
import session_overlay
from blueprints import environment as environment_blueprint


class Overlay:
    def __init__(self, book_ids):
        self.book_ids = book_ids
        self.plot_id = None
        self.quest_states = {}

    def get_worldbook_ids(self):
        return self.book_ids

    def get_plot_id(self):
        return self.plot_id

    def get_quest_states(self):
        return self.quest_states

    def load_quests_from_plot(self, plot_id):
        self.plot_id = plot_id
        self.quest_states = {"M1-1": {"status": "active", "updated_at": 1}}


def _book(root, book_id, relative, body):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "book.json").write_text(
        json.dumps({"id": book_id, "enabled": True}), encoding="utf-8")
    path = folder / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return folder


def _checkout(monkeypatch, root):
    content = root / "data" / "worldbooks" / "content"
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", root)
    monkeypatch.setattr(content_scope, "CONTENT_ROOT", content)
    monkeypatch.setattr(content_scope, "WORLDBOOKS_ROOT", content.parent)
    monkeypatch.setattr(environment_state, "CONTENT_ROOT", content)
    monkeypatch.setattr(environment_state, "_DEFAULT_ENV_DIR", str(content / "environment"))
    monkeypatch.setattr(environment_blueprint, "_REPO_ROOT", root)
    monkeypatch.setattr(session_overlay, "_PROJECT_ROOT", root)


def test_environment_reads_only_bound_books_in_order(tmp_path, monkeypatch):
    _checkout(monkeypatch, tmp_path)
    for book_id in ("first", "second"):
        _book(tmp_path, book_id, "environment/Location/Harbor/index.md",
              f"---\nname: {book_id}\n---\n{book_id} location")
        _book(tmp_path, book_id, "environment/weather/rain/index.md",
              f"---\nweather_type:\n  name: {book_id}\n---\n{book_id} weather")

    overlay = Overlay(["second", "first"])
    env = environment_state.EnvironmentState(overlay=overlay)
    assert env.load_location("Harbor") and env.location == "second"
    assert env.load_weather("rain") and env.weather == "second"
    assert env._list_locations() == ["Harbor"]

    overlay.book_ids = ["first"]
    assert env.load_location("Harbor") and env.location == "first"
    assert env.load_weather("rain") and env.weather == "first"
    overlay.book_ids = []
    assert not env.load_location("Harbor")
    assert not env.load_weather("rain")
    assert env._list_locations() == []


def test_presets_include_enabled_book_folders_without_shared_copy(tmp_path, monkeypatch):
    _checkout(monkeypatch, tmp_path)
    _book(tmp_path, "one", "environment/Location/Deck/index.md",
          "---\nname: Deck Name\n---\nDeck")
    disabled = _book(tmp_path, "disabled", "environment/weather/fog/index.md",
                     "---\nweather_type:\n  name: Fog\n---\nFog")
    (disabled / "book.json").write_text(
        json.dumps({"id": "disabled", "enabled": False}), encoding="utf-8")
    app = Flask(__name__)
    environment_blueprint.register(app, {"session": SimpleNamespace(get_session=lambda _: None)})
    response = app.test_client().get("/api/environment/presets")
    assert response.status_code == 200
    assert response.get_json()["locations"] == [{"id": "Deck", "name": "Deck Name"}]
    assert response.get_json()["weathers"] == []


def test_legacy_shared_weather_requires_bound_owner(tmp_path, monkeypatch):
    _checkout(monkeypatch, tmp_path)
    books = tmp_path / "data" / "worldbooks"
    weather = books / "content" / "environment" / "weather" / "rain" / "index.md"
    weather.parent.mkdir(parents=True)
    weather.write_text("---\nweather_type:\n  name: Legacy Rain\n---\nlegacy",
                       encoding="utf-8")
    (books / "content_manifest.json").write_text(json.dumps({
        "directories": {"environment/weather/rain/": ["legacy"]}, "files": {},
    }), encoding="utf-8")
    (books / "legacy.json").write_text(json.dumps({"id": "legacy", "enabled": True}),
                                       encoding="utf-8")

    assert not environment_state.EnvironmentState(overlay=Overlay([])).load_weather("rain")
    assert not environment_state.EnvironmentState(overlay=Overlay(["other"])).load_weather("rain")
    env = environment_state.EnvironmentState(overlay=Overlay(["legacy"]))
    assert env.load_weather("rain") and env.weather == "Legacy Rain"


def test_quest_routes_resolve_bound_plot_and_reject_other_book(tmp_path, monkeypatch):
    _checkout(monkeypatch, tmp_path)
    _book(tmp_path, "one", "plots/mission/index.md",
          "---\nid: mission\n---\n## 任务\n\n#### M1-1：One\n")
    _book(tmp_path, "two", "plots/mission/index.md",
          "---\nid: mission\n---\n## 任务\n\n#### M1-1：Two\n")
    overlay = Overlay(["two"])
    session = SimpleNamespace(overlay=overlay)
    app = Flask(__name__)
    environment_blueprint.register(app, {"session": SimpleNamespace(get_session=lambda _: session)})
    client = app.test_client()

    loaded = client.put("/api/sessions/s/quests/load", json={"plot_id": "mission"})
    assert loaded.status_code == 200
    assert loaded.get_json()["quests"][0]["name"] == "Two"
    listed = client.get("/api/sessions/s/quests")
    assert listed.get_json()["quests"][0]["name"] == "Two"

    overlay.book_ids = []
    assert client.get("/api/sessions/s/quests").get_json() == {"plot_id": None, "quests": []}
    assert client.put("/api/sessions/s/quests/load", json={"plot_id": "mission"}).status_code == 404
