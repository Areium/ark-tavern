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
    """v2 → v3 显式迁移（等价保留旧来源），可选地再收窄起点。

    两步都是真实用户路径：先显式启用按需规则（不能丢内容），
    再按需要收窄。返回第二次保存的响应。
    """
    body = {"expected_revision": 1, "adopt_v3": True, "roots": [], "requires_edges": []}
    first = client.put("/api/worldbook/book/configuration", json=body)
    assert first.status_code == 200, first.json
    if roots is None and not extra:
        return first
    revision = first.json["policy_revision"]
    payload = {"expected_revision": revision, "roots": roots if roots is not None else [], **extra}
    response = client.put("/api/worldbook/book/configuration", json=payload)
    assert response.status_code == 200, response.json
    return response


# ── 统一配置写入 ──

def test_put_configuration_applies_v3_rules_atomically(api):
    client, manager, _ = api
    body = {
        "expected_revision": 1,
        "adopt_v3": True,
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
    assert stored.schema_version == 3 and stored.v3_enabled
    roots = {r["entry_uid"]: r for r in stored.dependency_rules["roots"]}
    # 显式迁移：客户端草稿优先，旧来源按等价映射补齐（角色 B 不会因为迁移被丢下）
    assert roots["world"]["expansion"] == EXPANSION_REQUIRES_CLOSURE
    assert roots["a"]["expansion"] == EXPANSION_REQUIRES_CLOSURE
    assert roots["b"]["activation"] == ACTIVATION_ROSTER_ANY
    assert stored.related_edges == [{"from_uid": "b", "to_uid": "a"}]
    # v2 字段与 v3 起点保持同步，旧消费者仍可读
    assert stored.import_config["revision"] == 2
    assert stored.policy_revisions and stored.policy_revisions[-1]["revision"] == 2


def test_v2_ordinary_save_never_changes_scope_and_never_enables_v3(api):
    """普通保存（改分类 / 改边）不得隐式切到 v3，更不得把候选清空。

    预装书就是这种形态：selective + fixed/sources 都为空，候选完全由
    世界观分类与角色关联决定。旧实现里任何一次保存都会发 roots，
    于是「保存一次」= 启用 v3 且起点为空 = 候选变空集。
    """
    client, manager, _ = api
    before = manager.load("book")
    scope_before = before.resolve_import_scope(["A"])
    assert set(scope_before["resolved_entry_uids"]) == {"world", "a"}

    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": 1,
        "categories": before.categories,
        "entry_moves": {"tech": "other"},
        "entry_updates": {},
        "scope_mode": "selective",
        # 前端统一草稿总会带上这三项：它们**不能**触发隐式迁移
        "roots": [],
        "requires_edges": [],
        "related_edges": [],
    })
    assert response.status_code == 200, response.json
    stored = manager.load("book")
    assert stored.dependency_rules is None, "普通保存不该隐式启用 v3"
    assert stored.schema_version == 2
    scope_after = stored.resolve_import_scope(["A"])
    assert set(scope_after["resolved_entry_uids"]) == {"world", "a"}, "普通保存改变了候选范围"


def test_legacy_book_save_keeps_full_scope_and_legacy_mode(api):
    """legacy 书（全量兼容）保存后仍然是全量：不能被隐式切成空候选。"""
    client, manager, _ = api
    book = manager.load("book")
    book.scope_mode = "legacy"
    book.import_config["fixed_entry_uids"] = []
    book.import_config["dependency_sources"] = []
    manager.save(book)
    before = set(manager.load("book").resolve_import_scope([])["resolved_entry_uids"])
    assert before == {"world", "a", "b", "tech"}

    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": manager.load("book").import_config["revision"],
        "scope_mode": "legacy", "roots": [], "requires_edges": [], "related_edges": [],
    })
    assert response.status_code == 200, response.json
    stored = manager.load("book")
    assert stored.dependency_rules is None and stored.scope_mode == "legacy"
    assert set(stored.resolve_import_scope([])["resolved_entry_uids"]) == before


def test_explicit_adoption_preserves_all_old_sources(api):
    """显式启用按需规则时，旧来源必须逐条等价保留（世界观 / 角色 / 固定 / 导入源）。"""
    client, manager, _ = api
    book = manager.load("book")
    book.import_config["fixed_entry_uids"] = ["tech"]
    book.import_config["dependency_sources"] = [{"entry_uid": "b", "max_depth": 1}]
    manager.save(book)
    revision = manager.load("book").import_config["revision"]
    before = set(manager.load("book").resolve_import_scope(["A"])["resolved_entry_uids"])

    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": revision, "adopt_v3": True, "roots": [],
    })
    assert response.status_code == 200, response.json
    stored = manager.load("book")
    assert stored.v3_enabled
    after = set(stored.resolve_v3_import_scope(["A"])["resolved_entry_uids"])
    assert before <= after, f"迁移后丢条目：{sorted(before - after)}"
    roots = {r["entry_uid"]: r for r in stored.dependency_rules["roots"]}
    assert roots["world"]["activation"] == ACTIVATION_ALWAYS          # 世界观分类
    assert roots["a"]["activation"] == ACTIVATION_ROSTER_ANY          # 角色关联
    assert roots["tech"]["activation"] == ACTIVATION_ALWAYS           # 固定导入
    assert roots["b"]["expansion"] == "legacy_depth"                  # 导入源保留深度


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
        {"adopt_v3": True, "roots": [{"entry_uid": "missing", "activation": ACTIVATION_ALWAYS}]},
        {"adopt_v3": True, "roots": [{"entry_uid": "a", "activation": "sometimes"}]},
        {"adopt_v3": True, "roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS}],
         "requires_edges": [{"from_uid": "a", "to_uid": "a"}]},
        {"adopt_v3": True, "roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS}],
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
    assert body["draft_hash"] and body["policy_revision"] == 3
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
                "get_worldbook_scope": lambda s: copy.deepcopy(s._scope),
                "set_worldbook_scope": lambda s, v: setattr(s, "_scope", copy.deepcopy(v)),
                "get_worldbook_id": lambda s: None,
                "set_worldbook_id": lambda s, v: None,
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
                    "worldbook_scope": self.overlay.get_worldbook_scope()}

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
                           json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    assert response.status_code == 201
    scope = response.json["worldbook_scope"]
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
                          json={"worldbook_id": "book", "roster_character_ids": ["A"]})
    bound = created.json["worldbook_scope"]
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
                       json={"worldbook_id": "book", "roster_character_ids": ["A", "missing"]}
                       ).status_code == 400
    assert not manager._sessions


def test_full_scope_preview_and_session_creation_are_explicit_and_consistent(session_api):
    """显式全量兼容：预览与创建一致，只影响本会话，不改这本书的规则。"""
    client, _, books, _ = session_api
    adopt_v3(client, roots=[{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                             "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": ["A"]}])
    before = copy.deepcopy(books.load("book").dependency_rules)

    preview = client.post("/api/worldbook/book/scope-preview",
                          json={"roster_character_ids": ["A"], "full_scope": True})
    assert preview.status_code == 200
    body = preview.json
    assert body["full_scope"] is True
    # 全量：所有启用且有正文的条目都在候选里
    assert set(body["scope"]["resolved_entry_uids"]) == {"world", "a", "b", "tech"}
    assert body["saved_estimated_tokens"] == 0

    created = client.post("/api/sessions", json={
        "worldbook_id": "book", "roster_character_ids": ["A"],
        "full_scope": True, "expected_draft_hash": body["draft_hash"]})
    assert created.status_code == 201, created.json
    scope = created.json["worldbook_scope"]
    assert scope["full_scope"] is True
    assert set(scope["resolved_entry_uids"]) == {"world", "a", "b", "tech"}
    # 规则没被改动
    assert books.load("book").dependency_rules == before


def test_full_scope_hash_differs_and_stale_preview_is_rejected(session_api):
    """指纹区分是否全量兼容；预览过期时创建直接报错，不静默换范围。"""
    client, manager, books, _ = session_api
    book = books.load("book")
    book.dependency_rules = {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY,
                                        "expansion": EXPANSION_REQUIRES_CLOSURE,
                                        "character_ids": ["A"]}]}
    book.schema_version = 3
    books.save(book)

    partial = client.post("/api/worldbook/book/scope-preview",
                          json={"roster_character_ids": ["A"]}).json
    full = client.post("/api/worldbook/book/scope-preview",
                       json={"roster_character_ids": ["A"], "full_scope": True}).json
    assert partial["draft_hash"] != full["draft_hash"]

    # 用「全量」的指纹去创建一个「非全量」的会话 → 必须被拒绝
    rejected = client.post("/api/sessions", json={
        "worldbook_id": "book", "roster_character_ids": ["A"],
        "expected_draft_hash": full["draft_hash"]})
    assert rejected.status_code == 400
    assert "预览已过期" in rejected.json["error"]
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
        "worldbook_id": "book", "roster_character_ids": ["A"],
        "manual_entry_uids": ["world"], "expected_draft_hash": preview["draft_hash"]})
    assert created.status_code == 201, created.json
    assert "world" in created.json["worldbook_scope"]["resolved_entry_uids"]
    assert created.json["worldbook_scope"]["manual_entry_uids"] == ["world"]
    assert books.load("book").dependency_rules == before      # 书规则没被写回

    # 取消追加（不带 manual）→ 新会话不再包含，且没有破坏书上的配置
    again = client.post("/api/sessions", json={
        "worldbook_id": "book", "roster_character_ids": ["A"]})
    assert again.status_code == 201
    assert "world" not in again.json["worldbook_scope"]["resolved_entry_uids"]
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


def test_locked_manual_relation_wins_over_opposite_draft_relation(api):
    """旧书读回后行为不变：`edge_meta.locked` 标过的边，关系类型由持久化数据说了算，
    草稿提交相反类型也不能把它改掉。

    本用例只保证「旧书读回后行为不变」；该字段停写不删、不产生新值
    （AI 构建下线后不再有新值写入，见提案 §4.4）。
    """
    client, manager, _ = api
    book = manager.load("book")
    book.schema_version = 3
    book.dependency_rules = {
        "roots": [], "root_rule": {"entry_uids": []}, "rejected": [],
        "edge_meta": {"a|tech": {"origin": "manual", "locked": True}},
    }
    book.related_edges = [{"from_uid": "a", "to_uid": "tech"}]
    book.dependency_edges = []
    manager.save(book)
    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": 1,
        "roots": [],
        "requires_edges": [{"from_uid": "a", "to_uid": "tech"},
                           {"from_uid": "b", "to_uid": "tech"}],
        "related_edges": [{"from_uid": "a", "to_uid": "tech"}],
    })
    assert response.status_code == 200, response.json
    stored = manager.load("book")
    assert {"from_uid": "a", "to_uid": "tech"} in stored.related_edges
    assert {"from_uid": "a", "to_uid": "tech"} not in stored.dependency_edges
    assert {"from_uid": "b", "to_uid": "tech"} in stored.dependency_edges


def test_ai_only_fields_are_passthrough_and_never_grow(api):
    """守提案 §4.4 的口径：AI 专属字段**保留为兼容透传、只停写、新写入不再产生新值**。

    人工删掉一条旧 AI 边之后：`rejected` 不得被追加新记录（历史上那条「把删掉的
    AI 边记进 rejected」的 `removed_ai` 追写逻辑已随 AI 自动构建一起删除），
    而 `edge_meta` 的既有值必须原样透传，删边本身照常生效。
    """
    client, manager, _ = api
    book = manager.load("book")
    book.schema_version = 3
    book.dependency_edges = [{"from_uid": "a", "to_uid": "tech"}]
    book.related_edges = []
    book.dependency_rules = {
        "roots": [], "root_rule": {"entry_uids": []}, "rejected": [],
        "edge_meta": {"a|tech": {"origin": "llm", "model": "m", "evidence": "e"}},
    }
    manager.save(book)

    response = client.put("/api/worldbook/book/configuration", json={
        "expected_revision": 1,
        "roots": [],
        "requires_edges": [],
    })
    assert response.status_code == 200, response.json
    stored = manager.load("book")
    # 1) 删边不产生新的 rejected
    assert "rejected" not in stored.dependency_rules or stored.dependency_rules["rejected"] == []
    # 2) AI 时代的 edge_meta 原样透传
    assert stored.dependency_rules["edge_meta"] == {
        "a|tech": {"origin": "llm", "model": "m", "evidence": "e"}}
    # 3) 删边本身生效
    assert {"from_uid": "a", "to_uid": "tech"} not in stored.dependency_edges
    assert response.json["book"]["dependency_edges"] == []


def test_v3_legacy_mode_and_v2_session_are_preserved(api):
    client, manager, _ = api
    previous=manager.load('book').resolve_import_scope(['A'])
    adopt_v3(client,roots=[])
    book=manager.load('book')
    assert book.refresh_session_scope(previous,['A'])['resolved_entry_uids']
    assert book.refresh_session_scope(previous,['A']).get('schema_version') != 3
    response=client.put('/api/worldbook/book/configuration',json={'scope_mode':'legacy','roots':[]})
    assert response.status_code==200
    book=manager.load('book')
    assert set(book.session_scope_snapshot([])['resolved_entry_uids'])=={e.uid for e in book.entries}


def test_preinstalled_ordinary_save_preserves_candidates(tmp_path):
    import blueprints.worldbook as module
    original=WorldBookManager(Path(__file__).resolve().parents[1]/'data/worldbooks').load('arknights')
    if original is None:
        pytest.skip('preinstalled book unavailable')
    manager=WorldBookManager(tmp_path/'books');manager.save(copy.deepcopy(original))
    app=Flask(__name__);module.register(app,{'worldbook':manager})
    before=manager.load(original.id).resolve_import_scope([])['resolved_entry_uids']
    response=app.test_client().put(f'/api/worldbook/{original.id}/configuration',json={
        'expected_revision':original.import_config['revision'],'categories':original.categories})
    assert response.status_code==200,response.json
    after=manager.load(original.id)
    # 普通保存**不能悄悄改变 v3 状态**。预装书本就是 v3（本地 data/worldbooks 是
    # gitignored 的运行数据），硬编码 `not after.v3_enabled` 只在书还是 v2 时成立，
    # 属于把「保存前后一致」写成了「保存后必须是 v2」。
    assert after.v3_enabled == original.v3_enabled
    assert after.resolve_import_scope([])['resolved_entry_uids']==before
