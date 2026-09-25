"""世界书资料库与剧情世界书分离（book_type）与条目摘录。

覆盖：旧书默认 story、用途 round-trip、reference 禁止默认/绑定/解析、
搜索过滤、成功摘录、编辑稿摘录、来源追踪、原子失败不落盘、并发修订/锁边界。

所有连接都走真实 Flask 路由与真实 WorldBookManager；没有 LLM 调用。
"""
import copy
import hashlib
import json
import sys
import threading
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import (
    BOOK_TYPE_REFERENCE, BOOK_TYPE_STORY, DEFAULT_CATEGORIES, EXCERPT_SOURCE_FIELDS,
    WorldBook, WorldBookEntry, WorldBookManager, normalize_book_type,
)
from worldbook_scope import EXTENSION_KEY


def make_entry(uid, content=None, **kwargs):
    kwargs.setdefault("always_active", True)
    return WorldBookEntry(uid, content=content or f"content-{uid}", **kwargs)


@pytest.fixture
def manager(tmp_path):
    return WorldBookManager(tmp_path)


@pytest.fixture
def api(tmp_path):
    from blueprints.worldbook import register
    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": book_manager})
    return app.test_client(), book_manager


def make_story(client, name="剧情书", **extra):
    res = client.post("/api/worldbook", json={"name": name, **extra})
    assert res.status_code == 201, res.json
    return res.json["book"]


def make_reference(client, name="资料库", **extra):
    return make_story(client, name=name, book_type="reference", **extra)


def seed(manager, book_id, entries):
    """直接给一本书写入条目（测试夹具用，不走接口）。"""
    book = manager.load(book_id)
    for item in entries:
        book.entries.append(item)
    manager.save(book)
    return book


# ─────────────────────────────────────────────────────────────
# A. 数据模型与兼容迁移
# ─────────────────────────────────────────────────────────────

def test_legacy_book_without_field_reads_as_story(manager):
    """旧数据缺 book_type 时必须按 story 读取，不得自动变成 reference。"""
    book = manager.create_book("老书")
    path = manager._path(book.id)
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert "book_type" in raw
    raw.pop("book_type")
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    manager._cache.pop(book.id, None)

    reloaded = manager.load(book.id)
    assert reloaded.book_type == BOOK_TYPE_STORY
    assert reloaded.is_reference is False
    # 摘要也必须暴露 story，前端才能正确分组
    assert manager._summary(reloaded, None)["book_type"] == "story"


def test_legacy_exported_book_reimports_as_story(manager):
    """没有项目扩展的普通酒馆书导入后是 story（不得被误判成资料库）。"""
    st = {"entries": {"0": {"uid": "e1", "comment": "阿米娅",
                            "content": "罗德岛领袖", "key": ["阿米娅"]}}}
    book, _ = manager.import_book("酒馆书", st)
    assert book.book_type == BOOK_TYPE_STORY


def test_book_type_round_trips_through_save_and_load(tmp_path):
    """用途在保存/重载之间往返不丢（含预装包路径）。"""
    manager = WorldBookManager(tmp_path)
    story = manager.create_book("剧情")
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    manager.save(story)
    manager.save(reference)

    fresh = WorldBookManager(tmp_path)
    assert fresh.load(story.id).book_type == BOOK_TYPE_STORY
    assert fresh.load(reference.id).book_type == BOOK_TYPE_REFERENCE


def test_book_type_round_trips_through_export_and_reimport(manager):
    """用途随项目扩展命名空间往返；摘录来源一并保留。"""
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    seed(manager, reference.id, [make_entry("src", "源石技艺的规则。", name="源石技艺")])
    story = manager.create_book("剧情")
    manager.excerpt_entries(story.id, [
        {"source_book_id": reference.id, "source_entry_uid": "src"}])
    story = manager.load(story.id)

    exported = story.export_st()
    assert exported["extensions"][EXTENSION_KEY]["book_type"] == "story"
    reimported, _ = manager.import_book("回灌", json.dumps(exported))
    assert reimported.book_type == BOOK_TYPE_STORY
    assert reimported.entries[0].excerpt_source["source_entry_uid"] == "src"


def test_reference_export_keeps_type(manager):
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    exported = reference.export_st()
    assert exported["extensions"][EXTENSION_KEY]["book_type"] == "reference"
    reimported, _ = manager.import_book("回灌资料", json.dumps(exported))
    assert reimported.book_type == BOOK_TYPE_REFERENCE


def test_explicit_book_type_wins_over_import_payload(manager):
    """调用方明确表态时，导入物自带的用途不再优先。

    用户的导入选择（「用于剧情 / 存入资料库」）是他在这次操作里的决定，不能被文件里
    写死的用途推翻 —— 否则「导入为资料库」对一个本项目导出的 story 文件完全失效。
    """
    story = manager.create_book("剧情", book_type=BOOK_TYPE_STORY)
    exported = story.export_st()
    # 文件声明 story，但调用方说 reference → 以调用方为准
    reimported, _ = manager.import_book("回灌", json.dumps(exported),
                                        book_type=BOOK_TYPE_REFERENCE)
    assert reimported.book_type == BOOK_TYPE_REFERENCE

    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    exported_ref = reference.export_st()
    # 反方向同样成立：文件声明 reference，调用方说 story → 以调用方为准
    reimported, _ = manager.import_book("回灌2", json.dumps(exported_ref),
                                        book_type=BOOK_TYPE_STORY)
    assert reimported.book_type == BOOK_TYPE_STORY


def test_import_payload_type_used_when_caller_silent(manager):
    """调用方未表态（None / 空串）时才读取导入物扩展里的用途声明。"""
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    exported = reference.export_st()

    reimported, _ = manager.import_book("缺省", json.dumps(exported))
    assert reimported.book_type == BOOK_TYPE_REFERENCE

    reimported, _ = manager.import_book("空串", json.dumps(exported), book_type="")
    assert reimported.book_type == BOOK_TYPE_REFERENCE

    # 两边都没声明 → 默认 story（普通小书直接当剧情书）
    plain = {"entries": {"0": {"uid": "e1", "content": "正文", "key": ["k"]}}}
    reimported, _ = manager.import_book("平凡", plain)
    assert reimported.book_type == BOOK_TYPE_STORY


def test_normalize_book_type_rejects_unknown_values():
    assert normalize_book_type(None) == BOOK_TYPE_STORY
    assert normalize_book_type("") == BOOK_TYPE_STORY
    assert normalize_book_type(" story ") == BOOK_TYPE_STORY
    assert normalize_book_type("reference") == BOOK_TYPE_REFERENCE
    for bad in ("Reference", "library", "剧情", "stroy", 123, ["story"]):
        with pytest.raises(ValueError):
            normalize_book_type(bad)


def test_create_rejects_invalid_book_type_with_400(api):
    client, _ = api
    res = client.post("/api/worldbook", json={"name": "x", "book_type": "library"})
    assert res.status_code == 400
    assert "book_type" in res.json["error"]


def test_create_defaults_to_story(api):
    client, manager = api
    book = make_story(client, "新书")
    assert book["book_type"] == "story"
    assert book["is_reference"] is False
    assert manager.load(book["id"]).book_type == BOOK_TYPE_STORY


def test_create_explicit_reference(api):
    client, _ = api
    book = make_reference(client, "大资料库")
    assert book["book_type"] == "reference"
    assert book["is_reference"] is True


def test_import_accepts_explicit_book_type(api):
    client, manager = api
    body = {"name": "导入的资料库", "book_type": "reference",
            "data": {"entries": {"0": {"uid": "e1", "content": "正文", "key": ["k"]}}}}
    res = client.post("/api/worldbook/import", json=body)
    assert res.status_code == 201, res.json
    assert res.json["book"]["book_type"] == "reference"
    assert manager.load(res.json["book"]["id"]).is_reference is True


def test_import_rejects_invalid_book_type(api):
    client, _ = api
    res = client.post("/api/worldbook/import", json={
        "name": "x", "book_type": "nope",
        "data": {"entries": {"0": {"uid": "e1", "content": "正文", "key": ["k"]}}}})
    assert res.status_code == 400


def test_update_book_type_round_trips(api):
    client, manager = api
    book = make_story(client, "可切换")
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200, res.json
    assert res.json["book"]["book_type"] == "reference"
    assert manager.load(book["id"]).is_reference is True
    # 改回来也必须可行
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "story"})
    assert res.status_code == 200
    assert res.json["book"]["book_type"] == "story"


def test_reference_can_be_repaired_to_story_even_when_referenced(api):
    """reference -> story 是**修复**操作，不能被「转换为资料库」闸门拦住。

    历史坏状态（旧数据/手工改过 settings）下，一本 reference 可能仍是全局默认书或
    被会话绑定。此时用户想把它改回剧情世界书应当放行 —— 闸门只针对会把状态搞坏的
    story -> reference 方向，否则用户会陷入「改不回去」的死结。
    """
    client, manager = api
    ref = make_reference(client, "被误设为默认的资料库")
    # 强行制造坏状态：默认指针指向资料库
    # （公开的 set_default_book_id 会拒绝资料库，这里直接写底层 settings 模拟历史数据）
    manager._save_settings({"default_book_id": ref["id"]})
    assert manager.get_default_book_id() is None

    # 即便这本资料库还是默认书，改回 story 也必须成功
    res = client.put(f"/api/worldbook/{ref['id']}", json={"book_type": "story"})
    assert res.status_code == 200, res.json
    assert res.json["book"]["book_type"] == "story"
    assert manager.load(ref["id"]).is_reference is False


def test_retired_default_does_not_block_story_to_reference(api):
    """历史默认指针已失效，不再阻碍用途转换。"""
    client, manager = api
    book = make_story(client, "默认剧情书")
    manager._save_settings({"default_book_id": book["id"]})
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200


def test_update_book_type_rejects_invalid_value(api):
    client, _ = api
    book = make_story(client, "书")
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "archive"})
    assert res.status_code == 400
    assert "book_type" in res.json["error"]


# ── reference 不得设为默认 / 绑定 / 解析 ──

def test_reference_cannot_be_default(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    res = client.post(f"/api/worldbook/{reference['id']}/default", json={"default": True})
    assert res.status_code == 410
    assert manager.get_default_book_id() is None


def test_set_default_book_id_rejects_reference_at_manager_level(manager):
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    with pytest.raises(ValueError):
        manager.set_default_book_id(reference.id)


def test_reference_is_excluded_from_resolve_even_when_default_pointer(manager):
    """防御性兜底：即便默认指针指向资料库，解析也不得返回它。"""
    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    manager._save_settings({"default_book_id": reference.id})
    assert manager.resolve() is None


def test_reference_is_excluded_from_overlay_binding(manager):
    """会话 overlay 显式绑定资料库时也不得生效（防御旧数据/手工改动）。"""
    class Overlay:
        def __init__(self, book_id):
            self._book_id = book_id

        def get_worldbook_id(self):
            return self._book_id

        def get_worldbook_scope(self):
            return {"book_id": self._book_id, "resolved_entry_uids": []}

    reference = manager.create_book("资料", book_type=BOOK_TYPE_REFERENCE)
    assert manager.resolve(Overlay(reference.id)) is None

    story = manager.create_book("剧情")
    assert manager.resolve(Overlay(story.id)).id == story.id


def test_default_endpoint_is_retired_for_story_books(api):
    """剧情书也不能再设为全局默认。"""
    client, manager = api
    book = make_story(client, "默认书")
    assert client.post(f"/api/worldbook/{book['id']}/default",
                       json={"default": True}).status_code == 410

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200
    assert manager.get_default_book_id() is None


def test_story_cannot_be_switched_to_reference_while_session_bound(tmp_path):
    """会话绑定存在时拒绝转换，且明确列出受影响的会话。

    测试替身**只暴露真实 SessionManager 的公开契约** `list_sessions()`（返回带
    `id` / `worldbook_id` 的摘要字典），不提供私有 `_sessions` 或杜撰的 `sessions`
    属性 —— 早期版本误读了后者，测试一路通过而生产判断永远为空。
    """
    from blueprints.worldbook import register

    class FakeSessions:
        """契约与 src/session_manager.py 的公开面一致。"""

        def __init__(self):
            self.bound_book_id = None

        def list_sessions(self):
            return [{"id": "s1", "name": "会话一", "worldbook_id": self.bound_book_id}]

    sessions = FakeSessions()
    assert not hasattr(sessions, "sessions")
    assert not hasattr(sessions, "_sessions")

    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": book_manager, "session": sessions})
    client = app.test_client()

    book = make_story(client, "被绑定的书")
    sessions.bound_book_id = book["id"]

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 409
    assert "s1" in res.json["error"]
    # 状态没被动过：用途、磁盘、缓存一致
    assert book_manager.load(book["id"]).book_type == BOOK_TYPE_STORY

    # 会话改绑到别的书之后就能转换
    sessions.bound_book_id = "another-book"
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200


def _gate_client(tmp_path, sessions):
    """构造一个只带 worldbook + 给定会话服务的测试客户端。"""
    from blueprints.worldbook import register

    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": book_manager, "session": sessions})
    return app.test_client(), book_manager


def test_conversion_gate_fails_closed_when_list_sessions_missing(tmp_path):
    """会话服务存在但拿不到会话列表时**拒绝**转换（fail closed）。

    旧行为把「无法确认」当成「确认没有绑定」直接放行 —— 一本仍被会话绑定的书
    会被改成资料库，之后那些会话就指向一本不参与解析的书。这是安全闸门，
    查不清就必须拦。
    """
    class LegacySessions:
        """老替身：没有 list_sessions，也没有别的公开列举方式。"""

    client, manager = _gate_client(tmp_path, LegacySessions())
    book = make_story(client, "普通书")

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 503, res.json
    # 状态不变：内存缓存与磁盘都还是 story
    assert manager.load(book["id"]).book_type == BOOK_TYPE_STORY
    assert WorldBookManager(manager._dir).load(book["id"]).book_type == BOOK_TYPE_STORY


def test_conversion_gate_fails_closed_when_list_sessions_raises(tmp_path):
    """list_sessions() 抛异常 → 503，状态不变。"""
    class ExplodingSessions:
        def list_sessions(self):
            raise RuntimeError("会话索引损坏 at C:\\secret\\path\\sessions.json")

    client, manager = _gate_client(tmp_path, ExplodingSessions())
    book = make_story(client, "普通书")

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 503, res.json
    assert manager.load(book["id"]).book_type == BOOK_TYPE_STORY
    assert WorldBookManager(manager._dir).load(book["id"]).book_type == BOOK_TYPE_STORY
    # 响应不泄露内部细节：没有堆栈、没有异常原文里的路径
    body = str(res.json)
    assert "Traceback" not in body
    assert "secret" not in body and "sessions.json" not in body


def test_conversion_gate_fails_closed_on_invalid_return_type(tmp_path):
    """list_sessions() 返回结构类型无效（不是 list/tuple）→ 503，状态不变。"""
    class WeirdSessions:
        def list_sessions(self):
            return {"s1": {"worldbook_id": "whatever"}}   # 旧实现曾想兼容的 dict 形态

    client, manager = _gate_client(tmp_path, WeirdSessions())
    book = make_story(client, "普通书")

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 503, res.json
    assert manager.load(book["id"]).book_type == BOOK_TYPE_STORY
    assert WorldBookManager(manager._dir).load(book["id"]).book_type == BOOK_TYPE_STORY


def test_conversion_gate_allows_conversion_when_no_sessions(tmp_path):
    """正常返回空列表 = 确认没有绑定 → 允许转换（不能把 fail-closed 用过头）。"""
    class EmptySessions:
        def list_sessions(self):
            return []

    client, manager = _gate_client(tmp_path, EmptySessions())
    book = make_story(client, "普通书")

    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200, res.json
    assert manager.load(book["id"]).book_type == BOOK_TYPE_REFERENCE


def test_conversion_gate_without_session_service_allows_conversion(tmp_path):
    """没有任何会话服务（session_mgr is None）→ 按无绑定处理，允许转换。"""
    from blueprints.worldbook import register

    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    # 即便不注册 "session"，managers.get("session") 也是 None
    register(app, {"worldbook": book_manager})
    client = app.test_client()

    book = make_story(client, "普通书")
    res = client.put(f"/api/worldbook/{book['id']}", json={"book_type": "reference"})
    assert res.status_code == 200, res.json
    assert book_manager.load(book["id"]).book_type == BOOK_TYPE_REFERENCE


def test_reference_repair_does_not_need_session_enumeration(tmp_path):
    """reference -> story 是修复操作，不依赖会话枚举：会话服务坏掉也要放行。"""
    class ExplodingSessions:
        def list_sessions(self):
            raise RuntimeError("会话索引损坏")

    client, manager = _gate_client(tmp_path, ExplodingSessions())
    ref = make_reference(client, "资料库")
    res = client.put(f"/api/worldbook/{ref['id']}", json={"book_type": "story"})
    assert res.status_code == 200, res.json
    assert manager.load(ref["id"]).book_type == BOOK_TYPE_STORY


def test_reference_cannot_bind_session(tmp_path):
    from blueprints.worldbook import register

    class FakeRoster:
        def get_scene_characters(self):
            return []

    class FakeSession:
        id = "s1"
        scene_manager = FakeRoster()

        class overlay:
            @staticmethod
            def set_worldbook_id(_value):
                raise AssertionError("资料库不得被写入会话绑定")

    class FakeSessions:
        """只暴露 bind 路由真正使用的公开契约：get_session()。"""

        @staticmethod
        def get_session(session_id):
            return FakeSession() if session_id == "s1" else None

    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": book_manager, "session": FakeSessions()})
    client = app.test_client()

    reference = make_reference(client, "资料库")
    res = client.post(f"/api/worldbook/{reference['id']}/bind",
                      json={"session_id": "s1", "bound": True})
    assert res.status_code == 409
    assert "资料库" in res.json["error"]


def test_preinstalled_fallback_skips_reference(manager, monkeypatch, tmp_path):
    """预装回退也必须排除资料库。"""
    import world_book as module
    fallback_dir = tmp_path / "docs"
    fallback_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(module, "_WORLDBOOKS_DIR", fallback_dir)
    other = WorldBookManager(fallback_dir)
    book = other.create_book("兜底包")
    book.source = module.SOURCE_PREINSTALLED
    book.book_type = BOOK_TYPE_REFERENCE
    other.save(book)
    monkeypatch.setattr(module, "_PACK_FALLBACK_IDS", [book.id])
    assert manager._fallback_preinstalled() is None


# ─────────────────────────────────────────────────────────────
# B. 检索与摘录
# ─────────────────────────────────────────────────────────────

def test_search_filter_by_book_type(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "阿米娅的档案。", name="阿米娅")])
    seed(manager, story["id"], [make_entry("s1", "阿米娅的剧情稿。", name="阿米娅")])

    everything = client.get("/api/worldbook/search?q=阿米娅").json["results"]
    assert {hit["book"]["id"] for hit in everything} == {reference["id"], story["id"]}

    only_ref = client.get("/api/worldbook/search?q=阿米娅&book_type=reference").json["results"]
    assert [hit["book"]["id"] for hit in only_ref] == [reference["id"]]
    assert only_ref[0]["book"]["book_type"] == "reference"
    assert [m["uid"] for m in only_ref[0]["matches"]] == ["r1"]

    only_story = client.get("/api/worldbook/search?q=阿米娅&book_type=story").json["results"]
    assert [hit["book"]["id"] for hit in only_story] == [story["id"]]


def test_search_rejects_invalid_book_type(api):
    client, _ = api
    assert client.get("/api/worldbook/search?q=x&book_type=library").status_code == 400


def test_search_old_call_shape_still_compatible(api):
    """旧调用（无 book_type）行为不变：命中仍带来源书摘要与条目。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    seed(manager, reference["id"], [make_entry("r1", "源石技艺规则。", name="源石技艺")])
    payload = client.get("/api/worldbook/search?q=源石技艺&limit=5").json
    assert payload["results"][0]["book"]["name"] == "资料库"
    assert payload["results"][0]["match_count"] == 1
    assert payload["results"][0]["matches"][0]["content"] == "源石技艺规则。"


def _excerpt_body(reference_id, uid, **extra):
    return {"items": [{"source_book_id": reference_id, "source_entry_uid": uid, **extra}]}


def test_excerpt_copies_entry_verbatim(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry(
        "r1", "罗德岛的领袖。", name="阿米娅", trigger_keys=["阿米娅"], depth=7)])

    res = client.post(f"/api/worldbook/{story['id']}/excerpt",
                      json=_excerpt_body(reference["id"], "r1"))
    assert res.status_code == 201, res.json
    created = res.json["entries"][0]
    assert created["uid"] != "r1"
    assert created["uid"] in {e.uid for e in manager.load(story["id"]).entries}
    assert created["name"] == "阿米娅"
    assert created["content"] == "罗德岛的领袖。"
    assert created["trigger_keys"] == ["阿米娅"]
    assert created["depth"] == 7
    assert res.json["target"]["id"] == story["id"]
    assert res.json["target"]["entry_count"] == 1
    assert res.json["revision"] == 2


def test_excerpt_keeps_source_traceability(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "原文正文。", name="条目")])

    created = client.post(f"/api/worldbook/{story['id']}/excerpt",
                          json=_excerpt_body(reference["id"], "r1")).json["entries"][0]
    trace = created["excerpt_source"]
    assert trace["source_book_id"] == reference["id"]
    assert trace["source_entry_uid"] == "r1"
    assert trace["source_content_hash"] == hashlib.sha256("原文正文。".encode()).hexdigest()
    for field in EXCERPT_SOURCE_FIELDS:
        assert trace[field]

    # 来源书没有被修改
    source_book = manager.load(reference["id"])
    assert [e.uid for e in source_book.entries] == ["r1"]
    assert source_book.entries[0].content == "原文正文。"


def test_excerpt_with_edits_creates_story_use_draft(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "资料库原文。", name="阿米娅",
                                            trigger_keys=["阿米娅"])])

    res = client.post(f"/api/worldbook/{story['id']}/excerpt", json=_excerpt_body(
        reference["id"], "r1",
        name="阿米娅（第二章）", content="改写后的剧情稿。",
        trigger_keys=["阿米娅", "Amiya"], secondary_keys=["罗德岛"]))
    assert res.status_code == 201, res.json
    created = res.json["entries"][0]
    assert created["name"] == "阿米娅（第二章）"
    assert created["content"] == "改写后的剧情稿。"
    assert created["trigger_keys"] == ["阿米娅", "Amiya"]
    assert created["secondary_keys"] == ["罗德岛"]
    # 来源追踪指向的是**来源正文**的哈希，不是编辑稿
    assert created["excerpt_source"]["source_content_hash"] == hashlib.sha256(
        "资料库原文。".encode()).hexdigest()


def test_excerpt_batch_is_all_or_nothing(api):
    """任一条非法 → 整批不落盘，目标书保持原样。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文一。"), make_entry("r2", "正文二。")])
    before = json.dumps(manager.load(story["id"]).to_dict(), sort_keys=True)

    res = client.post(f"/api/worldbook/{story['id']}/excerpt", json={"items": [
        {"source_book_id": reference["id"], "source_entry_uid": "r1"},
        {"source_book_id": reference["id"], "source_entry_uid": "missing"},
    ]})
    assert res.status_code == 404
    assert json.dumps(manager.load(story["id"]).to_dict(), sort_keys=True) == before

    res = client.post(f"/api/worldbook/{story['id']}/excerpt", json={"items": [
        {"source_book_id": reference["id"], "source_entry_uid": "r1"},
        {"source_book_id": reference["id"], "source_entry_uid": "r2", "content": "   "},
    ]})
    assert res.status_code == 400
    assert json.dumps(manager.load(story["id"]).to_dict(), sort_keys=True) == before


def test_excerpt_batch_creates_all_entries_and_one_revision(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文一。"), make_entry("r2", "正文二。")])

    res = client.post(f"/api/worldbook/{story['id']}/excerpt", json={"items": [
        {"source_book_id": reference["id"], "source_entry_uid": "r1"},
        {"source_book_id": reference["id"], "source_entry_uid": "r2",
         "content": "编辑过的正文二。"},
    ]})
    assert res.status_code == 201, res.json
    assert len(res.json["entries"]) == 2
    assert res.json["target"]["entry_count"] == 2
    assert res.json["revision"] == 2
    uids = [e["uid"] for e in res.json["entries"]]
    assert len(set(uids)) == 2


def test_excerpt_rejects_reference_target(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    res = client.post(f"/api/worldbook/{reference['id']}/excerpt",
                      json=_excerpt_body(reference["id"], "r1"))
    assert res.status_code == 400
    assert "资料库" in res.json["error"]


def test_excerpt_allows_story_as_source(api):
    """剧情书也能当来源，便于剧情书之间复用条目。"""
    client, manager = api
    source = make_story(client, "来源剧情书")
    target = make_story(client, "目标剧情书")
    seed(manager, source["id"], [make_entry("s1", "可复用的条目。")])

    res = client.post(f"/api/worldbook/{target['id']}/excerpt",
                      json=_excerpt_body(source["id"], "s1"))
    assert res.status_code == 201, res.json
    assert res.json["entries"][0]["excerpt_source"]["source_book_id"] == source["id"]


def test_excerpt_rejects_missing_source_book(api):
    client, _ = api
    story = make_story(client, "剧情书")
    res = client.post(f"/api/worldbook/{story['id']}/excerpt",
                      json=_excerpt_body("no-such-book", "r1"))
    assert res.status_code == 404


def test_excerpt_rejects_missing_target(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    res = client.post("/api/worldbook/nope/excerpt", json=_excerpt_body(reference["id"], "r1"))
    assert res.status_code == 404


def test_excerpt_rejects_empty_items(api):
    client, _ = api
    story = make_story(client, "剧情书")
    assert client.post(f"/api/worldbook/{story['id']}/excerpt", json={"items": []}).status_code == 400
    assert client.post(f"/api/worldbook/{story['id']}/excerpt", json={}).status_code == 400


def test_excerpt_rejects_bad_field_types(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    for bad in ({"name": 5}, {"trigger_keys": "不是数组"}, {"trigger_keys": [1]},
                {"probability": 120}, {"position": 3}, {"depth": -1},
                {"always_active": "yes"}, {"content": 42}):
        res = client.post(f"/api/worldbook/{story['id']}/excerpt",
                          json=_excerpt_body(reference["id"], "r1", **bad))
        assert res.status_code == 400, (bad, res.json)
    assert manager.load(story["id"]).entries == []


def test_excerpt_null_field_means_use_source_value(api):
    """字段传 null 视作「没提供」：沿用来源原值，不把 null 当空值写进去。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "来源正文。", name="来源标题")])
    res = client.post(f"/api/worldbook/{story['id']}/excerpt",
                      json=_excerpt_body(reference["id"], "r1", content=None, name=None))
    assert res.status_code == 201, res.json
    assert res.json["entries"][0]["content"] == "来源正文。"
    assert res.json["entries"][0]["name"] == "来源标题"


def test_excerpt_same_entry_twice_gets_distinct_uids(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    first = client.post(f"/api/worldbook/{story['id']}/excerpt",
                        json=_excerpt_body(reference["id"], "r1")).json["entries"][0]
    second = client.post(f"/api/worldbook/{story['id']}/excerpt",
                         json=_excerpt_body(reference["id"], "r1")).json["entries"][0]
    assert first["uid"] != second["uid"]
    assert len(manager.load(story["id"]).entries) == 2


def test_excerpt_does_not_pollute_standard_sillytavern_fields(api):
    """摘录来源只进项目扩展命名空间，酒馆标准字段保持干净。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    client.post(f"/api/worldbook/{story['id']}/excerpt",
                json=_excerpt_body(reference["id"], "r1"))

    exported = client.get(f"/api/worldbook/{story['id']}/export").json["data"]
    entry = list(exported["entries"].values())[0]
    assert "excerpt_source" not in entry
    assert entry["extensions"][EXTENSION_KEY]["excerpt_source"]["source_entry_uid"] == "r1"
    # 标准字段仍然是酒馆认识的那几个
    assert entry["key"] == [] and entry["content"] == "正文。"


def test_excerpt_aligns_category_with_target_book(api):
    """来源分类在目标书不存在时退回未分类，不把条目塞进别人的分类 ID。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。", category_id="source-only")])

    created = client.post(f"/api/worldbook/{story['id']}/excerpt",
                          json=_excerpt_body(reference["id"], "r1")).json["entries"][0]
    assert created["category_id"] == "unclassified"

    # 目标书里存在的分类则原样保留
    created = client.post(f"/api/worldbook/{story['id']}/excerpt", json=_excerpt_body(
        reference["id"], "r1", category_id="worldview")).json["entries"][0]
    assert created["category_id"] == "worldview"


def test_excerpt_rejects_character_category_without_character(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    res = client.post(f"/api/worldbook/{story['id']}/excerpt", json=_excerpt_body(
        reference["id"], "r1", category_id="characters"))
    assert res.status_code == 400
    assert "角色" in res.json["error"]


def test_excerpt_persists_through_reload(api):
    """摘录结果必须真的落盘（不是只在内缓存里可见）。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    client.post(f"/api/worldbook/{story['id']}/excerpt",
                json=_excerpt_body(reference["id"], "r1"))

    fresh = WorldBookManager(manager._dir)
    reloaded = fresh.load(story["id"])
    assert len(reloaded.entries) == 1
    assert reloaded.entries[0].excerpt_source["source_entry_uid"] == "r1"


def test_excerpt_save_failure_leaves_cache_and_disk_unchanged(api, monkeypatch):
    """保存失败时不得污染内存缓存 —— 否则「失败不留半成品」只是磁盘上的假象。

    `load()` 返回的是缓存对象本身；如果先往它上面 append 再 save，而 save 在临时
    文件写入/替换时抛错，磁盘没变、缓存却已经多了条目、revision 也更高了。下次
    读这本书（同一 manager 命中缓存）就会看到一个从未落盘的状态。
    """
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])

    target_id = story["id"]
    before = manager.load(target_id)
    before_revision = before.import_config.get("revision", 1)
    # 先加载一次，确保后续断言读到的确实是缓存对象
    assert manager.load(target_id) is before

    def boom(_book):
        raise OSError("磁盘写满（故障注入）")

    monkeypatch.setattr(manager, "save", boom)
    with pytest.raises(OSError):
        manager.excerpt_entries(target_id, [
            {"source_book_id": reference["id"], "source_entry_uid": "r1"}])
    monkeypatch.undo()

    # 内存缓存没变
    after = manager.load(target_id)
    assert after is before
    assert after.entries == []
    assert after.import_config.get("revision", 1) == before_revision

    # 重新从磁盘加载也没变
    fresh = WorldBookManager(manager._dir)
    reloaded = fresh.load(target_id)
    assert reloaded.entries == []
    assert reloaded.import_config.get("revision", 1) == before_revision


def test_excerpt_save_failure_through_api_returns_500_and_keeps_state(tmp_path):
    """走接口路径：保存失败 → 500，书保持原样（不返回 201 的假成功）。"""
    from blueprints.worldbook import register

    book_manager = WorldBookManager(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": book_manager})
    client = app.test_client()

    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(book_manager, reference["id"], [make_entry("r1", "正文。")])

    def boom(_book):
        raise OSError("磁盘写满（故障注入）")

    book_manager.save = boom
    res = client.post(f"/api/worldbook/{story['id']}/excerpt",
                      json=_excerpt_body(reference["id"], "r1"))
    assert res.status_code == 500
    del book_manager.save  # 移除实例属性，回到真实方法

    assert book_manager.load(story["id"]).entries == []
    fresh = WorldBookManager(book_manager._dir)
    assert fresh.load(story["id"]).entries == []


def test_concurrent_excerpts_do_not_lose_entries(api):
    """并发摘录走同一把每书锁：两批都必须完整落盘，且修订号单调。"""
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    seed(manager, reference["id"], [make_entry(f"r{i}", f"正文{i}。") for i in range(8)])

    errors = []

    def worker(offset):
        try:
            res = client.post(f"/api/worldbook/{story['id']}/excerpt", json={"items": [
                {"source_book_id": reference["id"], "source_entry_uid": f"r{offset}"},
                {"source_book_id": reference["id"], "source_entry_uid": f"r{offset + 1}"},
            ]})
            assert res.status_code == 201, res.json
        except Exception as exc:  # pragma: no cover - 只在失败时触发
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in (0, 2, 4, 6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors
    final = manager.load(story["id"])
    assert len(final.entries) == 8
    assert len({e.uid for e in final.entries}) == 8
    assert final.import_config["revision"] == 5  # 1 初始 + 4 次成功摘录


def test_excerpt_does_not_touch_source_or_other_books(api):
    client, manager = api
    reference = make_reference(client, "资料库")
    story = make_story(client, "剧情书")
    other = make_story(client, "别的剧情书")
    seed(manager, reference["id"], [make_entry("r1", "正文。")])
    seed(manager, other["id"], [make_entry("o1", "别的正文。")])

    snapshot = {
        book_id: json.dumps(manager.load(book_id).to_dict(), sort_keys=True)
        for book_id in (reference["id"], other["id"], story["id"])
    }
    client.post(f"/api/worldbook/{story['id']}/excerpt",
                json=_excerpt_body(reference["id"], "r1"))
    for book_id in (reference["id"], other["id"]):
        assert json.dumps(manager.load(book_id).to_dict(), sort_keys=True) == snapshot[book_id]


def test_reference_stays_out_of_scope_resolution(api):
    """资料库条目不得通过任何解析入口进入候选。

    解析器本身是「书内」计算，不知道 book_type；「不参与解析」由**绑定点**保证：
    `resolve()` 直接排除资料库，素材注入、候选快照与会话创建都以它为准。
    这里逐一断言这些绑定点，而不是去改解析器语义（那会动到既有会话的等价性）。
    """
    client, manager = api
    reference = make_reference(client, "资料库")
    seed(manager, reference["id"], [
        make_entry("r1", "世界观设定。", category_id="worldview", always_active=True)])
    seed(manager, reference["id"], [
        make_entry("r2", "角色条目。", category_id="characters", character_id="阿米娅")])
    reference_book = manager.load(reference["id"])

    # 解析器本身仍能算（它是纯书内计算），但任何绑定点都不该把它交出去
    assert reference_book.resolve_import_scope([])["resolved_entry_uids"], \
        "前置条件：这本书在书内确实有候选，否则本用例不能证明是绑定点在拦"

    # ① 无会话：默认指针指向它也不生效
    #    （测试直接写 settings 模拟历史数据/手工编辑；正常路径由 /default 接口拦住）
    manager._save_settings({"default_book_id": reference["id"]})
    assert manager.resolve() is None

    # ② 有会话绑定：同样不生效
    overlay = type("Overlay", (), {
        "get_worldbook_id": lambda self: reference["id"],
        "get_worldbook_scope": lambda self: {
            "book_id": reference["id"], "resolved_entry_uids": ["r1", "r2"]},
    })()
    assert manager.resolve(overlay) is None

    # ③ 换成剧情书就正常生效（证明上一步不是「什么都没发生」）
    story = make_story(client, "剧情书")
    seed(manager, story["id"], [make_entry("s1", "世界观设定。", category_id="worldview")])
    story_overlay = type("StoryOverlay", (), {
        "get_worldbook_id": lambda self: story["id"],
    })()
    assert manager.resolve(story_overlay).id == story["id"]
