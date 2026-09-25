"""
Worldbook blueprint — 世界书（酒馆 Lorebook 兼容）管理 API。

路由：
    GET    /api/worldbook                       列出所有书
    POST   /api/worldbook                       新建空书
    POST   /api/worldbook/import               导入（JSON body 或文件上传）
    GET    /api/worldbook/<book_id>            书详情（含条目）
    PUT    /api/worldbook/<book_id>            更新书元信息
    DELETE /api/worldbook/<book_id>            删除书
    POST   /api/worldbook/<book_id>/entries    新增条目
    PUT    /api/worldbook/<book_id>/entries/<entry_id>   更新条目
    DELETE /api/worldbook/<book_id>/entries/<entry_id>   删除条目
    GET    /api/worldbook/<book_id>/lore-bindings        读取节点级绑定（无则 null）
    PUT    /api/worldbook/<book_id>/lore-bindings        保存节点级绑定（targets 为空 = 关闭）
    GET    /api/worldbook/<book_id>/export     导出酒馆 v1 格式（回灌用）
    PUT    /api/worldbook/<book_id>/taxonomy   更新分类树与条目归属
    POST   /api/worldbook/<book_id>/auto-classify  按条目元数据自动分类（预览 / 应用）
    POST   /api/worldbook/<book_id>/default    设为/取消全局默认书（资料库禁止设为默认）
    POST   /api/worldbook/<book_id>/bind       绑定到会话（或解绑；资料库禁止绑定）
    POST   /api/worldbook/<book_id>/excerpt    从来源书摘录条目到本书（仅 story，整批原子）
    POST   /api/worldbook/<book_id>/prompt-preview     单轮实际注入预览（只读，A-2）
    GET    /api/worldbook/<book_id>/dependency-tree    条目依赖子树（只读，A-3）
    GET    /api/worldbook/resolve              查询会话当前生效的书

用途（`book_type`）：`story` 剧情世界书可绑定会话、设为默认并参与解析；
`reference` 资料库只供浏览、检索与摘录。缺字段的旧数据按 `story` 读取。
"""

import json
import logging
import uuid
import copy
from contextlib import contextmanager

from flask import Blueprint, jsonify, request, g

from shared.helpers import json_error
from world_book import (
    BOOK_TYPE_REFERENCE, RESOLVER_VERSION, WorldBook, WorldBookEntry,
    apply_auto_classification, auto_classification_patch, content_revision,
    estimate_tokens, normalize_book_type,
)
from worldbook_classify import classify_entries
from character_stats import validate_stat_fields
from worldbook_scope import (
    ACTIVATION_ALWAYS, ACTIVATION_MANUAL, ACTIVATION_ROSTER_ANY,
    EXPANSION_LEGACY_DEPTH, EXPANSION_NONE, EXPANSION_REQUIRES_CLOSURE,
    MAX_DEPENDENCY_DEPTH, SCHEMA_VERSION_V3, resolve_v3_scope, validate_categories,
    validate_policy, validate_v3_rules,
)
import node_lore_scope

logger = logging.getLogger(__name__)


def _union_edges(first, second) -> list[dict]:
    """按 (from, to) 去重合并两组边（用于人工拒绝 / 锁定等持久化集合）。"""
    out, seen = [], set()
    for edge in list(first) + list(second):
        if not isinstance(edge, dict):
            continue
        pair = (edge.get("from_uid"), edge.get("to_uid"))
        if pair in seen or not all(isinstance(x, str) and x for x in pair):
            continue
        seen.add(pair)
        out.append({"from_uid": pair[0], "to_uid": pair[1]})
    return out


def _dependency_cycles(closure_uids, requires_edges) -> list[list[str]]:
    """求闭包内 requires 子图的**环**（强连通分量），供 A-3/A-4 标红。

    返回格式（冻结）：`cycles: string[][]`，每个元素是一条环，记录环上节点
    **按环序排列且首尾同一 uid**，例如 `[["a", "b", "c", "a"]]`；无环为 `[]`。
    - 大小 > 1 的强连通分量各产出一条环（节点按 uid 稳定排序后首尾闭合）；
    - 自环产出 `["x", "x"]`（v3 校验器禁止自环，这里只做防御）。

    前端按相邻对（`cycles[i][j] → cycles[i][j+1]`）推出环内的边。
    Tarjan 用**迭代**实现：依赖链可以有上千节点，递归会撞上 Python 的栈上限。
    """
    nodes = sorted(set(closure_uids))
    adjacency = {uid: set() for uid in nodes}
    for edge in requires_edges:
        if not isinstance(edge, dict):
            continue
        a, b = edge.get("from_uid"), edge.get("to_uid")
        if a in adjacency and b in adjacency:
            adjacency[a].add(b)

    index_of, low, on_stack, stack, components = {}, {}, set(), [], []
    counter = 0
    for start in nodes:
        if start in index_of:
            continue
        index_of[start] = low[start] = counter
        counter += 1
        stack.append(start)
        on_stack.add(start)
        work = [(start, iter(sorted(adjacency[start])))]
        while work:
            node, neighbours = work[-1]
            advanced = False
            for target in neighbours:
                if target not in index_of:
                    index_of[target] = low[target] = counter
                    counter += 1
                    stack.append(target)
                    on_stack.add(target)
                    work.append((target, iter(sorted(adjacency[target]))))
                    advanced = True
                    break
                if target in on_stack:
                    low[node] = min(low[node], index_of[target])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index_of[node]:
                component = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.append(member)
                    if member == node:
                        break
                components.append(sorted(component))

    cycles = []
    for component in components:
        if len(component) > 1:
            cycles.append(component + [component[0]])
        elif component and component[0] in adjacency[component[0]]:
            cycles.append([component[0], component[0]])
    return sorted(cycles)


def _apply_full_scope(payload: dict, book) -> dict:
    """把预览结果改成「本次会话显式全量兼容」。

    v2 与 v3 都走这一条：范围真的换成全量，预览与实际创建保持一致，
    只影响本次会话，不改动这本书的规则。

    全量条目取 `WorldBook.full_scope_uids()` —— 与 `WorldBook._full_scope_scope`
    （Prompt 预览的 v2 / v3 两条分支）**同源**，保证同一个 `full_scope` 开关在
    `scope-preview` 与 `prompt-preview` 上给出同一份范围（v2 书上曾经只有
    `scope-preview` 认这个开关）。本函数**只**改这些键，`scope` 里其余既有键
    （v2 的 `excluded_entries` 等）保持不动，对外行为与改动前逐字一致。
    """
    uids = book.full_scope_uids()
    wanted = set(uids)
    costs = {e.uid: estimate_tokens(e.content) for e in book.entries if e.uid in wanted}
    total = sum(costs.values())
    scope = dict(payload.get("scope") or {})
    scope.update({
        "resolved_entry_uids": uids,
        "selection_reasons": {uid: ["full_scope"] for uid in uids},
        "legacy_full_scope": True,
        "full_scope": True,
    })
    payload.update({
        "scope": scope,
        "full_scope": True,
        "entry_count": len(uids),
        "resolved_estimated_tokens": total,
        "saved_estimated_tokens": 0,
        "saved_percent": 0.0,
        "warnings": ["已选择「本次会话全量兼容」：这次会载入全部启用条目，"
                     "只影响本会话，不改变这本书的规则。"] + list(payload.get("warnings") or []),
    })
    return payload


def _merge_v3_payload(manual: dict, existing: dict = None) -> dict:
    """把人工草稿并入已持久化的 v3 规则集。

    草稿是唯一来源；`existing`（旧数据）只用来补草稿没提到的人工锁定项，
    否则「保存一次」就会静默清掉旧书里已锁定的起点。

    `rejected`（人工删除过的边）与 `edge_meta`（边的来源与证据）一并保留：
    它们已经写进旧书的 JSON，删字段会破坏旧书读回与酒馆格式往返导出，
    因此保留为兼容透传，新写入不再产生新值。
    """
    existing = existing or {}
    locked = {r.get("entry_uid") for r in existing.get("roots", [])
              if isinstance(r, dict) and r.get("locked")}

    roots = []
    seen = set()
    for root in list(manual.get("roots", [])):
        if not isinstance(root, dict) or not root.get("entry_uid"):
            continue
        uid = root["entry_uid"]
        if uid in seen:
            continue
        seen.add(uid)
        roots.append({**root, "locked": True} if uid in locked else root)
    # 人工锁定但草稿里没出现的起点：必须保留
    for root in existing.get("roots", []):
        if not isinstance(root, dict) or not root.get("entry_uid"):
            continue
        if root.get("locked") and root["entry_uid"] not in seen:
            seen.add(root["entry_uid"])
            roots.append({**root, "locked": True})

    def union(first, second):
        out, pairs = [], set()
        for edge in list(first) + list(second):
            if not isinstance(edge, dict):
                continue
            pair = (edge.get("from_uid"), edge.get("to_uid"))
            if pair in pairs:
                continue
            pairs.add(pair)
            out.append(edge)
        return out

    rejected = union(existing.get("rejected", []), manual.get("rejected", []))
    edge_meta = {k: dict(v) for k, v in (existing.get("edge_meta") or {}).items()
                 if isinstance(v, dict)}
    return {
        "roots": roots,
        "requires_edges": union(manual.get("requires_edges", []), []),
        "related_edges": union(manual.get("related_edges", []), []),
        "rejected": rejected,
        "edge_meta": edge_meta,
    }


def _entry_from_payload(payload: dict, uid: str = None) -> WorldBookEntry:
    """从请求体构建 WorldBookEntry（仅白名单字段）。"""
    if not isinstance(payload, dict):
        raise ValueError("条目数据必须是对象")
    content = str(payload.get("content", "") or "")
    if not content.strip():
        raise ValueError("条目内容不能为空")
    return WorldBookEntry(
        uid=str(uid or payload.get("uid") or uuid.uuid4().hex[:10]),
        name=str(payload.get("name", "") or ""),
        content=content,
        trigger_keys=[str(k) for k in (payload.get("trigger_keys") or [])],
        secondary_keys=[str(k) for k in (payload.get("secondary_keys") or [])],
        always_active=bool(payload.get("always_active", True)),
        selective=bool(payload.get("selective", True)),
        enabled=bool(payload.get("enabled", True)),
        position=1 if int(payload.get("position", 0) or 0) else 0,
        depth=max(0, int(payload.get("depth", 4))),
        scan_depth=max(1, int(payload.get("scan_depth", 4) or 4)),
        probability=max(0, min(100, int(payload.get("probability", 100)))),
        group=str(payload.get("group", "") or ""),
        group_weight=int(payload.get("group_weight", 100) or 100),
        case_sensitive=bool(payload.get("case_sensitive", False)),
        match_whole_words=bool(payload.get("match_whole_words", False)),
        category_id=str(payload.get("category_id", "") or "unclassified"),
        character_id=str(payload.get("character_id", "") or "").strip(),
        excerpt_source=copy.deepcopy(payload.get("excerpt_source"))
        if isinstance(payload.get("excerpt_source"), dict) else {},
        raw=copy.deepcopy(payload.get("raw")) if isinstance(payload.get("raw"), dict) else {},
    )


def _validate_entry_scope(book, entry):
    if entry.category_id not in {c["id"] for c in book.categories}:
        raise ValueError("条目引用了不存在的分类")
    kind = book.category_scope_type(entry.category_id)
    if kind == "character" and not entry.character_id:
        raise ValueError("角色分类的条目必须关联角色标识（角色目录名）")
    if kind != "character" and entry.character_id:
        raise ValueError("非角色分类不可关联角色；请清空角色标识")


def _decode_upload(raw: bytes) -> str:
    """尝试多种编码解码上传文件内容。"""
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _try_json(text: str):
    """尝试把文本解析为单个 JSON 对象，失败返回 None。"""
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _looks_like_card(obj) -> bool:
    """判断 JSON 对象是否为 SillyTavern 角色卡（含角色身份字段）。"""
    if not isinstance(obj, dict):
        return False
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    if not isinstance(data, dict) or not data.get("name"):
        return False
    return (
        isinstance(data.get("character_book"), dict)
        or isinstance(obj.get("character_book"), dict)
        or bool(data.get("first_mes"))
        or bool(data.get("personality"))
        or bool(data.get("description"))
        or bool(data.get("scenario"))
    )


def _parse_card_or_error(raw: bytes):
    """尝试解析角色卡（PNG/JSON），失败返回 None。"""
    try:
        from character_card import CharacterCardError, parse_character_card
        return parse_character_card(raw)
    except CharacterCardError as exc:
        logger.warning("角色卡解析失败: %s", exc)
        return None
    except Exception as exc:
        logger.warning("角色卡解析异常: %s", exc)
        return None


def _import_card_character(card_result: dict, managers: dict):
    """把角色卡中的角色写入 data/characters（连带导入内嵌世界书场景共用）。"""
    from character_card import write_character_dir
    from shared.cache import invalidate_all_caches
    character = write_character_dir(
        card_result["meta"], card_result["image_bytes"])
    try:
        import index_manager as idxmgr
        invalidate_all_caches(idxmgr, managers.get("wiki"))
    except Exception:
        pass
    return character


def _import_combat_nodes(book) -> dict:
    """把世界书里的战斗节点条目落地为 `data/combat/nodes/*.json`。

    失败不影响世界书本身导入成功：错误逐条返回，编辑器可提示用户修正。
    """
    try:
        from combat_data_loader import CombatDataLoader
        from combat_nodes import import_worldbook_nodes
        entries = [e.to_dict() for e in book.entries]
        enemies = set(CombatDataLoader().list_enemy_names())
        return import_worldbook_nodes(entries, book_id=book.id, enemy_names=enemies)
    except Exception as exc:  # 节点导入是附加能力，绝不阻断世界书导入
        logger.warning("世界书战斗节点导入失败 (%s): %s", getattr(book, "id", "?"), exc)
        return {"imported": [], "skipped": [], "errors": [str(exc)]}


def _refresh_combat_node_entries(book) -> int:
    """导出前把战斗节点条目的 content 从注册表回灌（节点侧编辑不丢）。"""
    from combat_nodes import (
        NodeError, encode_node_for_worldbook, decode_worldbook_entry, load_node_file,
    )

    updated = 0
    for entry in book.entries:
        payload = entry.to_dict()
        try:
            # 以围栏块内容为准解析 node_id（raw.extensions 在部分导入路径会被规范化掉）
            data = decode_worldbook_entry(payload)
        except NodeError as exc:
            logger.warning("战斗节点条目解析失败，导出时跳过: %s", exc)
            continue
        if not data:
            continue
        node_id = str(data.get("node_id") or "")
        node = load_node_file(node_id) if node_id else None
        if not node:
            continue
        fresh = encode_node_for_worldbook(node)
        entry.content = fresh["content"]
        entry.trigger_keys = fresh["trigger_keys"]
        entry.name = fresh["name"]
        entry.raw = {**(payload.get("raw") or {}), **fresh["raw"]}
        updated += 1
    return updated


def register(app, managers):
    bp = Blueprint("worldbook", __name__)
    wb_mgr = managers["worldbook"]
    session_mgr = managers.get("session")

    @bp.before_request
    def serialize_book_operations():
        # 覆盖条目 CRUD、统一配置写入、导出刷新、重装与元信息写入。
        book_id = (request.view_args or {}).get("book_id")
        if book_id:
            lock = wb_mgr.book_lock(book_id)
            lock.acquire()
            g.worldbook_lock = lock

    @bp.teardown_request
    def release_book_lock(_error):
        lock = g.pop("worldbook_lock", None)
        if lock is not None:
            lock.release()

    def _get_book_or_404(book_id):
        book = wb_mgr.load(book_id)
        if not book:
            return None, json_error("世界书不存在", 404)
        return copy.deepcopy(book), None

    @contextmanager
    def _locked_book(book_id):
        """所有写路径共用同一把每书锁，覆盖「读取 → 校验 → 提交」全过程。

        之前只有 `/configuration` 加锁，条目 CRUD / 分类 / 自动分类 / 导入配置
        仍在锁外做整书读改写：两个请求交错时，后提交的会把先提交的更新整段覆盖掉
        （例如先改了条目、再保存起点，起点保存会把条目改动回滚）。
        """
        with wb_mgr.book_lock(book_id):
            book = wb_mgr.load(book_id)
            if not book:
                yield None, json_error("世界书不存在", 404)
                return
            yield copy.deepcopy(book), None

    def _revision_conflict(book, data):
        """Optional optimistic guard used by the workbench autosave endpoints."""
        if not isinstance(data, dict) or "expected_revision" not in data:
            return None
        try:
            expected = int(data["expected_revision"])
        except (TypeError, ValueError):
            return json_error("expected_revision 必须是整数", 400)
        if expected != book.edit_revision:
            return json_error(
                f"世界书已被其它操作更新（当前修订 {book.edit_revision}），请重试", 409)
        return None

    class SessionOccupancyUnknown(Exception):
        """无法可靠列举会话占用状态（会话服务存在，但枚举失败）。

        这是**安全边界**上的信号，不是普通错误：把「无法确认有没有会话绑定」
        当成「确认没有」，会让一本仍被会话绑定的故事书被改成资料库，事后那些会话
        就指向一本不参与解析的书。所以宁可拒绝转换，也不 fail-open。
        """

    def _sessions_bound_to(book_id: str) -> list:
        """返回绑定了这本书的会话 id（已排序）。

        只依赖 SessionManager 的**公开契约** `list_sessions()` —— 它返回会话摘要，
        其中 `worldbook_id` 就是该会话当前绑定的世界书（`None` 表示未绑定）。
        不得读生产类的私有字段：早期版本误读了不存在的 `sessions` 属性，导致真实
        运行时这个判断永远为空，被绑定的书照样能改成资料库。

        **fail closed**：只要配置了 `session_mgr`，无法可靠拿到会话列表就抛
        `SessionOccupancyUnknown`，由调用方转成 503 拒绝转换 —— 不能把「无法确认」
        当成「确认没有」。只有 `session_mgr is None`（当前应用根本没有会话服务）
        才按「无绑定」处理，正常返回的**空列表**同样表示「确认没有绑定」。
        """
        if session_mgr is None:
            return []
        try:
            summaries = session_mgr.list_sessions()
        except Exception as e:
            # 保留原始异常供诊断，但对外只给「暂时无法确认」这种不泄露内部的措辞
            logger.exception("列举会话失败，无法确认世界书占用状态")
            raise SessionOccupancyUnknown(
                "暂时无法确认会话占用状态，请稍后重试") from e
        if not isinstance(summaries, (list, tuple)):
            logger.error(
                "list_sessions() 返回了意外的类型 %s，无法确认世界书占用状态",
                type(summaries).__name__)
            raise SessionOccupancyUnknown(
                "暂时无法确认会话占用状态，请稍后重试")
        return sorted(
            str(item.get("id"))
            for item in summaries
            if isinstance(item, dict) and book_id in (item.get("worldbook_ids") or
                                                       [item.get("worldbook_id")])
        )

    def _reference_conversion_conflict(book) -> str:
        """把 story 改成 reference 前的安全闸门。

        资料库不能参与解析，也不能被会话绑定。如果这本书当前是全局默认书、或者正被
        某些会话绑定，直接改用途就会留下悬空状态（会话指向一本不参与解析的书）。
        这里**拒绝**这次转换并说明要处理什么，而不是静默清空默认指针或改别人的会话 ——
        静默改会话属于「以动作换状态」，用户无法预知自己的会话被动了什么。

        会话占用状态无法确认时抛 `SessionOccupancyUnknown`（调用方转 503），**不是**
        返回「无冲突」—— 见 `_sessions_bound_to` 的 fail-closed 说明。
        """
        reasons = []
        if wb_mgr.get_default_book_id() == book.id:
            reasons.append("它是当前的全局默认世界书")
        session_ids = _sessions_bound_to(book.id)
        if session_ids:
            reasons.append(
                "它正被 %d 个会话绑定（%s）"
                % (len(session_ids), "、".join(sorted(session_ids)[:5])))
        if not reasons:
            return ""
        return ("无法把《%s》改为资料库：%s。"
                "请先改绑这些会话（或取消默认），再切换用途。"
                % (book.name, "；".join(reasons)))

    def _book_detail(book: "WorldBook", include_entries: bool = True) -> dict:
        stats = book.entry_stats()
        detail = {
            "id": book.id,
            "name": book.name,
            "description": book.description,
            "cover_image": book.cover_image,
            "source_format": book.source_format,
            "source": book.source,
            "book_type": book.book_type,
            "is_reference": book.is_reference,
            "is_preinstalled": wb_mgr.is_preinstalled(book.id),
            "enabled": book.enabled,
            "budget_tokens": book.budget_tokens,
            "estimated_tokens": stats.tokens,
            "injectable_entry_count": stats.injectable,
            "disabled_entry_count": stats.disabled,
            "system_entry_count": stats.system,
            "edit_revision": book.edit_revision,
            "entry_order": book.effective_entry_order(),
            "has_explicit_entry_order": book.entry_order is not None,
            "stat_fields": copy.deepcopy(book.stat_fields),
            "created_at": book.created_at,
            "updated_at": book.updated_at,
            "entry_count": stats.total,
            "is_default": wb_mgr.get_default_book_id() == book.id,
            "schema_version": book.schema_version,
            "scope_mode": book.scope_mode,
            "categories": book.categories,
            "dependency_edges": book.dependency_edges,
            "import_config": book.import_config,
            "dependency_rules": book.dependency_rules,
            "related_edges": book.related_edges,
            "content_revision": content_revision(book.entries),
            "resolver_version": RESOLVER_VERSION,
            "policy_revisions": [{"revision": item["revision"],
                                  "resolver_version": item["resolver_version"],
                                  "created_at": item["created_at"]}
                                 for item in book.policy_revisions],
            "evidence_issues": [],
        }
        if include_entries:
            detail["entries"] = [e.to_dict() for e in book.entries]
        return detail

    # ── 1. 书列表 / 创建 ──

    @bp.route("/api/worldbook", methods=["GET"])
    def list_books():
        return jsonify({"books": wb_mgr.list_books()})

    @bp.route("/api/worldbook", methods=["POST"])
    def create_book():
        data = request.json or {}
        name = str(data.get("name", "") or "").strip() or "未命名世界书"
        try:
            budget = int(data.get("budget_tokens", 0) or 0)
        except (TypeError, ValueError):
            budget = 0
        # 用途：缺省 story（普通新建的书就是剧情世界书）；非法值 400，不静默降级。
        try:
            book_type = normalize_book_type(data.get("book_type"))
        except ValueError as e:
            return json_error(str(e), 400)
        book = wb_mgr.create_book(name, budget_tokens=max(0, budget),
                                  book_type=book_type)
        book.description = str(data.get("description", "") or "")
        book.cover_image = str(data.get("cover_image", "") or "")
        if book.description or book.cover_image:
            wb_mgr.save(book)
        return jsonify({"book": _book_detail(book, include_entries=False)}), 201

    # ── 2. 导入 ──

    @bp.route("/api/worldbook/import", methods=["POST"])
    def import_book():
        name = ""
        source = None
        card_result = None  # 角色卡解析结果；非 None 时连带导入角色（角色/开场白可入队使用）
        requested_type = None  # 显式指定的用途；导入物自带的项目扩展优先

        if "file" in request.files and request.files["file"]:
            f = request.files["file"]
            name = str(request.form.get("name", "") or "").strip() or f.filename
            requested_type = request.form.get("book_type")
            raw = f.read()
            if raw.startswith(b"\x89PNG"):
                # PNG 角色卡：提取内嵌世界书 + 角色
                card_result = _parse_card_or_error(raw)
                if card_result is None:
                    return json_error("PNG 角色卡解析失败（未找到内嵌 chara JSON）", 400)
                source = card_result["book_data"]
                if source is None:
                    return json_error(
                        "该 PNG 角色卡未包含内嵌世界书（character_book / extensions.world）", 400)
            else:
                text = _decode_upload(raw)
                obj = _try_json(text)
                if _looks_like_card(obj):
                    card_result = _parse_card_or_error(raw)
                    if card_result is None:
                        return json_error("角色卡解析失败", 400)
                    source = card_result["book_data"] or obj
                else:
                    source = text
        elif request.json is not None:
            data = request.json
            name = str(data.get("name", "") or "").strip()
            requested_type = data.get("book_type")
            source = data.get("data") or data.get("book")
            if source is None:
                # 允许直接把整本书 JSON 作为 body（无 name/data 包装）
                source = {k: v for k, v in data.items() if k not in ("name", "book_type")}
            if _looks_like_card(source):
                card_result = _parse_card_or_error(
                    json.dumps(source, ensure_ascii=False).encode("utf-8"))
                if card_result is None:
                    return json_error("角色卡解析失败", 400)
                source = card_result["book_data"] or source
        else:
            return json_error("需要上传文件或 JSON body")

        if not source:
            return json_error("导入内容为空")

        # 用户没选用途（缺字段/空串）时传 None 而不是补默认值 —— 让 import_book 能区分
        # 「用户明确选了剧情」和「用户没表态」，后者要保留导入文件自带的用途声明。
        has_requested = requested_type is not None and str(requested_type).strip() != ""
        try:
            book_type = normalize_book_type(requested_type) if has_requested else None
        except ValueError as e:
            return json_error(str(e), 400)

        try:
            book, report = wb_mgr.import_book(name, source, book_type=book_type)
        except Exception as e:
            logger.exception("世界书导入失败")
            return json_error(f"导入失败: {e!s}", 500)

        # 角色卡连带导入角色：角色卡自带角色/开场白等内容可正常使用
        character = None
        if card_result is not None:
            try:
                character = _import_card_character(card_result, managers)
            except Exception as exc:
                logger.warning("角色卡连带导入角色失败: %s", exc)

        # 世界书里的战斗节点条目 → 落地为 data/combat/nodes/*.json
        combat_nodes = _import_combat_nodes(book)

        resp = {
            "book": _book_detail(book, include_entries=False),
            "report": report.to_dict(),
            "character": character,
            "combat_nodes": combat_nodes,
        }
        return jsonify(resp), 201

    # ── 3. 书详情 / 更新 / 删除 / 导出 ──

    @bp.route("/api/worldbook/<book_id>", methods=["GET"])
    def get_book(book_id):
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        return jsonify(_book_detail(book))

    @bp.route("/api/worldbook/<book_id>", methods=["PUT"])
    def update_book(book_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            data = request.json or {}
            conflict = _revision_conflict(book, data)
            if conflict:
                return conflict
            if "name" in data:
                new_name = str(data["name"] or "").strip()
                if new_name:
                    book.name = new_name
            if "budget_tokens" in data:
                try:
                    book.budget_tokens = max(0, int(data["budget_tokens"] or 0))
                except (TypeError, ValueError):
                    return json_error("budget_tokens 必须是整数")
            if "description" in data:
                book.description = str(data.get("description") or "")
            if "cover_image" in data:
                book.cover_image = str(data.get("cover_image") or "")
            if "stat_fields" in data:
                # 统一数值字段：非法定义直接 400，不静默丢字段
                try:
                    book.stat_fields = validate_stat_fields(data.get("stat_fields"))
                except ValueError as e:
                    return json_error(str(e), 400)
            if "enabled" in data:
                book.enabled = bool(data["enabled"])
            if "book_type" in data:
                try:
                    new_type = normalize_book_type(data["book_type"])
                except ValueError as e:
                    return json_error(str(e), 400)
                if new_type != book.book_type:
                    # 闸门只针对 story -> reference：资料库一旦被默认/会话引用就会
                    # 留下悬空状态。反方向（reference -> story）是**修复**历史坏状态
                    # 的操作，必须放行 —— 否则用户会陷入「改不回去」的死结。
                    if new_type == BOOK_TYPE_REFERENCE:
                        try:
                            conflict = _reference_conversion_conflict(book)
                        except SessionOccupancyUnknown as e:
                            # fail closed：查不清有没有会话在用，就不给改 —— 不返回
                            # 冲突文案（那是 409 的语义），也不落盘（book 尚未改动）
                            return json_error(
                                f"无法确认会话占用状态，因此未切换用途：{e}", 503)
                        if conflict:
                            # 不静默改会话/默认书：说清是哪些会话会被悬空，让用户先处理
                            return json_error(conflict, 409)
                    book.book_type = new_type
            wb_mgr.save(book)
            return jsonify({"book": _book_detail(book, include_entries=False)})

    @bp.route("/api/worldbook/<book_id>", methods=["DELETE"])
    def delete_book(book_id):
        """统一删除。预装包删除后可通过 /reinstall 从分发源一键重装还原。"""
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        wb_mgr.delete_book(book_id)
        return jsonify({"message": "已删除"})

    @bp.route("/api/worldbook/<book_id>/duplicate", methods=["POST"])
    def duplicate_book(book_id):
        """复制任意书为新的导入书（做变体/备份）。body: {name?}"""
        data = request.json or {}
        try:
            new_book = wb_mgr.duplicate_book(
                book_id,
                new_name=str(data.get("name", "") or "").strip() or None,
            )
        except ValueError as e:
            return json_error(str(e), 404)
        return jsonify({"book": _book_detail(new_book, include_entries=False)}), 201

    @bp.route("/api/worldbook/<book_id>/reinstall", methods=["POST"])
    def reinstall_book(book_id):
        """从分发源一键重装预装整合包（恢复出厂内容）。"""
        try:
            book = wb_mgr.reinstall_book(book_id)
        except ValueError as e:
            return json_error(str(e), 404)
        return jsonify({"book": _book_detail(book, include_entries=False)})

    @bp.route("/api/worldbook/<book_id>/export", methods=["GET"])
    def export_book(book_id):
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        # 战斗节点条目：从节点注册表回灌最新规格，保证"节点侧编辑"随书导出
        refreshed = _refresh_combat_node_entries(book)
        if refreshed:
            wb_mgr.save(book)
        return jsonify({"name": book.name, "format": "sillytavern_v1",
                        "data": book.export_st(),
                        "combat_nodes_refreshed": refreshed})

    # ── 4. 条目 CRUD ──

    @bp.route("/api/worldbook/<book_id>/entries", methods=["POST"])
    def create_entry(book_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            data = request.json or {}
            conflict = _revision_conflict(book, data)
            if conflict:
                return conflict
            try:
                entry = _entry_from_payload(data)
                _validate_entry_scope(book, entry)
                if any(e.uid == entry.uid for e in book.entries):
                    raise ValueError("条目 UID 已存在")
            except (TypeError, ValueError) as e:
                return json_error(str(e))
            book.entries.append(entry)
            if book.entry_order is not None:
                book.entry_order.append(entry.uid)
            book.import_config["revision"] += 1
            wb_mgr.save(book)
            return jsonify({"entry": entry.to_dict(), "edit_revision": book.edit_revision}), 201

    @bp.route("/api/worldbook/<book_id>/entries/<entry_id>", methods=["PUT"])
    def update_entry(book_id, entry_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            conflict = _revision_conflict(book, request.json or {})
            if conflict:
                return conflict
            for i, e in enumerate(book.entries):
                if e.uid == entry_id:
                    try:
                        if not isinstance(request.json, dict):
                            raise ValueError("条目数据必须是对象")
                        payload = {**e.to_dict(), **request.json}
                        updated = _entry_from_payload(payload, uid=entry_id)
                        _validate_entry_scope(book, updated)
                    except (TypeError, ValueError) as exc:
                        return json_error(str(exc))
                    # Hidden fields survive partial edits; the payload builder copies
                    # raw and excerpt_source from the current entry.
                    book.entries[i] = updated
                    book.import_config["revision"] += 1
                    wb_mgr.save(book)
                    return jsonify({"entry": updated.to_dict(), "edit_revision": book.edit_revision})
            return json_error("条目不存在", 404)

    @bp.route("/api/worldbook/<book_id>/entries/<entry_id>", methods=["DELETE"])
    def delete_entry(book_id, entry_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            for i, e in enumerate(book.entries):
                if e.uid == entry_id:
                    book.entries.pop(i)
                    if book.entry_order is not None:
                        book.entry_order = [uid for uid in book.entry_order if uid != entry_id]
                    affected = {"dependency_edges": sum(entry_id in (edge["from_uid"], edge["to_uid"]) for edge in book.dependency_edges),
                                "fixed_entries": int(entry_id in book.import_config["fixed_entry_uids"]),
                                "dependency_sources": sum(s["entry_uid"] == entry_id for s in book.import_config["dependency_sources"])}
                    book.dependency_edges = [edge for edge in book.dependency_edges
                                             if entry_id not in (edge["from_uid"], edge["to_uid"])]
                    book.related_edges = [edge for edge in book.related_edges
                                          if entry_id not in (edge["from_uid"], edge["to_uid"])]
                    if book.dependency_rules is not None:
                        book.dependency_rules["roots"] = [
                            root for root in book.dependency_rules["roots"]
                            if root["entry_uid"] != entry_id]
                        book.dependency_rules["root_rule"]["entry_uids"] = [
                            uid for uid in book.dependency_rules["root_rule"]["entry_uids"]
                            if uid != entry_id]
                        # 入边与出边、以及被拒绝建议都要一起清掉（不留悬空引用）
                        book.dependency_rules["rejected"] = [
                            edge for edge in book.dependency_rules.get("rejected", [])
                            if entry_id not in (edge.get("from_uid"), edge.get("to_uid"))]
                        meta = book.dependency_rules.get("edge_meta") or {}
                        book.dependency_rules["edge_meta"] = {
                            key: value for key, value in meta.items()
                            if entry_id not in key.split("|")}
                    config = book.import_config
                    config["fixed_entry_uids"] = [uid for uid in config["fixed_entry_uids"] if uid != entry_id]
                    config["dependency_sources"] = [s for s in config["dependency_sources"]
                                                    if s["entry_uid"] != entry_id]
                    config["revision"] += 1
                    wb_mgr.save(book)
                    return jsonify({"message": "已删除", "affected": affected})
            return json_error("条目不存在", 404)

    @bp.route("/api/worldbook/<book_id>/entry-order", methods=["PUT"])
    def reorder_entries(book_id):
        """Atomically persist a complete entry permutation."""
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            data = request.json or {}
            conflict = _revision_conflict(book, data)
            if conflict:
                return conflict
            order = data.get("entry_order")
            if not isinstance(order, list) or any(not isinstance(uid, str) for uid in order):
                return json_error("entry_order 必须是 UID 字符串数组", 400)
            known = [entry.uid for entry in book.entries]
            if len(order) != len(known) or len(set(order)) != len(order) or set(order) != set(known):
                return json_error("entry_order 必须完整且不重复地包含本书全部条目", 400)
            book.entry_order = list(order)
            wb_mgr.save(book)
            return jsonify({
                "entry_order": book.effective_entry_order(),
                "edit_revision": book.edit_revision,
            })

    # ── 4.0.1 节点级世界书绑定（docs/design/worldbook/node-scoped-worldbook-loading.md） ──

    @bp.route("/api/worldbook/<book_id>/lore-bindings", methods=["GET"])
    def get_lore_bindings(book_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            payload, fingerprint = node_lore_scope.find_bindings(book)
            return jsonify({
                "bindings": payload,
                "fingerprint": fingerprint,
                "entry_uid": node_lore_scope.bindings_entry_uid(book.id),
            })

    @bp.route("/api/worldbook/<book_id>/lore-bindings", methods=["PUT"])
    def put_lore_bindings(book_id):
        """保存节点绑定（targets 为空 = 关闭功能，条目作为惰性标记保留）。

        校验失败（坏 uid / 常驻条目 / 自引用 / 未知字段）一律 400 拒绝——
        配置错误必须暴露给作者，不能静默存成「看起来生效了」。
        """
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            payload = request.json
            if not isinstance(payload, dict):
                return json_error("绑定内容必须是 JSON 对象", 400)
            errors = node_lore_scope.validate_bindings(book, payload)
            if errors:
                return json_error("绑定校验失败：" + "；".join(errors), 400)
            data = node_lore_scope.encode_bindings_for_worldbook(payload, book.id)
            entry = WorldBookEntry(
                uid=data["uid"], name=data["name"], content=data["content"],
                trigger_keys=[], always_active=False, raw=data["raw"],
            )
            for i, e in enumerate(book.entries):
                if node_lore_scope.is_lore_bindings_entry(e):
                    book.entries[i] = entry
                    break
            else:
                book.entries.append(entry)
                if book.entry_order is not None:
                    book.entry_order.append(entry.uid)
            book.import_config["revision"] += 1
            wb_mgr.save(book)
            return jsonify({"bindings": payload, "entry_uid": entry.uid})

    # ── 4.1 分类树 / 依赖导入配置 ──

    def _policy_candidate(book, data):
        if not isinstance(data, dict):
            raise ValueError("请求体必须是对象")
        config, edges = validate_policy({e.uid for e in book.entries},
                                        {**book.import_config, **data}, book.dependency_edges)
        mode = data.get("scope_mode", book.scope_mode)
        if mode not in ("legacy", "selective"):
            raise ValueError("scope_mode 必须是 legacy 或 selective")
        candidate = copy.deepcopy(book)
        candidate.import_config = {**config, "revision": book.import_config["revision"] + 1}
        candidate.dependency_edges, candidate.scope_mode = edges, mode
        return candidate

    @bp.route("/api/worldbook/<book_id>/taxonomy", methods=["PUT"])
    def update_taxonomy(book_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            data = request.json
            try:
                if not isinstance(data, dict):
                    raise ValueError("请求体必须是对象")
                if data.get("expected_revision", book.import_config["revision"]) != book.import_config["revision"]:
                    return json_error("配置已变更，请重新加载后再保存", 409)
                old_kinds = {e.uid: book.category_scope_type(e.category_id) for e in book.entries}
                book.categories = validate_categories(data.get("categories"))
                moves = data.get("entry_moves", {})
                if not isinstance(moves, dict) or any(uid not in {e.uid for e in book.entries} for uid in moves):
                    raise ValueError("entry_moves 必须按有效条目 UID 指定目标分类")
                category_ids = {c["id"] for c in book.categories}
                for entry in book.entries:
                    if entry.uid in moves:
                        target = moves[entry.uid]
                        if not isinstance(target, str) or target not in category_ids:
                            raise ValueError(f"条目 {entry.uid} 的目标分类不存在")
                        entry.category_id = target
                        if book.category_scope_type(target) != "character":
                            entry.character_id = ""
                    if entry.category_id not in category_ids:
                        raise ValueError(f"请先为分类中的条目 {entry.uid} 指定迁移目标")
                    if entry.uid in moves or old_kinds[entry.uid] != book.category_scope_type(entry.category_id):
                        _validate_entry_scope(book, entry)
            except (TypeError, ValueError) as exc:
                return json_error(str(exc))
            # 编辑分类不隐式退出旧书兼容模式；用户检查预览后显式启用按需模式。
            book.import_config["revision"] += 1
            wb_mgr.save(book)
            return jsonify(_book_detail(book))

    @bp.route("/api/worldbook/<book_id>/auto-classify", methods=["POST"])
    def auto_classify(book_id):
        """按条目自带的可信元数据分类：默认只出方案（apply=false），apply=true 才写盘。

        只认 uid 前缀 / group 字段 / 名称后缀三类显式线索，不按名字或正文猜测。只改
        「条目属于哪一类」与随之而来的角色关联，不改载入模式、固定导入与依赖策略。
        """
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        result = classify_entries(book.entries)
        payload = result.to_payload()
        payload["proposal"] = result.categories(existing=book.categories)
        payload["apply"] = False
        # 统一草稿补丁：让「应用自动分类」也走草稿 + 一次原子保存，而不是绕过草稿写盘。
        payload["draft_patch"] = auto_classification_patch(book, result) if result.matched else None
        if not result.matched:
            payload["reason"] = "这本书的条目没有可用的分类线索（uid 前缀 / group 字段 / 名称后缀），已保持原样。"
            return jsonify(payload)
        if not data.get("apply"):
            return jsonify(payload)
        # 应用分类会整书写回：与其它写路径共用同一把锁
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            if data.get("expected_revision", book.import_config["revision"]) != book.import_config["revision"]:
                return json_error("配置已变更，请重新加载后再保存", 409)
            try:
                apply_auto_classification(book)
                for entry in book.entries:
                    _validate_entry_scope(book, entry)
            except (TypeError, ValueError) as exc:
                return json_error(str(exc))
            book.import_config["revision"] += 1
            wb_mgr.save(book)
            payload["apply"] = True
            return jsonify({"classification": payload, "book": _book_detail(book)})

    @bp.route("/api/worldbook/<book_id>/import-config", methods=["PUT"])
    def update_import_config(book_id):
        with _locked_book(book_id) as (book, err):
            if err:
                return err
            data = request.json
            try:
                if isinstance(data, dict) and data.get("expected_revision", book.import_config["revision"]) != book.import_config["revision"]:
                    return json_error("配置已变更，请重新加载后再保存", 409)
                book = _policy_candidate(book, data)
            except (TypeError, ValueError) as exc:
                return json_error(str(exc))
            wb_mgr.save(book)
            return jsonify(_book_detail(book))

    @bp.route("/api/worldbook/<book_id>/scope-preview", methods=["POST"])
    def preview_scope(book_id):
        """只读预览：接受完整草稿 / 阵容 / 会话覆盖，返回可解释的候选范围。

        绝不写缓存、磁盘或会话；也不改变已有会话的快照。
        """
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        data = request.json
        try:
            if not isinstance(data, dict):
                raise ValueError("请求体必须是对象")
            candidate = _draft_candidate(book, data, preview=True)
            roster = data.get("roster_character_ids", [])
            manual = data.get("manual_entry_uids", [])
            revision = data.get("policy_revision")
            full_scope = bool(data.get("full_scope"))
            if candidate.v3_enabled:
                payload = candidate.preview_v3_scope(roster, manual, revision, full_scope)
                if full_scope:
                    payload = _apply_full_scope(payload, candidate)
                return jsonify(payload)
            # 未启用 v3 的书沿用 v2 预览（旧语义不静默改变）
            payload = candidate.preview_scope(roster)
            if full_scope:
                payload = _apply_full_scope(payload, candidate)
            payload["draft_hash"] = candidate.policy_draft_hash(roster, manual, revision, full_scope)
            payload["policy_revision"] = candidate.import_config["revision"]
            payload["content_revision"] = content_revision(candidate.entries)
            payload["schema_version"] = candidate.schema_version
            payload["resolver_version"] = RESOLVER_VERSION
            return jsonify(payload)
        except (TypeError, ValueError) as exc:
            return json_error(str(exc))

    # ── 4.1b 只读预览：单轮实际注入（A-2）与条目依赖子树（A-3）──

    @bp.route("/api/worldbook/<book_id>/prompt-preview", methods=["POST"])
    def prompt_preview(book_id):
        """只读预览：这一轮实际会插进提示词的文本 / 顺序 / 位置 / 未插入原因（A-2）。

        **复用线上同一条执行路径**：`WorldBook.preview_prompt_injection` →
        `eligible_uids_for()` → `collect_matches(rng=random.Random(seed))` →
        `format_injection(trace=...)`。预览与真实注入字节等价，唯一差异是概率抽签
        改用固定种子（可复现）。

        **只读**：不写盘、不动候选缓存、不创建/修改会话、不污染全局 `random`。
        因此本路由**不加** `_locked_book`（加锁与只读语义无关，只会把并发预览串行化）。
        """
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        data = request.json
        try:
            if not isinstance(data, dict):
                raise ValueError("请求体必须是对象")
            mode = data.get("mode", "narrative")
            if mode not in ("narrative", "free"):
                return json_error("mode 只能是 narrative（剧情模式）或 free（自由模式）", 400)

            # 草稿口径与 scope-preview 一致：合成一本候选书，校验失败即抛错、绝不落盘
            policy = data.get("policy")
            if policy is None:
                candidate = book
            elif isinstance(policy, dict):
                candidate = _draft_candidate(book, policy, preview=True)
            else:
                raise ValueError("policy 必须是完整草稿对象")

            # token 预算覆盖只在**候选书副本**上生效（不改原书、不写盘）
            budget = data.get("budget_tokens")
            if isinstance(budget, bool) or budget is None:
                budget_value = 0
            else:
                try:
                    budget_value = int(budget)
                except (TypeError, ValueError):
                    budget_value = 0
            if budget_value > 0:
                candidate.budget_tokens = max(0, budget_value)

            roster = data.get("roster_character_ids") or []
            manual = data.get("manual_entry_uids") or []
            if not isinstance(roster, list) or not isinstance(manual, list):
                raise ValueError("roster_character_ids / manual_entry_uids 必须是数组")
            input_text = data.get("input_text") or ""
            recent_text = data.get("recent_text") or ""
            if not isinstance(input_text, str) or not isinstance(recent_text, str):
                raise ValueError("input_text / recent_text 必须是字符串")
            lore_scope = data.get("lore_scope")
            if lore_scope is not None and not isinstance(lore_scope, dict):
                raise ValueError("lore_scope 必须是对象（形状同会话节点作用域）")
            identity = data.get("identity")
            if not isinstance(identity, str) or not identity:
                identity = "博士"
            active_char = data.get("active_char")
            if not isinstance(active_char, str):
                active_char = None
            seed = data.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int):
                seed = 0

            if bool(data.get("all_entries", False)):
                # 系统层条目（节点图 / 节点绑定）由 preview_all_entries 自己按
                # `world_book.is_system_entry` 排除，这里不再单独挑 lore_bindings：
                # 同一份判定只能有一处，否则节点图条目会漏进全书预览。
                return jsonify(candidate.preview_all_entries(
                    mode=mode, identity=identity, active_char=active_char))

            return jsonify(candidate.preview_prompt_injection(
                mode=mode, input_text=input_text, recent_text=recent_text,
                roster_character_ids=roster, manual_entry_uids=manual,
                full_scope=bool(data.get("full_scope")), identity=identity,
                active_char=active_char, seed=seed, lore_scope=lore_scope))
        except (TypeError, ValueError) as exc:
            return json_error(str(exc))

    @bp.route("/api/worldbook/<book_id>/dependency-tree", methods=["GET"])
    def dependency_tree(book_id):
        """条目依赖子树（A-3）：`entry_uids` 的 requires 闭包 + 边状态 + 环。

        **复用 `resolve_v3_scope` 的同一段 BFS**，不另写第二套遍历：把 `entry_uids`
        合成等价起点（`always` + `requires_closure`；给了 `max_depth` 就用
        `always` + `legacy_depth`），边与其余装载路径与 `scope-preview` 完全一致。
        这样「条目页展开看到的依赖」与「分类与载入页看到的候选范围」永远同源。

        只读：不写盘、不改规则、不加 `_locked_book`。
        """
        book, err = _get_book_or_404(book_id)
        if err:
            return err
        known = {e.uid for e in book.entries}
        wanted, seen = [], set()
        for raw in (request.args.get("entry_uids") or "").split(","):
            uid = raw.strip()
            if not uid or uid in seen or uid not in known:
                continue
            seen.add(uid)
            wanted.append(uid)
        if not wanted:
            return json_error("entry_uids 不能为空，且至少需要一个本书中真实存在的条目 UID", 400)

        max_depth = None
        raw_depth = request.args.get("max_depth")
        if raw_depth not in (None, ""):
            try:
                max_depth = int(str(raw_depth).strip())
            except (TypeError, ValueError):
                return json_error("max_depth 必须是整数", 400)
            max_depth = max(0, min(MAX_DEPENDENCY_DEPTH, max_depth))

        roots = []
        for uid in wanted:
            root = {"entry_uid": uid, "activation": ACTIVATION_ALWAYS, "character_ids": []}
            if max_depth is None:
                root["expansion"] = EXPANSION_REQUIRES_CLOSURE
            else:
                root["expansion"] = EXPANSION_LEGACY_DEPTH
                root["max_depth"] = max_depth
            roots.append(root)
        rules = {"roots": roots, "root_rule": {"entry_uids": []}}

        # 边与其余参数走与 scope-preview 相同的装载口径（书里真实的 requires/related）
        result = resolve_v3_scope(
            book.entries, rules, book.dependency_edges, book.related_edges,
            roster_character_ids=[],
            policy_revision=book.import_config["revision"],
            content_revision=content_revision(book.entries),
            book_id=book.id,
        )
        closure = set(result["resolved_entry_uids"])
        nodes = [{"uid": node["uid"], "name": node["name"], "parent_uid": node["parent_uid"],
                  "child_uids": node["child_uids"], "depth": node["depth"],
                  "remaining": node["remaining"], "is_root": node["is_root"],
                  # 闭包只沿 requires 展开，所以「到达该节点的边」实践中恒为 requires；
                  # related 只作为提示走 edges[]，永远不参与展开、也不会出现在这里。
                  "relation": "requires"}
                 for node in result["display_tree"]]
        # 边集合（R-25）：保留 **from_uid 落在闭包内**的所有边，to_uid 可以在闭包外。
        # 依据：`status == "capped"` 的边正是「上游已到达、但遍历深度用尽」——
        # 它的目标**不在**闭包里（`remaining == 0` 不再遍历）。若按「两端都要在
        # 闭包内」过滤，capped 边会被整批丢掉，节点视图的灰虚线就画不出来。
        # 前端对闭包外的目标渲染成「未展开（深度用尽）」小标记，名字从 detail.entries 查。
        edges = [{"from_uid": edge["from_uid"], "to_uid": edge["to_uid"],
                  "relation": edge["relation"], "status": edge["status"]}
                 for edge in result["resolved_edges"] if edge["from_uid"] in closure]
        return jsonify({
            "book_id": book.id,
            "entry_uids": wanted,
            "nodes": nodes,
            "edges": edges,
            "cycles": _dependency_cycles(closure, book.dependency_edges),
            "issues": result["issues"],
        })

    # ── 4.2 统一配置写入（分类 + 关联 + 起点 + 边，一次原子提交）──

    def _draft_candidate(book, data, preview=False):
        """把请求体合成一本候选书。校验失败即抛 ValueError，绝不写盘。"""
        if not isinstance(data, dict):
            raise ValueError("请求体必须是对象")
        candidate = copy.deepcopy(book)
        known = {e.uid for e in candidate.entries}

        if "categories" in data:
            candidate.categories = validate_categories(data.get("categories"))
        category_ids = {c["id"] for c in candidate.categories}

        moves = data.get("entry_moves") or {}
        if not isinstance(moves, dict) or any(uid not in known for uid in moves):
            raise ValueError("entry_moves 必须按有效条目 UID 指定目标分类")
        for entry in candidate.entries:
            if entry.uid in moves:
                target = moves[entry.uid]
                if not isinstance(target, str) or target not in category_ids:
                    raise ValueError(f"条目 {entry.uid} 的目标分类不存在")
                entry.category_id = target
            if entry.category_id not in category_ids:
                raise ValueError(f"请先为分类中的条目 {entry.uid} 指定迁移目标")

        updates = data.get("entry_updates") or {}
        if not isinstance(updates, dict) or any(uid not in known for uid in updates):
            raise ValueError("entry_updates 必须按有效条目 UID 指定")
        for entry in candidate.entries:
            patch = updates.get(entry.uid)
            if not isinstance(patch, dict):
                continue
            if "character_id" in patch:
                entry.character_id = str(patch["character_id"] or "").strip()
            if "category_id" in patch:
                target = patch["category_id"]
                if not isinstance(target, str) or target not in category_ids:
                    raise ValueError(f"条目 {entry.uid} 的目标分类不存在")
                entry.category_id = target

        # 角色分类必须带角色目录名；非角色分类不可关联角色（沿用既有约束）
        for entry in candidate.entries:
            kind = candidate.category_scope_type(entry.category_id)
            if kind == "character" and not entry.character_id:
                raise ValueError(f"角色分类的条目 {entry.uid} 必须关联角色标识（角色目录名）")
            if kind != "character" and entry.character_id:
                raise ValueError(f"非角色分类的条目 {entry.uid} 不可关联角色")

        mode = data.get("scope_mode", candidate.scope_mode)
        if mode not in ("legacy", "selective"):
            raise ValueError("scope_mode 必须是 legacy 或 selective")
        candidate.scope_mode = mode

        # 是否采用 v3 按需规则：**显式**才迁移。
        # v2 书普通保存（改分类、改边）绝不能隐式切到 v3 —— 预装书 fixed/sources
        # 都是空的，一旦隐式启用就会把候选清成空集。
        adopt_v3 = bool(book.v3_enabled or data.get("adopt_v3"))

        existing_rules = dict(candidate.dependency_rules or {})
        request_rejected = [r for r in (data.get("rejected") or []) if isinstance(r, dict)]
        if request_rejected:
            existing_rules["rejected"] = _union_edges(
                existing_rules.get("rejected") or [], request_rejected)

        manual_keys = ("roots", "requires_edges", "related_edges")
        migrating = adopt_v3 and not book.v3_enabled
        v3_payload = None
        if adopt_v3 and (any(key in data for key in manual_keys) or migrating
                         or "rejected" in data):
            if migrating:
                # 显式迁移：把旧来源（世界观 / 阵容 / 固定 / 导入源）按**等价**映射
                # 并入起点。用并集而不是「客户端没给才补」——否则只要草稿漏了一类
                # 旧来源，保存一次就会静默少载入一批条目。
                base = candidate.equivalent_v3_rules()
                # 客户端（用户当前草稿）在前：用户显式改过的起点优先，
                # 等价映射只补草稿没提到的旧来源。
                manual = {
                    "roots": [r for r in ((data.get("roots") or []) + base["roots"])
                              if isinstance(r, dict)],
                    "requires_edges": [e for e in ((data.get("requires_edges") or [])
                                                   + base["requires_edges"]) if isinstance(e, dict)],
                    "related_edges": [e for e in ((data.get("related_edges") or [])
                                                  + base["related_edges"]) if isinstance(e, dict)],
                }
            else:
                # 已经是 v3：**已持久化的规则**就是草稿基线。
                # 只覆盖本次请求显式给出的列表，没给的键保持不动 —— 否则一个
                # 「只带 rejected」的部分请求会把用户配好的起点 / 依赖静默清空；
                # 反过来也不能把 v2 等价映射重新并进来，
                # 那会让「收窄起点」永远不生效（P1-3 的第二段反证）。
                manual = {
                    "roots": data.get("roots", existing_rules.get("roots") or []),
                    "requires_edges": data.get("requires_edges", candidate.dependency_edges),
                    "related_edges": data.get("related_edges", candidate.related_edges),
                }

            # 旧数据兼容守卫：`edge_meta.locked` 是 AI 构建时代写入的字段，按 §4.4
            # 停写不删；这里只保证旧书读回后关系类型不被草稿静默改写，不产生任何新值。
            locked_meta = {key for key, meta in (existing_rules.get("edge_meta") or {}).items()
                           if isinstance(meta, dict) and meta.get("locked")}
            existing_requires = {(e["from_uid"], e["to_uid"]) for e in candidate.dependency_edges}
            existing_related = {(e["from_uid"], e["to_uid"]) for e in candidate.related_edges}
            manual_requires = {(e.get("from_uid"), e.get("to_uid")): e
                               for e in manual.get("requires_edges", []) if isinstance(e, dict)}
            manual_related = {(e.get("from_uid"), e.get("to_uid")): e
                              for e in manual.get("related_edges", []) if isinstance(e, dict)}
            for key in locked_meta:
                if "|" not in key:
                    continue
                pair = tuple(key.split("|", 1))
                edge = {"from_uid": pair[0], "to_uid": pair[1]}
                if pair in existing_requires:
                    manual_related.pop(pair, None)
                    manual_requires[pair] = edge
                elif pair in existing_related:
                    manual_requires.pop(pair, None)
                    manual_related[pair] = edge
            manual["requires_edges"] = list(manual_requires.values())
            manual["related_edges"] = list(manual_related.values())
            v3_payload = _merge_v3_payload(manual, existing_rules)

        if migrating and v3_payload is None:
            # 显式迁移但请求体什么都没带（例如只有 {"adopt_v3": true}）：整体走等价映射
            v3_payload = candidate.equivalent_v3_rules()

        if v3_payload is not None and adopt_v3:
            candidate.dependency_rules, candidate.dependency_edges, candidate.related_edges = (
                validate_v3_rules(known, v3_payload, candidate.dependency_edges))
            candidate.schema_version = SCHEMA_VERSION_V3
            # v2 字段与 v3 起点保持同步，旧消费者（导出、旧接口）仍可读
            candidate.import_config["fixed_entry_uids"] = sorted(
                r["entry_uid"] for r in candidate.dependency_rules["roots"]
                if r["activation"] == ACTIVATION_ALWAYS and r["expansion"] == EXPANSION_NONE)
            candidate.import_config["dependency_sources"] = [
                {"entry_uid": r["entry_uid"], "max_depth": r["max_depth"]}
                for r in candidate.dependency_rules["roots"]
                if r["expansion"] == EXPANSION_LEGACY_DEPTH]
        elif not adopt_v3:
            # v2 书普通保存：草稿里的起点按 v2 形态写回，范围**逐条等价**，
            # 世界观 / 阵容仍然由分类决定，不因为保存一次而改变候选。
            v2_data = {key: data[key] for key in
                       ("fixed_entry_uids", "dependency_sources", "dependency_edges")
                       if key in data}
            if any(key in data for key in manual_keys):
                roots = [r for r in (data.get("roots") or []) if isinstance(r, dict)]
                v2_data["fixed_entry_uids"] = sorted({
                    r.get("entry_uid") for r in roots
                    if r.get("activation") == ACTIVATION_ALWAYS
                    and r.get("expansion") == EXPANSION_NONE and r.get("entry_uid")})
                v2_data["dependency_sources"] = [
                    {"entry_uid": r["entry_uid"], "max_depth": r.get("max_depth", 0)}
                    for r in roots
                    if r.get("expansion") == EXPANSION_LEGACY_DEPTH and r.get("entry_uid")]
                if "requires_edges" in data:
                    v2_data["dependency_edges"] = data.get("requires_edges") or []
            if "related_edges" in data:
                _, _, candidate.related_edges = validate_v3_rules(
                    known, {"roots": [], "requires_edges": [],
                            "related_edges": data.get("related_edges") or []})
            if v2_data:
                config, edges = validate_policy(known, {
                    **candidate.import_config, **v2_data,
                }, candidate.dependency_edges)
                candidate.import_config.update(config)
                candidate.dependency_edges = edges

        if not preview:
            candidate.import_config["revision"] = book.import_config["revision"] + 1
        return candidate

    @bp.route("/api/worldbook/<book_id>/configuration", methods=["PUT"])
    def put_configuration(book_id):
        """统一写入：分类 / 角色关联 / 起点规则 / 依赖边，一次原子提交。

        按书锁覆盖「检查 → 提交」，因此并发写不会因为原子替换而丢更新；
        版本不一致返回 409，前端保留草稿。
        """
        data = request.json
        if not isinstance(data, dict):
            return json_error("请求体必须是对象")
        with wb_mgr.book_lock(book_id):
            book = wb_mgr.load(book_id)
            if not book:
                return json_error("世界书不存在", 404)
            expected = data.get("expected_revision", book.import_config["revision"])
            if expected != book.import_config["revision"]:
                return json_error("配置已变更，请重新加载后再保存", 409)
            try:
                candidate = _draft_candidate(book, data)
            except (TypeError, ValueError) as exc:
                return json_error(str(exc))
            candidate.record_policy_revision()
            wb_mgr.save(candidate)
        return jsonify({
            "book": _book_detail(candidate),
            "policy_revision": candidate.import_config["revision"],
            "content_revision": content_revision(candidate.entries),
            "applied": {
                "categories": len(candidate.categories),
                "roots": len((candidate.dependency_rules or {}).get("roots", [])),
                "requires_edges": len(candidate.dependency_edges),
                "related_edges": len(candidate.related_edges),
            },
        })

    # ── 5. 会话绑定（旧默认书接口仅返回迁移提示） ──

    @bp.route("/api/worldbook/<book_id>/default", methods=["POST"])
    def set_default(book_id):
        return json_error("全局默认世界书已取消，请在会话中绑定世界书", 410)

    @bp.route("/api/sessions/<session_id>/worldbooks", methods=["PUT"])
    def set_session_worldbooks(session_id, ids_override=None):
        session = session_mgr.get_session(session_id) if session_mgr else None
        if not session:
            return json_error("会话不存在", 404)
        data = request.get_json(silent=True) or {}
        ids = ids_override if ids_override is not None else data.get("worldbook_ids")
        if not isinstance(ids, list) or any(not isinstance(x, str) or not x.strip() for x in ids):
            return json_error("worldbook_ids 必须是世界书 ID 数组")
        ids = list(dict.fromkeys(x.strip() for x in ids))
        books = []
        for book_id in ids:
            book = wb_mgr.load(book_id)
            if book is None or not book.enabled:
                return json_error("世界书不存在或已停用", 404)
            if book.is_reference:
                return json_error("资料库不能绑定到会话", 409)
            books.append(book)
        previous = set(session.overlay.get_worldbook_ids())
        scopes = {book.id: (book.session_scope_snapshot(session.scene_manager.get_roster())
                             if book.v3_enabled else book.resolve_import_scope(session.scene_manager.get_roster()))
                  for book in books if book.id not in previous}
        session.overlay.set_worldbook_bindings(ids, scopes)
        return jsonify({"session_id": session_id, "worldbook_id": session.overlay.get_worldbook_id(),
                        "worldbook_ids": ids, "worldbook_scope": session.overlay.get_worldbook_scope(),
                        "worldbook_scopes": {bid: session.overlay.get_worldbook_scope(bid) for bid in ids}})

    @bp.route("/api/worldbook/<book_id>/bind", methods=["POST"])
    def bind_session(book_id):
        """绑定世界书到会话。body: {session_id, bound}。

        bound=false 时显式不使用世界书，不回落全局默认书。
        """
        data = request.json or {}
        session_id = str(data.get("session_id", "") or "").strip()
        bound = bool(data.get("bound", True))
        if not session_id:
            return json_error("需要 session_id 参数")
        if not session_mgr:
            return json_error("会话服务不可用", 503)
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        if bound:
            book, err = _get_book_or_404(book_id)
            if err:
                return err
            if book.is_reference:
                return json_error("资料库不能绑定到会话；请选择剧情世界书", 409)
        ids = session.overlay.get_worldbook_ids()
        ids = (ids + [book_id] if bound and book_id not in ids else
               [bid for bid in ids if bid != book_id] if not bound else ids)
        return set_session_worldbooks(session_id, ids)

    @bp.route("/api/worldbook/search", methods=["GET"])
    def search_books():
        """跨书/条目检索：书名、条目名、条目内容、触发词。

        可选 `book_type=story|reference` 只搜该用途的书（资料库检索是挑条目摘录的主入口）；
        不传则与旧行为一致，搜全部书。每个命中带来源书完整摘要（含 `book_type`）。
        """
        q = request.args.get("q", "").strip()
        book_type = request.args.get("book_type", "").strip()
        limit = request.args.get("limit", "30")
        try:
            limit = max(1, min(100, int(limit)))
        except (TypeError, ValueError):
            limit = 30
        if book_type:
            try:
                normalize_book_type(book_type)
            except ValueError as e:
                return json_error(str(e), 400)
        return jsonify({"results": wb_mgr.search_books(q, limit, book_type or None)})

    @bp.route("/api/worldbook/<book_id>/excerpt", methods=["POST"])
    def excerpt_entries(book_id):
        """把来源条目摘录进目标剧情世界书（**整批原子**）。

        body:
            {"items": [
                {"source_book_id": "...", "source_entry_uid": "...",
                 # 以下可选：省略即原文照搬
                 "name": ..., "content": ..., "trigger_keys": [...], "secondary_keys": [...],
                 "always_active": bool, "position": 0|1, "depth": int, "probability": int,
                 "category_id": ..., "character_id": ..., "enabled": bool}
            ]}

        服务端负责：来源书/来源 UID 存在性、目标必须是 story、正文非空、字段类型；
        目标条目一律生成新 UID，来源不被修改；任一条失败整批不落盘。
        返回创建条目、目标书新修订与最新摘要。
        """
        data = request.json or {}
        items = data.get("items")
        with wb_mgr.book_lock(book_id):
            try:
                result = wb_mgr.excerpt_entries(book_id, items)
            except LookupError as e:
                return json_error(str(e), 404)
            except ValueError as e:
                return json_error(str(e), 400)
            except OSError as e:
                # 写盘失败（磁盘满/权限/临时文件替换失败）：整批没落盘，缓存也没被污染
                logger.exception("摘录保存失败")
                return json_error(f"摘录保存失败，未写入任何条目：{e!s}", 500)
        return jsonify(result), 201

    @bp.route("/api/worldbook/resolve", methods=["GET"])
    def resolve_book():
        """查询会话当前生效的世界书。"""
        session_id = request.args.get("session_id", "").strip()
        overlay = None
        if session_id and session_mgr:
            session = session_mgr.get_session(session_id)
            if not session:
                return json_error("会话不存在", 404)
            overlay = session.overlay
        book = wb_mgr.resolve(overlay)
        if not book:
            return jsonify({"book": None, "books": [], "default_book_id": None})
        resolved = book.books if hasattr(book, "books") else [book]
        return jsonify({
            "book": _book_detail(resolved[0], include_entries=False),
            "books": [_book_detail(item, include_entries=False) for item in resolved],
            "default_book_id": None,
        })

    app.register_blueprint(bp)
