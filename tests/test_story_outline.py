# -*- coding: utf-8 -*-
"""参考大纲（story_outline）：从世界书 / 剧情文档生成节点参考条目的纯逻辑验证。

覆盖：
  - 启发式切幕：`## 第N幕：` + `**必须保留的节拍**` 的护栏式剧情
    能确定性地切成章节/节拍，续写「路线」成为分支章节并从末幕挂出作者分支；
  - 规范化：id 去重、非法 target_beat_id 置空、combat 字段回填；
  - 折算成节拍骨架：`[COMBAT:node_id]` 标记、authored_branches、keep_on_deviate；
  - 世界书条目编解码往返 + 系统层判定（永不注入）；
  - LLM 生成：脚本化 LLM 输出 JSON → 大纲；输出损坏 → 回落启发式并标明 generation.error；
  - 偏离分支追加：新章节 id / 节拍 id 不与既有冲突。
"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import story_outline as so  # noqa: E402
from world_book import WorldBook, WorldBookEntry, WorldBookManager, entry_layer, is_system_entry  # noqa: E402

PLOT_ID = "fixture_plot"


@pytest.fixture()
def plot_doc():
    meta = {"id": PLOT_ID, "name": "测试剧情", "summary": "两幕与续写路线"}
    body = (
        "## 第一幕：相遇\n主角在雨中遇见向导。\n**必须保留的节拍**：向导知道密语。\n"
        "## 第二幕：危机\n机器失控，主角必须决定去留。\n"
        "## 路线 A：留下\n主角留下调查。\n"
        "## 路线 B：离开\n主角离开现场。\n"
    )
    return meta, body


def test_heuristic_outline_splits_acts_and_routes(plot_doc):
    meta, body = plot_doc
    outline = so.heuristic_outline(meta, body, worldbook_id="beyond-twin")
    assert outline["plot_id"] == PLOT_ID and outline["source"] == "heuristic"
    mains = [ch for ch in outline["chapters"] if ch["kind"] == "main"]
    routes = [ch for ch in outline["chapters"] if ch["kind"] == "branch"]
    assert [ch["title"] for ch in mains] == ["相遇", "危机"]
    assert [ch["title"] for ch in routes] == ["留下", "离开"]
    # 必须保留的节拍被抽成 must_keep
    first = mains[0]["beats"][0]
    assert "向导知道密语" in first["must_keep"]
    assert first["id"] == "beat_act_1_1"
    # 危机幕命中战斗关键词 → 建议战斗
    act2 = mains[1]["beats"][0]
    assert act2["combat"] and act2["combat"].get("suggested") and act2["combat"]["required"] is False
    # 末幕挂出指向两条路线的作者分支
    last = mains[-1]["beats"][-1]
    assert [b["target_beat_id"] for b in last["branches"]] == [
        "beat_route_a_1", "beat_route_b_1"]


def test_normalize_dedupes_ids_and_drops_bogus_targets():
    doc = {
        "plot_id": "p", "chapters": [
            {"id": "act_1", "title": "A", "beats": [
                {"id": "x", "title": "一", "content": "c1",
                 "branches": [{"label": "去", "target_beat_id": "beat_y"},
                              {"label": "留", "target_beat_id": "no_such"}]},
                {"id": "x", "title": "二", "content": "c2", "combat": True},
            ]},
            {"id": "act_1", "title": "B", "beats": [{"id": "y", "summary": "s"}]},
        ],
    }
    out = so.normalize_outline(doc)
    ids = so.beat_ids(out)
    assert ids == ["beat_x", "beat_x_2", "beat_y"]
    assert [ch["id"] for ch in out["chapters"]] == ["act_1", "act_1_2"]
    br = out["chapters"][0]["beats"][0]["branches"]
    assert br[0]["target_beat_id"] == "beat_y" and br[1]["target_beat_id"] is None
    assert out["chapters"][0]["beats"][1]["combat"] == {
        "required": True, "description": "", "enemies": [], "band": "T1", "node_id": ""}
    with pytest.raises(so.OutlineError):
        so.normalize_outline({"plot_id": "p", "chapters": []})


def test_outline_to_beats_carries_combat_marker_and_branches(plot_doc):
    meta, body = plot_doc
    outline = so.heuristic_outline(meta, body)
    outline["chapters"][1]["beats"][0]["combat"] = {
        "required": True, "description": "机器失控", "enemies": ["测试敌人"],
        "band": "T2", "node_id": "enc_fixture"}
    beats = so.outline_to_beats(outline)
    assert len(beats) == 4
    b2 = beats[1]["beats"][0]
    assert "[COMBAT:enc_fixture]" in b2["content"]
    assert beats[0]["beats"][0]["keep_on_deviate"] is True
    last = beats[1]["beats"][-1]
    assert [b["target_beat_id"] for b in last["authored_branches"]] == ["beat_route_a_1", "beat_route_b_1"]
    assert all(b["source"] == "author" for b in last["authored_branches"])


def test_worldbook_entry_roundtrip_is_system_layer(plot_doc):
    meta, body = plot_doc
    outline = so.heuristic_outline(meta, body, worldbook_id="fixture-book")
    payload = so.encode_outline_for_worldbook(outline)
    assert payload["uid"] == "story_outline_fixture_plot" and payload["trigger_keys"] == []
    entry = WorldBookEntry.from_dict(payload)
    assert is_system_entry(entry) and entry_layer(entry) == "system", "大纲条目永不注入"
    decoded = so.decode_outline_entry(entry)
    assert decoded["plot_id"] == PLOT_ID and len(decoded["chapters"]) == 4
    # 只有围栏、没有 extensions 标记的条目同样能识别（导入酒馆格式后的形态）
    bare = {"uid": "u", "content": payload["content"], "raw": {}}
    assert so.is_outline_entry(bare) and is_system_entry(bare)
    assert so.decode_outline_entry({"uid": "u", "content": "普通条目", "raw": {}}) is None


def test_delete_outline_clears_display_folder_mapping(tmp_path):
    manager = WorldBookManager(tmp_path)
    manager.save(WorldBook("book", "测试书"))
    outline = {"plot_id": "plot", "title": "测试", "chapters": [
        {"id": "ch", "title": "章节", "beats": [{"id": "beat", "title": "节拍", "content": "内容"}]},
    ]}
    so.save_outline(manager, "book", outline)
    book = manager.load("book")
    uid = so.entry_uid("plot")
    book.entry_groups = [{"id": "g", "name": "大纲"}]
    book.entry_group_map = {uid: "g"}
    manager.save(book)

    assert so.delete_outline(manager, "book", "plot") is True
    reloaded = manager.load("book")
    assert reloaded.entry_groups == [{"id": "g", "name": "大纲"}]
    assert reloaded.entry_group_map == {}
    assert all(entry.uid != uid for entry in reloaded.entries)


class _ScriptedLLM:
    def __init__(self, content):
        self.content = content
        self.calls = []

    def chat(self, messages, **kw):
        self.calls.append(messages)
        return {"content": self.content, "usage": {"total_tokens": 10}}


def _fake_book():
    entries = [
        WorldBookEntry(uid="plots_fixture_plot_index", name="测试剧情", content="剧情条目内容"),
        WorldBookEntry(uid="characters_妮可_index", name="妮可", content="穿灰色毛绒外套的小女孩"),
        WorldBookEntry(uid="world_彼岸双生", name="世界", content="深湾市，台风夜"),
        WorldBookEntry(uid="plot_graph_fixture_plot", name="节点图", content="```json plot-graph\n{}\n```"),
        WorldBookEntry(uid="off", name="停用", content="不该出现", enabled=False),
    ]
    return type("Book", (), {"entries": entries, "id": "fixture-book"})()


def test_collect_reference_entries_prefers_plot_and_skips_system(plot_doc):
    refs = so.collect_reference_entries(_fake_book(), PLOT_ID)
    uids = [r["uid"] for r in refs]
    assert uids[0] == "plots_fixture_plot_index"
    assert "plot_graph_fixture_plot" not in uids and "off" not in uids
    assert {r["kind"] for r in refs} == {"剧情", "角色", "世界"}


def test_llm_outline_generation_uses_references_and_normalizes(plot_doc):
    meta, body = plot_doc
    llm_doc = {
        "title": "彼岸双生",
        "chapters": [
            {"id": "act_1", "title": "门前的猫", "summary": "台风夜相遇", "beats": [
                {"id": "beat_act1_meet", "title": "门口的女孩", "summary": "程叙被妮可绊倒",
                 "content": "……", "must_keep": "妮可知道程叙姓名",
                 "branches": [{"label": "报警", "intent": "谨慎", "target_beat_id": "beat_act1_call"},
                              {"label": "让她进门", "intent": "接纳", "target_beat_id": "beat_act1_call"}]},
                {"id": "beat_act1_call", "title": "母亲的电话", "summary": "电话替妮可造身份", "content": "……"},
            ]},
            {"id": "act_5", "title": "三十九度", "summary": "高烧与事故", "beats": [
                {"id": "beat_act5_factory", "title": "工厂事故", "summary": "机器人自主行动",
                 "content": "……",
                 "combat": {"required": True, "description": "失控机器人堵住车间出口",
                            "enemies": ["失控巡检机器人", "不存在的敌人"], "band": "T2"}},
            ]},
        ],
    }
    llm = _ScriptedLLM("```json\n" + json.dumps(llm_doc, ensure_ascii=False) + "\n```")
    outline = so.generate_outline_with_llm(
        llm, meta, body, book=_fake_book(), worldbook_id="beyond-twin",
        available_enemies=["失控巡检机器人"])
    assert outline["source"] == "llm" and outline["generation"]["ok"]
    assert outline["reference_uids"][0] == "plots_fixture_plot_index"
    user_msg = llm.calls[0][1]["content"]
    assert "<reference_entries>" in user_msg and "穿灰色毛绒外套" in user_msg
    assert "失控巡检机器人" in user_msg
    ids = so.beat_ids(outline)
    assert ids == ["beat_act1_meet", "beat_act1_call", "beat_act5_factory"]
    combat = outline["chapters"][1]["beats"][0]["combat"]
    assert combat["required"] and combat["band"] == "T2" and combat["node_id"] == ""


def test_llm_outline_failure_falls_back_to_heuristic(plot_doc):
    meta, body = plot_doc
    outline = so.generate_outline_with_llm(_ScriptedLLM("这不是 JSON"), meta, body, worldbook_id="beyond-twin")
    assert outline["source"] == "heuristic"
    assert outline["generation"]["ok"] is False and "JSON" in outline["generation"]["error"]
    assert len(outline["chapters"]) == 4

    class _Boom:
        def chat(self, *a, **k):
            raise RuntimeError("LLM 挂了")

    outline = so.generate_outline_with_llm(_Boom(), meta, body)
    assert outline["generation"]["error"] == "LLM 挂了" and outline["source"] == "heuristic"


def test_append_branch_chapter_keeps_ids_unique(plot_doc):
    meta, body = plot_doc
    outline = so.heuristic_outline(meta, body)
    before = set(so.beat_ids(outline))
    ch = so.append_branch_chapter(outline, {
        "title": "妮可离家出走", "summary": "妮可独自去了澜晶",
        "beats": [{"title": "空房间", "summary": "程叙发现妮可不见了", "content": "……"},
                  {"title": "追到深湾", "summary": "程叙在办公区外遇上安保",
                   "combat": {"required": True, "description": "安保拦截", "enemies": [], "band": "T1"}}],
    }, round_num=9, from_node_id="n_abc", parent_beat_id="beat_act_1_1")
    assert ch["id"] == "dev_1" and ch["kind"] == "branch"
    assert ch["origin"] == {"type": "deviation", "round": 9, "from_node_id": "n_abc", "parent_beat_id": "beat_act_1_1"}
    assert [b["id"] for b in ch["beats"]] == ["beat_dev_1_1", "beat_dev_1_2"]
    assert before < set(so.beat_ids(outline))
    ch2 = so.append_branch_chapter(outline, {"title": "再偏一次"})
    assert ch2["id"] == "dev_2" and ch2["beats"][0]["id"] == "beat_dev_2_1"
