"""条目依赖子树接口（A-3 / §3.3）：必须与 resolve_v3_scope 的同一段 BFS 同源。

接口走真实代码：`GET /api/worldbook/<id>/dependency-tree` → `resolve_v3_scope`
（起点由查询参数合成）+ `_dependency_cycles`；对照组是 `POST /scope-preview`。
"""
import copy
import hashlib
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager
from worldbook_scope import (
    ACTIVATION_ALWAYS, EXPANSION_REQUIRES_CLOSURE,
)


def entry(uid, **kwargs):
    kwargs.setdefault("content", f"{uid} 的正文内容。")
    kwargs.setdefault("name", uid)
    kwargs.setdefault("category_id", "other")
    kwargs.setdefault("always_active", True)
    kwargs.setdefault("position", 1)
    return WorldBookEntry(uid, **kwargs)


def book_fixture(requires, related=(), roots=None):
    """按 (requires, related) 构造一本 v3 书；默认起点是 `a`（always + requires_closure）。"""
    uids = sorted({u for pair in list(requires) + list(related) for u in pair})
    entries = [entry(uid) for uid in uids]
    if roots is None:
        roots = [{"entry_uid": uids[0], "activation": ACTIVATION_ALWAYS,
                  "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": []}]
    return WorldBook(
        "book", "依赖树测试书", entries, categories=copy.deepcopy(DEFAULT_CATEGORIES),
        dependency_edges=[{"from_uid": a, "to_uid": b} for a, b in requires],
        related_edges=[{"from_uid": a, "to_uid": b} for a, b in related],
        dependency_rules={"roots": roots,
                          "root_rule": {"entry_uids": [r["entry_uid"] for r in roots]},
                          },
        scope_mode="selective",
    )


@pytest.fixture
def make_api(tmp_path):
    """工厂：把一本书写进临时目录并返回 (client, manager, tmp_path)。"""
    from blueprints.worldbook import register

    def build(book):
        manager = WorldBookManager(tmp_path)
        manager.save(book)
        app = Flask(__name__)
        app.config["TESTING"] = True
        register(app, {"worldbook": manager})
        return app.test_client(), manager, tmp_path

    return build


def tree_of(client, entry_uids):
    url = "/api/worldbook/book/dependency-tree?entry_uids=" + ",".join(entry_uids)
    response = client.get(url)
    assert response.status_code == 200, response.json
    return response.json


def edge_status(payload, a, b):
    for edge in payload["edges"]:
        if edge["from_uid"] == a and edge["to_uid"] == b:
            return edge["status"]
    return None


def node_uids(payload):
    return [node["uid"] for node in payload["nodes"]]


# ── 1. 与 display_tree 同构 ──

def test_nodes_are_isomorphic_with_scope_preview_display_tree(make_api):
    """同一份规则下，dependency-tree 的 nodes[] 与 scope-preview 的 display_tree 逐字段一致。"""
    client, _, _ = make_api(book_fixture([("a", "b"), ("b", "c")], related=[("a", "d")]))
    tree = tree_of(client, ["a"])
    scope = client.post("/api/worldbook/book/scope-preview", json={})
    assert scope.status_code == 200, scope.json
    display = scope.json["display_tree"]
    assert [n["uid"] for n in tree["nodes"]] == [n["uid"] for n in display]
    for node, expected in zip(tree["nodes"], display):
        # nodes[] 是 display_tree 的**投影**：契约冻结的 7 个节点字段逐字段一致，另补 relation
        assert set(node) == {"uid", "name", "parent_uid", "child_uids", "depth",
                             "is_root", "relation"}
        assert {k: node[k] for k in node if k != "relation"} == {
            k: expected[k] for k in node if k != "relation"}
        assert node["relation"] == "requires"
    # 边状态也同源：闭包内的 requires 边与 resolved_edges 的 (from,to,status) 一致
    resolved = {(e["from_uid"], e["to_uid"]): e["status"]
                for e in scope.json["resolved_edges"]
                if e["from_uid"] in {n["uid"] for n in display}}
    for edge in tree["edges"]:
        assert edge["status"] == resolved[(edge["from_uid"], edge["to_uid"])]
    assert tree["entry_uids"] == ["a"]
    assert tree["book_id"] == "book"


def test_derived_fields_are_consistent_with_depth_uid_order(make_api):
    """R-10：`display_tree` 的 repeated / first_parent_uid / display_index 口径。

    多源到达（两个起点指向同一节点）与菱形依赖下 `repeated` 为真，单链下为假；
    `display_index` 与 `(depth, uid)` 稳定排序一致；`first_parent_uid` 等于 `parent_uid`。

    这三个派生字段挂在 `display_tree` 上（`WorldBookDisplayNodeDTO`，由 scope-preview / 
    节点视图消费）；依赖树接口的 `nodes[]` 按冻结契约只暴露 7 个节点字段 + `relation`，
    因此这里用同一起点集合的 scope-preview 断言派生字段，再断言依赖树的 `nodes[]`
    是同一份 `display_tree` 的投影 —— 两者必须来自同一段 BFS。
    """
    roots = [{"entry_uid": uid, "activation": ACTIVATION_ALWAYS,
              "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": []}
             for uid in ("a", "z")]
    client, _, _ = make_api(book_fixture(
        [("a", "shared"), ("z", "shared"), ("shared", "leaf"),
         ("a", "x"), ("a", "y"), ("x", "z2"), ("y", "z2")], roots=roots))
    response = client.post("/api/worldbook/book/scope-preview", json={})
    assert response.status_code == 200, response.json
    display = response.json["display_tree"]
    by_uid = {node["uid"]: node for node in display}
    assert by_uid["shared"]["repeated"] is True        # 多源到达
    assert by_uid["z2"]["repeated"] is True            # 菱形依赖
    assert by_uid["leaf"]["repeated"] is False         # 单链
    assert by_uid["a"]["repeated"] is False            # 起点无入边
    assert by_uid["a"]["first_parent_uid"] is None
    assert all(node["first_parent_uid"] == node["parent_uid"] for node in display)
    assert [node["display_index"] for node in display] == list(range(len(display)))
    assert [node["uid"] for node in display] == [
        node["uid"] for node in sorted(display, key=lambda n: (n["depth"], n["uid"]))]

    # 依赖树端点用同一起点集合时，nodes[] 就是这份 display_tree 的投影
    tree = tree_of(client, ["a", "z"])
    assert [(n["uid"], n["parent_uid"], n["depth"], n["is_root"])
            for n in tree["nodes"]] == [(n["uid"], n["parent_uid"], n["depth"],
                                         n["is_root"]) for n in display]
    # 同一份请求重复发起结果完全相同（确定性）
    assert tree_of(client, ["a", "z"]) == tree


def test_single_chain_has_no_repeated_nodes(make_api):
    """单链 a → b → c：没有任何 uid 有两条入边（`display_tree.repeated` 全为假）。"""
    client, _, _ = make_api(book_fixture([("a", "b"), ("b", "c")]))
    tree = tree_of(client, ["a"])
    assert node_uids(tree) == ["a", "b", "c"]
    display = client.post("/api/worldbook/book/scope-preview", json={}).json["display_tree"]
    assert all(node["repeated"] is False for node in display)
    assert all(node["first_parent_uid"] == node["parent_uid"] for node in display)


# ── 2. 多源闭包与主路径 ──

def test_multi_arrival_uses_stable_shortest_display_path(make_api):
    """同一节点被长短两路到达时只显示一次，并采用先到的最短展示路径。"""
    client, _, _ = make_api(book_fixture([("a", "m"), ("m", "n"), ("a", "n")]))
    tree = tree_of(client, ["a"])
    node = next(n for n in tree["nodes"] if n["uid"] == "n")
    assert node["depth"] == 1
    assert node["parent_uid"] == "a"
    assert edge_status(tree, "a", "n") == "skeleton"
    assert edge_status(tree, "m", "n") == "cross"   # 边生效但目标已被更强的到达覆盖


# ── 3. 环终止与 cycles 格式 ──

def test_cycle_terminates_and_reports_cycle_in_r26_format(make_api):
    """a → b → a 不超时、nodes 有限，cycles 按 R-26 记录（首尾同一 uid）。"""
    client, _, _ = make_api(book_fixture([("a", "b"), ("b", "a")]))
    tree = tree_of(client, ["a"])
    assert sorted(node_uids(tree)) == ["a", "b"]     # 环上节点各出现一次，闭包有限
    assert len(tree["cycles"]) == 1
    cycle = tree["cycles"][0]
    assert cycle[0] == cycle[-1]                     # 首尾同一 uid
    assert sorted(set(cycle)) == ["a", "b"]
    assert len(cycle) == 3
    # 环内边按相邻对推出：两条边都真实存在
    pairs = {(cycle[i], cycle[i + 1]) for i in range(len(cycle) - 1)}
    assert pairs == {("a", "b"), ("b", "a")}
    assert {frozenset(pair) for pair in pairs} == {frozenset(("a", "b"))}


def test_self_loop_is_reported_as_two_identical_uids(make_api):
    """自环产出 `["x","x"]`（v3 校验器禁自环，这里按 R-26 格式做防御性断言）。"""
    from blueprints.worldbook import _dependency_cycles
    assert _dependency_cycles({"x"}, [{"from_uid": "x", "to_uid": "x"}]) == [["x", "x"]]
    assert _dependency_cycles({"a", "b"}, [{"from_uid": "a", "to_uid": "b"}]) == []


def test_cycle_closure_terminates_and_reports_the_full_cycle(make_api):
    """requires 闭包完整包含环后仍有限终止，并报告该环。"""
    client, _, _ = make_api(book_fixture([("a", "b"), ("b", "c"), ("c", "a")]))
    tree = tree_of(client, ["a"])
    assert node_uids(tree) == ["a", "b", "c"]
    assert len(tree["cycles"]) == 1


# ── 4. related 不参与展开 ──

def test_related_edges_never_expand_but_stay_in_edges(make_api):
    """只有 related 边的目标不进 nodes[]；但 from_uid 在闭包内时仍出现在 edges[]。"""
    client, _, _ = make_api(book_fixture([("a", "b")], related=[("a", "aside"), ("b", "b2")]))
    tree = tree_of(client, ["a"])
    assert node_uids(tree) == ["a", "b"]
    assert "aside" not in node_uids(tree) and "b2" not in node_uids(tree)
    related = [e for e in tree["edges"] if e["relation"] == "related"]
    assert related == [{"from_uid": "a", "to_uid": "aside", "relation": "related",
                        "status": "idle"},
                       {"from_uid": "b", "to_uid": "b2", "relation": "related",
                        "status": "idle"}]
    # b 虽然在闭包里，但 b → b2 是 related：仍保留、仍 idle，且不展开 b2
    assert "b2" not in node_uids(tree)
    assert all(node["relation"] == "requires" for node in tree["nodes"])


def test_edges_are_never_dangling_from_outside_closure(make_api):
    """与所选 UID 无关的边不返回（R-25 只保留 from_uid 在闭包内的边）。"""
    client, _, _ = make_api(book_fixture([("a", "b"), ("b", "c"), ("c", "d")]))
    tree = tree_of(client, ["a"])
    assert node_uids(tree) == ["a", "b", "c", "d"]
    assert [e["from_uid"] for e in tree["edges"]] == ["a", "b", "c"]
    assert all(e["from_uid"] in set(node_uids(tree)) for e in tree["edges"])


# ── 6. 参数校验与只读 ──

def test_missing_or_unknown_entry_uids_return_400_without_writing(make_api):
    """entry_uids 为空 / 全是无效 uid → 400，且不写盘。"""
    client, _, tmp_path = make_api(book_fixture([("a", "b")]))
    path = Path(tmp_path) / "books" / "book.json"
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    for url in ("/api/worldbook/book/dependency-tree",
                "/api/worldbook/book/dependency-tree?entry_uids=",
                "/api/worldbook/book/dependency-tree?entry_uids=,,",
                "/api/worldbook/book/dependency-tree?entry_uids=ghost,phantom"):
        response = client.get(url)
        assert response.status_code == 400, url
        assert "entry_uids" in response.json["error"]
    # 混入无效 uid 时只保留真实的（去空、去重、保持请求顺序）
    mixed = tree_of(client, ["b", "ghost", "b", "a"])
    assert mixed["entry_uids"] == ["b", "a"]
    assert sorted(node_uids(mixed)) == ["a", "b"]
    assert (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns) == before


def test_issues_are_forwarded_from_scope_resolution(make_api):
    """issues 直接用 resolve_v3_scope 的结果（停用 / 空正文可解释）。"""
    book = book_fixture([("a", "b")])
    book.entries[1] = entry("b", content="   ")
    client, _, _ = make_api(book)
    tree = tree_of(client, ["a"])
    assert [issue["code"] for issue in tree["issues"]] == ["empty_content"]
    assert tree["issues"][0]["uid"] == "b"
