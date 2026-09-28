"""世界书分类 / 导入策略校验；与酒馆的关键词、常驻、预算规则相互独立。"""

from collections import deque
import copy
import time

EXTENSION_KEY = "arknights_tavern"
UNCLASSIFIED = {"id": "unclassified", "parent_id": None, "name": "未分类",
                "scope_type": "other", "sort_order": 1000}


def validate_categories(value):
    if not isinstance(value, list):
        raise ValueError("categories 必须是数组")
    result, by_id = [], {}
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("分类必须是对象")
        cid, name = raw.get("id"), raw.get("name")
        if not isinstance(cid, str) or not cid.strip() or cid != cid.strip() or cid in by_id:
            raise ValueError("分类 ID 必须是唯一的非空字符串")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"分类 {cid} 名称不能为空")
        parent = raw.get("parent_id") or None
        if parent is not None and not isinstance(parent, str):
            raise ValueError(f"分类 {cid} 的父级 ID 无效")
        kind = raw.get("scope_type", "other")
        if kind not in ("worldview", "character", "other"):
            raise ValueError(f"分类 {cid} 类型无效")
        order = raw.get("sort_order", 0)
        if type(order) is not int:
            raise ValueError(f"分类 {cid} 排序必须是整数")
        category = {"id": cid, "name": name.strip(), "parent_id": parent,
                    "scope_type": kind, "sort_order": order}
        result.append(category)
        by_id[cid] = category
    for category in result:
        seen, current = set(), category
        while current["parent_id"]:
            if current["id"] in seen:
                raise ValueError(f"分类树不能包含循环：{category['id']}")
            seen.add(current["id"])
            parent = by_id.get(current["parent_id"])
            if not parent:
                raise ValueError(f"分类 {current['id']} 的父级不存在")
            if current["scope_type"] != parent["scope_type"]:
                raise ValueError(f"子分类 {current['id']} 必须继承父级类型")
            current = parent
    if "unclassified" in by_id and by_id["unclassified"] != UNCLASSIFIED:
        raise ValueError("系统分类“未分类”不可修改或移动")
    if "unclassified" not in by_id:
        result.append(copy.deepcopy(UNCLASSIFIED))
    return result


def find_scope_extension(value):
    """提取本项目的命名空间扩展；标准酒馆/JSONL 仍按外部格式导入。"""
    if not isinstance(value, dict):
        return None
    if "entries" in value:
        extensions = value.get("extensions")
        extension = extensions.get(EXTENSION_KEY) if isinstance(extensions, dict) else None
        return extension if isinstance(extension, dict) else None
    for key in ("data", "character_book", "world", "extensions"):
        extension = find_scope_extension(value.get(key))
        if extension is not None:
            return extension
    return None


# ─────────────────────────────────────────────────────────────
# v3：全书底层有向图 + 条件起点
#
# 当前规则把「谁进候选」与「怎么组织」彻底分开：
#   - 分类只负责组织（改名/移动分类**不**隐式改变候选范围）；
#   - 起点由 activation 决定，展开由 expansion 决定；
#   - requires 边参与遍历，related 边只供浏览。
# ─────────────────────────────────────────────────────────────

SCHEMA_VERSION_V3 = 3

ACTIVATION_ALWAYS = "always"
ACTIVATION_ROSTER_ANY = "roster_any"
ACTIVATION_MANUAL = "manual"
ACTIVATIONS = (ACTIVATION_ALWAYS, ACTIVATION_ROSTER_ANY, ACTIVATION_MANUAL)

EXPANSION_NONE = "none"
EXPANSION_REQUIRES_CLOSURE = "requires_closure"
EXPANSIONS = (EXPANSION_NONE, EXPANSION_REQUIRES_CLOSURE)

# 必要闭包的保护上限：超过即报「来源过大」，**不做静默截断**。
MAX_CLOSURE_NODES = 20000


def _norm_edge_list(known, value, label):
    """规范化一类有向边：拒绝坏引用、自环与重复边（不静默过滤）。"""
    if not isinstance(value, list):
        raise ValueError(f"{label}必须是数组")
    seen, result = set(), []
    for edge in value:
        if not isinstance(edge, dict):
            raise ValueError(f"{label}必须是对象")
        a, b = edge.get("from_uid"), edge.get("to_uid")
        if not isinstance(a, str) or not isinstance(b, str) or a not in known or b not in known:
            raise ValueError(f"{label}包含不存在的节点：{a} → {b}")
        if a == b:
            raise ValueError(f"{label}不能为自环：{a} → {b}")
        if (a, b) in seen:
            raise ValueError(f"{label}不能有重复边：{a} → {b}")
        seen.add((a, b))
        result.append({"from_uid": a, "to_uid": b})
    return result


def validate_v3_rules(known, value):
    """校验 v3 规则集，返回规范化后的 (rules, requires_edges, related_edges)。

    `known` 是合法 UID 集合。写入接口严格拒绝坏引用——配置错误必须暴露给用户，
    不能被静默丢弃成「看起来生效了」。

    """
    if not isinstance(value, dict):
        raise ValueError("v3 规则必须是对象")
    raw_roots = value.get("roots", [])
    requires = value.get("requires_edges", [])
    related = value.get("related_edges", [])
    if not isinstance(raw_roots, list):
        raise ValueError("起点必须是数组")

    seen, roots = set(), []
    for raw in raw_roots:
        if not isinstance(raw, dict):
            raise ValueError("起点必须是对象")
        uid = raw.get("entry_uid")
        if not isinstance(uid, str) or uid not in known:
            raise ValueError(f"起点包含不存在或无效的条目：{uid}")
        if uid in seen:
            raise ValueError(f"起点重复：{uid}")
        seen.add(uid)

        activation = raw.get("activation", ACTIVATION_MANUAL)
        if activation not in ACTIVATIONS:
            raise ValueError(f"起点 {uid} 的 activation 必须是 {'/'.join(ACTIVATIONS)}")
        expansion = raw.get("expansion", EXPANSION_REQUIRES_CLOSURE)
        if expansion not in EXPANSIONS:
            raise ValueError(f"起点 {uid} 的 expansion 必须是 {'/'.join(EXPANSIONS)}")

        chars = raw.get("character_ids", [])
        if not isinstance(chars, list) or any(
                not isinstance(c, str) or not c.strip() for c in chars):
            raise ValueError(f"起点 {uid} 的 character_ids 必须是非空字符串组成的数组")
        if activation == ACTIVATION_ROSTER_ANY and not chars:
            raise ValueError(f"起点 {uid} 使用 roster_any 时必须给出 character_ids")
        if activation != ACTIVATION_ROSTER_ANY and chars:
            raise ValueError(f"起点 {uid} 只有 roster_any 才能指定 character_ids")

        item = {"entry_uid": uid, "activation": activation, "expansion": expansion,
                "character_ids": sorted({c.strip() for c in chars})}
        roots.append(item)

    requires_edges = _norm_edge_list(known, requires, "必要依赖边")
    related_edges = _norm_edge_list(known, related, "关联补充边")
    overlap = {(e["from_uid"], e["to_uid"]) for e in requires_edges} & {
        (e["from_uid"], e["to_uid"]) for e in related_edges}
    if overlap:
        pair = sorted(overlap)[0]
        raise ValueError(f"同一条边不能既是必要依赖又是关联补充：{pair[0]} → {pair[1]}")

    root_rule = value.get("root_rule")
    if root_rule is None:
        root_rule = {"entry_uids": sorted(seen)}
    elif not isinstance(root_rule, dict):
        raise ValueError("root_rule 必须是对象")
    rule_uids = root_rule.get("entry_uids", [])
    if not isinstance(rule_uids, list) or any(
            not isinstance(u, str) or u not in known for u in rule_uids):
        raise ValueError("root_rule.entry_uids 必须是有效条目 UID 数组")
    if len(set(rule_uids)) != len(rule_uids):
        raise ValueError("root_rule.entry_uids 不能重复")

    return ({"roots": roots, "root_rule": {"entry_uids": sorted(set(rule_uids))}},
            requires_edges, related_edges)


def resolve_v3_scope(entries, rules, requires_edges, related_edges,
                     roster_character_ids=None, policy_revision=1,
                     content_revision="", book_id="", manual_entry_uids=None):
    """按 v3 规则解析候选范围，返回可解释的完整结果。

    解析以**实际成功加载的阵容**激活起点，沿 requires 闭包展开，UID 去重，
    保留所有选用原因与参与边，并生成稳定主路径用于树显示。

    关键语义：
    - `related` 边**不参与遍历**，只作为浏览信息返回；
    - 被依赖带入的条目**不会**反过来激活它所属角色的整组条目
      （激活只看起点自身的 activation，依赖只负责补齐）；
    - 环可终止；必要闭包超限时报「来源过大」；
    - `manual_entry_uids`（本次会话的手动追加）作为**临时起点**参与同一次解析：
      它同样沿 requires 闭包补齐、带 manual 原因、进入展示树，
      而不是解析完之后做一次并集（那样会漏掉它需要的依赖，也没有解释）。

    返回的 `resolved_edges[].status` 与 `display_tree[].repeated / first_parent_uid /
    display_index` 是**读时派生**字段（提案 §3.4.5 / §4.2）：只描述这次解析的
    结果形状，不写回任何持久化 schema，也不改变任何既有字段的语义。
    """
    roster = set()
    for value in roster_character_ids or []:
        if isinstance(value, str) and value.strip():
            roster.add(value.strip())

    by_uid = {}
    for entry in entries:
        uid = getattr(entry, "uid", None) if not isinstance(entry, dict) else entry.get("uid")
        if isinstance(uid, str) and uid:
            by_uid[uid] = entry

    def field(uid, name, default=""):
        entry = by_uid.get(uid)
        if entry is None:
            return default
        if isinstance(entry, dict):
            return entry.get(name, default)
        return getattr(entry, name, default)

    # ── 1. 激活起点 ──
    root_reasons = {}   # uid -> [reason, ...]

    def mark_root(uid: str, reason: str):
        bucket = root_reasons.setdefault(uid, [])
        if reason not in bucket:
            bucket.append(reason)

    active_roots = []
    for root in rules["roots"]:
        uid = root["entry_uid"]
        activation = root["activation"]
        if activation == ACTIVATION_ALWAYS:
            active_roots.append(root)
            mark_root(uid, "always")
        elif activation == ACTIVATION_ROSTER_ANY:
            hit = sorted(roster & set(root["character_ids"]))
            if hit:
                active_roots.append(root)
                mark_root(uid, "roster:" + ",".join(hit))
        # manual：只登记，不自动激活（由调用方按需显式追加）

    # 本次会话的手动追加：临时起点，参与同一次解析（含 requires 闭包）。
    manual_uids = sorted({uid for uid in (manual_entry_uids or [])
                          if isinstance(uid, str) and uid in by_uid})
    for uid in manual_uids:
        active_roots.append({"entry_uid": uid, "activation": ACTIVATION_MANUAL,
                             "expansion": EXPANSION_REQUIRES_CLOSURE,
                             "character_ids": []})
        mark_root(uid, "manual")

    # ── 2. 沿 requires 闭包展开 ──
    adjacency = {}
    for edge in requires_edges:
        adjacency.setdefault(edge["from_uid"], []).append(edge["to_uid"])
    for targets in adjacency.values():
        targets.sort()

    expanded = {}      # uid -> 是否按 requires_closure 展开
    path_of = {}       # uid -> {"root","depth","parent"}
    used_edges = set() # 真正参与展开的边
    oversized = None

    queue = deque()
    for root in active_roots:
        uid = root["entry_uid"]
        expansion = root["expansion"]
        queue.append((uid, expansion == EXPANSION_REQUIRES_CLOSURE, uid, 0, None))

    while queue:
        uid, should_expand, root_uid, depth, parent = queue.popleft()
        known = expanded.get(uid)
        if known is True or known is should_expand:
            continue
        expanded[uid] = should_expand
        path_of[uid] = {"root": root_uid, "depth": depth, "parent": parent}
        if not should_expand:
            continue
        for target in adjacency.get(uid, []):
            used_edges.add((uid, target))
            queue.append((target, True, root_uid, depth + 1, uid))
        if oversized is None and len(expanded) > MAX_CLOSURE_NODES:
            oversized = len(expanded)

    if oversized is not None:
        # 超限时不做静默截断：节点、边与展示树的字段形状与正常返回一致（空数组），
        # 调用方不需要为这条分支写第二套解析规则。
        return {"book_id": book_id, "schema_version": SCHEMA_VERSION_V3,
                "policy_revision": policy_revision, "content_revision": content_revision,
                "roster_character_ids": sorted(roster), "active_roots": [],
                "resolved_entry_uids": [], "resolved_edges": [],
                "selection_reasons": {}, "display_tree": [], "cross_references": [],
                "manual_entry_uids": manual_uids,
                "issues": [{"code": "closure_too_large", "severity": "error",
                            "message": (f"必要依赖闭包超过 {MAX_CLOSURE_NODES} 个条目"
                                        f"（已达 {oversized}），疑似起点或依赖配置过大；"
                                        "请收窄起点或检查依赖边。")}],
                "resolved_at": time.time()}

    # ── 3. 选用原因 ──
    reasons = {}
    for uid in expanded:
        entry_reasons = list(root_reasons.get(uid, []))
        if path_of[uid]["root"] != uid:
            entry_reasons.append("requires")
        reasons[uid] = entry_reasons

    # 主路径边：闭包展开优先于 `none` 起点；同一 uid 只有一个父，树边天然无重复。
    tree_edges = {(info["parent"], uid) for uid, info in path_of.items() if info["parent"]}

    def _requires_edge_status(a, b):
        """requires 边的读时状态（R-11，判定顺序不可调换）。

        - `skeleton`：这条边就是主路径（`display_tree` 的父子关系）；
        - `cross`：边生效但目标已被别处覆盖（环内边 / 非树边）；
        - `idle`：上游根本不在闭包里（或其余情况）。
        """
        if (a, b) in tree_edges:
            return "skeleton"
        if (a, b) in used_edges:
            return "cross"
        return "idle"

    resolved_edges = [{"from_uid": a, "to_uid": b, "relation": "requires",
                       "active": (a, b) in used_edges,
                       "status": _requires_edge_status(a, b)}
                      for a, b in sorted({(e["from_uid"], e["to_uid"]) for e in requires_edges})]
    # `related` 边恒为 idle：它只供浏览，不参与遍历，永远不会是主路径或交叉引用。
    resolved_edges.extend({"from_uid": e["from_uid"], "to_uid": e["to_uid"],
                           "relation": "related", "active": False, "status": "idle"}
                          for e in related_edges)

    # ── 4. 稳定主路径树 ──
    # 按 (深度, uid) 排序：父节点深度必然小于子节点，因此父总在子之前，
    # 同一层内按 uid 稳定排序 → 同一份输入永远得到同一棵树。
    ordered = sorted(expanded, key=lambda u: (path_of[u]["depth"], u))
    children = {}
    for uid in ordered:
        parent = path_of[uid]["parent"]
        if parent is not None and parent in expanded:
            children.setdefault(parent, []).append(uid)

    display_tree = []
    for display_index, uid in enumerate(ordered):
        info = path_of[uid]
        # `display_tree` 是「每个 uid 一行」（由 expanded 表生成），同 uid 不会重复出现，
        # 所以「repeated = 是否非首次出现」的字面读法恒为 false、没有意义。这里按
        # **可用于灰节点渲染**的语义实现：
        # - `display_index`：该 uid 在 `display_tree` 里的 0-based 位次（树已按
        #   (depth, uid) 稳定排序，位次因此也稳定）；
        # - `first_parent_uid`：该 uid 的**主路径父**（即 `parent_uid`，根为 null），
        #   前端用它判断「哪一次到达是主到达」；
        # - `repeated`：该 uid 在闭包内是否**多于一次到达** —— 判定基于「到达次数」
        #   而不是「入边条数」：
        #
        #     到达次数 = 被**实际遍历**的 requires 入边条数（`used_edges`）
        #              + 它自己作为起点被激活的那一次（`root_reasons`）
        #
        #   两个边界必须守住，否则会误判：
        #   1. 用 `used_edges` 而不是 `requires_edges`：`none` 起点不会展开它的出边；
        #   2. 起点被激活本身也是一次到达：一个根若还被一条被遍历的边指向，
        #      它就有 2 次到达（自己作为根 + 来自那条边），不能只看入边条数。
        #
        #   五类边界：根+无入边=1(false)；根+一条被遍历入边=2(true)；
        #   非根+一条入边（它的树父）=1(false)；非根+两条被遍历入边=2(true)；
        #   非根+两条被遍历入边=2(true)。
        #
        #   ⚠ 它与节点视图的「灰出现」只是**单向**关系，`repeated` 是灰出现的**下界**：
        #   `repeated == true` ⟹ 一定有第二次到达；但**反向不成立** —— 按提案
        #   §3.4.3.1「主节点唯一：轨道上的出现优先」，**只要一个 uid 在轨道上**
        #   （全书启用且有正文的条目），它之后任何一次沿 requires 的向下展开出现
        #   都必然是**灰节点**，哪怕 `repeated == false`（真实预装书里这种 uid 有
        #   15 个，全部是「轨道条目 + 它那一次 skeleton 到达」）。
        #   因此「灰集合」是 `repeated` 的**超集**：主/灰归属以「轨道优先 →
        #   `first_parent_uid`」与 `resolved_edges[].status === "cross"` 为准；
        #   前端**不得**把 `repeated == false` 读成「这个 uid 不会有灰出现」。
        traversed_in = {a for (a, b) in used_edges if b == uid}
        arrivals = len(traversed_in) + (1 if uid in root_reasons else 0)
        display_tree.append({
            "uid": uid, "name": field(uid, "name", "") or uid,
            "root_uid": info["root"], "depth": info["depth"], "parent_uid": info["parent"],
            "child_uids": sorted(children.get(uid, [])),
            "is_root": uid in root_reasons,
            "repeated": arrivals > 1,
            "first_parent_uid": info["parent"],
            "display_index": display_index,
        })

    # ── 5. 交叉引用（环内 / 非树边）──
    cross = [{"from_uid": a, "to_uid": b} for a, b in sorted(used_edges) if (a, b) not in tree_edges]

    # ── 6. 问题清单（已激活必要依赖的停用/缺失/空正文必须可解释）──
    issues = []
    for uid in sorted(expanded):
        if uid not in by_uid:
            issues.append({"code": "missing_entry", "severity": "error", "uid": uid,
                           "message": f"依赖引用了不存在的条目 {uid}"})
            continue
        if not field(uid, "enabled", True):
            issues.append({"code": "disabled_entry", "severity": "warning", "uid": uid,
                           "message": f"{field(uid, 'name', '') or uid} 已停用，不会注入"})
        content = field(uid, "content", "")
        if not isinstance(content, str) or not content.strip():
            issues.append({"code": "empty_content", "severity": "warning", "uid": uid,
                           "message": f"{field(uid, 'name', '') or uid} 正文为空，不会注入"})

    return {"book_id": book_id, "schema_version": SCHEMA_VERSION_V3,
            "policy_revision": policy_revision, "content_revision": content_revision,
            "roster_character_ids": sorted(roster),
            "active_roots": [{"entry_uid": r["entry_uid"],
                              "activation": r["activation"],
                              "expansion": r["expansion"],
                              "character_ids": r["character_ids"]}
                             for r in active_roots],
            "resolved_entry_uids": sorted(expanded),
            "resolved_edges": resolved_edges,
            "selection_reasons": {uid: reasons[uid] for uid in sorted(reasons)},
            "display_tree": display_tree,
            "cross_references": cross,
            "issues": issues,
            "manual_entry_uids": manual_uids,
            "resolved_at": time.time()}
