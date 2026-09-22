import copy
import sys
import threading
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints.sessions import register
from session_worldbook_dependencies import (
    apply_inheritance_update, change_entry_override, change_relation, effective_graph,
    ensure_editable_scope,
    preview_inheritance_update, restore_inheritance,
)
from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager


def make_book():
    return WorldBook("book", "会话测试书", [
        WorldBookEntry("a", name="角色A", content="角色A使用源石技艺。",
                       category_id="characters", character_id="A", always_active=True),
        WorldBookEntry("b", name="角色B", content="角色B的记录。",
                       category_id="characters", character_id="B", always_active=True),
        WorldBookEntry("tech", name="源石技艺", content="源石技艺的定义。",
                       category_id="other", always_active=True),
    ], categories=copy.deepcopy(DEFAULT_CATEGORIES))


def v3_book():
    book = make_book().adopt_v2_as_v3()
    for root in book.dependency_rules["roots"]:
        if root["entry_uid"] == "a":
            root["expansion"] = "requires_closure"
    book.dependency_edges = [{"from_uid": "a", "to_uid": "tech"}]
    book.import_config["revision"] = 3
    book.policy_revisions = []
    book.record_policy_revision()
    return book


def test_local_override_delete_restore_and_refresh_are_stable():
    book = v3_book()
    scope = book.session_scope_snapshot(["A"], ["b"])
    changed = change_relation(scope, "a", "tech", None, 1)
    refreshed = book.refresh_session_scope(changed, ["A"])
    assert ("a", "tech") not in {(e["from_uid"], e["to_uid"])
                                   for e in effective_graph(refreshed)["requires_edges"]}
    assert refreshed["manual_entry_uids"] == ["b"]
    assert refreshed["scope_revision"] == 2
    restored = restore_inheritance(refreshed, 2, "a", "tech")
    restored = book.refresh_session_scope(restored, ["A"])
    assert {"from_uid": "a", "to_uid": "tech"} in restored["requires_edges"]


def test_pair_suppression_survives_global_relation_change():
    book = v3_book()
    scope = change_relation(book.session_scope_snapshot(["A"]), "a", "tech", None, 1)
    book.dependency_edges = []
    book.related_edges = [{"from_uid": "a", "to_uid": "tech"}]
    preview = preview_inheritance_update(scope, book)
    updated = apply_inheritance_update(scope, preview, 2, preview["preview_hash"])
    graph = effective_graph(updated)
    assert graph["requires_edges"] == [] and graph["related_edges"] == []


def test_global_update_keeps_local_relation_and_reports_conflict():
    book = v3_book()
    scope = change_relation(book.session_scope_snapshot(["A"]), "a", "tech", "related", 1)
    book.dependency_edges = [{"from_uid": "a", "to_uid": "tech"}]
    book.related_edges = []
    book.import_config["revision"] = 4
    preview = preview_inheritance_update(scope, book)
    updated = apply_inheritance_update(scope, preview, 2, preview["preview_hash"])
    assert preview["conflicts"][0]["resolution"] == "local_wins"
    assert effective_graph(updated)["related_edges"] == [{"from_uid": "a", "to_uid": "tech"}]


def test_schema2_session_upgrade_is_local_and_range_equivalent():
    book = make_book()
    old = book.resolve_import_scope(["A"])
    upgraded = ensure_editable_scope(old, book, ["A"])
    assert upgraded["schema_version"] == 3
    assert set(upgraded["resolved_entry_uids"]) == set(old["resolved_entry_uids"])
    assert book.schema_version == 2 and book.dependency_rules is None


def test_entry_enabled_override_changes_only_session_scope_and_injection():
    book = v3_book()
    book.entries.append(WorldBookEntry(
        "off", name="默认停用", content="会话特调内容。", always_active=True,
        enabled=False, category_id="other"))
    scope = book.session_scope_snapshot(["A"])

    enabled = change_entry_override(scope, "off", True, 1)
    enabled = book.refresh_session_scope(enabled, ["A"])
    assert "off" in enabled["resolved_entry_uids"]
    assert enabled["local_overrides"]["entry_enabled"] == {"off": True}
    overlay = Overlay()
    overlay.set_worldbook_scope(enabled)
    assert "off" in {entry.uid for entry in book.collect_matches(
        "", "", eligible_uids=book.eligible_uids_for(overlay))}

    disabled = change_entry_override(enabled, "a", False, 2)
    disabled = book.refresh_session_scope(disabled, ["A"])
    assert "a" not in disabled["resolved_entry_uids"]
    restored = change_entry_override(disabled, "a", None, 3)
    restored = book.refresh_session_scope(restored, ["A"])
    assert "a" in restored["resolved_entry_uids"]


class Overlay:
    def __init__(self):
        self.scope = None
        self.book_id = None
        self.lock = threading.RLock()
    def get_worldbook_scope(self): return copy.deepcopy(self.scope)
    def set_worldbook_scope(self, value): self.scope = copy.deepcopy(value)
    def update_worldbook_scope(self, updater):
        with self.lock:
            self.scope = copy.deepcopy(updater(copy.deepcopy(self.scope)))
            return copy.deepcopy(self.scope)
    def get_worldbook_id(self): return self.book_id
    def set_worldbook_id(self, value): self.book_id = value


class FakeSession:
    def __init__(self, sid, backend, **kwargs):
        self.id, self.name, self.mode = sid, kwargs["name"], kwargs.get("mode", "free")
        self.overlay, self.characters = Overlay(), []
        self.scene_manager = type("Scene", (), {
            "load_character": lambda _s, name: self.characters.append(name) is None,
            "get_scene_characters": lambda _s: list(self.characters),
        })()
    def to_dict(self):
        return {"id": self.id, "worldbook_scope": self.overlay.get_worldbook_scope(),
                "characters": self.characters}


class StubLLM:
    """会话依赖面板不调用模型；一旦被调用就立刻失败。"""

    def __init__(self): self.calls = []
    def chat(self, messages, **_kwargs):
        self.calls.append(messages)
        raise AssertionError("会话依赖面板不应调用 LLM")


class Backend:
    def __init__(self, llm): self.llm = llm
    def get_llm(self): return self.llm, "stub"


@pytest.fixture
def session_api(tmp_path, monkeypatch):
    import session_manager as manager_module
    books = WorldBookManager(tmp_path / "books")
    books.save(make_book())
    llm = StubLLM()
    monkeypatch.setattr(manager_module, "Session", FakeSession)
    monkeypatch.setattr(manager_module.SessionOverlay, "delete_session_overlays", lambda *_: None)
    manager = object.__new__(manager_module.SessionManager)
    manager._lock, manager._sessions, manager._next_id = threading.Lock(), {}, 0
    manager._llm_backend = manager._wiki_manager = None
    manager._worldbook_manager = books
    manager._save_session_meta = lambda _session: None
    app = Flask(__name__); app.config["TESTING"] = True
    register(app, {"session": manager, "worldbook": books, "llm_backend": Backend(llm)})
    return app.test_client(), manager, books, llm


def test_api_schema2_snapshot_override_and_cross_session_isolation(session_api):
    client, manager, books, llm = session_api
    first = client.post("/api/sessions", json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    second = client.post("/api/sessions", json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    assert first.status_code == second.status_code == 201 and llm.calls == []
    one, two = first.json["id"], second.json["id"]
    deps = client.get(f"/api/sessions/{one}/worldbook-dependencies").json
    changed = client.patch(f"/api/sessions/{one}/worldbook-dependencies", json={
        "from_uid": "a", "to_uid": "tech", "relation": "requires",
        "enable_source_expansion": True,
        "expected_scope_revision": deps["scope_revision"]})
    assert changed.status_code == 200, changed.json
    assert "tech" in changed.json["resolved_entry_uids"]
    other = client.get(f"/api/sessions/{two}/worldbook-dependencies").json
    assert other["local_overrides"]["requires_edges"] == []
    assert books.load("book").dependency_edges == []
    preview = client.post(
        f"/api/sessions/{one}/worldbook-dependencies/inheritance-preview")
    assert preview.status_code == 200, preview.json


def test_entry_override_api_is_scoped_to_bound_session(session_api):
    client, _manager, books, _llm = session_api
    book = books.load("book")
    book.entries.append(WorldBookEntry(
        "off", name="默认停用", content="仅本会话启用。", always_active=True,
        enabled=False, category_id="other"))
    books.save(book)
    first = client.post("/api/sessions", json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    second = client.post("/api/sessions", json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    one, two = first.json["id"], second.json["id"]

    initial = client.get(f"/api/sessions/{one}/worldbook-entry-overrides")
    assert initial.status_code == 200
    changed = client.patch(f"/api/sessions/{one}/worldbook-entry-overrides", json={
        "entry_uid": "off", "enabled": True,
        "expected_scope_revision": initial.json["scope_revision"],
    })
    assert changed.status_code == 200, changed.json
    assert changed.json["overrides"] == {"off": True}
    assert next(entry for entry in changed.json["entries"] if entry["uid"] == "off") == {
        "uid": "off", "name": "默认停用", "category_id": "other",
        "default_enabled": False, "effective_enabled": True, "selected": True,
    }
    other = client.get(f"/api/sessions/{two}/worldbook-entry-overrides")
    assert other.json["overrides"] == {}
    assert books.load("book").entries[-1].enabled is False

    restored = client.patch(f"/api/sessions/{one}/worldbook-entry-overrides", json={
        "entry_uid": "off", "enabled": None,
        "expected_scope_revision": changed.json["scope_revision"],
    })
    assert restored.status_code == 200
    assert restored.json["overrides"] == {}
    assert next(entry for entry in restored.json["entries"] if entry["uid"] == "off")["effective_enabled"] is False


def test_session_overlay_scope_survives_reload(tmp_path, monkeypatch):
    import session_overlay as overlay_module
    monkeypatch.setattr(overlay_module, "_SESSIONS_DIR", tmp_path / "sessions")
    first = overlay_module.SessionOverlay("session-1", "free")
    scope = v3_book().session_scope_snapshot(["A"])
    changed = change_relation(scope, "a", "tech", None, 1)
    first.set_worldbook_scope(changed)
    restored = overlay_module.SessionOverlay("session-1", "free").get_worldbook_scope()
    assert restored["scope_revision"] == 2
    assert restored["suppressed_edges"] == changed["suppressed_edges"]
    assert effective_graph(restored)["requires_edges"] == []


