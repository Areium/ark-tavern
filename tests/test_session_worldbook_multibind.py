"""多本会话书分别冻结范围、共同注入，解绑后不回退默认书。"""
import sys
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from blueprints.worldbook import register
from blueprints.sessions import register as register_sessions
from session_overlay import SessionOverlay
from world_book import WorldBook, WorldBookEntry, WorldBookManager


def test_multi_book_binding_and_injection(tmp_path, monkeypatch):
    import session_overlay

    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    manager = WorldBookManager(tmp_path / "books")
    for book_id in ("one", "two"):
        manager.save(WorldBook(book_id, book_id, [WorldBookEntry(
            "shared_uid", name=book_id, content=f"{book_id} setting",
            always_active=True)]))
    overlay = SessionOverlay("multi", "free")
    session = SimpleNamespace(id="multi", overlay=overlay,
                              scene_manager=SimpleNamespace(get_roster=lambda: []))
    sessions = SimpleNamespace(get_session=lambda sid: session if sid == "multi" else None)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager, "session": sessions})
    client = app.test_client()

    result = client.put("/api/sessions/multi/worldbooks",
                        json={"worldbook_ids": ["one", "two"]})
    assert result.status_code == 200, result.json
    assert result.json["worldbook_ids"] == ["one", "two"]
    assert all(result.json["worldbook_scopes"][bid]["resolved_entry_uids"] == ["shared_uid"]
               for bid in ("one", "two"))
    bundle = manager.resolve(overlay)
    eligible = bundle.eligible_uids_for(overlay)
    before, after = bundle.format_injection(
        bundle.collect_matches("", "", eligible_uids=eligible))
    assert "one setting" in before + after
    assert "two setting" in before + after

    result = client.put("/api/sessions/multi/worldbooks", json={"worldbook_ids": ["two"]})
    assert result.status_code == 200
    assert result.json["worldbook_scopes"]["two"]["resolved_entry_uids"] == ["shared_uid"]
    assert manager.resolve(overlay).id == "two"
    assert client.put("/api/sessions/multi/worldbooks", json={"worldbook_ids": []}).status_code == 200
    assert manager.resolve(overlay) is None
    assert SessionOverlay("multi", "free").get_worldbook_ids() == []


def test_multi_binding_rejects_reference_atomically(tmp_path, monkeypatch):
    import session_overlay

    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    manager = WorldBookManager(tmp_path / "books")
    manager.save(WorldBook("story", "story"))
    manager.save(WorldBook("reference", "reference", book_type="reference"))
    overlay = SessionOverlay("multi", "free")
    session = SimpleNamespace(id="multi", overlay=overlay,
                              scene_manager=SimpleNamespace(get_roster=lambda: []))
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager, "session": SimpleNamespace(get_session=lambda _: session)})
    response = app.test_client().put("/api/sessions/multi/worldbooks",
                                     json={"worldbook_ids": ["story", "reference"]})
    assert response.status_code == 409
    assert overlay.get_worldbook_ids() == []


def test_create_session_freezes_each_selected_book(tmp_path, monkeypatch):
    import threading
    import session_manager
    import session_overlay

    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    books = WorldBookManager(tmp_path / "books")
    for book_id in ("one", "two"):
        books.save(WorldBook(book_id, book_id, [WorldBookEntry(
            f"entry_{book_id}", content=f"content {book_id}", always_active=True)]))

    class StubSession:
        def __init__(self, sid, _backend, **kwargs):
            self.id = sid
            self.name = kwargs["name"]
            self.mode = kwargs["mode"]
            self.player_identity = kwargs["player_identity"]
            self.overlay = SessionOverlay(sid, self.mode)
            self.scene_manager = SimpleNamespace(get_roster=lambda: [self.player_identity],
                                                 get_scene_characters=lambda: [])

        def to_dict(self):
            return {"id": self.id, "worldbook_ids": self.overlay.get_worldbook_ids(),
                    "worldbook_scopes": {bid: self.overlay.get_worldbook_scope(bid)
                                         for bid in self.overlay.get_worldbook_ids()}}

    monkeypatch.setattr(session_manager, "Session", StubSession)
    manager = object.__new__(session_manager.SessionManager)
    manager._lock = threading.Lock()
    manager._sessions = {}
    manager._next_id = 0
    manager._llm_backend = manager._wiki_manager = None
    manager._worldbook_manager = books
    manager._save_session_meta = lambda _: None
    app = Flask(__name__)
    app.config["TESTING"] = True
    register_sessions(app, {"session": manager, "worldbook": books})
    response = app.test_client().post("/api/sessions", json={
        "worldbook_ids": ["one", "two"],
        "roster_character_ids": [],
    })
    assert response.status_code == 201, response.json
    assert response.json["worldbook_ids"] == ["one", "two"]
    assert response.json["worldbook_scopes"]["one"]["resolved_entry_uids"] == ["entry_one"]
    assert response.json["worldbook_scopes"]["two"]["resolved_entry_uids"] == ["entry_two"]
