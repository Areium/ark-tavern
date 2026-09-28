"""新建会话：主控角色与角色入队是同一次选择。

契约（`blueprints/sessions.py` + `SceneManager.get_roster()`）：

1. 图形界面显式提交 `identity`；显式传空 = 明确没选 → 400，不允许建出一个没有主控的会话。
   API 省略该字段时使用当前平台的中性身份「玩家」。
2. 主控是**阵容成员**：它进 `worldbook_scope.roster_character_ids`，属于它的世界书
   条目按 roster 规则载入。
3. 主控**不是场景 NPC**：它不进 `scene_manager` 的场景角色（模型不替玩家说话），
   同一角色也绝不会因为「身份」与「入队」两条路径在阵容里出现两次。
"""
import copy
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager

MAIN_CONTROL = "龙门侦探"


def entry(uid, **kwargs):
    return WorldBookEntry(uid, content=f"content-{uid}", always_active=True, **kwargs)


def book_fixture():
    """一本含「主控专属条目」的书：mc 只认主控角色。"""
    return WorldBook("book", "测试书", [
        entry("world", category_id="worldview"),
        entry("a", category_id="squad", character_id="A"),
        entry("mc", category_id="squad", character_id=MAIN_CONTROL),
    ], categories=copy.deepcopy(DEFAULT_CATEGORIES) + [
        {"id": "faction", "name": "势力", "parent_id": "characters",
         "scope_type": "character", "sort_order": 1},
        {"id": "squad", "name": "队伍", "parent_id": "faction",
         "scope_type": "character", "sort_order": 1},
    ], dependency_rules={"roots": [
        {"entry_uid": "world", "activation": "always", "expansion": "none"},
        {"entry_uid": "a", "activation": "roster_any", "expansion": "none", "character_ids": ["A"]},
        {"entry_uid": "mc", "activation": "roster_any", "expansion": "none",
         "character_ids": [MAIN_CONTROL]},
    ], "root_rule": {"entry_uids": ["world", "a", "mc"]}})


class Overlay:
    def __init__(self):
        self.scope, self.book_id = None, None

    def get_worldbook_scope(self, book_id=None): return copy.deepcopy(self.scope)
    def set_worldbook_scope(self, value, book_id=None): self.scope = copy.deepcopy(value)
    def get_worldbook_ids(self): return [self.book_id] if self.book_id else []
    def get_worldbook_id(self): return self.book_id
    def set_worldbook_ids(self, values): self.book_id = values[0] if values else None
    def update_worldbook_scope(self, updater, book_id=None):
        self.scope = copy.deepcopy(updater(copy.deepcopy(self.scope)))
        return copy.deepcopy(self.scope)


class FakeSceneManager:
    """只实现会话创建用得上的三件事：加载队友、场景角色、阵容。"""

    LOADABLE = ("A", "B")

    def __init__(self, session):
        self._session = session
        self.player_identity = ""

    def load_character(self, name):
        if name not in self.LOADABLE:
            return False
        if name not in self._session.characters:
            self._session.characters.append(name)
        return True

    def get_scene_characters(self):
        return list(self._session.characters)

    def get_roster(self):
        """服务端口径：主控在前 + 队友，按名去重（与 SceneManager.get_roster 同规则）。"""
        roster = [self.player_identity] if self.player_identity else []
        roster.extend(self._session.characters)
        return list(dict.fromkeys(roster))

    def set_player_identity(self, name):
        self.player_identity = (name or "").strip()


class FakeSession:
    def __init__(self, sid, backend, **kwargs):
        self.id, self.name = sid, kwargs["name"]
        self.mode = kwargs.get("mode", "free")
        self.combat_mode = kwargs.get("combat_mode", "narrative")
        self.player_identity = (kwargs.get("player_identity") or "").strip() or "博士"
        self.overlay = Overlay()
        self.characters = []
        self.scene_manager = FakeSceneManager(self)
        self.scene_manager.player_identity = self.player_identity

    def to_dict(self):
        return {
            "id": self.id,
            "player_identity": self.player_identity,
            "characters": self.scene_manager.get_scene_characters(),
            "roster": self.scene_manager.get_roster(),
            "worldbook_ids": self.overlay.get_worldbook_ids(),
            "worldbook_scopes": {bid: self.overlay.get_worldbook_scope(bid)
                                 for bid in self.overlay.get_worldbook_ids()},
        }


@pytest.fixture
def session_api(tmp_path, monkeypatch):
    import session_manager as module
    from blueprints.sessions import register
    books = WorldBookManager(tmp_path)
    books.save(book_fixture())
    cleaned, persisted = [], []

    monkeypatch.setattr(module, "Session", FakeSession)
    monkeypatch.setattr(module.SessionOverlay, "delete_session_overlays",
                        lambda sid, mode: cleaned.append(sid))
    manager = object.__new__(module.SessionManager)
    manager._lock, manager._sessions, manager._next_id = threading.Lock(), {}, 0
    manager._llm_backend = manager._wiki_manager = None
    manager._worldbook_manager = books
    manager._save_session_meta = lambda session: persisted.append(session.id)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": books, "session": manager})
    return app.test_client(), manager, books, cleaned, persisted


# ── 1. 未选主控不得创建 ──────────────────────────────────────────────────────

def test_explicit_empty_identity_is_rejected(session_api):
    """新流程显式传空 identity = 没选主控 → 明确拒绝，不留半成品。"""
    client, manager, _, cleaned, _ = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"], "identity": ""})
    assert response.status_code == 400
    assert "必须选择主控角色" in response.json["error"]
    assert not manager._sessions and not cleaned


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_any_blank_identity_is_rejected(session_api, blank):
    client, _, _, _, _ = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"], "identity": blank})
    assert response.status_code == 400


def test_absent_identity_still_falls_back_for_other_callers(session_api):
    """省略身份时使用平台当前的中性身份「玩家」。"""
    client, _, _, _, _ = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"]})
    assert response.status_code == 201, response.json
    assert response.json["player_identity"] == "玩家"


# ── 2. 主控 = 阵容成员，且只算一次 ───────────────────────────────────────────

def test_main_control_joins_roster_but_is_not_a_scene_character(session_api):
    client, _, _, _, _ = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"], "identity": MAIN_CONTROL})
    assert response.status_code == 201, response.json
    body = response.json

    assert body["player_identity"] == MAIN_CONTROL
    # 阵容：主控在前 + 队友
    assert body["roster"] == [MAIN_CONTROL, "A"]
    # 场景角色只有队友：主控由玩家扮演，模型不替玩家说话
    assert body["characters"] == ["A"]
    # 主控的世界书条目按 roster 规则载入
    scope = body["worldbook_scopes"]["book"]
    assert MAIN_CONTROL in scope["roster_character_ids"]
    assert "mc" in scope["resolved_entry_uids"]


def test_same_character_is_not_added_twice(session_api):
    """阵容里既写主控又写队友时，只保留一条（身份与入队不重复）。"""
    client, _, _, _, _ = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": [MAIN_CONTROL, "A", MAIN_CONTROL],
        "identity": MAIN_CONTROL})
    assert response.status_code == 201, response.json
    assert response.json["roster"] == [MAIN_CONTROL, "A"]
    assert response.json["characters"] == ["A"]
    assert response.json["worldbook_scopes"]["book"]["roster_character_ids"] == sorted([MAIN_CONTROL, "A"])


def test_main_control_does_not_go_through_the_npc_loading_path(session_api):
    """主控不需要是「可加载的场景角色」：它不参与 load_character，因此不会因
    角色卡不在可加载集合里而拒绝创建。"""
    client, _, _, _, _ = session_api
    assert MAIN_CONTROL not in FakeSceneManager.LOADABLE
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": [], "identity": MAIN_CONTROL})
    assert response.status_code == 201, response.json
    assert response.json["characters"] == []
    assert response.json["roster"] == [MAIN_CONTROL]


def test_teammate_loading_failure_still_rejects_and_cleans_up(session_api):
    client, manager, _, cleaned, persisted = session_api
    response = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A", "missing"],
        "identity": MAIN_CONTROL})
    assert response.status_code == 400
    assert "无法加载入队角色" in response.json["error"]
    assert not manager._sessions and not persisted and len(cleaned) == 1


def test_switching_main_control_keeps_roster_in_sync(session_api):
    """换主控后，会话与场景管理器的阵容口径保持一致（旧主控退出、新主控进入）。"""
    client, manager, _, _, _ = session_api
    created = client.post("/api/sessions", json={
        "worldbook_ids": ["book"], "roster_character_ids": ["A"], "identity": MAIN_CONTROL})
    session_id = created.json["id"]

    assert manager.set_player_identity(session_id, "B")
    session = manager._sessions[session_id]
    assert session.player_identity == "B"
    assert session.scene_manager.get_roster() == ["B", "A"]
    assert session.scene_manager.get_scene_characters() == ["A"]


# ── 3. SceneManager 阵容口径（真实实现，不用替身）───────────────────────────

def test_scene_manager_roster_excludes_main_control_from_scene_characters():
    """阵容 = 主控 + 队友；场景角色只有队友；同一个名字在阵容里只出现一次。"""
    from SceneManager import SceneManager

    scene = SceneManager(None, None, player_identity=MAIN_CONTROL)
    scene._agents = {"A": object()}
    assert scene.get_scene_characters() == ["A"]
    assert scene.get_roster() == [MAIN_CONTROL, "A"]

    # 主控恰好也是队友（角色卡同名）→ 仍然只算一次
    scene.set_player_identity("A")
    assert scene.get_roster() == ["A"]
    assert scene.get_scene_characters() == ["A"]


def test_scene_manager_roster_drives_the_worldbook_scope_refresh(tmp_path, monkeypatch):
    """阵容成员变动按**阵容**（含主控）重算候选范围，主控的条目随之进出。"""
    import SceneManager as scene_module
    from SceneManager import SceneManager

    manager = WorldBookManager(tmp_path)
    book = book_fixture()
    manager.save(book)
    overlay = Overlay()
    overlay.scope = book.session_scope_snapshot([MAIN_CONTROL])
    overlay.book_id = book.id

    scene = SceneManager(None, None, overlay=overlay, worldbook_manager=manager,
                         player_identity=MAIN_CONTROL)
    monkeypatch.setattr(scene, "_persist_scene", lambda: None)
    monkeypatch.setattr(overlay, "get_character_overrides", lambda _: {}, raising=False)
    monkeypatch.setattr(overlay, "get_index_config", lambda: None, raising=False)
    monkeypatch.setattr(scene_module, "CharacterAgent",
                        lambda *args, **kwargs: SimpleNamespace(character="card"))

    assert scene.load_character("A")
    assert set(overlay.scope["resolved_entry_uids"]) == {"world", "a", "mc"}

    # 换主控：属于旧主控的 mc 退出、属于新主控的条目进来（B 无专属条目 → 只剩队友的 a）
    scene.set_player_identity("B")
    assert set(overlay.scope["resolved_entry_uids"]) == {"world", "a"}
