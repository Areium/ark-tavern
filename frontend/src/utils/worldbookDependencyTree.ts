/**
 * 条目依赖逐层展开（A-3）的**纯逻辑**。
 *
 * 服务端的 `GET /api/worldbook/<id>/dependency-tree` 已经把「多源到达取最大剩余深度、
 * 环终止、`remaining==0` 不再遍历」算完了（与 `resolve_v3_scope` 同一段 BFS）。这里只做
 * **展示层**的三件事：
 *   1. 多源到达去重（同一 uid 保留剩余深度最大的一次到达，其余标为重复）；
 *   2. 逐层展开的树形投影（默认 1 层、`related` 不算展开来源、环内节点不再向下）；
 *   3. breadcrumb 与 `remaining` 的人话文案。
 *
 * 前端**不自行截断依赖闭包**：只按「服务端给的子节点」渲染，`remaining==0` 或落在环内
 * 的行不再向下，这两类都是服务端已经终止遍历的情况。纯函数、无 React、无副作用。
 */
import type {
  WorldBookDependencyTreeNodeDTO, WorldBookDependencyTreeEdgeDTO, WorldBookIssueDTO,
} from "../types";

export const REMAINING_UNLIMITED_LABEL = "不限深度";
export const REMAINING_EXHAUSTED_LABEL = "深度已用尽";
export const CYCLE_STOP_NOTE = "依赖环：不再向下展开";
export const REPEATED_STOP_NOTE = "重复到达：默认不再展开";
export const LEAFLESS_NOTE = "没有可展开的必要依赖";
export const STATIC_RELATION_NOTE =
  "这是静态依赖关系，不代表该条目本轮一定载入；实际候选看「分类与载入」，实际注入看「Prompt 预览」。";

/** 树内最多渲染多少行（只影响显示，不影响候选与服务端结果）。 */
export const MAX_DEPENDENCY_TREE_ROWS = 400;

export const RELATION_LABELS: Record<string, string> = {
  requires: "必要依赖",
  related: "仅提示相关",
};

// ── 剩余深度 ────────────────────────────────────────────────────────────────

/** 剩余深度的排序权重：`null`（requires_closure 的不限深度）最强。 */
export const rankRemaining = (remaining: number | null | undefined): number =>
  (remaining === null || remaining === undefined ? Number.POSITIVE_INFINITY : remaining);

/** 人话文案：不限深度不能显示成 `null`。 */
export function remainingLabel(remaining: number | null | undefined): string {
  if (remaining === null || remaining === undefined) return REMAINING_UNLIMITED_LABEL;
  if (!Number.isFinite(remaining) || remaining <= 0) return REMAINING_EXHAUSTED_LABEL;
  return `还剩 ${remaining} 跳`;
}

// ── 环 ──────────────────────────────────────────────────────────────────────

/** 边 key：用不可能出现在 uid 里的分隔符，避免 `a|b` 与 `a|b|c` 之类的撞车。 */
export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** `cycles` 形如 `[["a","b","a"]]`（回到起点的路径）→ 环内边集合。 */
export function cycleEdgeSet(cycles: string[][] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const path of cycles || []) {
    if (!Array.isArray(path)) continue;
    for (let index = 0; index + 1 < path.length; index += 1) {
      if (path[index] && path[index + 1]) out.add(edgeKey(path[index], path[index + 1]));
    }
  }
  return out;
}

/** 环内节点集合。 */
export function cycleNodeSet(cycles: string[][] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const path of cycles || []) for (const uid of path || []) if (uid) out.add(uid);
  return out;
}

// ── 多源到达 ────────────────────────────────────────────────────────────────

export function pickStrongestArrival<T extends { remaining?: number | null }>(
  arrivals: T[] | null | undefined,
): T | null {
  let best: T | null = null;
  for (const arrival of arrivals || []) {
    if (!arrival) continue;
    if (!best || rankRemaining(arrival.remaining) > rankRemaining(best.remaining)) best = arrival;
  }
  return best;
}

export interface ArrivalNormalization {
  /** uid → 剩余深度最强的那次到达 */
  primary: Map<string, WorldBookDependencyTreeNodeDTO>;
  /** 被更强到达覆盖掉的其他到达 */
  repeated: WorldBookDependencyTreeNodeDTO[];
}

/**
 * 同一 uid 被多条路径到达时，只保留剩余深度最大的一次（平手保留先到的），
 * 其余进 `repeated`。服务端正常只回一条/uid，这里是防御性归一，不改服务端口径。
 */
export function normalizeArrivals(
  nodes: WorldBookDependencyTreeNodeDTO[] | null | undefined,
): ArrivalNormalization {
  const primary = new Map<string, WorldBookDependencyTreeNodeDTO>();
  const repeated: WorldBookDependencyTreeNodeDTO[] = [];
  for (const node of nodes || []) {
    if (!node || typeof node.uid !== "string" || !node.uid) continue;
    const known = primary.get(node.uid);
    if (!known) { primary.set(node.uid, node); continue; }
    if (rankRemaining(node.remaining) > rankRemaining(known.remaining)) {
      repeated.push(known);
      primary.set(node.uid, node);
    } else {
      repeated.push(node);
    }
  }
  return { primary, repeated };
}

// ── breadcrumb ──────────────────────────────────────────────────────────────

type NodeLookup = Map<string, WorldBookDependencyTreeNodeDTO>
  | Record<string, { parent_uid: string | null; name?: string } | undefined>;

const lookupNode = (
  byUid: NodeLookup, uid: string,
): { parent_uid: string | null; name?: string } | null => {
  if (byUid instanceof Map) return byUid.get(uid) || null;
  return (byUid && byUid[uid]) || null;
};

/**
 * 由 `nodes[].parent_uid` 逐级回溯到根，返回 `[root, ..., uid]`。
 * 父链断掉（父不在结果里）或父链成环时立即停止，绝不无限循环。
 */
export function breadcrumbUids(
  byUid: NodeLookup, uid: string, maxHops = 64,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = uid;
  while (current && !seen.has(current) && chain.length < maxHops) {
    seen.add(current);
    chain.unshift(current);
    const node = lookupNode(byUid, current);
    current = node && node.parent_uid ? node.parent_uid : null;
  }
  return chain;
}

export const nameOf = (byUid: NodeLookup, uid: string): string => {
  const node = lookupNode(byUid, uid);
  return (node && node.name) || uid;
};

/** `A → B → X` 形式的路径文案。 */
export const breadcrumbLabel = (byUid: NodeLookup, uid: string): string =>
  breadcrumbUids(byUid, uid).map((item) => nameOf(byUid, item)).join(" → ");

// ── 条目状态（issues）───────────────────────────────────────────────────────

export const ENTRY_STATUS_LABELS: Record<string, string> = {
  disabled_entry: "停用",
  empty_content: "正文为空",
  missing_entry: "不存在",
};

/** 条目的状态徽标：来自 `issues` 的 `disabled_entry` / `empty_content` / `missing_entry`。 */
export function entryStatusOf(
  issues: WorldBookIssueDTO[] | null | undefined, uid: string,
): { code: string; label: string } {
  for (const issue of issues || []) {
    if (!issue || issue.uid !== uid) continue;
    const code = String(issue.code || "");
    if (ENTRY_STATUS_LABELS[code]) return { code, label: ENTRY_STATUS_LABELS[code] };
  }
  return { code: "", label: "" };
}

// ── 树形投影 ────────────────────────────────────────────────────────────────

export interface DependencyTreeRelatedRef { uid: string; name: string }

export interface DependencyTreeRow {
  /** 渲染 key：同一 uid 的不同到达路径各有一行 */
  key: string;
  uid: string;
  name: string;
  depth: number;
  remaining: number | null;
  remainingLabel: string;
  relation: "requires" | "related";
  isRoot: boolean;
  /** 到达该行的边在环内 */
  viaCycleEdge: boolean;
  /** 该 uid 落在某个环里 */
  inCycle: boolean;
  /** 同一 uid 在本轮展开中第二次（及以后）到达 */
  repeated: boolean;
  /** 首次到达的 key；非重复行为 null */
  duplicateOf: string | null;
  /** 首次到达的路径（由 `parent_uid` 回溯） */
  duplicatePath: string;
  /** 灰行（重复到达，或位于被强制展开的重复子树内） */
  dimmed: boolean;
  path: string[];
  pathLabel: string;
  statusCode: string;
  statusLabel: string;
  /** `requires` 出边数（三角旁的徽标） */
  requiresChildCount: number;
  /** `related` 出边目标（仅提示，不参与展开） */
  relatedUids: DependencyTreeRelatedRef[];
  /** 行首三角（仅当存在 requires 出边、且不因环/深度用尽而终止） */
  expandable: boolean;
  /** 重复到达行可「仍要展开（仅查看）」 */
  forceable: boolean;
  /** 当前是否已渲染子行 */
  expanded: boolean;
  /** 停在这里的原因文案（无则为空串） */
  stopNote: string;
  children: DependencyTreeRow[];
}

export interface DependencyTreeOptions {
  /** 根 uid（组件传入，通常一个）；缺省时退回 `entry_uids` → `is_root` → 无父节点者 */
  rootUids?: string[];
  /** 展开到第几层：1 = 默认只展开根的一层，0 = 只显示根行 */
  expandedDepth?: number;
  /** 只看 requires：为 true 时不收集 related 提示 */
  requiresOnly?: boolean;
  /** 用户显式展开的行 key（越过深度上限 / 强制展开重复行） */
  forced?: Iterable<string> | null;
  /** 用户显式折叠的行 key */
  collapsed?: Iterable<string> | null;
  /**
   * 本地草稿里的 related 边：服务端可能按「两端都在闭包内」过滤掉闭包外的 related 边，
   * 补上它们只是为了把「仅提示相关」这一行显示出来（不参与展开，也不影响候选）。
   */
  relatedEdges?: Array<{ from_uid: string; to_uid: string }> | null;
  /** uid → 名称（补 related 目标 / 闭包外条目的显示名） */
  names?: Record<string, string> | null;
  maxRows?: number;
}

export interface DependencyTreeResult {
  rows: DependencyTreeRow[];
  /** 行总数（含所有层级） */
  rowCount: number;
  primaryCount: number;
  requiresEdgeCount: number;
  relatedEdgeCount: number;
  cycleCount: number;
  /** 是否因为行数上限截断显示 */
  truncated: boolean;
}

export interface DependencyTreeInput {
  nodes?: WorldBookDependencyTreeNodeDTO[] | null;
  edges?: WorldBookDependencyTreeEdgeDTO[] | null;
  /** 环内路径，形如 `[["a","b","a"]]` */
  cycles?: string[][] | null;
  issues?: WorldBookIssueDTO[] | null;
  /** 服务端回显的起点 uid */
  entry_uids?: string[] | null;
}

export function buildDependencyTree(
  input: DependencyTreeInput | null | undefined,
  options: DependencyTreeOptions = {},
): DependencyTreeResult {
  const nodes = (input && input.nodes) || [];
  const edges: WorldBookDependencyTreeEdgeDTO[] = (input && input.edges) || [];
  const cycles = (input && input.cycles) || [];
  const issues = (input && input.issues) || [];
  const extraNames = options.names || {};
  const { primary } = normalizeArrivals(nodes);
  const cycleEdges = cycleEdgeSet(cycles);
  const cycleNodes = cycleNodeSet(cycles);
  const nameFor = (uid: string): string => {
    const node = primary.get(uid);
    return (node && node.name) || extraNames[uid] || uid;
  };

  // 子节点来源：**只认 requires 边**（related 永远不参与展开）
  const requiresChildren = new Map<string, string[]>();
  const relatedTargets = new Map<string, string[]>();
  const pushUnique = (map: Map<string, string[]>, from: string, to: string) => {
    const list = map.get(from);
    if (!list) { map.set(from, [to]); return; }
    if (!list.includes(to)) list.push(to);
  };
  let requiresEdgeCount = 0;
  let relatedEdgeCount = 0;
  for (const edge of edges) {
    if (!edge) continue;
    if (edge.relation === "related") { relatedEdgeCount += 1; pushUnique(relatedTargets, edge.from_uid, edge.to_uid); }
    else { requiresEdgeCount += 1; pushUnique(requiresChildren, edge.from_uid, edge.to_uid); }
  }
  // 兜底：服务端只回节点（无 edges）时用 child_uids，语义仍是 requires 子树
  if (!edges.length) {
    for (const node of primary.values()) {
      const kids = (node.child_uids || []).filter((uid) => uid && uid !== node.uid);
      if (kids.length) requiresChildren.set(node.uid, kids);
    }
  }
  for (const edge of options.relatedEdges || []) {
    if (!edge || !edge.from_uid || !edge.to_uid || edge.from_uid === edge.to_uid) continue;
    pushUnique(relatedTargets, edge.from_uid, edge.to_uid);
  }

  const rootUids = (() => {
    const explicit = (options.rootUids || []).filter(Boolean);
    if (explicit.length) return explicit;
    const echoed = ((input && input.entry_uids) || []).filter(Boolean);
    if (echoed.length) return echoed;
    const flagged = [...primary.values()].filter((node) => node.is_root).map((node) => node.uid);
    if (flagged.length) return flagged.sort();
    return [...primary.values()].filter((node) => !node.parent_uid).map((node) => node.uid).sort();
  })();

  const expandedDepth = Number.isFinite(options.expandedDepth)
    ? Math.max(0, Math.floor(options.expandedDepth as number)) : 1;
  const forced = new Set(options.forced || []);
  const collapsed = new Set(options.collapsed || []);
  const maxRows = Number.isFinite(options.maxRows) && (options.maxRows as number) > 0
    ? Math.floor(options.maxRows as number) : MAX_DEPENDENCY_TREE_ROWS;

  const firstSeenUid = new Map<string, string>();
  let rowCount = 0;
  let truncated = false;

  const childUidsOf = (uid: string): string[] =>
    [...new Set((requiresChildren.get(uid) || []).filter((target) => target && target !== uid))].sort();

  const walk = (
    uid: string, parentKey: string | null, depth: number, isRoot: boolean,
    viaCycleEdge: boolean, grey: boolean, chain: string[],
  ): DependencyTreeRow | null => {
    if (rowCount >= maxRows) { truncated = true; return null; }
    rowCount += 1;
    const key = parentKey ? `${parentKey}\u0000${uid}` : uid;
    const node = primary.get(uid);
    // 树里的行都经由 requires 边到达；related 只作行内提示，不成为可展开的行
    const relation: DependencyTreeRow["relation"] = "requires";
    const firstKey = firstSeenUid.get(uid) || null;
    const repeated = firstKey !== null && firstKey !== key;
    if (firstKey === null) firstSeenUid.set(uid, key);
    const path = [...chain, uid];
    const stopByCycle = viaCycleEdge && cycleNodes.has(uid);
    const stopByRemaining = !!node && node.remaining === 0;
    const childUids = childUidsOf(uid);
    const requiresChildCount = childUids.length;
    // 依赖指向结果里没有的条目（服务端未回该节点）→ 明确标「不存在」，不静默吞掉
    const status = node
      ? entryStatusOf(issues, uid)
      : { code: "missing_entry", label: ENTRY_STATUS_LABELS.missing_entry };
    const relatedUids: DependencyTreeRelatedRef[] = options.requiresOnly ? []
      : [...new Set(relatedTargets.get(uid) || [])]
        .filter((target) => target && target !== uid)
        .sort()
        .map((target) => ({ uid: target, name: nameFor(target) }));

    const canWalkDown = !stopByCycle && !stopByRemaining;
    const forceable = repeated && requiresChildCount > 0 && canWalkDown && !forced.has(key);
    let expanded = false;
    if (canWalkDown && requiresChildCount && !collapsed.has(key)) {
      if (forced.has(key)) expanded = true;
      else if (repeated) expanded = false;
      else expanded = depth < expandedDepth;
    }
    let stopNote = "";
    if (stopByCycle) stopNote = CYCLE_STOP_NOTE;
    else if (stopByRemaining) stopNote = REMAINING_EXHAUSTED_LABEL + "（服务端未继续遍历）";
    else if (repeated && requiresChildCount) stopNote = REPEATED_STOP_NOTE;
    else if (isRoot && !requiresChildCount) stopNote = LEAFLESS_NOTE;

    const row: DependencyTreeRow = {
      key, uid, name: node ? (node.name || uid) : nameFor(uid), depth,
      remaining: node ? (node.remaining ?? null) : null,
      remainingLabel: remainingLabel(node ? node.remaining : null),
      relation, isRoot, viaCycleEdge, inCycle: cycleNodes.has(uid),
      repeated, duplicateOf: firstKey, duplicatePath: repeated ? breadcrumbLabel(primary, uid) : "",
      dimmed: repeated || grey,
      path, pathLabel: path.map((item) => nameFor(item)).join(" → "),
      statusCode: status.code, statusLabel: status.label,
      requiresChildCount, relatedUids,
      expandable: requiresChildCount > 0 && canWalkDown && !repeated,
      forceable, expanded, stopNote,
      children: [],
    };
    if (expanded) {
      const childGrey = grey || repeated;
      for (const child of childUids) {
        const childRow = walk(child, key, depth + 1, false,
          cycleEdges.has(edgeKey(uid, child)), childGrey, path);
        if (childRow) row.children.push(childRow);
        if (truncated) break;
      }
      if (!row.children.length) row.expanded = false;
    }
    return row;
  };

  const rows: DependencyTreeRow[] = [];
  for (const uid of rootUids) {
    const row = walk(uid, null, 0, true, false, false, []);
    if (row) rows.push(row);
    if (truncated) break;
  }

  return {
    rows, rowCount,
    primaryCount: primary.size,
    requiresEdgeCount, relatedEdgeCount,
    cycleCount: (cycles || []).length,
    truncated,
  };
}
