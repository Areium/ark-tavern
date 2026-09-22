import type { WorldBookEntryDTO, WorldBookSummary } from "../types";

/**
 * 世界书条目的分层与统计口径 —— **前端唯一实现**。
 *
 * 三层（与后端 `world_book.entry_layer` 同构）：
 *
 *  - `stable`  稳定层：`position=0` 且常驻。每次请求原样注入，留在提示词前缀里。
 *  - `dynamic` 动态层：其余注入条目。按关键词 / 概率 / 预算触发后插入。
 *  - `system`  系统层：**不是注入条目**，而是编辑器 / 运行时元数据 ——
 *              剧情节点图（`plot_graphs`）与节点绑定（`node_lore_scope`）。
 *              它们由各自模块整条替换、空触发键且非常驻，按设计永不注入，
 *              只服务画布渲染与系统判定，因此不计入 token、不进 Prompt 预览。
 *
 * 判定顺序必须是「先系统层、再稳定 / 动态」：节点图条目本身也满足
 * 「非常驻」这一条，只按位置分层会把它误报成动态层。
 */

/** 展示用 token 估算：中日韩基本区逐字 1，其余按 code point 每 4 个 1。 */
export function estimateDisplayTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const point of Array.from(text || "")) {
    const code = point.codePointAt(0) || 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor(other / 4);
}

/** 单条目展示估算：与后端 `entry_tokens` / `estimated_tokens()` 同一口径。 */
export function entryTokens(entry: Pick<WorldBookEntryDTO, "name" | "content">): number {
  return estimateDisplayTokens(entry.name ? `### ${entry.name}\n${entry.content}` : entry.content);
}

/** 条目分层：稳定层 / 动态层 / 系统层。 */
export type WorldBookEntryLayer = "stable" | "dynamic" | "system";

export const ENTRY_LAYERS: readonly WorldBookEntryLayer[] = ["stable", "dynamic", "system"];

export const LAYER_LABELS: Record<WorldBookEntryLayer, string> = {
  stable: "稳定层",
  dynamic: "动态层",
  system: "系统层",
};

export const LAYER_HINTS: Record<WorldBookEntryLayer, string> = {
  stable: "常驻且位于静态位置：每次请求原样注入，保持在提示词前缀里。",
  dynamic: "按触发条件插入：关键词命中后才进提示词，内容随对话变化。",
  system: "节点图 / 节点绑定：只服务画布与系统判定，永不注入，也不计入 token。",
};

/**
 * 系统层条目类型标记 —— 必须与后端 `world_book.SYSTEM_ENTRY_TYPES` /
 * `SYSTEM_ENTRY_FENCES` 保持一致；`scripts/test_worldbook_layer_ui.cjs`
 * 会比对两张表，任何一侧新增类型而另一侧没跟上都会失败。
 */
export const SYSTEM_ENTRY_TYPES: readonly string[] = ["plot_graph", "lore_bindings"];
export const SYSTEM_ENTRY_FENCES: readonly string[] = ["plot-graph", "arknights_tavern_lore_bindings"];
const SYSTEM_EXT_NAMESPACE = "arknights_tavern";

const SYSTEM_FENCE_RE = new RegExp(
  "```json\\s+(?:" + SYSTEM_ENTRY_FENCES.join("|") + ")\\s*\\n");

/**
 * 是否系统层条目：extensions 标记优先，围栏块兜底。
 *
 * 与承载模块自己的 `is_graph_entry` / `is_lore_bindings_entry` 同构：条目正文里
 * 出现 `plot-graph` 围栏块即视为图条目（那是模块的既有判定），因此这里也认。
 */
export function isSystemEntry(entry: Pick<WorldBookEntryDTO, "content" | "raw">): boolean {
  const raw = (entry?.raw || {}) as Record<string, any>;
  const extensions = (raw.extensions || {}) as Record<string, any>;
  const ext = (extensions[SYSTEM_EXT_NAMESPACE] || {}) as Record<string, any>;
  if (SYSTEM_ENTRY_TYPES.includes(String(ext.entry_type || ""))) return true;
  return SYSTEM_FENCE_RE.test(String(entry?.content || ""));
}

/** 条目分层；判定顺序见模块说明（先系统层）。 */
export function entryLayer(
  entry: Pick<WorldBookEntryDTO, "content" | "raw" | "position" | "always_active">,
): WorldBookEntryLayer {
  if (isSystemEntry(entry)) return "system";
  return entry.position === 0 && entry.always_active ? "stable" : "dynamic";
}

/** 分层在列表里的落位：稳定层 → 动态层 → 系统层。 */
const LAYER_RANK: Record<WorldBookEntryLayer, number> = { stable: 0, dynamic: 1, system: 2 };

type LayerOrderable = Pick<WorldBookEntryDTO, "uid" | "content" | "raw" | "position" | "always_active">;

/**
 * 展示顺序：**稳定层 → 动态层 → 系统层**，层内保持入参顺序（稳定排序）。
 *
 * 系统层条目（节点图 / 节点绑定）不参与注入、也就不参与注入排序 —— 它们不是
 * 「排在后面的内容」，而是一份附录。所以一律沉到列表最底端，用户不会看到
 * 一张节点图夹在角色设定和他正在编辑的条目中间。持久化的 `entry_order` 不受影响
 * （它只管注入顺序，本来就不需要为系统层条目留位置）。
 *
 * 用下标做次级键而不是依赖 `Array.prototype.sort` 的稳定性：稳定排序是规范保证的，
 * 但显式写出来读代码的人不必去回忆这条保证。
 */
export function sortEntriesByLayer<T extends LayerOrderable>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, rank: LAYER_RANK[entryLayer(entry)] }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.entry);
}

/**
 * 条目是否参与拖动排序。
 *
 * 系统层条目不参与：它们的顺序没有意义，而且后端 `entry_order` 必须是完整排列 ——
 * 让用户拖它们只会制造「拖了但没人看得出变化」的假交互。
 */
export function isSortableEntry(
  entry: Pick<WorldBookEntryDTO, "content" | "raw" | "position" | "always_active">,
): boolean {
  return entryLayer(entry) !== "system";
}

export interface WorldBookEntryStats {
  /** 全部条目（含停用与系统层） */
  total: number;
  /** 会进候选的条目 = 启用的非系统条目；「勾选后实时更新」看的就是它 */
  injectable: number;
  /** 已停用条目 */
  disabled: number;
  /** 系统层条目（永不注入） */
  system: number;
  /** 会注入条目的展示 token 估算 */
  tokens: number;
}

/** 按条目列表算统计口径：与后端 `book_entry_stats` 逐字段同构。 */
export function bookEntryStats(
  entries: readonly Pick<WorldBookEntryDTO, "content" | "raw" | "position" | "always_active" | "enabled" | "name">[] | null | undefined,
): WorldBookEntryStats {
  const stats: WorldBookEntryStats = { total: 0, injectable: 0, disabled: 0, system: 0, tokens: 0 };
  for (const entry of entries || []) {
    stats.total += 1;
    if (isSystemEntry(entry)) { stats.system += 1; continue; }
    if (entry.enabled === false) { stats.disabled += 1; continue; }
    stats.injectable += 1;
    stats.tokens += entryTokens(entry);
  }
  return stats;
}

/**
 * 书架列表项的统计：优先用服务端算好的分层字段。
 *
 * 未选中的书在界面上没有条目明细，只能用摘要；字段缺失（旧响应）时退回
 * 「全部条目都会注入」的旧口径，至少不会显示成 0。
 */
export function summaryEntryStats(
  book: Pick<WorldBookSummary,
    "entry_count" | "injectable_entry_count" | "disabled_entry_count" | "system_entry_count" | "estimated_tokens">,
): WorldBookEntryStats {
  const total = book.entry_count || 0;
  const system = book.system_entry_count || 0;
  const disabled = book.disabled_entry_count || 0;
  return {
    total,
    system,
    disabled,
    injectable: book.injectable_entry_count ?? Math.max(0, total - system - disabled),
    tokens: book.estimated_tokens ?? 0,
  };
}

/** 人读的封面体积文案（KB / MB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
