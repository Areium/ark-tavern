"""系统层条目：节点图 / 节点绑定既不是稳定层也不是动态层，永不注入。

口径（与 `world_book.is_system_entry` 同源）：
  * 不计入 `WorldBook.estimated_tokens()`，也不计入摘要里的条目 / token 数；
  * 不进 Prompt 预览的 `order`（本来就不注入），**也不进 `dropped`**
    （报「关键词未命中」会把作者引向「去补触发词」这个完全错误的方向）；
  * 全书预览（`all_entries`）同样排除，且不需要调用方自己挑 UID。

判定必须与承载模块自己的表保持一致 —— 本文件第一组用例直接比对
`plot_graphs` / `node_lore_scope` / `combat_nodes` 里的常量，任何一侧新增
类型而另一侧没跟上都会立刻失败。
"""
import copy
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import combat_nodes
import node_lore_scope
import plot_graphs
import story_outline
from world_book import (
    DEFAULT_CATEGORIES, SYSTEM_ENTRY_FENCES, SYSTEM_ENTRY_TYPES, WorldBook,
    WorldBookEntry, WorldBookManager, book_entry_stats, entry_layer,
    is_system_entry,
)
from worldbook_scope import ACTIVATION_ALWAYS, EXPANSION_NONE


# ── 1. 判定与承载模块的常量必须同步 ──

def test_system_entry_tables_match_the_owning_modules():
    """四张表（world_book / plot_graphs / node_lore_scope / story_outline）不允许各自漂移。"""
    assert set(SYSTEM_ENTRY_TYPES) == {plot_graphs._ENTRY_TYPE, node_lore_scope._ENTRY_TYPE,
                                       story_outline.ENTRY_TYPE}
    assert set(SYSTEM_ENTRY_FENCES) == {plot_graphs.WORLD_BOOK_FENCE,
                                        node_lore_scope.WORLD_BOOK_FENCE,
                                        story_outline.WORLD_BOOK_FENCE}
    # 战斗节点条目是**会注入**的（有关键词），绝不能滑进系统层。
    assert combat_nodes._ENTRY_TYPE not in SYSTEM_ENTRY_TYPES
    assert combat_nodes.WORLD_BOOK_FENCE not in SYSTEM_ENTRY_FENCES


def test_is_system_entry_recognises_marker_and_fence():
    marked = WorldBookEntry("g", "```json plot-graph\n{}\n```",
                            raw={"extensions": {"arknights_tavern": {"entry_type": "plot_graph"}}})
    fenced = WorldBookEntry("g2", "```json plot-graph\n{\"plot_id\":\"p\"}\n```")
    bindings = WorldBookEntry("b", "```json arknights_tavern_lore_bindings\n{}\n```")
    plain = WorldBookEntry("p", "泰拉世界：源石与天灾。")
    fake = WorldBookEntry("f", "正文里提到 plot-graph 这个词，但没有围栏块。")

    assert is_system_entry(marked) is True
    assert is_system_entry(fenced) is True, "围栏块兜底判定与 plot_graphs.is_graph_entry 一致"
    assert is_system_entry(bindings) is True
    assert is_system_entry(plain) is False
    assert is_system_entry(fake) is False, "只是提到名字不算承载节点图"
    # dict 形态（接口层 / 预览路径上会出现）同样要认
    assert is_system_entry(marked.to_dict()) is True
    assert is_system_entry(plain.to_dict()) is False


def test_entry_layer_separates_system_from_dynamic():
    """系统层条目也「非常驻」——只按位置分层会把它误报成动态层。"""
    stable = WorldBookEntry("s", "内容", always_active=True, position=0)
    dynamic = WorldBookEntry("d", "内容", always_active=False, position=1)
    system = WorldBookEntry("g", "```json plot-graph\n{}\n```")
    # 即便被改成常驻 + position 0，系统层仍然是系统层
    forced = WorldBookEntry("g2", "```json plot-graph\n{}\n```",
                            always_active=True, position=0)

    assert entry_layer(stable) == "stable"
    assert entry_layer(dynamic) == "dynamic"
    assert entry_layer(system) == "system"
    assert entry_layer(forced) == "system"


# ── 2. 统计口径 ──

def _entries():
    return [
        WorldBookEntry("world", "泰拉世界：源石与天灾。", name="世界设定",
                       always_active=True, position=0),
        WorldBookEntry("lore", "源石技艺的定义。", name="源石技艺",
                       always_active=True, position=1),
        WorldBookEntry("off", "停用条目。", name="停用条目", enabled=False),
        WorldBookEntry("g", "```json plot-graph\n{\"plot_id\":\"p\"}\n```", name="节点图：P",
                       trigger_keys=[], always_active=False),
        WorldBookEntry("b", "```json arknights_tavern_lore_bindings\n{}\n```", name="节点绑定：book",
                       trigger_keys=[], always_active=False),
    ]


def test_entry_stats_count_only_enabled_non_system_entries():
    stats = book_entry_stats(_entries())
    assert stats.total == 5
    assert stats.injectable == 2, "停用与系统层都不算「会注入的条目」"
    assert stats.disabled == 1
    assert stats.system == 2


def test_estimated_tokens_excludes_disabled_and_system_entries():
    """勾掉一条 / 加一张节点图，展示 token 必须跟着动 —— 两者都不注入。"""
    entries = _entries()
    book = WorldBook("book", "统计测试书", entries)
    stats = book_entry_stats(entries)

    assert book.estimated_tokens() == stats.tokens
    counts = book.entry_stats()
    assert (counts.total, counts.injectable, counts.disabled, counts.system) == (5, 2, 1, 2)
    assert counts.tokens == stats.tokens
    # 停用一条 → 变少；把系统层条目改成会注入的普通条目 → 变多
    entries[1].enabled = False
    assert book.estimated_tokens() < stats.tokens
    assert book.entry_stats().disabled == 2

    entries[3].raw = {}
    entries[3].content = "普通正文。"
    assert book.estimated_tokens() > 0
    assert book.entry_stats().system == 1


def test_book_character_roster_reads_entry_character_ids():
    """书内角色花名册 = 启用且非系统条目的 `character_id`（去重保序）。

    新建会话按它取「这本书的角色」做候选与自动选中；角色卡 frontmatter 的来源书可能是
    拆分前的 `arknights`，所以名单只能从条目上读。
    """
    book = WorldBook("book", "花名册测试书", [
        WorldBookEntry("a", "临光设定。", name="临光", character_id="临光"),
        WorldBookEntry("b", "瑕光设定。", name="瑕光", character_id="瑕光"),
        WorldBookEntry("a2", "临光重复条目。", name="临光重复", character_id="临光"),
        WorldBookEntry("off", "停用角色条目。", name="停用角色", character_id="停用角色", enabled=False),
        WorldBookEntry("g", "```json plot-graph\n{\"plot_id\":\"p\"}\n```", name="节点图：P",
                       trigger_keys=[], always_active=False),
        WorldBookEntry("plain", "普通世界观条目。", name="世界观"),
    ])

    assert book.character_ids() == ["临光", "瑕光"], "停用条目、系统层条目与空 character_id 都不算"


def test_summary_exposes_book_character_roster(tmp_path):
    """摘要里带上花名册：前端靠它判断「这本书有哪些角色」，不必自己遍历条目。"""
    manager = WorldBookManager(tmp_path)
    manager.save(WorldBook("book", "花名册测试书", [
        WorldBookEntry("a", "临光设定。", name="临光", character_id="临光"),
        WorldBookEntry("b", "瑕光设定。", name="瑕光", character_id="瑕光"),
    ], book_type="story"))

    summary = next(book for book in manager.list_books() if book["id"] == "book")
    assert summary["character_ids"] == ["临光", "瑕光"]


def test_full_scope_compatibility_also_skips_system_entries():
    """「显式全量兼容」放宽的是候选，不是把永不注入的系统层条目也算进去。

    `full_scope_uids` 是 full_scope 语义的唯一真源（预览 / scope-preview / 会话快照
    共用），因此这里排掉一次，三处口径同时正确。
    """
    book = WorldBook("book", "全量测试书", _entries())
    assert book.full_scope_uids() == ["lore", "world"], "系统层与停用条目都不在「全量」里"
    # 停用条目也不该出现在全量候选里（与 _full_scope_entries 的既有口径一致）
    for entry in book.entries:
        entry.enabled = True
    assert book.full_scope_uids() == ["lore", "off", "world"]


# ── 3. 接口：摘要 / 详情与预览 ──

@pytest.fixture
def api(tmp_path):
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    root = {"entry_uid": "world", "activation": ACTIVATION_ALWAYS,
            "expansion": EXPANSION_NONE, "character_ids": []}
    book = WorldBook("book", "系统层测试书", _entries(),
                     categories=copy.deepcopy(DEFAULT_CATEGORIES),
                     related_edges=[],
                     dependency_rules={"roots": [root],
                                       "root_rule": {"entry_uids": ["world"]},
                                       "rejected": [], "edge_meta": {}},
                     scope_mode="selective")
    manager.save(book)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    return app.test_client(), manager, tmp_path


def test_summary_and_detail_expose_the_same_split(api):
    client, _, _ = api
    summary = client.get("/api/worldbook").json["books"][0]
    detail = client.get("/api/worldbook/book").json

    for payload in (summary, detail):
        assert payload["entry_count"] == 5, "总数含系统层，界面用它显示「/ 共 N」"
        assert payload["injectable_entry_count"] == 2
        assert payload["disabled_entry_count"] == 1
        assert payload["system_entry_count"] == 2
    assert summary["estimated_tokens"] == detail["estimated_tokens"]


def _preview(client, **body):
    body.setdefault("mode", "narrative")
    response = client.post("/api/worldbook/book/prompt-preview", json=body)
    assert response.status_code == 200, response.json
    return response.json


def test_single_turn_preview_never_reports_system_entries(api):
    """系统层条目不出现在 order，也不出现在 dropped（它们不是「未命中关键词」）。"""
    client, _, _ = api
    payload = _preview(client, input_text="泰拉", recent_text="")
    uids = {item["uid"] for item in payload["order"]}
    dropped = {item["uid"] for item in payload["dropped"]}

    assert "g" not in uids and "b" not in uids
    assert "g" not in dropped and "b" not in dropped
    # 停用条目仍要如实报告 —— 排除的只是系统层这一类
    assert "off" in dropped


def test_all_entries_preview_excludes_system_entries_without_a_hint(api):
    """全书预览不再需要调用方自己挑 lore_bindings：两种系统层条目都必须排除。"""
    client, _, _ = api
    payload = _preview(client, all_entries=True, input_text="", recent_text="")
    uids = {item["uid"] for item in payload["order"]}
    assert uids == {"world", "lore"}
    assert {item["uid"] for item in payload["dropped"]} == {"off"}
    assert "plot-graph" not in payload["stable_text"] + payload["dynamic_text"]
    assert "lore_bindings" not in payload["stable_text"] + payload["dynamic_text"]


def test_scope_preview_full_scope_agrees_with_the_single_turn_preview(api):
    """「全量兼容」下的候选数在三处必须一致：scope-preview / 单轮预览 / 摘要口径。

    系统层条目既不进候选也不进 token —— 三处都用 `full_scope_uids()`，一处排掉即可。
    """
    client, _, _ = api
    scope = client.post("/api/worldbook/book/scope-preview",
                        json={"roster_character_ids": [], "full_scope": True})
    assert scope.status_code == 200, scope.json
    body = scope.json
    assert body["full_entry_count"] == 2, "world + lore；节点图 / 节点绑定不算"
    assert body["entry_count"] == 2

    payload = _preview(client, input_text="", recent_text="", full_scope=True)
    assert payload["totals"]["candidate_count"] == body["entry_count"]
