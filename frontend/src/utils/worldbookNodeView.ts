/**
 * 世界书节点视图（A-4，提案 §3.4）的**纯逻辑**：轨道排序 / 渲染模型 / 确定性布局 / 统计 / 视觉映射。
 *
 * 三条纪律，读代码前先读这里：
 *
 * 1. **去重口径不属于本模块**。谁在候选闭包里、谁被 `best` 表（最大剩余深度）判定为重复，
 *    全部由服务端 `resolve_v3_scope` 的读时派生字段给出：`display_tree[].repeated /
 *    first_parent_uid / display_index`（契约 R-10）与 `resolved_edges[].status`（R-11）。
 *    这里**不做第二套去重**，只把服务端字段投影成渲染模型。
 * 2. 前端唯一的判断是提案 §3.4.3.1 写死的「主节点唯一」规则：**同一 uid 只有一个主节点，
 *    轨道上的出现优先**；轨道上没有它的位置时（例如条目已停用 / 空正文），取最早到达的
 *    那个展开位置。其余出现位置一律是灰节点 —— 这是「同一个 uid 的多个出现位置里哪个是主
 *    节点」的显示规则，不是重新判定谁在闭包里。
 * 3. 全部是纯函数：不改入参、同输入同输出。布局不含随机数、不含时间、不读 DOM、不做动画，
 *    所以同一份输入永远得到同一张图（提案 §3.4.6「布局完全确定性」）。
 */
import type {
  WorldBookActivation, WorldBookDetail, WorldBookDisplayNodeDTO, WorldBookDependencyEdgeDTO,
  WorldBookEdgeStatus, WorldBookEntryDTO, WorldBookExpansion, WorldBookIssueDTO,
  WorldBookRootDTO, WorldBookScopePreviewDTO,
} from "../types";
import { ACTIVATION_LABELS, EXPANSION_LABELS } from "../components/worldbook/panel";

/* ── 规模常量（提案 §3.4.6 / §3.4.7，契约 R-13）──────────────────────────────── */

/** 轨道条目超过这个数量时启用虚拟化（只渲染视口内节点与其子树） */
export const TRACK_VIRTUALIZE_THRESHOLD = 120;
/** 展开子树（不含轨道）的显示上限；超出的部分只隐藏显示，不影响真实候选 */
export const SUBTREE_NODE_LIMIT = 400;
/** 「展开到 N 层」默认覆盖约这么多节点 */
export const DEFAULT_EXPAND_NODE_BUDGET = 60;
/** 右侧属性栏里最多列出的依赖边条数（超出只提示总数） */
export const DOWNSTREAM_EDGE_LIMIT = 60;

export const NODE_WIDTH = 132;
export const NODE_HEIGHT = 46;
export const SLOT_WIDTH = 150;
export const ROW_HEIGHT = 96;
export const TRACK_GAP = 30;
export const CANVAS_PADDING = 28;

/* ── 轨道排序（提案 §3.4.2）────────────────────────────────────────────────── */

export interface NodeViewTrackRow {
  /** 轨道节点 key（`track#<uid>`），在全视图内唯一 */
  key: string;
  uid: string;
  name: string;
  /** 0-based 位次，即节点上方显示的静态序号 */
  seq: number;
  position: number;
  depth: number;
  group_weight: number;
  entry: WorldBookEntryDTO;
}

const numeric = (value: unknown, fallback: number): number =>
  (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** 轨道条目 = 全书「启用且有正文」的条目（提案 §3.4.1） */
export function isTrackEntry(entry: WorldBookEntryDTO | null | undefined): boolean {
  if (!entry || typeof entry.uid !== "string" || !entry.uid) return false;
  if (entry.enabled === false) return false;
  return String(entry.content ?? "").trim() !== "";
}

/**
 * 与 `src/world_book.py:1380` 的真实注入排序键逐字一致：
 * `position` 升序 → `group_weight` 降序 → `depth` 升序 → `uid` 升序。
 *
 * uid 比较用 `String` 的 UTF-16 码元序（uid 是 ASCII slug，与 Python 的字符串序一致）；
 * 显式写全四个键，所以排序结果与引擎的排序实现无关，永远稳定。
 */
export function compareInjectionOrder(
  a: Pick<WorldBookEntryDTO, "uid" | "position" | "depth" | "group_weight">,
  b: Pick<WorldBookEntryDTO, "uid" | "position" | "depth" | "group_weight">,
): number {
  const position = numeric(a.position, 0) - numeric(b.position, 0);
  if (position !== 0) return position;
  const weight = numeric(b.group_weight, 100) - numeric(a.group_weight, 100);
  if (weight !== 0) return weight;
  const depth = numeric(a.depth, 4) - numeric(b.depth, 4);
  if (depth !== 0) return depth;
  const left = String(a.uid ?? "");
  const right = String(b.uid ?? "");
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 轨道：全书启用且有正文的条目，按静态注入排序键从左到右排成单一序列。 */
export function trackOrder(entries: WorldBookEntryDTO[] | null | undefined): NodeViewTrackRow[] {
  const rows = (entries || []).filter(isTrackEntry).slice();
  rows.sort(compareInjectionOrder);
  return rows.map((entry, seq) => ({
    key: trackNodeKey(entry.uid),
    uid: entry.uid,
    name: entry.name || entry.uid,
    seq,
    position: numeric(entry.position, 0),
    depth: numeric(entry.depth, 4),
    group_weight: numeric(entry.group_weight, 100),
    entry,
  }));
}

export const trackNodeKey = (uid: string) => `track#${uid}`;
export const rowNodeKey = (uid: string, index: number) => `tree#${uid}#${index}`;
export const ghostNodeKey = (uid: string) => `ghost#${uid}`;

/* ── 渲染模型（服务端字段 → 渲染模型 的纯投影）──────────────────────────────── */

export type NodeViewNodeKind = "track" | "expansion" | "orphan" | "ghost";

export interface NodeViewProblem {
  code: string;
  severity: string;
  message: string;
}

export interface NodeViewRootBadge {
  activation: WorldBookActivation | null;
  expansion: WorldBookExpansion | null;
  activationLabel: string;
  /** `legacy_depth` 带 `+N`（提案 §3.4.2） */
  expansionLabel: string;
}

export interface NodeViewPathStep {
  uid: string;
  name: string;
  /** 该级的渲染节点 key；主节点缺失时为 `""`（不可跳转） */
  key: string;
}

export interface NodeViewNode {
  key: string;
  uid: string;
  name: string;
  kind: NodeViewNodeKind;
  /** 主节点：同一 uid 唯一的那个正式节点（轨道优先） */
  isPrimary: boolean;
  /** 灰节点：该 uid 在本视图里的非首次到达 */
  isRepeated: boolean;
  onTrack: boolean;
  /** 被任何起点覆盖（出现在 display_tree 里） */
  covered: boolean;
  /** 轨道上的游离条目：未被任何起点覆盖 */
  loose: boolean;
  /** 深度用尽（capped 边）指向、且没有别处出现位置的只读占位节点 */
  ghost: boolean;
  /** 轨道位次（0-based），非轨道节点为 null */
  trackSeq: number | null;
  /** `display_tree` 位次（服务端派生；缺失时按数组下标降级） */
  displayIndex: number | null;
  parentUid: string | null;
  /** `display_tree[].first_parent_uid`（缺失时回落 `parent_uid`） */
  firstParentUid: string | null;
  parentKey: string | null;
  childKeys: string[];
  /** 渲染深度：轨道 0，向下逐层 +1 */
  depth: number;
  remaining: number | null;
  isRoot: boolean;
  rootBadge: NodeViewRootBadge | null;
  /** 到达该节点的那条边的状态（轨道主节点为 null） */
  arrivalStatus: WorldBookEdgeStatus | null;
  problems: NodeViewProblem[];
  position: number;
  groupWeight: number;
  entryDepth: number;
  categoryId: string | null;
  categoryName: string | null;
  /** 本轮实际命中序号（仅主节点；来自 Prompt 预览联动） */
  actualSeq: number | null;
  actualLayer: "stable" | "dynamic" | null;
  /** 到达路径 breadcrumb（含自身，最后一级是当前节点） */
  path: NodeViewPathStep[];
}

export interface NodeViewEdge {
  key: string;
  fromKey: string;
  toKey: string;
  fromUid: string;
  toUid: string;
  relation: "requires" | "related";
  status: WorldBookEdgeStatus;
  kind: "skeleton" | "cross" | "capped" | "related";
  /** 位于依赖环内（纯函数判环，见 findCycleEdgeKeys） */
  inCycle: boolean;
}

export interface NodeViewModel {
  bookId: string;
  bookName: string;
  track: NodeViewTrackRow[];
  nodes: NodeViewNode[];
  edges: NodeViewEdge[];
  byKey: Record<string, NodeViewNode>;
  /** display_tree 里去重后的 uid（每个 uid 只算一次 = 主节点口径） */
  coveredUids: string[];
  /** 环内边（`from|to`），已排序 */
  cycleEdgeKeys: string[];
  /** Prompt 预览联动是否生效（仅当 bookId 与当前书一致） */
  promptOrderApplied: boolean;
  promptMode: "narrative" | "free" | null;
  /** 灰节点数 / 主节点数（供统计与断言；灰节点不参与序号与范围计数） */
  primaryCount: number;
  repeatedCount: number;
  warnings: string[];
}

/** Prompt 预览联动值（appStore.promptPreviewOrder 的只读投影，契约 R-6 / §2.1） */
export interface PromptOrderLike {
  bookId: string;
  mode: "narrative" | "free";
  order: Array<{
    uid: string; seq: number; layer: "stable" | "dynamic";
    position: number; group_weight: number; depth: number;
  }>;
}

const isRootRow = (row: WorldBookDisplayNodeDTO): boolean => !row.parent_uid;

function badgeOf(root: WorldBookRootDTO | undefined): NodeViewRootBadge | null {
  if (!root) return null;
  const expansion = root.expansion ?? null;
  const depth = typeof root.max_depth === "number" ? root.max_depth : null;
  const expansionLabel = expansion
    ? `${EXPANSION_LABELS[expansion] || expansion}${expansion === "legacy_depth" && depth !== null ? ` +${depth}` : ""}`
    : "未标注展开方式";
  return {
    activation: root.activation ?? null,
    expansion,
    activationLabel: root.activation ? (ACTIVATION_LABELS[root.activation] || root.activation) : "未标注激活方式",
    expansionLabel,
  };
}

/**
 * 把 `display_tree` / `resolved_edges` / `active_roots` / `issues` / Prompt 预览顺序
 * 投影成渲染模型。纯函数，不改入参。
 *
 * 主节点规则（提案 §3.4.3.1）：轨道上的出现优先；轨道上没有时取最早到达的展开位置。
 * 服务端派生字段缺失时**优雅降级**：`repeated` 视为 false、`display_index` 用数组下标、
 * `first_parent_uid` 回落 `parent_uid` —— 只做投影，不在这里重新推导去重。
 */
export function buildNodeViewModel(
  preview: WorldBookScopePreviewDTO | null,
  detail: WorldBookDetail | null,
  promptOrder: PromptOrderLike | null = null,
): NodeViewModel {
  const bookId = detail?.id || "";
  const entries = detail?.entries || [];
  const entryByUid = new Map<string, WorldBookEntryDTO>();
  for (const entry of entries) entryByUid.set(entry.uid, entry);
  const categoryNames = new Map<string, string>();
  for (const category of detail?.categories || []) categoryNames.set(category.id, category.name);

  const track = trackOrder(entries);
  const trackByUid = new Map(track.map((row) => [row.uid, row] as const));

  const treeRows = preview?.display_tree || [];
  const resolvedEdges = preview?.resolved_edges || [];
  const warnings: string[] = [];
  if (treeRows.length && treeRows.some((row) => typeof row.repeated !== "boolean"
    || typeof row.display_index !== "number" || row.first_parent_uid === undefined)) {
    warnings.push("display_tree 缺少服务端读时派生字段（repeated / first_parent_uid / display_index）：按「首次到达」降级渲染，不额外自算去重。");
  }
  if (!treeRows.length && (resolvedEdges.length > 0 || (preview?.scope?.resolved_entry_uids || []).length > 0)) {
    warnings.push("服务端没有返回 display_tree（这本书可能还没启用按需载入）：节点视图只渲染轨道，不画依赖展开（capped 边仍会给出深度用尽的只读占位节点）。");
  }

  interface RowRef { row: WorldBookDisplayNodeDTO; index: number; displayIndex: number }
  const rows: RowRef[] = treeRows.map((row, index) => ({
    row, index, displayIndex: numeric(row.display_index, index),
  }));
  const rowsByUid = new Map<string, RowRef[]>();
  for (const ref of rows) {
    const list = rowsByUid.get(ref.row.uid);
    if (list) list.push(ref); else rowsByUid.set(ref.row.uid, [ref]);
  }
  for (const list of rowsByUid.values()) {
    list.sort((a, b) => a.displayIndex - b.displayIndex || a.index - b.index);
  }
  const earliestRef = (uid: string): RowRef | null => rowsByUid.get(uid)?.[0] || null;

  /** 该行由哪个渲染节点代表：轨道主节点（根行）或它自己的展开位置 */
  const rowKeyOf = (ref: RowRef): string =>
    (trackByUid.has(ref.row.uid) && isRootRow(ref.row) ? trackNodeKey(ref.row.uid) : rowNodeKey(ref.row.uid, ref.index));

  const primaryKeyOf = (uid: string): string | null => {
    if (trackByUid.has(uid)) return trackNodeKey(uid);
    const ref = earliestRef(uid);
    return ref ? rowKeyOf(ref) : null;
  };

  const problemsByUid = new Map<string, NodeViewProblem[]>();
  for (const issue of (preview?.issues || []) as WorldBookIssueDTO[]) {
    if (!issue?.uid) continue;
    const list = problemsByUid.get(issue.uid);
    const problem = { code: issue.code, severity: issue.severity, message: issue.message };
    if (list) list.push(problem); else problemsByUid.set(issue.uid, [problem]);
  }
  const rootsByUid = new Map<string, WorldBookRootDTO>();
  for (const root of preview?.active_roots || []) {
    if (root?.entry_uid && !rootsByUid.has(root.entry_uid)) rootsByUid.set(root.entry_uid, root);
  }

  const nodes: NodeViewNode[] = [];
  const byKey: Record<string, NodeViewNode> = {};
  const addNode = (node: NodeViewNode) => {
    if (byKey[node.key]) return;   // 兜底：同一 key 只建一次，保证主节点唯一
    byKey[node.key] = node;
    nodes.push(node);
  };
  const entryFields = (uid: string) => {
    const entry = entryByUid.get(uid) || null;
    const categoryId = entry?.category_id || null;
    return {
      name: entry?.name || uid,
      position: numeric(entry?.position, 0),
      groupWeight: numeric(entry?.group_weight, 100),
      entryDepth: numeric(entry?.depth, 4),
      categoryId,
      categoryName: categoryId ? (categoryNames.get(categoryId) || null) : null,
    };
  };

  // ── 1) 轨道节点：全书启用且有正文的条目，即使未被任何起点覆盖也留在轨道上 ──
  for (const row of track) {
    const ref = earliestRef(row.uid);
    const fields = entryFields(row.uid);
    addNode({
      key: row.key, uid: row.uid, name: fields.name, kind: "track",
      isPrimary: true, isRepeated: false, onTrack: true,
      covered: !!ref, loose: !ref, ghost: false,
      trackSeq: row.seq, displayIndex: null,
      parentUid: null, firstParentUid: null, parentKey: null, childKeys: [],
      depth: 0, remaining: null, isRoot: rootsByUid.has(row.uid),
      rootBadge: badgeOf(rootsByUid.get(row.uid)), arrivalStatus: null,
      problems: problemsByUid.get(row.uid) || [],
      position: fields.position, groupWeight: fields.groupWeight, entryDepth: fields.entryDepth,
      categoryId: fields.categoryId, categoryName: fields.categoryName,
      actualSeq: null, actualLayer: null, path: [],
    });
  }

  // ── 2) 根行与轨道主节点合并：子节点直接挂在轨道节点下面（§3.4.1 的示意） ──
  for (const ref of rows) {
    if (rowKeyOf(ref) !== trackNodeKey(ref.row.uid)) continue;
    const node = byKey[trackNodeKey(ref.row.uid)];
    if (!node) continue;
    node.displayIndex = ref.displayIndex;
    node.depth = numeric(ref.row.depth, 0);
    node.remaining = ref.row.remaining ?? null;
    node.isRoot = true;
    node.covered = true;
    node.loose = false;
  }

  // ── 3) 展开位置：非首次到达的一律是灰节点 ──
  for (const ref of rows) {
    if (rowKeyOf(ref) === trackNodeKey(ref.row.uid)) continue;
    const uid = ref.row.uid;
    const onTrack = trackByUid.has(uid);
    const earliest = earliestRef(uid);
    const earliestIndex = earliest ? earliest.index : ref.index;
    // 轨道已有主节点 → 这次展开必然是非首次到达；
    // 轨道上没有它 → 最早到达的那次是主节点，其余（含服务端标 repeated 的）是灰节点。
    const isRepeated = onTrack
      || ref.index !== earliestIndex
      || ref.row.repeated === true;
    const fields = entryFields(uid);
    addNode({
      key: rowNodeKey(uid, ref.index), uid, name: ref.row.name || fields.name,
      kind: isRootRow(ref.row) ? "orphan" : "expansion",
      isPrimary: !isRepeated, isRepeated, onTrack,
      covered: true, loose: false, ghost: false,
      trackSeq: null, displayIndex: ref.displayIndex,
      parentUid: ref.row.parent_uid ?? null,
      firstParentUid: ref.row.first_parent_uid ?? ref.row.parent_uid ?? null,
      parentKey: null, childKeys: [],
      depth: numeric(ref.row.depth, 0),
      remaining: ref.row.remaining ?? null,
      isRoot: !!ref.row.is_root || isRootRow(ref.row),
      rootBadge: badgeOf(rootsByUid.get(uid)),
      arrivalStatus: null,
      problems: problemsByUid.get(uid) || [],
      position: fields.position, groupWeight: fields.groupWeight, entryDepth: fields.entryDepth,
      categoryId: fields.categoryId, categoryName: fields.categoryName,
      actualSeq: null, actualLayer: null, path: [],
    });
  }

  // ── 4) capped（深度用尽）目标若在别处都没有出现位置，给一个只读占位节点 ──
  const requiresEdges = resolvedEdges.filter((edge) => edge.relation !== "related");
  for (const edge of requiresEdges) {
    if (edge.status !== "capped") continue;
    if (primaryKeyOf(edge.to_uid)) continue;
    const parentKey = primaryKeyOf(edge.from_uid);
    if (!parentKey || !byKey[parentKey]) continue;
    const key = ghostNodeKey(edge.to_uid);
    if (byKey[key]) continue;
    const fields = entryFields(edge.to_uid);
    addNode({
      key, uid: edge.to_uid, name: fields.name, kind: "ghost",
      isPrimary: false, isRepeated: true, onTrack: false,
      covered: false, loose: false, ghost: true,
      trackSeq: null, displayIndex: null,
      parentUid: edge.from_uid, firstParentUid: edge.from_uid, parentKey, childKeys: [],
      depth: 0, remaining: 0, isRoot: false, rootBadge: null,
      arrivalStatus: "capped", problems: problemsByUid.get(edge.to_uid) || [],
      position: fields.position, groupWeight: fields.groupWeight, entryDepth: fields.entryDepth,
      categoryId: fields.categoryId, categoryName: fields.categoryName,
      actualSeq: null, actualLayer: null, path: [],
    });
  }

  // ── 5) 父子关系：display_tree 的父子是骨架；capped 占位节点挂在它的上游下面 ──
  const childrenOf = new Map<string, string[]>();
  const pushChild = (parentKey: string, childKey: string) => {
    const list = childrenOf.get(parentKey);
    if (list) list.push(childKey); else childrenOf.set(parentKey, [childKey]);
  };
  for (const ref of rows) {
    const parentUid = ref.row.parent_uid;
    if (!parentUid) continue;
    const parentRef = earliestRef(parentUid);
    const parentKey = parentRef ? rowKeyOf(parentRef) : primaryKeyOf(parentUid);
    const childKey = rowKeyOf(ref);
    if (!parentKey || !byKey[parentKey] || !byKey[childKey] || parentKey === childKey) continue;
    byKey[childKey].parentKey = parentKey;
    pushChild(parentKey, childKey);
  }
  for (const node of nodes) {
    if (node.kind !== "ghost" || !node.parentKey || !byKey[node.parentKey]) continue;
    pushChild(node.parentKey, node.key);
  }
  for (const node of nodes) {
    const kids = childrenOf.get(node.key) || [];
    kids.sort((a, b) => compareUid(byKey[a]?.uid || a, byKey[b]?.uid || b));
    node.childKeys = kids;
  }

  // ── 6) 边：skeleton 用 display_tree 父子关系，cross / capped / related 用 resolved_edges ──
  const cycleEdgeKeys = findCycleEdgeKeys(requiresEdges.map((edge) => ({ from_uid: edge.from_uid, to_uid: edge.to_uid })));
  const cycleSet = new Set(cycleEdgeKeys);
  const edges: NodeViewEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  const addEdge = (edge: Omit<NodeViewEdge, "key">) => {
    const key = `${edge.kind}:${edge.fromKey}=>${edge.toKey}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    edges.push({ key, ...edge });
  };
  const statusOf = new Map<string, WorldBookEdgeStatus>();
  for (const edge of requiresEdges) statusOf.set(`${edge.from_uid}|${edge.to_uid}`, edge.status);

  for (const ref of rows) {
    const parentUid = ref.row.parent_uid;
    if (!parentUid) continue;
    const childKey = rowKeyOf(ref);
    const node = byKey[childKey];
    if (!node || !node.parentKey) continue;
    const pair = `${parentUid}|${ref.row.uid}`;
    const status = statusOf.get(pair) || "skeleton";
    node.arrivalStatus = node.arrivalStatus || status;
    addEdge({
      fromKey: node.parentKey, toKey: childKey, fromUid: parentUid, toUid: ref.row.uid,
      relation: "requires", status, kind: "skeleton", inCycle: cycleSet.has(pair),
    });
  }

  const nodeKeyForUid = (uid: string): string | null => {
    const primary = primaryKeyOf(uid);
    if (primary && byKey[primary]) return primary;
    const ghost = ghostNodeKey(uid);
    return byKey[ghost] ? ghost : null;
  };
  /** 该 uid 的展开出现位置（根行与轨道主节点合并时就是轨道节点） */
  const rowKeyForUid = (uid: string): string | null => {
    const ref = earliestRef(uid);
    if (!ref) return null;
    const key = rowKeyOf(ref);
    return byKey[key] ? key : null;
  };
  for (const edge of requiresEdges) {
    if (edge.status !== "cross" && edge.status !== "capped") continue;
    const fromKey = primaryKeyOf(edge.from_uid);
    // cross：边确实生效了，但目标在别处已经被覆盖 → 指向目标在展开里的那个（灰）出现位置；
    // capped：目标这次根本没被遍历 → 指向它的主节点（轨道位置 / 展开位置），都没有就给只读占位节点。
    const toKey = edge.status === "cross"
      ? (rowKeyForUid(edge.to_uid) || nodeKeyForUid(edge.to_uid))
      : nodeKeyForUid(edge.to_uid);
    if (!fromKey || !toKey || !byKey[fromKey] || !byKey[toKey] || fromKey === toKey) continue;
    addEdge({
      fromKey, toKey, fromUid: edge.from_uid, toUid: edge.to_uid,
      relation: "requires", status: edge.status, kind: edge.status,
      inCycle: cycleSet.has(`${edge.from_uid}|${edge.to_uid}`),
    });
  }
  const coveredSet = new Set(rows.map((ref) => ref.row.uid));
  for (const edge of resolvedEdges) {
    if (edge.relation !== "related") continue;
    // 两端都在候选闭包内才画：related 只做图示，画在闭包外会糊成一片。
    if (!coveredSet.has(edge.from_uid) || !coveredSet.has(edge.to_uid)) continue;
    const fromKey = primaryKeyOf(edge.from_uid);
    const toKey = primaryKeyOf(edge.to_uid);
    if (!fromKey || !toKey || !byKey[fromKey] || !byKey[toKey] || fromKey === toKey) continue;
    addEdge({
      fromKey, toKey, fromUid: edge.from_uid, toUid: edge.to_uid,
      relation: "related", status: edge.status || "idle", kind: "related", inCycle: false,
    });
  }
  const nodeOrder = new Map(nodes.map((node, index) => [node.key, index] as const));
  edges.sort((a, b) => (nodeOrder.get(a.fromKey)! - nodeOrder.get(b.fromKey)!)
    || (nodeOrder.get(a.toKey)! - nodeOrder.get(b.toKey)!)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // ── 7) 到达路径 breadcrumb：从顶层往下，逐级可点跳转 ──
  const pathCache = new Map<string, NodeViewPathStep[]>();
  const pathOf = (key: string): NodeViewPathStep[] => {
    const cached = pathCache.get(key);
    if (cached) return cached;
    const node = byKey[key];
    if (!node) return [];
    const chain: NodeViewPathStep[] = [];
    const guard = new Set<string>();
    let cursor: NodeViewNode | undefined = node;
    while (cursor && !guard.has(cursor.key)) {
      guard.add(cursor.key);
      chain.unshift({ uid: cursor.uid, name: cursor.name, key: cursor.key });
      cursor = cursor.parentKey ? byKey[cursor.parentKey] : undefined;
    }
    pathCache.set(key, chain);
    return chain;
  };
  for (const node of nodes) node.path = pathOf(node.key);

  // ── 8) 本轮命中叠加（仅当预览结果属于当前这本书；只叠加在主节点上） ──
  const promptOrderApplied = !!promptOrder && !!bookId && promptOrder.bookId === bookId;
  if (promptOrderApplied && promptOrder) {
    const matched = new Map<string, { seq: number; layer: "stable" | "dynamic" }>();
    for (const item of promptOrder.order || []) {
      if (!item?.uid || matched.has(item.uid)) continue;
      matched.set(item.uid, { seq: item.seq, layer: item.layer });
    }
    for (const node of nodes) {
      const hit = matched.get(node.uid);
      if (!hit) continue;
      if (!node.isPrimary) continue;   // 灰节点不参与序号
      node.actualSeq = hit.seq;
      node.actualLayer = hit.layer;
    }
  }

  let primaryCount = 0;
  let repeatedCount = 0;
  for (const node of nodes) {
    if (node.isPrimary) primaryCount += 1; else repeatedCount += 1;
  }

  return {
    bookId,
    bookName: detail?.name || bookId,
    track,
    nodes,
    edges,
    byKey,
    coveredUids: [...coveredSet].sort(compareUid),
    cycleEdgeKeys,
    promptOrderApplied,
    promptMode: promptOrderApplied && promptOrder ? promptOrder.mode : null,
    primaryCount,
    repeatedCount,
    warnings,
  };
}

export const compareUid = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ── 判环（纯函数，提案 §3.4.4 红虚线）──────────────────────────────────────── */

/**
 * 找出「位于依赖环内」的边，返回排序后的 `from|to` 列表。
 *
 * 用强连通分量判定：一条边 `u→v` 在环上 ⟺ u 与 v 属于同一个强连通分量，且该分量
 * 规模 > 1（或 u === v 的自环）。这样「两端互为祖先」与「自环」都被同一条规则覆盖，
 * 不需要另写一遍可达性；迭代式 Tarjan，无递归深度风险。
 */
export function findCycleEdgeKeys(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid">> | null | undefined,
): string[] {
  const adjacency = new Map<string, string[]>();
  const edgeList: Array<{ from: string; to: string }> = [];
  for (const edge of edges || []) {
    const from = edge?.from_uid;
    const to = edge?.to_uid;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) continue;
    edgeList.push({ from, to });
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from)!.push(to);
  }
  for (const list of adjacency.values()) list.sort();
  const startIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const component = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentSize = new Map<number, number>();
  let counter = 0;
  let componentId = 0;

  for (const start of [...adjacency.keys()].sort()) {
    if (startIndex.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.next === 0) {
        startIndex.set(frame.node, counter);
        lowLink.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const targets = adjacency.get(frame.node) || [];
      let descended = false;
      while (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;
        if (!startIndex.has(target)) {
          work.push({ node: target, next: 0 });
          descended = true;
          break;
        }
        if (onStack.has(target)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, startIndex.get(target)!));
        }
      }
      if (descended) continue;
      if (lowLink.get(frame.node) === startIndex.get(frame.node)) {
        let member: string | undefined;
        const members: string[] = [];
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.set(member, componentId);
          members.push(member);
        } while (member !== frame.node);
        componentSize.set(componentId, members.length);
        componentId += 1;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }
    }
  }

  const keys = new Set<string>();
  for (const edge of edgeList) {
    const same = component.get(edge.from) === component.get(edge.to);
    if (!same) continue;
    const size = componentSize.get(component.get(edge.from)!) || 0;
    if (edge.from === edge.to || size > 1) keys.add(`${edge.from}|${edge.to}`);
  }
  return [...keys].sort(compareUid);
}

/* ── 边与节点的视觉映射（提案 §3.4.4，集中一处，不散落在 JSX 里）──────────── */

export type EdgeLineStyle = "solid" | "dashed" | "dotted";
export type EdgeColorRole = "primary" | "muted" | "related" | "idle" | "cycle";
export interface EdgeVisual {
  lineStyle: EdgeLineStyle;
  colorRole: EdgeColorRole;
  label: string;
  arrow: boolean;
}

export function edgeVisual(
  status: WorldBookEdgeStatus | null | undefined,
  relation: "requires" | "related" | null | undefined,
  inCycle = false,
): EdgeVisual {
  if (inCycle) {
    return { lineStyle: "dashed", colorRole: "cycle", label: "位于依赖环内（红虚线）", arrow: true };
  }
  if (relation === "related") {
    return { lineStyle: "dotted", colorRole: "related", label: "仅图示，不参与展开（related）", arrow: false };
  }
  switch (status) {
    case "skeleton":
      return { lineStyle: "solid", colorRole: "primary", label: "主路径（requires · skeleton）", arrow: true };
    case "cross":
      return { lineStyle: "solid", colorRole: "muted", label: "边已生效但目标已被覆盖（requires · cross）", arrow: true };
    case "capped":
      return { lineStyle: "dashed", colorRole: "muted", label: "上游已到达但遍历深度用尽（requires · capped）", arrow: true };
    default:
      return { lineStyle: "dotted", colorRole: "idle", label: "上游不在候选范围内，不参与展开（requires · idle）", arrow: false };
  }
}

/* ── 统计条（提案 §3.4.1 六项）──────────────────────────────────────────────── */

export interface NodeViewStats {
  /** 起点数：本次激活的起点条目数 */
  roots: number;
  /** 已在范围内：display_tree 里去重后的 uid 数（主节点口径） */
  inScope: number;
  /** 未被任何起点覆盖：留在轨道上但不在候选范围内的条目数 */
  uncovered: number;
  /** 依赖环：位于环内的边数 */
  cycles: number;
  /** 超深度边：status = capped 的 requires 边数 */
  cappedEdges: number;
  /** 隐藏节点数：仅因显示上限被截断的下游节点数（不影响真实候选） */
  hidden: number;
}

export function summarize(
  model: NodeViewModel,
  preview: WorldBookScopePreviewDTO | null,
  hiddenCount = 0,
): NodeViewStats {
  const roots = new Set<string>();
  for (const root of preview?.active_roots || []) if (root?.entry_uid) roots.add(root.entry_uid);
  const covered = new Set(model.coveredUids);
  let uncovered = 0;
  for (const row of model.track) if (!covered.has(row.uid)) uncovered += 1;
  let cappedEdges = 0;
  for (const edge of preview?.resolved_edges || []) {
    if (edge?.relation !== "related" && edge?.status === "capped") cappedEdges += 1;
  }
  return {
    roots: roots.size,
    inScope: model.coveredUids.length,
    uncovered,
    cycles: model.cycleEdgeKeys.length,
    cappedEdges,
    hidden: Math.max(0, Math.floor(hiddenCount) || 0),
  };
}

/** 下游规模：沿 requires 边可达的**去重**条目数（不含自身；related 不参与） */
export function downstreamCount(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid"> & { relation?: "requires" | "related" }> | null | undefined,
  uid: string,
): number {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges || []) {
    if (!edge?.from_uid || !edge?.to_uid) continue;
    if (edge.relation === "related") continue;
    const list = adjacency.get(edge.from_uid);
    if (list) list.push(edge.to_uid); else adjacency.set(edge.from_uid, [edge.to_uid]);
  }
  for (const list of adjacency.values()) list.sort();
  const seen = new Set<string>();
  const stack = [...(adjacency.get(uid) || [])].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    if (next === uid || seen.has(next)) continue;
    seen.add(next);
    for (const target of (adjacency.get(next) || []).slice().reverse()) {
      if (!seen.has(target)) stack.push(target);
    }
  }
  return seen.size;
}

/** 加依赖的拦截规则：自环与重复边都不写进统一草稿 */
export function canAddRequiresEdge(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid">> | null | undefined,
  fromUid: string,
  toUid: string,
): { ok: boolean; reason: string } {
  if (!fromUid || !toUid) return { ok: false, reason: "起点与目标都要选到条目" };
  if (fromUid === toUid) return { ok: false, reason: "不能依赖自己（自环）" };
  if ((edges || []).some((edge) => edge?.from_uid === fromUid && edge?.to_uid === toUid)) {
    return { ok: false, reason: "这条 requires 依赖已经存在" };
  }
  return { ok: true, reason: "" };
}

/* ── 展开辅助 ──────────────────────────────────────────────────────────────── */

/** 默认只展开已激活起点的子树（提案 §3.4.7） */
export function defaultExpandedKeys(model: NodeViewModel): string[] {
  return model.nodes
    .filter((node) => node.isPrimary && !!node.rootBadge && node.childKeys.length > 0)
    .map((node) => node.key)
    .sort(compareUid);
}

/**
 * 展开到第 N 层时需要展开的节点 key。
 *
 * 轨道节点也在里面：根行的子节点直接挂在轨道主节点下面（§3.4.1 的示意），
 * 所以「展开到 N 层」必须同时展开深度 < N 的轨道节点。
 */
export function expandKeysToDepth(model: NodeViewModel, depth: number): string[] {
  const keys: string[] = [];
  for (const node of model.nodes) {
    if (node.depth < depth && node.childKeys.length > 0) keys.push(node.key);
  }
  return keys.sort(compareUid);
}

/** 「展开到 N 层」的默认层数：覆盖约 budget 个节点的最小层数 */
export function depthForNodeBudget(model: NodeViewModel, budget = DEFAULT_EXPAND_NODE_BUDGET): number {
  const perDepth = new Map<number, number>();
  for (const node of model.nodes) {
    if (node.kind !== "expansion" && node.kind !== "orphan") continue;
    perDepth.set(node.depth, (perDepth.get(node.depth) || 0) + 1);
  }
  const levels = [...perDepth.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const level of levels) {
    total += perDepth.get(level) || 0;
    if (total >= budget) return level;
  }
  return levels.length ? levels[levels.length - 1] : 0;
}

/* ── 拓扑截断与确定性布局 ──────────────────────────────────────────────────── */

/**
 * 显示上限截断。
 *
 * 入参必须是**前序（pre-order）平铺**的子树节点列表：按前缀切片 ⇒ 保留下来的每个节点
 * 的祖先必然也在保留集合里，不会出现悬空子节点。超过上限的部分只影响显示，
 * 不影响真实候选（提案 §3.4.7）。
 */
export function truncateSubtree<T>(nodes: T[] | null | undefined, limit: number): { nodes: T[]; hiddenCount: number } {
  const list = nodes || [];
  const size = Math.max(0, Math.floor(limit) || 0);
  if (list.length <= size) return { nodes: list.slice(), hiddenCount: 0 };
  return { nodes: list.slice(0, size), hiddenCount: list.length - size };
}

export interface LayoutOptions {
  /** 已展开的节点 key（不展开的节点收起子树） */
  expanded?: Iterable<string> | null;
  /** 只渲染这些轨道条目（筛选器）；null / 缺省 = 全部 */
  trackUids?: Iterable<string> | null;
  /** 展开子树的显示上限，默认 SUBTREE_NODE_LIMIT */
  limit?: number;
}

export interface LayoutNode {
  key: string;
  uid: string;
  kind: NodeViewNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** 归属的顶层节点 key（轨道条目 / 非轨道起点）；虚拟化按它整带取舍 */
  bandKey: string;
  topLevel: boolean;
  isPrimary: boolean;
  isRepeated: boolean;
  trackSeq: number | null;
  hasChildren: boolean;
  expanded: boolean;
  /** 下游被显示上限截断 */
  truncated: boolean;
}

export interface LayoutEdge {
  key: string;
  from: string;
  to: string;
  fromUid: string;
  toUid: string;
  relation: "requires" | "related";
  status: WorldBookEdgeStatus;
  kind: NodeViewEdge["kind"];
  inCycle: boolean;
}

export interface LayoutBand {
  key: string;
  uid: string;
  seq: number | null;
  x0: number;
  x1: number;
  topLevel: boolean;
}

export interface NodeViewLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bands: LayoutBand[];
  width: number;
  height: number;
  hiddenCount: number;
  /** 下游被截断的节点（用于提示「已隐藏 N 个下游节点」） */
  truncatedKeys: string[];
  topLevelCount: number;
}

/**
 * 确定性布局：轨道在 y=0 从左到右，`requires` 展开逐层向下。
 *
 * - 同父的子按 uid 稳定排序；
 * - 子树宽度按后代数量分配（每个叶子占一个 SLOT_WIDTH）；
 * - 父节点居中于子节点群（`x = (首子中心 + 末子中心) / 2`）；
 * - 轨道本身是严格从左到右的单一序列，父节点带宽只影响间距、不改变先后。
 */
export function layoutTrack(model: NodeViewModel, options: LayoutOptions = {}): NodeViewLayout {
  const limit = options.limit === undefined ? SUBTREE_NODE_LIMIT : options.limit;
  const expanded = new Set<string>(options.expanded ? Array.from(options.expanded) : []);
  const trackFilter = options.trackUids ? new Set<string>(Array.from(options.trackUids)) : null;

  const childrenOf = (key: string): string[] =>
    (model.byKey[key]?.childKeys || []).filter((child) => !!model.byKey[child]);

  // 顶层：轨道条目（按位次）+ 轨道外的起点（停用 / 空正文的根）
  const topLevel: string[] = [];
  for (const row of model.track) {
    if (trackFilter && !trackFilter.has(row.uid)) continue;
    if (model.byKey[row.key]) topLevel.push(row.key);
  }
  const orphans = model.nodes
    .filter((node) => node.kind === "orphan")
    .sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0) || compareUid(a.uid, b.uid))
    .map((node) => node.key);

  interface RenderItem { key: string; depth: number; bandKey: string; topLevel: boolean; parentKey: string | null }
  const renderList: RenderItem[] = [];
  const visit = (key: string, depth: number, bandKey: string, isTop: boolean, parentKey: string | null) => {
    const node = model.byKey[key];
    if (!node) return;
    renderList.push({ key, depth, bandKey, topLevel: isTop, parentKey });
    if (!expanded.has(key)) return;
    for (const child of childrenOf(key)) visit(child, depth + 1, bandKey, false, key);
  };
  for (const key of topLevel) visit(key, 0, key, true, null);
  for (const key of orphans) visit(key, 0, key, true, null);

  // 显示上限只作用于「轨道之外的下游节点」；轨道本身是必须完整呈现的顺序序列。
  // renderList 是前序遍历，`truncateSubtree` 按前缀切片 ⇒ 保留下来的节点其祖先必然保留。
  const topLevelSet = new Set(renderList.filter((item) => item.topLevel).map((item) => item.key));
  const subtreeItems = renderList.filter((item) => !item.topLevel);
  const { nodes: keptSubtreeItems, hiddenCount } = truncateSubtree(subtreeItems, limit);
  const kept = new Set<string>(topLevelSet);
  for (const item of keptSubtreeItems) kept.add(item.key);
  const truncatedKeys: string[] = [];
  for (const item of subtreeItems) {
    if (kept.has(item.key)) continue;
    const parentKey = item.parentKey || "";
    if (kept.has(parentKey) && !truncatedKeys.includes(parentKey)) truncatedKeys.push(parentKey);
  }
  truncatedKeys.sort(compareUid);
  const truncatedSet = new Set(truncatedKeys);

  const items = renderList.filter((item) => kept.has(item.key));
  const position = new Map<string, { center: number; x0: number; x1: number }>();
  let cursor = CANVAS_PADDING;
  let first = true;
  const place = (key: string): { center: number; x0: number; x1: number } => {
    const cached = position.get(key);
    if (cached) return cached;
    const kids = expanded.has(key) ? childrenOf(key).filter((child) => kept.has(child)) : [];
    let span: { center: number; x0: number; x1: number };
    if (kids.length) {
      const spans = kids.map((child) => place(child));
      const x0 = Math.min(...spans.map((item) => item.x0));
      const x1 = Math.max(...spans.map((item) => item.x1));
      span = { center: (x0 + x1) / 2, x0, x1 };
    } else {
      span = { center: cursor + NODE_WIDTH / 2, x0: cursor, x1: cursor + NODE_WIDTH };
      cursor += SLOT_WIDTH;
    }
    position.set(key, span);
    return span;
  };
  for (const key of [...topLevel, ...orphans]) {
    if (!kept.has(key)) continue;
    if (!first) cursor += TRACK_GAP;
    first = false;
    place(key);
  }

  const layoutNodes: LayoutNode[] = [];
  let width = CANVAS_PADDING * 2;
  let height = CANVAS_PADDING * 2 + NODE_HEIGHT;
  for (const item of items) {
    const node = model.byKey[item.key];
    const span = position.get(item.key) || { center: cursor, x0: cursor, x1: cursor + NODE_WIDTH };
    const x = span.center - NODE_WIDTH / 2;
    const y = CANVAS_PADDING + item.depth * ROW_HEIGHT;
    layoutNodes.push({
      key: node.key, uid: node.uid, kind: node.kind,
      x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
      depth: item.depth, bandKey: item.bandKey, topLevel: item.topLevel,
      isPrimary: node.isPrimary, isRepeated: node.isRepeated, trackSeq: node.trackSeq,
      hasChildren: childrenOf(node.key).length > 0,
      expanded: expanded.has(node.key),
      truncated: truncatedSet.has(node.key),
    });
    width = Math.max(width, x + NODE_WIDTH + CANVAS_PADDING);
    height = Math.max(height, y + NODE_HEIGHT + CANVAS_PADDING);
  }

  const bandsByKey = new Map<string, LayoutBand>();
  const seqOf = new Map(model.track.map((row) => [row.key, row.seq] as const));
  for (const node of layoutNodes) {
    const band = bandsByKey.get(node.bandKey);
    if (!band) {
      bandsByKey.set(node.bandKey, {
        key: node.bandKey, uid: model.byKey[node.bandKey]?.uid || node.uid,
        seq: seqOf.get(node.bandKey) ?? null,
        x0: node.x, x1: node.x + node.width, topLevel: node.topLevel,
      });
    } else {
      band.x0 = Math.min(band.x0, node.x);
      band.x1 = Math.max(band.x1, node.x + node.width);
    }
  }
  const bands = [...bandsByKey.values()].sort((a, b) => a.x0 - b.x0 || compareUid(a.key, b.key));
  const keptKeys = new Set(layoutNodes.map((node) => node.key));
  const layoutEdges: LayoutEdge[] = model.edges
    .filter((edge) => keptKeys.has(edge.fromKey) && keptKeys.has(edge.toKey))
    .map((edge) => ({
      key: edge.key, from: edge.fromKey, to: edge.toKey,
      fromUid: edge.fromUid, toUid: edge.toUid,
      relation: edge.relation, status: edge.status, kind: edge.kind, inCycle: edge.inCycle,
    }));

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    bands,
    width: Math.round(width),
    height: Math.round(height),
    hiddenCount,
    truncatedKeys,
    topLevelCount: topLevel.length + orphans.length,
  };
}

/** 边上/下行的贝塞尔路径：向下展开走「下游底边 → 子节点顶边」，反向引用走「上游顶边 → 目标底边」 */
export function edgeGeometry(
  from: Pick<LayoutNode, "x" | "y" | "width" | "height">,
  to: Pick<LayoutNode, "x" | "y" | "width" | "height">,
): { d: string; fromX: number; fromY: number; toX: number; toY: number; up: boolean } {
  const fromX = from.x + from.width / 2;
  const toX = to.x + to.width / 2;
  const down = to.y >= from.y + from.height;
  const fromY = down ? from.y + from.height : from.y;
  const toY = down ? to.y : to.y + to.height;
  const curve = Math.max(16, Math.abs(toY - fromY) / 2);
  const d = down
    ? `M ${round(fromX)} ${round(fromY)} C ${round(fromX)} ${round(fromY + curve)}, ${round(toX)} ${round(toY - curve)}, ${round(toX)} ${round(toY)}`
    : `M ${round(fromX)} ${round(fromY)} C ${round(fromX)} ${round(fromY - curve)}, ${round(toX)} ${round(toY + curve)}, ${round(toX)} ${round(toY)}`;
  return { d, fromX, fromY, toX, toY, up: !down };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** 虚拟化：按轨道带宽与视口是否相交取舍（轨道条目 > 120 时启用，提案 §3.4.6 / R-13） */
export function visibleBandKeys(
  bands: LayoutBand[],
  viewLeft: number,
  viewWidth: number,
  overscan = 240,
): Set<string> {
  const left = viewLeft - overscan;
  const right = viewLeft + Math.max(0, viewWidth) + overscan;
  const keep = new Set<string>();
  for (const band of bands) {
    if (band.x1 >= left && band.x0 <= right) keep.add(band.key);
  }
  return keep;
}
