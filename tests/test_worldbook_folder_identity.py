"""Player identity edits stay inside their selected worldbook folder."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints import sessions


def test_player_identity_edits_and_session_binding_use_selected_book(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "_REPO_ROOT", tmp_path)
    books = tmp_path / "data" / "worldbooks" / "books"
    for book_id in ("first", "second"):
        folder = books / book_id
        folder.mkdir(parents=True)
        (folder / "book.json").write_text(
            json.dumps({"id": book_id, "enabled": True}), encoding="utf-8")

    overlay = SimpleNamespace(get_worldbook_ids=lambda: ["second"])
    session = SimpleNamespace(overlay=overlay, player_identity="玩家")

    class SessionManager:
        def get_session(self, session_id):
            return session if session_id == "sample" else None

        def set_player_identity(self, session_id, identity):
            session.player_identity = identity
            return True

    app = Flask(__name__)
    app.config.update(TESTING=True)
    sessions.register(app, {"session": SessionManager()})
    client = app.test_client()

    for book_id in ("first", "second"):
        result = client.put(
            "/api/player-identities/Hero",
            json={"worldbook_id": book_id, "metadata": {"name": book_id},
                  "content": f"{book_id} profile"},
        )
        assert result.status_code == 200
        assert (books / book_id / "characters" / "Hero" / "index.md").is_file()

    listed = client.get("/api/player-identities").json
    assert {item["worldbook_id"] for item in listed} == {"first", "second"}
    assert client.put("/api/sessions/sample/identity", json={"identity": "Hero"}).status_code == 200

    assert client.delete("/api/player-identities/Hero?worldbook_id=first").status_code == 200
    assert not (books / "first" / "characters" / "Hero").exists()
    assert (books / "second" / "characters" / "Hero" / "index.md").is_file()
    assert client.put("/api/sessions/sample/identity", json={"identity": "Hero"}).status_code == 200

    (books / "second" / "book.json").write_text(
        json.dumps({"id": "second", "enabled": False}), encoding="utf-8")
    assert client.put("/api/sessions/sample/identity", json={"identity": "Hero"}).status_code == 404


def test_empty_bookshelf_does_not_resolve_identity(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "_REPO_ROOT", tmp_path)
    overlay = SimpleNamespace(get_worldbook_ids=lambda: [])
    session = SimpleNamespace(overlay=overlay, player_identity="玩家")

    class SessionManager:
        def get_session(self, _):
            return session

        def set_player_identity(self, _, identity):
            session.player_identity = identity
            return True

    app = Flask(__name__)
    app.config.update(TESTING=True)
    sessions.register(app, {"session": SessionManager()})
    response = app.test_client().put(
        "/api/sessions/sample/identity", json={"identity": "Personal"})
    assert response.status_code == 404
    assert session.player_identity == "玩家"
