"""节点图与世界书归属：plot_flows 解析、node_graph 过滤、导入自动标注。

使用仓库内真实数据（data/worldbooks/content/plots、data/worldbooks/content/combat/nodes
已按通用资料、风雪过境与战斗测试分别标注归属），
除 import 打标测试外不写盘。
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import combat_nodes  # noqa: E402
from combat_nodes import (  # noqa: E402
    decode_worldbook_entry, encode_node_for_worldbook,
    import_worldbook_nodes, node_graph, node_overview, plot_flows,
)

BOOK = "arknights"
PLOT_BOOKS = {
    "combat-test": "combat-test",
    "fengxue_guojing": "fengxue-guojing",
    "near-light": "near-light",
    # 6d967c6 新增剧情（frontmatter worldbook_id: beyond-twin）时漏登记，导致本用例 KeyError
    "beyond_twin": "beyond-twin",
    "grey_lantern": "grey-lantern",
}


# ── plot_flows：剧情流程解析 ──

def test_plot_flows_use_directory_plot_id():
    flows = {f["plot_id"]: f for f in plot_flows()}
    # plot_id 与 node_bindings / 会话一致：用目录名而非 frontmatter id
    assert "fengxue_guojing" in flows
    assert "near-light" in flows


def test_plot_flows_collect_chapters_beats_and_combat_refs():
    flows = {f["plot_id"]: f for f in plot_flows()}
    feng = flows["fengxue_guojing"]
    assert len(feng["chapters"]) == 6
    beats = [b for c in feng["chapters"] for b in c["beats"]]
    assert len(beats) == 21
    # [COMBAT:] 引用挂在节拍上
    beat_refs = {nid for b in beats for nid in b["combat_nodes"]}
    assert "enc_snow_convoy" in beat_refs
    # 节拍摘要是首行非标记文本
    assert any(b["summary"] for b in beats)


def test_plot_flows_stop_at_narrative_section_end():
    """near-light 场景流程图配置区里的重复章节不应被收集。"""
    flows = {f["plot_id"]: f for f in plot_flows()}
    nl = flows["near-light"]
    assert [c["idx"] for c in nl["chapters"]] == [1, 2, 3, 4]


def test_plot_flows_orphan_combat_refs_at_plot_level():
    """无标准节拍结构的剧情（combat-test）→ 引用挂 plot 级。"""
    flows = {f["plot_id"]: f for f in plot_flows()}
    ct = flows["combat-test"]
    assert ct["chapters"] == []
    assert "enc_quick_test_1" in ct["combat_nodes"]


def test_plot_flows_worldbook_stamp():
    for f in plot_flows():
        assert f["worldbook_id"] == PLOT_BOOKS[f["plot_id"]]


def test_plot_flows_narrative_chapters_carry_label_and_kind():
    flows = {f["plot_id"]: f for f in plot_flows()}
    feng = flows["fengxue_guojing"]
    assert feng["source"] == "narrative"
    first = feng["chapters"][0]
    assert first["id"] == "ch_1" and first["kind"] == "main"
    assert first["label"] == f"章节 1：{first['title']}"
    # 正文 `#### beat_id` 骨架没有标题：title 为空串，前端退回 beat id
    assert first["beats"][0]["title"] == ""


def test_plot_flows_guardrail_plot_falls_back_to_outline():
    """彼岸双生没有 `## 章节 N` 骨架：章节来自参考大纲（启发式切幕），
    否则「从剧情结构生成布局」只会画出一个剧情入口节点。"""
    flows = {f["plot_id"]: f for f in plot_flows()}
    bt = flows["beyond_twin"]
    assert bt["source"] == "outline"
    mains = [c for c in bt["chapters"] if c["kind"] == "main"]
    routes = [c for c in bt["chapters"] if c["kind"] == "branch"]
    assert [c["label"] for c in mains][:2] == ["第一幕：门前的猫", "第二幕：被浪费的下午"]
    assert [c["label"] for c in routes] == ["路线 A：回应", "路线 B：追查澜晶", "路线 C：寻找林奈", "路线 D：让她回家"]
    assert [c["idx"] for c in bt["chapters"]] == list(range(1, 12))
    beat = mains[0]["beats"][0]
    assert beat["id"] == "beat_act_1_1" and beat["title"] == "门前的猫" and beat["summary"]
    assert beat["keep_on_deviate"] is True
    # combat-test 既无章节骨架也无「第N幕」：保持无章节，不被误切
    assert flows["combat-test"]["chapters"] == [] and flows["combat-test"]["source"] == "narrative"


def test_plot_flows_prefers_saved_outline_and_bound_nodes(monkeypatch):
    """书里已生成的 LLM 大纲优先于启发式切幕；节点文件 bind 到大纲节拍的战斗节点作为引用挂上。"""
    import story_outline as so

    saved = {
        "schema_version": 1, "plot_id": "beyond_twin", "title": "彼岸双生", "source": "llm",
        "chapters": [
            {"id": "act_1", "title": "门前的猫", "beats": [
                {"id": "beat_act1_meet", "title": "门口的女孩", "summary": "程叙被绊倒",
                 "combat": {"required": True, "node_id": "enc_llm_made"}}]},
            {"id": "dev_1", "title": "妮可离家出走", "kind": "branch",
             "origin": {"type": "deviation", "round": 9},
             "beats": [{"id": "beat_dev_1_1", "title": "空房间", "summary": "妮可不见了"}]},
        ],
    }

    class _Mgr:
        pass

    monkeypatch.setattr(so, "load_outline",
                        lambda mgr, book_id, plot_id: saved if plot_id == "beyond_twin" else None)
    monkeypatch.setattr(combat_nodes, "list_node_files", lambda: [Path("enc_bound.json")])
    monkeypatch.setattr(combat_nodes, "load_node_file", lambda stem: {
        "node_id": "enc_bound", "bind": {"plot_id": "beyond_twin", "beat_id": "beat_dev_1_1"}})
    flows = {f["plot_id"]: f for f in plot_flows(_Mgr())}
    bt = flows["beyond_twin"]
    assert bt["source"] == "outline"
    assert [c["label"] for c in bt["chapters"]] == ["第一幕：门前的猫", "偏离分支 A：妮可离家出走"]
    assert bt["chapters"][0]["beats"][0]["combat_nodes"] == ["enc_llm_made"]
    assert bt["chapters"][1]["beats"][0]["combat_nodes"] == ["enc_bound"]
    # 传入 book_mgr 不影响正文骨架剧情
    assert flows["fengxue_guojing"]["source"] == "narrative"


# ── node_overview / node_graph：按世界书过滤 ──

def test_node_overview_books_own_their_current_nodes():
    rows, _meta = node_overview(book_id=BOOK)
    assert len(rows) == 5
    assert all(r["worldbook_id"] == BOOK for r in rows)
    combat_rows, _ = node_overview(book_id="combat-test")
    snow_rows, _ = node_overview(book_id="fengxue-guojing")
    assert len(combat_rows) == 3 and len(snow_rows) == 8


def test_node_overview_filters_foreign_book():
    rows, _meta = node_overview(book_id="不存在的书")
    assert rows == []


def test_node_overview_unfiltered_returns_all():
    unfiltered, _ = node_overview()
    assert len(unfiltered) == 19
    assert {n["node_id"] for n in unfiltered if n.get("worldbook_id") == "grey-lantern"} == {
        "enc_grey_checkpoint", "enc_grey_warehouse", "enc_grey_bridge",
    }


def test_node_graph_includes_referenced_plots():
    combat = node_graph("combat-test")
    snow = node_graph("fengxue-guojing")
    near = node_graph("near-light")
    assert {p["plot_id"] for p in combat["plots"]} == {"combat-test"}
    assert {p["plot_id"] for p in snow["plots"]} == {"fengxue_guojing"}
    assert {p["plot_id"] for p in near["plots"]} == {"near-light"}
    assert "enc_quick_test_1" in {n["node_id"] for n in combat["nodes"]}
    assert "enc_snow_convoy" in {n["node_id"] for n in snow["nodes"]}


# ── 世界书导入：节点自动标注归属 ──

@pytest.fixture()
def no_write(monkeypatch):
    """拦截 save_node 落盘，捕获导入时写入的节点数据。"""
    captured: dict = {}

    def fake_save_node(data, expected_hash="", *, enemy_names=None):
        captured[data["node_id"]] = data
        return data

    monkeypatch.setattr(combat_nodes, "save_node", fake_save_node)
    return captured


def test_import_worldbook_nodes_stamps_worldbook_id(no_write):
    node = {
        "node_id": "enc_wb_import", "name": "导入测试",
        "map": {"rows": 5, "cols": 5, "tiles": "ground",
                "deploy": {"player": {"rect": [0, 0, 4, 0]}, "enemy": {"rect": [0, 4, 4, 4]}}},
        "waves": [{"enemies": [{"enemy": "整合运动士兵", "count": 1, "positions": [[2, 4]]}]}],
    }
    entry = encode_node_for_worldbook(node)
    assert decode_worldbook_entry(entry)["node_id"] == "enc_wb_import"

    result = import_worldbook_nodes([entry], book_id=BOOK)
    assert result["errors"] == []
    assert result["imported"] == [{"node_id": "enc_wb_import", "book_id": BOOK}]
    stamped = no_write["enc_wb_import"]
    assert stamped["worldbook_id"] == BOOK
    assert stamped["source"] == {"type": "worldbook", "book_id": BOOK, "entry_uid": entry["uid"]}
