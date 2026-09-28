"""角色数值（世界书统一字段 × 角色全局值 × 会话值）与插件数据接口。

覆盖三层口径的纯逻辑、世界书序列化 / 导出回读、`blueprints/stage.py` 的全部端点，
以及「数值随剧情树节点快照回档」。会话与文档管理器都用最小替身，不落盘到真实数据目录。
"""
import copy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import character_stats as cs  # noqa: E402
import session_overlay  # noqa: E402
from session_overlay import SessionOverlay  # noqa: E402
from world_book import WorldBook, WorldBookEntry, WorldBookManager  # noqa: E402

FIELDS = [
    {"key": "hp", "label": "体力", "type": "number", "min": 0, "max": 100, "default": 100},
    {"key": "gold", "label": "金钱", "type": "number", "default": 0},
    {"key": "mood", "label": "心情", "type": "select", "options": ["平静", "警惕", "愤怒"]},
    {"key": "wounded", "label": "负伤", "type": "bool"},
    {"key": "note", "label": "备注", "type": "text"},
]


# ── 纯逻辑 ────────────────────────────────────────────────────────────────────

def test_normalize_fields_dedupes_and_fills_defaults():
    fields = cs.normalize_stat_fields([
        {"key": "hp", "type": "number", "min": "100", "max": "0"},   # min/max 反了 → 交换
        {"key": "hp", "label": "重复"},                                # 重复键丢弃
        {"key": "bad key!"},                                            # 非法键丢弃
        {"key": "mood", "type": "select", "options": "平静, 警惕、愤怒"},
        {"key": "flag", "type": "bool", "default": "yes"},
        "not a dict",
    ])
    assert [f["key"] for f in fields] == ["hp", "mood", "flag"]
    hp = fields[0]
    assert hp["label"] == "hp" and hp["min"] == 0 and hp["max"] == 100 and hp["default"] == 0
    assert fields[1]["options"] == ["平静", "警惕", "愤怒"] and fields[1]["default"] == "平静"
    assert fields[2]["default"] is True


def test_validate_fields_reports_problems():
    with pytest.raises(ValueError, match="数组"):
        cs.validate_stat_fields({"key": "hp"})
    with pytest.raises(ValueError, match="键名非法"):
        cs.validate_stat_fields([{"key": "has space"}])
    with pytest.raises(ValueError, match="重复"):
        cs.validate_stat_fields([{"key": "hp"}, {"key": "hp"}])
    with pytest.raises(ValueError, match="类型"):
        cs.validate_stat_fields([{"key": "hp", "type": "color"}])
    assert cs.validate_stat_fields(None) == []


def test_coerce_and_sanitize_values():
    fields = cs.normalize_stat_fields(FIELDS)
    out = cs.sanitize_values(fields, {
        "hp": "150",            # 超上限 → 夹到 100
        "gold": 12.0,
        "mood": "警惕",
        "wounded": "否",
        "note": 42,             # 文本字段接受任何标量
        "custom": "自定义值",    # 字段外自由填写
        "obj": {"nested": 1},   # 非标量丢弃（非严格模式）
    })
    assert out == {"hp": 100, "gold": 12.0, "mood": "警惕", "wounded": False,
                   "note": "42", "custom": "自定义值"}
    with pytest.raises(ValueError, match="心情"):
        cs.sanitize_values(fields, {"mood": "狂喜"}, strict=True)
    with pytest.raises(ValueError, match="体力"):
        cs.sanitize_values(fields, {"hp": "abc"}, strict=True)
    with pytest.raises(ValueError, match="键名非法"):
        cs.sanitize_values(fields, {"a b": 1}, strict=True)
    # None 表示删键，原样保留给调用方处理
    assert cs.sanitize_values(fields, {"hp": None}, strict=True) == {"hp": None}


def test_merge_layers_and_sources():
    fields = cs.normalize_stat_fields(FIELDS)
    values, sources = cs.merge_character_stats(fields, {"hp": 80, "custom": 1}, {"hp": 30, "gold": 5})
    assert values["hp"] == 30 and sources["hp"] == "session"
    assert values["gold"] == 5 and sources["gold"] == "session"
    assert values["mood"] == "平静" and sources["mood"] == "default"
    assert values["custom"] == 1 and sources["custom"] == "global"


def test_format_block_only_lists_present_values():
    fields = cs.normalize_stat_fields(FIELDS)
    block = cs.format_stats_block(fields, {"临光": {"hp": 80, "wounded": True, "note": ""},
                                           "瑕光": {}})
    assert block.startswith("<character_stats>") and block.endswith("</character_stats>")
    assert "临光：体力 80/100、负伤 是" in block
    assert "瑕光" not in block
    assert cs.format_stats_block(fields, {"瑕光": {}}) == ""


# ── 世界书序列化 / 导出 ───────────────────────────────────────────────────────

def test_worldbook_round_trips_stat_fields(tmp_path):
    manager = WorldBookManager(tmp_path)
    book = WorldBook("book", "测试书", [WorldBookEntry("e1", content="x", always_active=True)],
                     stat_fields=FIELDS)
    manager.save(book)
    reloaded = WorldBook.from_dict(book.to_dict())
    assert [f["key"] for f in reloaded.stat_fields] == ["hp", "gold", "mood", "wounded", "note"]

    exported = book.export_st()
    assert exported["extensions"]["arknights_tavern"]["stat_fields"][0]["key"] == "hp"
    imported, _report = manager.import_book("回读", exported)
    assert [f["key"] for f in imported.stat_fields] == [f["key"] for f in book.stat_fields]

    copy_book = manager.duplicate_book("book", "副本")
    assert copy_book.stat_fields == book.stat_fields

    # 没定义过字段的书序列化形态不变
    plain = WorldBook("plain", "无字段", [])
    assert "stat_fields" not in plain.to_dict()
    assert "stat_fields" not in plain.export_st()["extensions"]["arknights_tavern"]


@pytest.fixture
def worldbook_api(tmp_path):
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    manager.save(WorldBook("book", "测试书", [WorldBookEntry("e1", content="x", always_active=True)]))
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    return app.test_client(), manager


def test_worldbook_api_updates_and_validates_stat_fields(worldbook_api):
    client, manager = worldbook_api
    response = client.put("/api/worldbook/book", json={"stat_fields": FIELDS})
    assert response.status_code == 200, response.json
    assert [f["key"] for f in response.json["book"]["stat_fields"]] == ["hp", "gold", "mood", "wounded", "note"]
    detail = client.get("/api/worldbook/book").json
    assert detail["stat_fields"][0]["label"] == "体力"

    bad = client.put("/api/worldbook/book", json={"stat_fields": [{"key": "hp"}, {"key": "hp"}]})
    assert bad.status_code == 400 and "重复" in bad.json["error"]
    # 失败的写入不落盘
    assert len(manager.load("book").stat_fields) == 5


# ── 会话与舞台端点（最小替身） ────────────────────────────────────────────────

class FakeDocs:
    """内存版 DocumentManager：只实现 stage.py 用到的 read/save。"""

    def __init__(self, docs):
        self.docs = docs

    def read_document(self, category, name, *, book_id=None, book_ids=None):
        from document_manager import DocumentNotFoundError
        if category != "characters" or name not in self.docs:
            raise DocumentNotFoundError(name)
        meta, content = self.docs[name]
        return {"metadata": copy.deepcopy(meta), "content": content}

    def save_document(self, category, name, content, metadata=None, expected_hash=None, *, book_id=None):
        self.docs[name] = (copy.deepcopy(metadata or {}), content)
        return {"hash": "x", "path": name}


class FakeScene:
    def __init__(self, player, npcs):
        self.player_identity = player
        self.npcs = list(npcs)
        self.active = npcs[0] if npcs else None

    def get_scene_characters(self):
        return list(self.npcs)

    def get_roster(self):
        return list(dict.fromkeys([self.player_identity, *self.npcs]))


@pytest.fixture
def stage_api(tmp_path, monkeypatch):
    from blueprints.stage import register
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    wb_mgr = WorldBookManager(tmp_path / "books")
    wb_mgr.save(WorldBook("book", "测试书", [], stat_fields=FIELDS))
    wb_mgr.save(WorldBook("other", "另一本", [], stat_fields=[{"key": "luck", "label": "运气"}]))
    docs = FakeDocs({
        "临光": ({"name": "临光", "worldbook_id": "book", "stats": {"hp": 80}}, "正文"),
        "瑕光": ({"name": "瑕光", "worldbook_id": "other"}, ""),
        "博士": ({"name": "博士", "player_identity": True}, ""),
    })
    overlay = SessionOverlay("s1", "story")
    overlay.set_worldbook_ids(["book"])
    session = SimpleNamespace(
        id="s1", overlay=overlay, player_identity="博士",
        scene_manager=FakeScene("博士", ["临光", "瑕光"]),
        environment=SimpleNamespace(location="龙门", weather="晴天", time_of_day="夜晚", atmosphere=["安静"]),
        data_dir=tmp_path / "sessions" / "story" / "s1",
    )
    session.data_dir.mkdir(parents=True, exist_ok=True)
    session_mgr = SimpleNamespace(get_session=lambda sid: session if sid == "s1" else None)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"session": session_mgr, "document": docs, "worldbook": wb_mgr})
    return app.test_client(), session, docs


def test_character_global_stats_get_put(stage_api):
    client, _session, docs = stage_api
    got = client.get("/api/characters/临光/stats").json
    assert got["worldbook_name"] == "测试书" and got["values"]["hp"] == 80 and got["sources"]["hp"] == "global"
    assert got["values"]["gold"] == 0 and got["sources"]["gold"] == "default"

    put = client.put("/api/characters/临光/stats", json={"values": {"gold": "15", "hp": None, "custom": "x"}})
    assert put.status_code == 200, put.json
    assert docs.docs["临光"][0]["stats"] == {"gold": 15, "custom": "x"}
    assert put.json["values"]["hp"] == 100 and put.json["sources"]["hp"] == "default"

    bad = client.put("/api/characters/临光/stats", json={"values": {"mood": "狂喜"}})
    assert bad.status_code == 400
    assert client.get("/api/characters/不存在/stats").status_code == 404

    # replace=true 清掉未提及的键；全空则 frontmatter 不再保留 stats
    client.put("/api/characters/临光/stats", json={"values": {}, "replace": True})
    assert "stats" not in docs.docs["临光"][0]


def test_same_named_character_stats_write_to_selected_book(tmp_path):
    from blueprints.stage import register
    from document_manager import DocumentManager

    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
            "categories:\n  characters: characters/\n",
        encoding="utf-8")
    books = data / "worldbooks"
    manager = WorldBookManager(books)
    for book_id, hp in (("first", 10), ("second", 20)):
        manager.save(WorldBook(book_id, book_id, [], stat_fields=FIELDS))
        actor = books / "books" / book_id / "characters" / "Hero"
        actor.mkdir(parents=True)
        (actor / "index.md").write_text(
            f"---\nname: Hero\nstats:\n  hp: {hp}\n---\n", encoding="utf-8")

    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"session": SimpleNamespace(get_session=lambda _: None),
                   "document": DocumentManager(str(tmp_path)), "worldbook": manager})
    client = app.test_client()
    assert client.get("/api/characters/Hero/stats?worldbook_id=first").json["stored"]["hp"] == 10
    assert client.get("/api/characters/Hero/stats?worldbook_id=second").json["stored"]["hp"] == 20
    result = client.put("/api/characters/Hero/stats?worldbook_id=second",
                        json={"values": {"hp": 30}})
    assert result.status_code == 200, result.json
    assert client.get("/api/characters/Hero/stats?worldbook_id=first").json["stored"]["hp"] == 10
    assert client.get("/api/characters/Hero/stats?worldbook_id=second").json["stored"]["hp"] == 30

def test_session_stats_merge_and_bound_book_fields(stage_api):
    client, session, _docs = stage_api
    listing = client.get("/api/sessions/s1/character-stats").json
    by_name = {c["name"]: c for c in listing["characters"]}
    assert list(by_name) == ["博士", "临光", "瑕光"]
    assert by_name["博士"]["is_player"] is True
    # 会话绑定了 book：瑕光自己来源于 other，但同一会话统一用 book 的字段
    assert by_name["瑕光"]["worldbook_id"] == "book"
    assert by_name["临光"]["values"]["hp"] == 80 and by_name["临光"]["sources"]["hp"] == "global"

    put = client.put("/api/sessions/s1/character-stats/临光", json={"values": {"hp": 40, "mood": "警惕"}})
    assert put.status_code == 200, put.json
    assert put.json["values"]["hp"] == 40 and put.json["sources"]["hp"] == "session"
    assert put.json["session_values"] == {"hp": 40, "mood": "警惕"}
    assert session.overlay.get_character_stats("临光") == {"hp": 40, "mood": "警惕"}

    # 合并写：只改一个键，另一个保留；None 删键
    client.put("/api/sessions/s1/character-stats/临光", json={"values": {"mood": None, "gold": 3}})
    assert session.overlay.get_character_stats("临光") == {"hp": 40, "gold": 3}

    bad = client.put("/api/sessions/s1/character-stats/临光", json={"values": {"hp": "many"}})
    assert bad.status_code == 400
    assert client.put("/api/sessions/s1/character-stats/../x", json={"values": {}}).status_code in (400, 404)

    reset = client.delete("/api/sessions/s1/character-stats/临光").json
    assert reset["values"]["hp"] == 80 and reset["sources"]["hp"] == "global"
    assert session.overlay.get_character_stats("临光") == {}
    assert client.get("/api/sessions/nope/character-stats").status_code == 404


def test_session_stats_fall_back_to_character_book_when_unbound(stage_api):
    client, session, _docs = stage_api
    session.overlay.set_worldbook_ids([])
    listing = client.get("/api/sessions/s1/character-stats").json
    by_name = {c["name"]: c for c in listing["characters"]}
    assert by_name["瑕光"]["worldbook_id"] == "other"
    assert [f["key"] for f in by_name["瑕光"]["fields"]] == ["luck"]
    assert by_name["博士"]["fields"] == []
    # 字段外的自定义键仍可写
    put = client.put("/api/sessions/s1/character-stats/博士", json={"values": {"reputation": 7}})
    assert put.status_code == 200 and put.json["values"] == {"reputation": 7}


def test_plugin_data_crud_and_limits(stage_api):
    client, session, _docs = stage_api
    empty = client.get("/api/sessions/s1/plugin-data/notes").json
    assert empty["data"] == {} and empty["updated_at"] is None

    put = client.put("/api/sessions/s1/plugin-data/notes", json={"data": {"text": "hi", "count": 1}})
    assert put.status_code == 200 and put.json["data"] == {"text": "hi", "count": 1}
    merged = client.put("/api/sessions/s1/plugin-data/notes", json={"data": {"count": None, "tags": ["a"]}}).json
    assert merged["data"] == {"text": "hi", "tags": ["a"]}
    replaced = client.put("/api/sessions/s1/plugin-data/notes", json={"data": {"only": 1}, "replace": True}).json
    assert replaced["data"] == {"only": 1}
    assert client.get("/api/sessions/s1/plugin-data").json["namespaces"]["notes"]["data"] == {"only": 1}

    assert client.put("/api/sessions/s1/plugin-data/Bad-Name", json={"data": {}}).status_code == 400
    assert client.put("/api/sessions/s1/plugin-data/notes", json={"data": [1]}).status_code == 400
    assert client.put("/api/sessions/s1/plugin-data/notes", json=[1]).status_code == 400
    big = client.put("/api/sessions/s1/plugin-data/notes", json={"data": {"blob": "x" * (70 * 1024)}})
    assert big.status_code == 413

    assert client.delete("/api/sessions/s1/plugin-data/notes").json["removed"] is True
    assert client.delete("/api/sessions/s1/plugin-data/notes").json["removed"] is False
    assert session.overlay.list_plugin_data() == {}


def test_stage_payload(stage_api, monkeypatch):
    client, session, _docs = stage_api
    stage = client.get("/api/sessions/s1/stage").json
    assert stage["location"] == "龙门" and stage["time"] == "夜晚"
    assert [c["name"] for c in stage["characters"]] == ["临光", "瑕光"]
    assert stage["characters"][0]["active"] is True
    assert stage["player"]["name"] == "博士"
    assert "skin_url" in stage["player"]
    assert stage["background"]["source"] in ("default", "none", "location", "session")
    for character in stage["characters"]:
        for key in ("skin_url", "avatar_url", "color"):
            assert key in character

    import session_resources
    monkeypatch.setattr(
        session_resources, "find_session_media_path",
        lambda _directory, name, kind: "player-skin.png" if (name, kind) == ("博士", "skin") else None,
    )
    session.scene_manager.npcs.append("博士")
    stage_with_player_skin = client.get("/api/sessions/s1/stage").json
    assert stage_with_player_skin["player"]["skin_url"] == "/api/characters/%E5%8D%9A%E5%A3%AB/skin?session_id=s1"
    assert [c["name"] for c in stage_with_player_skin["characters"]] == ["临光", "瑕光"]
    assert client.get("/api/sessions/nope/stage").status_code == 404


def test_stage_uses_narration_beat_even_after_session_advances(stage_api, monkeypatch):
    client, session, _docs = stage_api
    import plot_graphs
    monkeypatch.setattr(session.overlay, "get_plot_id", lambda: "p")
    monkeypatch.setattr(session.overlay, "get_current_beat_id", lambda: "next")
    monkeypatch.setattr(session.overlay, "get_beat_state", lambda: {"chapter_idx": 1})
    monkeypatch.setattr(plot_graphs, "load_graph", lambda *_: {"nodes": [
        {"id": "old", "type": "beat", "title": "旧节拍", "ref": {"chapter_idx": 1, "beat_id": "old"},
         "scene_media": {"background_url": "/api/assets/plots/p/art/old.png",
                         "cg_url": "/api/assets/plots/p/art/cg.png", "cg_title": "旧画面"}},
        {"id": "next", "type": "beat", "title": "下一节拍", "ref": {"chapter_idx": 2, "beat_id": "next"},
         "scene_media": {"background_url": "/api/assets/plots/p/art/next.png"}},
    ]})
    session._narration_history = [{"round": 1, "beat_id": "old", "chapter_idx": 1}]
    old = client.get("/api/sessions/s1/stage?round=1").json
    assert old["background"]["url"].endswith("old.png")
    assert old["scene_media"]["cg"]["title"] == "旧画面"
    assert old["scene_media"]["cue_key"] == "p:1:old:1"
    current = client.get("/api/sessions/s1/stage").json
    assert current["background"]["url"].endswith("next.png")
    assert current["scene_media"]["cg"] is None


# ── 快照与回档 ────────────────────────────────────────────────────────────────

def test_stats_and_plugin_data_follow_tree_rollback(tmp_path, monkeypatch):
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    overlay = SessionOverlay("s2", "story")
    overlay.init_story_tree("")
    overlay.set_character_stats("临光", {"hp": 90})
    overlay.set_plugin_data("notes", {"n": 1})
    overlay.commit_tree_step(narrative="第一幕", summary="s", title="t",
                             branches=[{"label": "走"}], round_num=1)
    root = overlay.get_current_tree_node()
    assert root["state"]["character_stats"] == {"临光": {"hp": 90}}
    assert root["state"]["plugin_data"]["notes"]["data"] == {"n": 1}

    overlay.set_character_stats("临光", {"hp": 20})
    overlay.set_plugin_data("notes", {"n": 2})
    overlay.commit_tree_step(narrative="第二幕", branch={"label": "走"}, round_num=2)
    assert overlay.get_character_stats("临光") == {"hp": 20}

    overlay.rollback_to_tree_node(root["id"])
    assert overlay.get_character_stats("临光") == {"hp": 90}
    assert overlay.get_plugin_data("notes")["data"] == {"n": 1}

    # 老快照（没有这两个键）回档时保持现值
    node = overlay.get_current_tree_node()
    node["state"].pop("character_stats", None)
    node["state"].pop("plugin_data", None)
    overlay.set_character_stats("临光", {"hp": 55})
    overlay.rollback_to_tree_node(node["id"])
    assert overlay.get_character_stats("临光") == {"hp": 55}
    assert overlay.to_dict()["character_stats"] == {"临光": {"hp": 55}}
