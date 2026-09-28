"""v3 依赖图解析：条件起点、requires 闭包、related 不扩张、环终止与可解释问题。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from worldbook_scope import (
    ACTIVATION_ALWAYS, ACTIVATION_MANUAL, ACTIVATION_ROSTER_ANY,
    EXPANSION_NONE, EXPANSION_REQUIRES_CLOSURE,
    resolve_v3_scope, validate_v3_rules,
)


class E:
    """最小条目替身：只需要 resolve_v3_scope 读取的字段。"""

    def __init__(self, uid, name="", enabled=True, content=None):
        self.uid = uid
        self.name = name or uid
        self.enabled = enabled
        self.content = f"content-{uid}" if content is None else content


def resolve(entries, roots, requires=(), related=(), roster=(), **kwargs):
    rules, req, rel = validate_v3_rules({e.uid for e in entries}, {
        "roots": roots,
        "requires_edges": [{"from_uid": a, "to_uid": b} for a, b in requires],
        "related_edges": [{"from_uid": a, "to_uid": b} for a, b in related],
    })
    return resolve_v3_scope(entries, rules, req, rel, roster_character_ids=list(roster), **kwargs)


def always(uid, expansion=EXPANSION_REQUIRES_CLOSURE, **kw):
    return {"entry_uid": uid, "activation": ACTIVATION_ALWAYS, "expansion": expansion, **kw}


def roster_root(uid, chars, expansion=EXPANSION_REQUIRES_CLOSURE):
    return {"entry_uid": uid, "activation": ACTIVATION_ROSTER_ANY,
            "expansion": expansion, "character_ids": list(chars)}


def test_single_character_does_not_activate_other_characters():
    """入队 A 只带出 A 自己的起点与它 requires 的内容，不激活 B 的整组。"""
    entries = [E("base"), E("a1"), E("a2"), E("b1"), E("b2")]
    result = resolve(
        entries,
        [always("base"), roster_root("a1", ["A"]), roster_root("b1", ["B"])],
        requires=[("a1", "a2"), ("b1", "b2")],
        roster=["A"],
    )
    assert set(result["resolved_entry_uids"]) == {"base", "a1", "a2"}
    assert "b1" not in result["resolved_entry_uids"]
    assert "b2" not in result["resolved_entry_uids"]
    assert result["selection_reasons"]["a2"] == ["requires"]
    assert result["selection_reasons"]["a1"] == ["roster:A"]


def test_dependency_pull_does_not_activate_that_characters_whole_group():
    """被依赖带入某个未入队角色的条目，不因此激活那位角色的整组条目。"""
    entries = [E("base"), E("a1"), E("b_bio"), E("b_secret"), E("b_group")]
    result = resolve(
        entries,
        [always("base"), roster_root("a1", ["A"]), roster_root("b_secret", ["B"])],
        requires=[("base", "b_bio"), ("b_secret", "b_group")],
        roster=["A"],
    )
    assert "b_bio" in result["resolved_entry_uids"]        # 作为依赖被补齐
    assert "b_secret" not in result["resolved_entry_uids"]  # 但不激活 B 的起点
    assert "b_group" not in result["resolved_entry_uids"]   # 也不带出 B 的整组
    assert result["selection_reasons"]["b_bio"] == ["requires"]


def test_shared_dependency_selected_once_and_leaving_roster_keeps_it():
    """共享依赖只选一次；移除某角色不会删掉另一角色仍然需要的内容。"""
    entries = [E("a1"), E("b1"), E("shared")]
    roots = [roster_root("a1", ["A"]), roster_root("b1", ["B"])]
    requires = [("a1", "shared"), ("b1", "shared")]

    both = resolve(entries, roots, requires=requires, roster=["A", "B"])
    assert both["resolved_entry_uids"].count("shared") == 1

    only_b = resolve(entries, roots, requires=requires, roster=["B"])
    assert set(only_b["resolved_entry_uids"]) == {"b1", "shared"}
    assert only_b["selection_reasons"]["shared"] == ["requires"]


def test_related_edges_never_expand_the_closure():
    """related 只浏览：不参与遍历，也不改变候选。"""
    entries = [E("root"), E("related_only"), E("requires_one")]
    result = resolve(
        entries,
        [always("root")],
        requires=[("root", "requires_one")],
        related=[("root", "related_only"), ("requires_one", "related_only")],
    )
    assert set(result["resolved_entry_uids"]) == {"root", "requires_one"}
    assert "related_only" not in result["resolved_entry_uids"]
    relations = {(e["from_uid"], e["to_uid"]): e["relation"] for e in result["resolved_edges"]}
    assert relations[("root", "related_only")] == "related"
    assert relations[("root", "requires_one")] == "requires"


def test_cycle_terminates_and_reports_cross_reference():
    entries = [E("a"), E("b"), E("c")]
    result = resolve(entries, [always("a")], requires=[("a", "b"), ("b", "c"), ("c", "a")])
    assert set(result["resolved_entry_uids"]) == {"a", "b", "c"}
    assert result["cross_references"] == [{"from_uid": "c", "to_uid": "a"}]
    # 树上每个节点恰好有一个父（环上不再重复挂载）
    parents = [n["parent_uid"] for n in result["display_tree"] if n["parent_uid"]]
    assert sorted(parents) == ["a", "b"]


def test_expansion_none_and_requires_closure():
    entries = [E("x"), E("y"), E("z")]
    requires = [("x", "y"), ("y", "z")]

    none = resolve(entries, [always("x", EXPANSION_NONE)], requires=requires)
    assert set(none["resolved_entry_uids"]) == {"x"}

    closure = resolve(entries, [always("x", EXPANSION_REQUIRES_CLOSURE)], requires=requires)
    assert set(closure["resolved_entry_uids"]) == {"x", "y", "z"}


def test_requires_closure_is_not_silently_truncated():
    """新必要闭包不按深度截断：链路任意长也完整展开。"""
    length = 60
    entries = [E(f"n{i}") for i in range(length)]
    requires = [(f"n{i}", f"n{i + 1}") for i in range(length - 1)]
    result = resolve(entries, [always("n0")], requires=requires)
    assert len(result["resolved_entry_uids"]) == length
    assert result["issues"] == []


def test_oversized_closure_reports_error_instead_of_truncating(monkeypatch):
    """超限时给出结构化问题并放弃解析，而不是悄悄截断成"看起来完整"。"""
    import worldbook_scope as module
    monkeypatch.setattr(module, "MAX_CLOSURE_NODES", 5)
    entries = [E(f"n{i}") for i in range(10)]
    requires = [(f"n{i}", f"n{i + 1}") for i in range(9)]
    rules, req, rel = validate_v3_rules(
        {e.uid for e in entries},
        {"roots": [always("n0")],
         "requires_edges": [{"from_uid": a, "to_uid": b} for a, b in requires]})
    result = module.resolve_v3_scope(entries, rules, req, rel)
    assert result["resolved_entry_uids"] == []
    assert result["issues"][0]["code"] == "closure_too_large"
    assert result["issues"][0]["severity"] == "error"


def test_manual_roots_are_never_auto_activated():
    entries = [E("auto"), E("manual_only")]
    result = resolve(entries, [always("auto"), {"entry_uid": "manual_only",
                                                "activation": ACTIVATION_MANUAL,
                                                "expansion": EXPANSION_REQUIRES_CLOSURE}])
    assert result["resolved_entry_uids"] == ["auto"]
    assert result["active_roots"] == [
        {"entry_uid": "auto", "activation": ACTIVATION_ALWAYS,
         "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": []}]


def test_disabled_and_empty_entries_are_reported_not_silently_complete():
    entries = [E("root"), E("off", enabled=False), E("blank", content="   ")]
    result = resolve(entries, [always("root")], requires=[("root", "off"), ("root", "blank")])
    codes = {i["code"]: i["uid"] for i in result["issues"]}
    assert codes["disabled_entry"] == "off"
    assert codes["empty_content"] == "blank"
    # 候选仍保留它们，由注入层按停用/空正文过滤——问题必须可解释
    assert "off" in result["resolved_entry_uids"]


def test_display_tree_has_single_root_per_branch_and_is_deterministic():
    entries = [E("r1"), E("r2"), E("shared"), E("leaf")]
    roots = [always("r1"), always("r2")]
    requires = [("r1", "shared"), ("r2", "shared"), ("shared", "leaf")]
    first = resolve(entries, roots, requires=requires)
    second = resolve(entries, roots, requires=requires)
    assert first["display_tree"] == second["display_tree"]
    assert [n["uid"] for n in first["display_tree"]].count("shared") == 1
    node = next(n for n in first["display_tree"] if n["uid"] == "shared")
    assert node["is_root"] is False and node["depth"] == 1
    assert node["root_uid"] in ("r1", "r2")
    # 子节点挂在唯一的父上
    assert node["child_uids"] == ["leaf"]


@pytest.mark.parametrize("bad", [
    {"roots": [{"entry_uid": "missing", "activation": ACTIVATION_ALWAYS}]},
    {"roots": [{"entry_uid": "a", "activation": "sometimes"}]},
    {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS, "expansion": "deep"}]},
    {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ROSTER_ANY}]},
    {"roots": [{"entry_uid": "a", "activation": ACTIVATION_ALWAYS, "character_ids": ["A"]}]},
    {"roots": [always("a"), always("a")]},
    {"roots": [always("a", "unsupported_expansion")]},
    {"roots": [always("a")], "requires_edges": [{"from_uid": "a", "to_uid": "a"}]},
    {"roots": [always("a")], "requires_edges": [{"from_uid": "a", "to_uid": "missing"}]},
    {"roots": [always("a")], "requires_edges": [{"from_uid": "a", "to_uid": "b"}] * 2},
    {"roots": [always("a")], "requires_edges": [{"from_uid": "a", "to_uid": "b"}],
     "related_edges": [{"from_uid": "a", "to_uid": "b"}]},
    {"roots": [always("a")], "root_rule": {"entry_uids": ["missing"]}},
    [],
])
def test_v3_validation_rejects_bad_shapes(bad):
    with pytest.raises(ValueError):
        validate_v3_rules({"a", "b"}, bad)


# ── 读时派生字段（提案 §3.4.5 / §4.2；既有字段与语义不变）──

def statuses(result):
    return {(e["from_uid"], e["to_uid"]): e["status"] for e in result["resolved_edges"]}


def test_resolved_edge_status_skeleton_cross_idle():
    """边状态区分主路径、闭包内交叉边和未激活上游。"""
    entries = [E(u) for u in ("a", "b", "c", "d", "g")]
    result = resolve(
        entries,
        [always("a")],
        requires=[("a", "b"), ("a", "c"), ("b", "d"), ("c", "d"), ("g", "a")],
    )
    assert set(result["resolved_entry_uids"]) == {"a", "b", "c", "d"}
    by_pair = statuses(result)
    assert by_pair[("a", "b")] == "skeleton"      # 主路径（display_tree 的父子关系）
    assert by_pair[("a", "c")] == "skeleton"
    assert by_pair[("b", "d")] == "skeleton"
    assert by_pair[("c", "d")] == "cross"         # 边生效但 d 已被 b 那次到达覆盖
    assert by_pair[("g", "a")] == "idle"          # g 不在闭包里
    # 既有字段一个都不能少或改名
    for edge in result["resolved_edges"]:
        assert set(edge) == {"from_uid", "to_uid", "relation", "active", "status"}


def test_resolved_edge_related_status_is_always_idle():
    """related 边只供浏览：不参与遍历，status 恒为 idle（哪怕两端都在闭包里）。"""
    entries = [E("root"), E("in_scope"), E("aside")]
    result = resolve(entries, [always("root")],
                     requires=[("root", "in_scope")],
                     # 两端都在闭包里的 related 边同样恒为 idle（反向边与 requires 不同对）
                     related=[("in_scope", "root"), ("root", "aside")])
    related = [e for e in result["resolved_edges"] if e["relation"] == "related"]
    assert [e["status"] for e in related] == ["idle", "idle"]
    assert all(e["active"] is False for e in related)


def test_display_tree_repeated_marks_multi_parent_arrivals_and_diamonds():
    """`repeated` = 存在**超过一次到达**（多源到达 / 菱形 / 根被回指都成立）。

    到达次数 = 被实际遍历的 requires 入边条数 + 该 uid 自己作为起点被激活的那一次。
    """
    entries = [E(u) for u in ("r1", "r2", "solo", "shared", "leaf", "x", "y", "z")]
    result = resolve(
        entries,
        [always("r1"), always("r2"), always("solo")],
        requires=[("r1", "shared"), ("r2", "shared"), ("shared", "leaf"),
                  ("r1", "x"), ("r1", "y"), ("x", "z"), ("y", "z")],
    )
    by_uid = {n["uid"]: n for n in result["display_tree"]}
    assert [n["uid"] for n in result["display_tree"]].count("shared") == 1
    # 多源到达：r1、r2 都指向 shared
    assert by_uid["shared"]["repeated"] is True
    # 菱形依赖：x、y 都指向 z
    assert by_uid["z"]["repeated"] is True
    # 单链：只有主路径父一个入边
    assert by_uid["leaf"]["repeated"] is False
    # 根 + 无入边：只有「作为起点被激活」这一次到达
    assert by_uid["r1"]["repeated"] is False
    assert by_uid["r1"]["first_parent_uid"] is None
    assert by_uid["r2"]["repeated"] is False
    assert by_uid["solo"]["repeated"] is False
    assert by_uid["solo"]["first_parent_uid"] is None
    # first_parent_uid 就是主路径父（保留字段名，供前端判定「哪次到达是主到达」）
    assert all(n["first_parent_uid"] == n["parent_uid"] for n in result["display_tree"])

    # 根 + 一条**被遍历**的入边 → 2 次到达 → true（旧口径只看入边条数会错判成 false）
    rooted = resolve([E(u) for u in ("a", "b")], [always("a")],
                     requires=[("a", "b"), ("b", "a")])
    by_uid = {n["uid"]: n for n in rooted["display_tree"]}
    assert by_uid["a"]["first_parent_uid"] is None and by_uid["a"]["is_root"] is True
    assert by_uid["a"]["repeated"] is True
    assert by_uid["b"]["repeated"] is False



def test_repeated_equals_second_traversed_arrival_invariant():
    """不变量：`repeated` ⟺ 「除主到达之外还存在至少一次**被遍历的**到达」。

    到达次数按 `resolved_edges` 里 `active is True`（＝被实际遍历）的 requires 入边条数
    计算，再加「该 uid 自己作为起点被激活」那一次（`active_roots` 的入口）。
    这条不变量是「灰节点预告」与「灰节点真的对应一次重复到达」之间的对应关系：
    只要它成立，节点视图就不会出现「标了重复到达、却没有第二次到达」的假灰节点。

    附带条件（同样逐 uid 断言）：每个 `repeated == True` 的 uid，要么在
    `resolved_edges` 里有一条 `status == "cross"` 的入边，要么自己是根且有一条
    被遍历的入边。
    """
    entries = [E(u) for u in ("r1", "r2", "p", "d1", "d2", "x", "leaf")]
    result = resolve(
        entries,
        [always("r1"), always("r2")],
        requires=[("r1", "p"), ("p", "r1"),        # 回指起点：根 r1 二次到达
                  ("r1", "d1"), ("r1", "d2"),
                  ("d1", "x"), ("d2", "x"),        # 菱形：x 二次到达
                  ("x", "leaf")],
    )
    tree = result["display_tree"]
    roots = {root["entry_uid"] for root in result["active_roots"]}
    traversed_in = {}
    cross_in = {}
    for edge in result["resolved_edges"]:
        if edge["relation"] != "requires" or not edge["active"]:
            continue
        traversed_in.setdefault(edge["to_uid"], set()).add(edge["from_uid"])
        if edge["status"] == "cross":
            cross_in.setdefault(edge["to_uid"], set()).add(edge["from_uid"])

    for node in tree:
        uid = node["uid"]
        arrivals = len(traversed_in.get(uid, ())) + (1 if uid in roots else 0)
        assert node["repeated"] == (arrivals > 1), (
            f"{uid}: repeated={node['repeated']} 但到达次数={arrivals}")
        if node["repeated"]:
            assert cross_in.get(uid) or (node["is_root"] and traversed_in.get(uid)), (
                f"{uid}: 声称有重复到达，却既没有 cross 入边也不是「根 + 被遍历的入边」")

    # 三类边界在同一份夹具里各自成立
    by_uid = {n["uid"]: n for n in tree}
    assert by_uid["r1"]["repeated"] is True        # 根 + 一条被遍历入边
    assert by_uid["r2"]["repeated"] is False       # 根 + 无入边
    assert by_uid["leaf"]["repeated"] is False     # 非根 + 一条入边（树父）
    assert by_uid["x"]["repeated"] is True         # 非根 + 两条被遍历入边


def test_display_tree_display_index_follows_depth_uid_order():
    """`display_index` 是稳定位次，与 `(depth, uid)` 排序一致。"""
    entries = [E(u) for u in ("r1", "r2", "shared", "leaf")]
    result = resolve(entries, [always("r1"), always("r2")],
                     requires=[("r1", "shared"), ("r2", "shared"), ("shared", "leaf")])
    tree = result["display_tree"]
    assert [n["display_index"] for n in tree] == list(range(len(tree)))
    assert [n["uid"] for n in tree] == [n["uid"] for n in
                                        sorted(tree, key=lambda n: (n["depth"], n["uid"]))]
    # 同一份输入重复解析得到同一份派生字段
    again = resolve(entries, [always("r1"), always("r2")],
                    requires=[("r1", "shared"), ("r2", "shared"), ("shared", "leaf")])
    assert again["display_tree"] == tree


def test_closure_too_large_branch_keeps_derived_field_shape(monkeypatch):
    """闭包超限提前返回时，节点 / 边 / 展示树仍是同样的字段形状（空数组）。"""
    import worldbook_scope as module
    monkeypatch.setattr(module, "MAX_CLOSURE_NODES", 3)
    entries = [E(f"n{i}") for i in range(8)]
    result = resolve(entries, [always("n0")],
                     requires=[(f"n{i}", f"n{i + 1}") for i in range(7)])
    assert result["resolved_edges"] == []
    assert result["display_tree"] == []
    assert result["issues"][0]["code"] == "closure_too_large"


def test_existing_result_fields_are_neither_removed_nor_renamed(monkeypatch):
    """读时派生字段只做追加：既有返回键、既有边 / 节点字段一个都没删或改名。"""
    import worldbook_scope as module
    top_level = {"book_id", "schema_version", "policy_revision", "content_revision",
                 "roster_character_ids", "active_roots", "resolved_entry_uids",
                 "resolved_edges", "selection_reasons", "display_tree",
                 "cross_references", "issues", "manual_entry_uids", "resolved_at"}
    edge_fields = {"from_uid", "to_uid", "relation", "active"}
    node_fields = {"uid", "name", "root_uid", "depth", "parent_uid", "child_uids",
                   "is_root"}

    entries = [E("a"), E("b"), E("c")]
    result = resolve(entries, [always("a")], requires=[("a", "b"), ("b", "c")],
                     related=[("a", "c")])
    assert set(result) == top_level
    for edge in result["resolved_edges"]:
        assert edge_fields <= set(edge)
    for node in result["display_tree"]:
        assert node_fields <= set(node)

    monkeypatch.setattr(module, "MAX_CLOSURE_NODES", 1)
    oversized = resolve(entries, [always("a")], requires=[("a", "b"), ("b", "c")])
    assert set(oversized) == top_level
