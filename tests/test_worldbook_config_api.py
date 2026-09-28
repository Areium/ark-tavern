"""统一配置写入、v3 预览与创建会话的原子性/一致性。

接口、锁、CAS 与校验都是真实代码；LLM 只出现在「创建会话不调用模型」这类断言里。
"""
import copy
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager
from worldbook_scope import (
    ACTIVATION_ALWAYS, ACTIVATION_ROSTER_ANY, EXPANSION_REQUIRES_CLOSURE,
)


def entry(uid, content=None, **kwargs):
    return WorldBookEntry(uid, content=content or f"content-{uid}",
                          always_active=True, **kwargs)


def book_fixture():
    return WorldBook("book", "测试书", [
        entry("world", "泰拉世界的基础设定，源石与天灾。", name="世界设定",
              category_id="worldview"),
        entry("a", "角色A：罗德岛干员。他使用源石技艺。", name="角色A",
              category_id="characters", character_id="A"),
        entry("b", "角色B：与角色A同属罗德岛。", name="角色B",
              category_id="characters", character_id="B"),
        entry("tech", "源石技艺的定义与规则。", name="源石技艺", category_id="other"),
    ], categories=copy.deepcopy(DEFAULT_CATEGORIES))


class StubLLM:
    """这些用例都不应调用模型；一旦被调用就立刻失败。"""

    def __init__(self):
        self.calls = 0

    def chat(self, messages, **kwargs):
        self.calls += 1
        raise AssertionError("这些用例不应调用 LLM")


class Backend:
    def __init__(self, llm=None, model="stub"):
        self._llm, self._model = llm, model

    def get_llm(self):
        return self._llm, self._model


@pytest.fixture
def api(tmp_path):
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    manager.save(book_fixture())
    app = Flask(__name__)
    app.config["TESTING"] = True
    managers = {"worldbook": manager, "llm_backend": Backend(StubLLM())}
    register(app, managers)
    return app.test_client(), manager, managers


def adopt_v3(client, roots=None, **extra):
    """保存当前 v3 起点与依赖边。"""
    payload = {"expected_revision": 1, "roots": roots if roots is not None else [], **extra}
    response = client.put("/api/worldbook/book/configuration", json=payload)
    assert response.status_code == 200, response.json
    return response


def test_pack_routes_are_removed_and_book_detail_has_no_pack_fields(api):
    client, _, _ = api
    assert client.get("/api/worldbook/available-packs").status_code == 404
    assert client.post("/api/worldbook/available-packs/book/install").status_code == 404
    assert client.post("/api/worldbook/book/reinstall").status_code == 404
    detail = client.get("/api/worldbook/book")
    assert detail.status_code == 200
    assert "source" not in detail.json
    assert "is_preinstalled" not in detail.json


# ── 统一配置写入 ──

def test_put_configuration_applies_v3_rules_atomically(api):
    client, manager, _ = api
    body = {
        "expected_revision": 1,
        "roots": [
            {"entry_uid": "world", "activation": ACTIVATION_ALWAYS,
             "expansion": EXPANSION_REQUIRES_CLOSURE},
            {"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]},
        ],
        "requires_edges": [{"from_uid": "a", "to_uid": "tech"}],
        "related_edges": [{"from_uid": "b", "to_uid": "a"}],
    }
    response = client.put("/api/worldbook/book/configuration", json=body)
    assert response.status_code == 200, response.json
    assert response.json["policy_revision"] == 2
    stored = manager.load("book")
    assert stored.schema_version == 3 and stored.scope_mode == "selective"
    roots = {r["entry_uid"]: r for r in stored.dependency_rules["roots"]}
    # 保存的起点和边按草稿原样生效。
    assert roots["world"]["expansion"] == EXPANSION_REQUIRES_CLOSURE
    assert roots["a"]["expansion"] == EXPANSION_REQUIRES_CLOSURE
    assert set(roots) == {"world", "a"}
    assert stored.related_edges == [{"from_uid": "b", "to_uid": "a"}]
    assert stored.import_config["revision"] == 2
    assert stored.policy_revisions and stored.policy_revisions[-1]["revision"] == 2


def test_delete_entry_cleans_current_and_historical_rule_references(api):
    client, manager, _ = api
    saved = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": 1,
        "roots": [{"entry_uid": "world", "activation": ACTIVATION_ALWAYS,
                   "expansion": EXPANSION_REQUIRES_CLOSURE}],
        "requires_edges": [{"from_uid": "world", "to_uid": "tech"}],
        "related_edges": [{"from_uid": "a", "to_uid": "world"}],
    })
    assert saved.status_code == 200, saved.json

    deleted = client.delete("/api/worldbook/book/entries/world")
    assert deleted.status_code == 200, deleted.json
    assert deleted.json["affected"]["policy_revisions"] == 3

    reloaded = WorldBookManager(manager._dir).load("book")
    assert reloaded is not None
    assert all(root["entry_uid"] != "world" for root in reloaded.dependency_rules["roots"])
    assert reloaded.dependency_edges == []
    assert reloaded.related_edges == []
    for revision in reloaded.policy_revisions:
        assert all(root["entry_uid"] != "world" for root in revision["rules"]["roots"])
        assert revision["requires_edges"] == []
        assert revision["related_edges"] == []


def test_put_configuration_conflict_returns_409_and_keeps_draft(api):
    client, manager, _ = api
    before = manager._path("book").read_bytes()
    response = client.put("/api/worldbook/book/configuration",
                          json={"expected_revision": 99, "roots": []})
    assert response.status_code == 409
    assert manager._path("book").read_bytes() == before


def test_put_configuration_rejects_invalid_and_writes_nothing(api):
    client, manager, _ = api
    before = manager._path("book").read_bytes()
    for body in (
        {"roots": [{"entry_uid": "missing", "activation": ACTIVATION_ALWAYS}]},
        {"roots": [{"entry_uid": "a", "activation": "sometimes"}]},
        {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS}],
         "requires_edges": [{"from_uid": "a", "to_uid": "a"}]},
        {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS}],
         "requires_edges": [{"from_uid": "a", "to_uid": "b"}],
         "related_edges": [{"from_uid": "a", "to_uid": "b"}]},
        {"entry_moves": {"missing": "other"}},
        {"scope_mode": "nonsense"},
    ):
        assert client.put("/api/worldbook/book/configuration", json=body).status_code == 400, body
    assert manager._path("book").read_bytes() == before


def test_scope_preview_returns_v3_explanations_and_is_read_only(api):
    client, manager, _ = api
    adopt_v3(client, roots=[{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]}],
             requires_edges=[{"from_uid": "a", "to_uid": "tech"}])
    before = manager._path("book").read_bytes()
    response = client.post("/api/worldbook/book/scope-preview",
                           json={"roster_character_ids": ["A"]})
    assert response.status_code == 200
    body = response.json
    assert set(body["scope"]["resolved_entry_uids"]) == {"a", "tech"}
    assert body["active_roots"][0]["entry_uid"] == "a"
    assert body["selection_reasons"]["tech"] == ["requires"]
    assert body["display_tree"] and body["display_tree"][0]["uid"] == "a"
    assert body["draft_hash"] and body["policy_revision"] == 2
    assert body["content_revision"] and body["resolver_version"] == 3
    assert manager._path("book").read_bytes() == before


def test_scope_preview_reports_single_character_and_manual_additions(api):
    client, _, _ = api
    adopt_v3(client, roots=[
        {"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
         "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]},
        {"entry_uid": "b", "activation": ACTIVATION_ROSTER_ANY,
         "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["B"]}])
    single = client.post("/api/worldbook/book/scope-preview",
                         json={"roster_character_ids": ["A"]}).json
    assert set(single["scope"]["resolved_entry_uids"]) == {"a"}
    manual = client.post("/api/worldbook/book/scope-preview",
                         json={"roster_character_ids": ["A"], "manual_entry_uids": ["tech"]}).json
    assert set(manual["scope"]["resolved_entry_uids"]) == {"a", "tech"}
    assert manual["selection_reasons"]["tech"] == ["manual"]


def test_manual_append_expands_its_required_closure(api):
    """手动追加是**临时起点**：它需要的必要依赖也要一起带进来，并且可解释。

    旧实现是「解析完之后并集 UID」，所以空阵容下追加 A（A requires B）
    只会得到 A：既没有 B，也没有树和原因。
    """
    client, _, _ = api
    adopt_v3(client, roots=[],
             requires_edges=[{"from_uid": "a", "to_uid": "tech"}])
    empty = client.post("/api/worldbook/book/scope-preview",
                        json={"roster_character_ids": []}).json
    assert empty["scope"]["resolved_entry_uids"] == []

    manual = client.post("/api/worldbook/book/scope-preview",
                         json={"roster_character_ids": [], "manual_entry_uids": ["a"]}).json
    resolved = set(manual["scope"]["resolved_entry_uids"])
    assert resolved == {"a", "tech"}, "手动追加没有展开它需要的必要依赖"
    assert manual["selection_reasons"]["a"] == ["manual"]
    assert manual["selection_reasons"]["tech"] == ["requires"]
    tree = {node["uid"]: node for node in manual["display_tree"]}
    assert tree["a"]["is_root"] is True and tree["tech"]["parent_uid"] == "a"


def test_scope_preview_draft_hash_is_stable_and_roster_sensitive(api):
    client, _, _ = api
    body = {"roster_character_ids": ["A"], "fixed_entry_uids": ["tech"]}
    first = client.post("/api/worldbook/book/scope-preview", json=body).json["draft_hash"]
    again = client.post("/api/worldbook/book/scope-preview", json=body).json["draft_hash"]
    other = client.post("/api/worldbook/book/scope-preview",
                        json={**body, "roster_character_ids": ["B"]}).json["draft_hash"]
    assert first == again and first != other


# ── 创建会话：零 LLM 调用 + 预览/创建一致 ──

@pytest.fixture
def session_api(tmp_path, monkeypatch):
    import session_manager as module
    from blueprints.sessions import register as register_sessions
    from blueprints.worldbook import register as register_worldbook
    book_manager = WorldBookManager(tmp_path)
    book_manager.save(book_fixture())
    llm = StubLLM()

    class FakeSession:
        def __init__(self, sid, backend, **kwargs):
            self.id, self.name = sid, kwargs["name"]
            self.mode = kwargs.get("mode", "free")
            self.overlay = type("O", (), {
                "_scope": None,
                "_ids": [],
                "get_worldbook_scope": lambda s, book_id=None: copy.deepcopy(s._scope),
                "set_worldbook_scope": lambda s, v, book_id=None: setattr(s, "_scope", copy.deepcopy(v)),
                "get_worldbook_ids": lambda s: list(s._ids),
                "get_worldbook_id": lambda s: next(iter(s._ids), None),
                "set_worldbook_ids": lambda s, ids: setattr(s, "_ids", list(ids)),
            })()
            self.characters = []
            def load(name):
                if name not in ("A", "B"):
                    return False
                if name not in self.characters:
                    self.characters.append(name)
                return True
            self.scene_manager = type("S", (), {
                "load_character": staticmethod(load),
                "get_scene_characters": lambda s: self.characters,
                # 这个替身没有 player_identity，阵容就等于场景角色（与真实实现同规则）
                "get_roster": lambda s: list(self.characters),
            })()

        def to_dict(self):
            return {"id": self.id, "characters": self.characters,
                    "worldbook_ids": self.overlay.get_worldbook_ids(),
                    "worldbook_scopes": {bid: self.overlay.get_worldbook_scope(bid)
                                         for bid in self.overlay.get_worldbook_ids()}}

    monkeypatch.setattr(module, "Session", FakeSession)
    monkeypatch.setattr(module.SessionOverlay, "delete_session_overlays", lambda *a: None)
    import threading as _threading
    manager = object.__new__(module.SessionManager)
    manager._lock, manager._sessions, manager._next_id = _threading.Lock(), {}, 0
    manager._llm_backend = manager._wiki_manager = None
    manager._worldbook_manager = book_manager
    manager._save_session_meta = lambda session: None
    app = Flask(__name__)
    app.config["TESTING"] = True
    managers = {"worldbook": book_manager, "session": manager,
                "llm_backend": Backend(llm)}
    # 两个 blueprint 都要注册：会话创建依赖 worldbook 的 /configuration 写入 v3 规则
    register_worldbook(app, managers)
    register_sessions(app, managers)
    return app.test_client(), manager, book_manager, llm


def test_session_creation_uses_v3_snapshot_and_calls_no_llm(session_api):
    client, manager, books, llm = session_api
    adopt_v3(client, roots=[{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]}],
             requires_edges=[{"from_uid": "a", "to_uid": "tech"}])
    calls_before = llm.calls
    response = client.post("/api/sessions",
                           json={"worldbook_ids": ["book"], "roster_character_ids": ["A"]})
    assert response.status_code == 201
    scope = response.json["worldbook_scopes"]["book"]
    assert set(scope["resolved_entry_uids"]) == {"a", "tech"}
    assert scope["resolver_version"] == 3
    assert scope["rules"] and scope["requires_edges"]
    assert scope["roster_character_ids"] == ["A"]
    assert scope["active_roots"][0]["entry_uid"] == "a"
    assert scope["selection_reasons"]["tech"] == ["requires"]
    assert scope["display_tree"]
    assert llm.calls == calls_before          # 创建会话不调用 LLM


def test_session_creation_snapshot_restores_bound_rules_after_book_edit(session_api):
    """会话绑定完整规则版本：书后来改了，会话仍能恢复它创建时的规则。"""
    client, _, books, _ = session_api
    adopt_v3(client, roots=[{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]}],
             requires_edges=[{"from_uid": "a", "to_uid": "tech"}])
    created = client.post("/api/sessions",
                          json={"worldbook_ids": ["book"], "roster_character_ids": ["A"]})
    bound = created.json["worldbook_scopes"]["book"]
    assert set(bound["resolved_entry_uids"]) == {"a", "tech"}

    # 书改成不再依赖 tech
    revision = books.load("book").import_config["revision"]
    client.put("/api/worldbook/book/configuration", json={
        "expected_revision": revision, "requires_edges": []})
    stored = books.load("book")
    assert "tech" not in stored.resolve_v3_import_scope(["A"])["resolved_entry_uids"]
    # 用绑定版本重算，仍得到创建时的结果
    restored = stored.resolve_v3_import_scope(["A"], revision=bound["policy_revision"])
    assert set(restored["resolved_entry_uids"]) == {"a", "tech"}


def test_session_creation_failure_leaves_no_partial_session(session_api):
    client, manager, _, _ = session_api
    assert client.post("/api/sessions",
                       json={"worldbook_ids": ["book"], "roster_character_ids": ["A", "missing"]}
                       ).status_code == 400
    assert not manager._sessions


def test_manual_append_is_session_scoped_and_cancellable(session_api):
    """手动追加只作用于本会话：书规则不变，取消追加后新会话不再包含它。"""
    client, _, books, _ = session_api
    adopt_v3(client, roots=[{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]}])
    before = copy.deepcopy(books.load("book").dependency_rules)

    preview = client.post("/api/worldbook/book/scope-preview",
                          json={"roster_character_ids": ["A"],
                                "manual_entry_uids": ["world"]}).json
    assert "world" in preview["scope"]["resolved_entry_uids"]
    assert preview["scope"]["selection_reasons"]["world"] == ["manual"]

    created = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"],
        "manual_entry_uids_by_book": {"book": ["world"]},
        "expected_draft_hashes": {"book": preview["draft_hash"]}})
    assert created.status_code == 201, created.json
    assert "world" in created.json["worldbook_scopes"]["book"]["resolved_entry_uids"]
    assert created.json["worldbook_scopes"]["book"]["manual_entry_uids"] == ["world"]
    assert books.load("book").dependency_rules == before      # 书规则没被写回

    # 取消追加（不带 manual）→ 新会话不再包含，且没有破坏书上的配置
    again = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"]})
    assert again.status_code == 201
    assert "world" not in again.json["worldbook_scopes"]["book"]["resolved_entry_uids"]
    assert books.load("book").dependency_rules == before

def test_old_entry_route_and_configuration_share_transaction_lock(api, monkeypatch):
    import threading
    import blueprints.worldbook as module
    client, manager, _ = api
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    original = module._entry_from_payload
    def paused(payload, uid=None):
        entered.set()
        assert release.wait(5)
        return original(payload, uid)
    monkeypatch.setattr(module, '_entry_from_payload', paused)
    responses = {}
    def old_write():
        with client.application.test_client() as c:
            responses['entry'] = c.put('/api/worldbook/book/entries/tech', json={'content':'new definition'})
    def config_write():
        with client.application.test_client() as c:
            responses['config'] = c.put('/api/worldbook/book/configuration', json={
                'expected_revision':2, 'adopt_v3':True,
                'roots':[{'entry_uid':'tech','activation':'always','expansion':'none'}]})
            finished.set()
    a=threading.Thread(target=old_write); b=threading.Thread(target=config_write)
    a.start(); assert entered.wait(3); b.start()
    assert not finished.wait(.1), 'configuration must wait for old entry transaction'
    release.set(); a.join(5); b.join(5)
    assert responses['entry'].status_code == responses['config'].status_code == 200
    stored=manager.load('book')
    assert next(e for e in stored.entries if e.uid=='tech').content == 'new definition'
    assert any(r['entry_uid']=='tech' for r in stored.dependency_rules['roots'])


def test_ordinary_save_preserves_candidates(api):
    client, manager, _ = api
    original = manager.load("book")
    before = original.resolve_v3_import_scope([])["resolved_entry_uids"]
    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": original.import_config["revision"],
        "categories": original.categories,
    })
    assert response.status_code == 200, response.json
    after = manager.load("book")
    assert after.schema_version == 3 and after.scope_mode == "selective"
    assert after.resolve_v3_import_scope([])["resolved_entry_uids"] == before
