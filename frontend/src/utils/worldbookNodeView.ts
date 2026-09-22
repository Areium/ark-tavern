/**
 * 世界书节点视图（A-4，提案 §3.4）的**纯逻辑**：轨道排序 / 渲染模型 / 确定性布局 / 统计 / 视觉映射。
 *
 * 三条纪律，读代码前先读这里：
 *
 * 1. **去重口径不属于本模块**。谁在候选闭包里、谁有多个到达，全部由服务端 `resolve_v3_scope`
 *    的读时派生字段给出（契约 R-10 / R-11）：
 *    - `resolved_edges[].status`：`skeleton` 主路径 / `cross` 边生效但目标已被别处覆盖 /
 *      `capped` 上游到了但深度用尽（**没有**被遍历）/ `idle` 上游不在闭包里；
 *    - `display_tree[].first_parent_uid`：该 uid 的**主到达**来自哪个父；
 *    - `display_tree[].repeated`：该 uid 在闭包内**多于一次到达**（被遍历的 requires 入边 + 起点激活）；
 *    - `display_tree[].display_index`：`display_tree` 中的 0-based 稳定位次。
 *    这里**不做第二套去重**，只把服务端字段投影成渲染模型。
 * 2. 前端唯一的判断是提案 §3.4.3 的「主节点唯一 + 灰只读子树」规则，R-10 澄清后的精确口径是：
 *    - **轨道上的 uid**：轨道节点是唯一主节点，它的**所有**向下展开出现位置一律是灰节点；
 *    - **不在轨道上的 uid**（例如条目已停用 / 正文为空）：主到达 = `from_uid === first_parent_uid`
 *      的那次展开位置，其余到达（`cross` 边带来的）一律灰节点；
 *    - **灰色向下传播**（提案 §3.4.3.2）：灰节点的下游不管在不在轨道上，只要是从灰子树里展开出来的，
 *      整棵子树都是灰色只读视图（`dimmed`）；它不会波及「别处的主到达位置」。
 *    每个到达都是一次「出现位置」：主到达节点是 `display_tree` 的那一行（挂在 `first_parent_uid` 下），
 *    其余到达来自 `resolved_edges` 里指向同一 uid 的 `cross` 边（挂在边起点的主节点下）。
 *    **`repeated` 与灰出现是单向关系**：`repeated === true` ⟹ 该 uid 在闭包内还有第二次到达
 *    （于是视图里会给出一处灰出现），但反过来不成立 —— 灰集合是 `repeated` 的**超集**：
 *    「轨道优先」会灰掉轨道上 uid 的展开出现，灰色传播会灰掉整棵灰子树，两者都不依赖 `repeated`，
 *    所以 `repeated === false` 不代表「一定没有灰出现」。
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
export function trackOrder(entries: WorldBookEntryDTO[] | null | undefined,
  explicitOrder?: readonly string[] | null): NodeViewTrackRow[] {
  const rows = (entries || []).filter(isTrackEntry).slice();
  if (explicitOrder?.length) {
    const index = new Map(explicitOrder.map((uid, position) => [uid, position]));
    rows.sort((a, b) => {
      const layerA = a.position === 0 && a.always_active ? 0 : 1;
      const layerB = b.position === 0 && b.always_active ? 0 : 1;
      return layerA - layerB
        || (index.get(a.uid) ?? explicitOrder.length) - (index.get(b.uid) ?? explicitOrder.length)
        || compareInjectionOrder(a, b);
    });
  } else {
    rows.sort(compareInjectionOrder);
  }
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
/** `cross` 边带来的那次到达：同一 uid 可能从多个上游被重复到达，key 里带上 from_uid */
export const crossNodeKey = (uid: string, fromUid: string) => `cross#${uid}#${fromUid}`;

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
  /** 主节点：同一 uid 唯一的那个正式节点（轨道优先，否则 first_parent_uid 指向的那次到达） */
  isPrimary: boolean;
  /**
   * 灰节点：该 uid 在本视图里的非主到达，**或**它整个落在灰色只读子树里（提案 §3.4.3.2）。
   *
   * 与 `dimmed` **同值**，语义就是「处于灰只读视图内」（两者同值是刻意的：去掉一个会牵动布局、
   * 组件与断言多处）。要判断灰的**来源**请用 `isExtraArrival`（cross 边带来的重复到达）与模型上的
   * `primaryKeys`（该 uid 是否另有主到达位置）：两者都不成立 ＝ 只活在灰只读子树里、从未在别处
   * 出现过的下游节点 —— 界面文案必须与「已插入过」区分开（见组件里的 `grayNodeTitle`）。
   */
  isRepeated: boolean;
  /** 渲染为灰色只读视图（灰底 / 灰字 / 虚线边框 / 降低不透明度）。轨道节点恒为 false；与 `isRepeated` 同值。 */
  dimmed: boolean;
  /** 这条出现位置由 `cross` 边带来（即「边生效但目标已被别处覆盖」的那次到达） */
  isExtraArrival: boolean;
  /**
   * 服务端 `display_tree[].repeated`：该 uid 在**闭包内多于一次到达**（被实际遍历的 requires 入边数
   * ＋ 它自己作为起点被激活的那一次）。**单向**：它为 true ⟹ 一定还有第二次到达（通常就是一处灰出现），
   * 但它为 false 完全**不代表**「不会有灰出现」——「轨道优先」会灰掉轨道上 uid 的展开出现、
   * 灰色传播会灰掉整棵灰子树，两者都与它无关，所以灰集合是它的**超集**。
   * 只用于界面提示与一致性告警，不参与主/灰归属。
   */
  hasRepeatedArrival: boolean;
  /** 这次到达的 `from_uid`（轨道节点为 null） */
  arrivalFrom: string | null;
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
  /** 依赖环分组：每个环一组（成员 uid 已排序），供统计条显示「环个数」 */
  cycleGroups: string[][];
  /** Prompt 预览联动是否生效（仅当 bookId 与当前书一致） */
  promptOrderApplied: boolean;
  promptMode: "narrative" | "free" | null;
  /**
   * 本次预览是不是「全量兼容」（`preview.full_scope === true`）：所有条目都在候选里，
   * 依赖闭包不再决定范围 —— 此时不标「游离」，未覆盖统计也不适用（提案 §3.4.2 的第四档徽标）。
   */
  fullScope: boolean;
  /** uid → 该 uid 的主节点 key（可能在读只读子树里没有主节点，那就没有这个 uid） */
  primaryKeys: Record<string, string>;
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
 * 主/灰判定（R-10 澄清后的精确口径，见文件头纪律 2）：轨道上的 uid 以轨道节点为唯一主节点、
 * 其余出现位置全灰；不在轨道上的 uid 以 `from_uid === first_parent_uid` 的那次到达为主节点、
 * 其余到达全灰。服务端派生字段缺失时**优雅降级**（`repeated` 视为 false、`display_index` 用
 * 数组下标、`first_parent_uid` 缺失时回落「最早到达」），降级都会写进 `warnings`。
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

  const track = trackOrder(entries, detail?.has_explicit_entry_order ? detail.entry_order : null);
  const trackByUid = new Map(track.map((row) => [row.uid, row] as const));

  const treeRows = preview?.display_tree || [];
  const resolvedEdges = preview?.resolved_edges || [];
  // 「全量兼容」（full_scope）不是起点激活方式，而是本次预览的整档语义：所有条目都在候选里，
  // 依赖闭包不决定范围。此时 display_tree 会是空的，若照常渲染会把全书标成「游离」——那是误导，
  // 因此这里显式记下这一档，交给界面给出「不显示依赖闭包」的提示（提案 §3.4.2 的第四档徽标）。
  const fullScope = preview?.full_scope === true;
  const warnings: string[] = [];
  if (fullScope) {
    warnings.push("本次预览为全量兼容（full_scope）：全书条目都在候选里，因此不标「游离」、"
      + "也不显示依赖闭包（起点数 / 已在范围内 / 未覆盖 / 依赖环都不反映本次范围）。");
  }
  if (treeRows.length && treeRows.some((row) => typeof row.repeated !== "boolean"
    || typeof row.display_index !== "number" || row.first_parent_uid === undefined)) {
    warnings.push("display_tree 缺少服务端读时派生字段（repeated / first_parent_uid / display_index）："
      + "主到达按 display_index 最小的一次降级判定、无法预告重复到达，不额外自算去重。");
  }
  if (!treeRows.length && !fullScope
    && (resolvedEdges.length > 0 || (preview?.scope?.resolved_entry_uids || []).length > 0)) {
    warnings.push("服务端没有返回 display_tree（这本书可能还没启用按需载入）：节点视图只渲染轨道，"
      + "不画依赖展开、也不画 cross 重复到达（capped 边仍会给出深度用尽的只读占位节点）。");
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

  /**
   * 该 uid 的主到达渲染节点（R-10）。
   *
   * - 轨道上有它 → 轨道节点（轨道优先，唯一主节点）；
   * - 轨道上没有 → `from_uid === first_parent_uid` 的那次展开位置，也就是 `display_tree`
   *   里这一行（服务端保证 `first_parent_uid === parent_uid`）。
   *
   * **回落条件**（都会写进 `warnings`，且只是降级、不改语义）：服务端没给 `first_parent_uid`
   * （旧 payload / 字段缺失），或 `display_tree` 里根本没有这个 uid 的行时，才回落到
   * 「`display_index` 最小的那次到达」即数组里最早的那一行。只要服务端给了字段，
   * 主/灰就完全按 `first_parent_uid` 判定，前端不自行推导去重。
   */
  const mainArrivalKeyOf = (uid: string): { key: string | null; fallback: boolean } => {
    if (trackByUid.has(uid)) return { key: trackNodeKey(uid), fallback: false };
    const ref = earliestRef(uid);
    if (!ref) return { key: null, fallback: false };
    const key = rowNodeKey(uid, ref.index);
    const parentUid = ref.row.parent_uid ?? null;
    const serverParent = ref.row.first_parent_uid;
    const hasField = serverParent !== undefined;      // null 是「根」的合法值，不算缺失
    const matches = hasField && (serverParent ?? null) === parentUid;
    return { key, fallback: !matches };
  };

  const primaryKeyOf = (uid: string): string | null => mainArrivalKeyOf(uid).key;
  if (rows.some((ref) => mainArrivalKeyOf(ref.row.uid).fallback)) {
    warnings.push("display_tree 没有可用的 first_parent_uid（字段缺失，或与 parent_uid 不一致）：主到达按 display_index 最小的一次降级判定。");
  }

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
      isPrimary: true, isRepeated: false, dimmed: false, isExtraArrival: false,
      hasRepeatedArrival: ref?.row.repeated === true, arrivalFrom: null,
      onTrack: true,
      // 全量兼容下所有条目都在候选里，「未被任何起点覆盖」这个说法不成立，因此不标游离。
      covered: !!ref, loose: !fullScope && !ref, ghost: false,
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

  // ── 3) 主到达的展开位置：轨道上的 uid 一律灰（轨道节点才是它的唯一主节点），
  //      轨道上没有的 uid 以「from_uid === first_parent_uid 的那次到达」为主节点 ──
  for (const ref of rows) {
    if (rowKeyOf(ref) === trackNodeKey(ref.row.uid)) continue;
    const uid = ref.row.uid;
    const onTrack = trackByUid.has(uid);
    const isPrimary = !onTrack;
    const fields = entryFields(uid);
    addNode({
      key: rowNodeKey(uid, ref.index), uid, name: ref.row.name || fields.name,
      kind: isRootRow(ref.row) ? "orphan" : "expansion",
      isPrimary, isRepeated: !isPrimary, dimmed: !isPrimary, isExtraArrival: false,
      hasRepeatedArrival: ref.row.repeated === true,
      arrivalFrom: ref.row.first_parent_uid ?? ref.row.parent_uid ?? null,
      onTrack,
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

  // ── 3b) 其余到达：`cross` 边（边生效、但目标的主到达在别处）带来的出现位置一律是灰节点。
  //       它们挂在**边起点的主节点**下，所以「cross 边 → 灰节点」在图上直接可见（§3.4.4）。
  //       没有 display_tree 时整体跳过：那时连闭包与主到达都不知道，画孤立的灰节点只会误导，
  //       于是降级成「只渲染轨道」（见上面的 warnings）。
  //      服务端 `repeated === true` 表示「闭包内还有第二次到达」。它与灰出现是**单向**关系：
  //      repeated 为真时通常会给出一处灰出现（那次到达就是 cross 边），但**反过来不成立** ——
  //      灰集合是 repeated 的超集（轨道优先 + 灰色传播都会灰掉一些 repeated=false 的出现），
  //      所以这里只在「repeated 为真却找不到那次到达」时报警告，绝不把 repeated=false 当异常。
  const extraArrivalsByUid = new Map<string, string[]>();
  const crossRequiresEdges = rows.length
    ? resolvedEdges.filter((edge) => edge.relation !== "related" && edge.status === "cross")
    : [];
  for (const edge of crossRequiresEdges) {
    const fromUid = edge.from_uid;
    const toUid = edge.to_uid;
    const parentKey = primaryKeyOf(fromUid);
    if (!parentKey || !byKey[parentKey]) continue;
    const key = crossNodeKey(toUid, fromUid);
    if (byKey[key]) continue;
    const fields = entryFields(toUid);
    addNode({
      key, uid: toUid, name: fields.name, kind: "expansion",
      isPrimary: false, isRepeated: true, dimmed: true, isExtraArrival: true,
      hasRepeatedArrival: false, arrivalFrom: fromUid, onTrack: trackByUid.has(toUid),
      covered: true, loose: false, ghost: false,
      trackSeq: null, displayIndex: null,
      parentUid: fromUid, firstParentUid: fromUid, parentKey, childKeys: [],
      depth: (byKey[parentKey]?.depth ?? 0) + 1,
      remaining: null, isRoot: false, rootBadge: null, arrivalStatus: "cross",
      problems: problemsByUid.get(toUid) || [],
      position: fields.position, groupWeight: fields.groupWeight, entryDepth: fields.entryDepth,
      categoryId: fields.categoryId, categoryName: fields.categoryName,
      actualSeq: null, actualLayer: null, path: [],
    });
    const list = extraArrivalsByUid.get(toUid);
    if (list) list.push(key); else extraArrivalsByUid.set(toUid, [key]);
  }
  const undocumentedRepeat = rows
    .filter((ref) => ref.row.repeated === true && !(extraArrivalsByUid.get(ref.row.uid) || []).length)
    .map((ref) => ref.row.uid)
    .sort(compareUid);
  if (undocumentedRepeat.length) {
    warnings.push(`服务端标记了 repeated（闭包内还有第二次到达）但 resolved_edges 里没有对应的 cross 边：`
      + `${undocumentedRepeat.slice(0, 5).join("、")}${undocumentedRepeat.length > 5 ? " 等" : ""}`
      + "——那次多父到达可能已被深度截断成 capped，本视图里因此没有对应的重复到达出现位置。"
      + "注意 repeated 与灰出现是单向关系：这条告警只针对「repeated 为真却找不到那次到达」，"
      + "反过来 repeated 为 false 也完全可能有灰出现（轨道优先 / 灰色传播）。");
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
      isPrimary: false, isRepeated: true, dimmed: true, isExtraArrival: false,
      hasRepeatedArrival: false, arrivalFrom: edge.from_uid,
      onTrack: false,
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

  // ── 5) 父子关系：display_tree 的父子是骨架；cross 出现位置与 capped 占位节点挂在各自的上游主节点下 ──
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
    if ((node.kind !== "ghost" && !node.isExtraArrival) || !node.parentKey || !byKey[node.parentKey]) continue;
    pushChild(node.parentKey, node.key);
  }
  for (const node of nodes) {
    const kids = childrenOf.get(node.key) || [];
    kids.sort((a, b) => compareUid(byKey[a]?.uid || a, byKey[b]?.uid || b));
    node.childKeys = kids;
  }

  // ── 5b) 灰色只读子树的向下传播（提案 §3.4.3.2：灰节点「保留可展开手柄，仍可展开……
  //        展开结果整棵子树同为灰色只读视图」）──
  // 规则：childGrey = parentGrey || parent.baseRepeated（父是灰的，或父本身是重复到达）。
  // 注意它**只沿渲染树向下传播**：某个 uid 在别处的主到达位置（轨道节点，或它自己
  // first_parent_uid 指向的那次展开位置，只要不在灰子树里）不受影响，仍然是主节点且不灰。
  // 轨道节点是轨道顺序里的主节点，恒不灰。
  //
  // 裁定（编排者 2026-09-21，保留现口径）：传播**不跨** `related` / `idle` / `capped` 边 ——
  // 那些边没有发生到达，灰只读视图不该凭空沿它们扩边。
  //
  // 裁定（编排者 2026-09-21，保留现口径）：整条只出现在灰只读子树里的 uid **不设主节点**
  // （`isPrimary` 全 false、`primaryKeys` 里没有它），界面因此不渲染「跳到首次出现」。
  // 依据：提案 §3.4.3.2「展开结果整棵子树同为灰色只读视图」与 §3.4.3.1「轨道上没有时取最早
  // 到达的展开位置」在同一场景下冲突，取 §3.4.3.2（针对灰展开更具体，且它的括号理由
  // 「其下游可能带出别处没有的节点」描述的正是这个场景）。
  const dimmedMemo = new Map<string, boolean>();
  const isDimmedKey = (key: string): boolean => {
    const cached = dimmedMemo.get(key);
    if (cached !== undefined) return cached;
    const node = byKey[key];
    if (!node) return false;
    dimmedMemo.set(key, false);   // 防环兜底（display_tree 本身无环）
    const parent = node.parentKey ? byKey[node.parentKey] : undefined;
    const value = node.isRepeated || (parent ? isDimmedKey(parent.key) : false);
    dimmedMemo.set(key, value);
    return value;
  };
  for (const node of nodes) {
    if (node.kind === "track") {
      node.dimmed = false;
      node.isRepeated = false;
      node.isPrimary = true;
      continue;
    }
    const grey = isDimmedKey(node.key);
    node.dimmed = grey;
    node.isRepeated = grey;
    node.isPrimary = !grey;
  }

  // ── 6) 边：skeleton 用 display_tree 父子关系，cross / capped / related 用 resolved_edges ──
  const cycleEdgeKeys = findCycleEdgeKeys(requiresEdges.map((edge) => ({ from_uid: edge.from_uid, to_uid: edge.to_uid })));
  const cycleGroups = findCycleGroups(requiresEdges.map((edge) => ({ from_uid: edge.from_uid, to_uid: edge.to_uid })));
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
  for (const edge of requiresEdges) {
    if (edge.status !== "cross" && edge.status !== "capped") continue;
    const fromKey = primaryKeyOf(edge.from_uid);
    // cross：边确实生效了，但目标的主到达在别处 → 指向这次到达自己的（灰）出现位置（§3.4.4）；
    // capped：目标这次根本没被遍历 → 指向它的主节点（轨道位置 / 展开位置），都没有就给只读占位节点。
    const toKey = edge.status === "cross"
      ? (byKey[crossNodeKey(edge.to_uid, edge.from_uid)] ? crossNodeKey(edge.to_uid, edge.from_uid) : nodeKeyForUid(edge.to_uid))
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
  const primaryKeys: Record<string, string> = {};
  for (const node of nodes) {
    if (node.isPrimary) {
      primaryCount += 1;
      // 同一 uid 至多一个主节点（轨道节点排在前面，因此轨道优先）；落在灰只读子树里的 uid 可能没有主节点。
      if (!primaryKeys[node.uid]) primaryKeys[node.uid] = node.key;
    } else {
      repeatedCount += 1;
    }
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
    cycleGroups,
    promptOrderApplied,
    promptMode: promptOrderApplied && promptOrder ? promptOrder.mode : null,
    fullScope,
    primaryKeys,
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
 *
 * 口径说明：这里对**全部 requires 边**判环，而服务端 `_dependency_cycles` 只在候选闭包内判环；
 * 两者的口径差异在真实预装书上一致（同为 4 条环内边）。界面上「依赖环」显示的是**环个数**
 * （见 `findCycleGroups`），环内边数作为副标显示。
 */
export function findCycleEdgeKeys(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid">> | null | undefined,
): string[] {
  const analysis = analyzeCycles(edges);
  const keys = new Set<string>();
  for (const edge of analysis.edgeList) {
    const id = analysis.component.get(edge.from);
    if (id === undefined || id !== analysis.component.get(edge.to)) continue;
    if (edge.from === edge.to || (analysis.sizes.get(id) || 0) > 1) keys.add(`${edge.from}|${edge.to}`);
  }
  return [...keys].sort(compareUid);
}

/**
 * 依赖环的**分组**：每个环算一组，成员 uid 已排序。界面统计条的「依赖环」用它的长度（环个数），
 * 而不是环内边数 —— 一个二元环有两条边，报边数会让人以为有两个环。
 *
 * 分组口径（F-9 防御性一致性）：
 * - 规模 > 1 的强连通分量 = 一个环，成员**直接取自分量**（不靠边反推，避免漏成员）；
 * - 自环只有在**不在任何规模 > 1 的分量里**时才单独成组 —— 否则会与它所在的分量重复计数
 *   （例如 `a→a` 与 `a↔b` 应算 1 个环，而不是 2 个）。真实数据没有自环，v3 校验器也禁自环，
 *   这条只是防御。
 */
export function findCycleGroups(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid">> | null | undefined,
): string[][] {
  const analysis = analyzeCycles(edges);
  const groups = new Map<number, string[]>();
  for (const [node, id] of analysis.component) {
    if ((analysis.sizes.get(id) || 0) <= 1) continue;
    const list = groups.get(id);
    if (list) list.push(node); else groups.set(id, [node]);
  }
  const output = [...groups.values()].map((members) => [...new Set(members)].sort(compareUid));
  const selfLoops = new Set<string>();
  for (const edge of analysis.edgeList) if (edge.from === edge.to) selfLoops.add(edge.from);
  for (const uid of selfLoops) {
    const id = analysis.component.get(uid);
    if (id !== undefined && (analysis.sizes.get(id) || 0) > 1) continue;   // 已并入它所在的环
    output.push([uid]);
  }
  output.sort((a, b) => compareUid(a[0] || "", b[0] || ""));
  return output;
}

interface CycleAnalysis {
  edgeList: Array<{ from: string; to: string }>;
  component: Map<string, number>;
  sizes: Map<number, number>;
}

/** 迭代式 Tarjan 求强连通分量；边与邻接都做稳定排序，结果与输入顺序无关。 */
function analyzeCycles(
  edges: Array<Pick<WorldBookDependencyEdgeDTO, "from_uid" | "to_uid">> | null | undefined,
): CycleAnalysis {
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
  const sizes = new Map<number, number>();
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
        sizes.set(componentId, members.length);
        componentId += 1;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }
    }
  }
  return { edgeList, component, sizes };
}

/* ── 边与节点的视觉映射（提案 §3.4.4，集中一处，不散落在 JSX 里）──────────── */

/**
 * 裁定来源（编排者 2026-09-21 同意，提案 §3.4.4 未定义这两种情况）：
 * - `requires · idle`（上游不在候选闭包里）**不画**：大书上这类边会让轨道糊成一片，
 *   而它不参与任何展开；只在右侧属性栏按 `edgeVisual("idle", "requires")` 的文案列出。
 * - `related` 只在两端都在候选闭包内时才画（点线「仅图示」）；画在闭包外同样只会糊成一片。
 * 其余四种视觉严格按提案 §3.4.4 的表格：实线箭头 skeleton / 灰实线 cross / 灰虚线 capped / 红虚线环内。
 */

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
  /** 未被任何起点覆盖：留在轨道上但不在候选范围内的条目数（全量兼容下不适用，见 fullScope） */
  uncovered: number;
  /** 依赖环：**环的个数**（一个二元环算 1 个；自环单独算 1 个） */
  cycles: number;
  /** 依赖环内边数（副标；一个二元环有 2 条边） */
  cycleEdges: number;
  /** 超深度边：status = capped 的 requires 边数 */
  cappedEdges: number;
  /** 隐藏节点数：仅因显示上限被截断的下游节点数（不影响真实候选） */
  hidden: number;
  /** 本次预览是否为「全量兼容」：true 时 uncovered / inScope 都不反映范围语义 */
  fullScope: boolean;
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
    cycles: model.cycleGroups.length,
    cycleEdges: model.cycleEdgeKeys.length,
    cappedEdges,
    hidden: Math.max(0, Math.floor(hiddenCount) || 0),
    fullScope: model.fullScope,
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
