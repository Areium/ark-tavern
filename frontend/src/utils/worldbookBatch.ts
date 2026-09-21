/**
 * 世界书条目的批量操作：全部是对**统一草稿**的纯函数变换，不写盘、不改书。
 *
 * 调用方（WorldBookScopeManager）拿到新草稿后照常走工作台页头那一次原子保存，
 * 因此批量操作与单点编辑共用同一条校验 / 修订号路径。
 *
 * 画布专属的框选几何与旧词表（v2 的固定条目 / 依赖来源）已随 D-1 / D-3 删除；
 * 起点一律用 v3 表述（R-17 的 `batchRoots`）。
 */
import type { WorldBookActivation, WorldBookDetail, WorldBookExpansion, WorldBookRootDTO } from "../types";
import type { WorldBookDraft } from "../hooks/useWorldbookDraft";
import { categoryDescendants } from "./worldbookScope";

export type EdgeDraft = WorldBookDraft["requires_edges"][number];

const edgeKey = (from: string, to: string) => JSON.stringify([from, to]);
/** legacy_depth 起点的默认深度：与 `policyFromDraft` 的 `max_depth ?? 1` 同口径。 */
const DEFAULT_LEGACY_DEPTH = 1;

/** 分类（含子分类）下的全部条目 UID；`unclassified` 同样适用。 */
export function categoryEntryUids(detail: WorldBookDetail, categoryId: string): string[] {
  if (!categoryId) return [];
  const scope = categoryDescendants(detail.categories || [], categoryId);
  return (detail.entries || [])
    .filter((entry) => scope.has(entry.category_id || "unclassified"))
    .map((entry) => entry.uid);
}

/** 只保留书中真实存在的条目，并去掉重复与空值。 */
export function knownUids(detail: WorldBookDetail, uids: string[]): string[] {
  const known = new Set((detail.entries || []).map((entry) => entry.uid));
  return [...new Set(uids.filter((uid) => typeof uid === "string" && known.has(uid)))];
}

/**
 * 批量设置 / 移除起点（R-17，取代 v2 的「固定条目」与「依赖来源」两次批量写）。
 *
 * 对 `knownUids(detail, uids)` 里的每个 uid，**替换**草稿 `roots` 中该 uid 的既有起点为
 * `{ entry_uid, activation, expansion, max_depth? }`：
 *  - `activation === null` 表示**移除**这些 uid 的起点；
 *  - `expansion === "legacy_depth"` 时带上 `max_depth`，并钳制到 `0..32`
 *    （未给出时按 `1` 处理）；
 *  - 起点顺序按 `(entry_uid, activation, expansion)` 稳定排序，避免每次批量操作
 *    都产生无意义的草稿差异。
 *
 * 产出新草稿，不改入参；`uids` 为空或无有效 uid 时原样返回。
 */
export function batchRoots(
  draft: WorldBookDraft, detail: WorldBookDetail, uids: string[],
  activation: WorldBookActivation | null, expansion: WorldBookExpansion, maxDepth: number | null = null,
): WorldBookDraft {
  const targets = knownUids(detail, uids);
  if (!targets.length) return draft;
  const drop = new Set(targets);
  const kept = draft.roots.filter((root) => !drop.has(root.entry_uid));
  if (activation === null) {
    const roots = [...kept].sort((a, b) => a.entry_uid.localeCompare(b.entry_uid));
    return { ...draft, roots };
  }
  const depth = expansion === "legacy_depth"
    ? Math.max(0, Math.min(32, Math.floor(maxDepth ?? DEFAULT_LEGACY_DEPTH)))
    : null;
  const added: WorldBookRootDTO[] = targets.map((entry_uid) => (depth === null
    ? { entry_uid, activation, expansion }
    : { entry_uid, activation, expansion, max_depth: depth }));
  const roots = [...kept, ...added].sort((a, b) =>
    a.entry_uid.localeCompare(b.entry_uid)
    || a.activation.localeCompare(b.activation)
    || a.expansion.localeCompare(b.expansion));
  return { ...draft, roots };
}

/** 批量建立有向依赖：direction=to 表示 uids → target，from 表示 target → uids。 */
export function batchAddEdges(draft: WorldBookDraft, detail: WorldBookDetail, uids: string[], target: string, direction: "to" | "from"):
  { requires_edges: EdgeDraft[]; added: EdgeDraft[]; skipped: number } {
  const targetUid = typeof target === "string" ? target.trim() : "";
  const known = new Set((detail.entries || []).map((entry) => entry.uid));
  if (!known.has(targetUid)) return { requires_edges: draft.requires_edges, added: [], skipped: 0 };
  const existing = new Set(draft.requires_edges.map((edge) => edgeKey(edge.from_uid, edge.to_uid)));
  const added: EdgeDraft[] = [];
  let skipped = 0;
  for (const uid of knownUids(detail, uids)) {
    if (uid === targetUid) { skipped++; continue; }   // 自环由后端拒绝，这里直接跳过
    const edge = direction === "to"
      ? { from_uid: uid, to_uid: targetUid }
      : { from_uid: targetUid, to_uid: uid };
    const key = edgeKey(edge.from_uid, edge.to_uid);
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    added.push(edge);
  }
  return added.length
    ? { requires_edges: [...draft.requires_edges, ...added], added, skipped }
    : { requires_edges: draft.requires_edges, added, skipped };
}

/** 批量清除依赖边：删除所有一端落在 uids 里的边。 */
export function batchRemoveEdges(draft: WorldBookDraft, detail: WorldBookDetail, uids: string[]):
  { requires_edges: EdgeDraft[]; removed: number } {
  const drop = new Set(knownUids(detail, uids));
  if (!drop.size) return { requires_edges: draft.requires_edges, removed: 0 };
  const kept = draft.requires_edges.filter((edge) => !drop.has(edge.from_uid) && !drop.has(edge.to_uid));
  const removed = draft.requires_edges.length - kept.length;
  return removed ? { requires_edges: kept, removed } : { requires_edges: draft.requires_edges, removed: 0 };
}

/** 批量移入分类：产出 taxonomy 需要的 entry_moves。 */
export function batchMove(detail: WorldBookDetail, uids: string[], categoryId: string): Record<string, string> {
  const known = new Set((detail.categories || []).map((category) => category.id));
  if (!categoryId || !known.has(categoryId)) return {};
  const moves: Record<string, string> = {};
  for (const uid of knownUids(detail, uids)) moves[uid] = categoryId;
  return moves;
}
