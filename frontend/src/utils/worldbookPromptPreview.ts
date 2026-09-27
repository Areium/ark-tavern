/**
 * Prompt 预览（A-2）的**纯逻辑**：未插入原因的分组与文案、`### 名称` 锚点解析、
 * 宿主骨架条的世界书块定位、摘要文案、会话最近对话拼接。
 *
 * 这里不引入 React、不做任何副作用、不发请求：全部是可直接在 Node 里断言的函数
 * （见 `scripts/test_worldbook_scope_ui.cjs` 的 WU-E 断言块）。
 */
import type {
  ChatMessage, WorldBookDropReason, WorldBookPromptLayer, WorldBookPromptPreviewDroppedDTO,
  WorldBookPromptPreviewOrderDTO, WorldBookPromptPreviewSiteDTO, WorldBookPromptPreviewSkeletonDTO,
  WorldBookPromptPreviewTotalsDTO,
} from "../types";

// ── 未插入原因（R-2 的九类口径，顺序即判定优先级）───────────────────────────

/** 九类未插入原因的展示顺序：与契约 R-2 的判定优先级一致（自上而下取第一个成立者）。 */
export const DROP_REASON_ORDER: WorldBookDropReason[] = [
  "not_in_scope",
  "node_binding_demoted",
  "disabled",
  "empty_content",
  "selective_reject",
  "keyword_miss",
  "secondary_miss",
  "probability_miss",
  "budget_exceeded",
];

export const DROP_REASON_LABELS: Record<string, string> = {
  not_in_scope: "不在候选范围",
  node_binding_demoted: "被节点作用域排除",
  disabled: "条目已停用",
  empty_content: "正文为空",
  selective_reject: "选择性触发无法判定",
  keyword_miss: "关键词未命中",
  secondary_miss: "副键未命中",
  probability_miss: "概率未通过",
  budget_exceeded: "超出 token 预算",
};

/** 每类原因一句可执行的修复入口。 */
export const DROP_REASON_HINTS: Record<string, string> = {
  not_in_scope: "不在本书候选范围内；去「分类与载入」把它设为起点或手动追加。",
  node_binding_demoted: "该条目被当前节点作用域排除；换节点或调整节点的世界书绑定。",
  disabled: "去「条目」重新启用这条条目。",
  empty_content: "给这条条目补上正文：空正文不会插进提示词。",
  selective_reject: "选择性条目没有可用的主键；补上触发关键词，或把它改成非选择性条目。",
  keyword_miss: "这一轮输入与最近对话里没有出现它的触发关键词；补关键词或改写输入。",
  secondary_miss: "主键命中了但副键都没命中；放宽副键或减少副键数量。",
  probability_miss: "概率条目这次没抽中；固定种子下结果可复现，也可把概率调到 100。",
  budget_exceeded: "提高预算或减少常驻条目。",
};

export interface DroppedGroup {
  reason: string;
  label: string;
  hint: string;
  items: WorldBookPromptPreviewDroppedDTO[];
}

/**
 * 按 reason 分组。已知九类按 `DROP_REASON_ORDER` 排列；服务端若给出未识别的原因，
 * 原样收在末尾的兜底组里，不静默丢弃（宁可显眼也不要让条目消失）。
 */
export function groupDropped(
  dropped: WorldBookPromptPreviewDroppedDTO[] | null | undefined,
): DroppedGroup[] {
  const buckets = new Map<string, WorldBookPromptPreviewDroppedDTO[]>();
  for (const item of dropped || []) {
    if (!item) continue;
    const reason = String(item.reason || "");
    const bucket = buckets.get(reason);
    if (bucket) bucket.push(item);
    else buckets.set(reason, [item]);
  }
  const groups: DroppedGroup[] = [];
  for (const reason of DROP_REASON_ORDER) {
    const items = buckets.get(reason);
    if (!items) continue;
    groups.push({ reason, label: DROP_REASON_LABELS[reason] || reason, hint: DROP_REASON_HINTS[reason] || "", items });
    buckets.delete(reason);
  }
  for (const [reason, items] of buckets) {
    groups.push({
      reason,
      label: `未识别的原因（${reason || "空"}）`,
      hint: "服务端给出了前端不认识的原因码，请核对前后端版本是否一致。",
      items,
    });
  }
  return groups;
}

// ── `### 名称` 锚点解析 ─────────────────────────────────────────────────────

/**
 * 一个已拼装文本块：`### 名称` 行是锚点，其后到下一个锚点之间的内容是正文。
 *
 * 开头没有 `### ` 的部分（例如 `【世界书】` 头）单独成块，`name` 为空字符串；
 * 整段没有任何 `### ` 时兜底为一个 `name` 为空的整段块 —— 两种情况都要能渲染，
 * 不能因为后端换了格式就把正文吞掉。
 */
export interface InjectionBlock {
  /** 锚点名（`### ` 之后的内容）；无锚点块为空字符串 */
  name: string;
  /** 原始锚点行（含 `###`）；无锚点块为空字符串 */
  heading: string;
  body: string;
  /** 在该层内的 0-based 序号 */
  index: number;
}

/**
 * 解析一层拼装文本。
 *
 * 条目正文自己也会写 markdown 小标题，例如地点的视觉、氛围、声音与细节。
 * 一次内容较多的预览中，许多 `### ` 行只是正文小标题，并非条目锚点。
 * 所以只要调用方给得出**本轮注入的条目名**（`order[].name`），就只认这些名字当锚点，
 * 其余 `### ` 行留在正文里 —— 否则中栏会把一条条目劈成四块，还会长出点不开的死锚点。
 *
 * 不给 `knownNames`（或给空集合）时退回「按所有 `### ` 行切分」的老口径，用于
 * 不知道条目名、只拿到一段文本的场景。
 */
export function parseInjectionBlocks(
  text: string | null | undefined,
  knownNames?: Iterable<string> | null,
): InjectionBlock[] {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return [];
  const candidates = knownNames ? new Set([...knownNames].filter(Boolean)) : null;
  const known = candidates && candidates.size ? candidates : null;
  const blocks: InjectionBlock[] = [];
  let name = "";
  let heading = "";
  let lines: string[] = [];
  let open = false;
  const flush = () => {
    if (!open) return;
    const body = lines.join("\n").trim();
    if (name || body) blocks.push({ name, heading, body, index: blocks.length });
    lines = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const match = /^###\s+(.*)$/.exec(line);
    // known 非空时，只有命中已知条目名的 `### ` 行才是锚点
    if (match && (!known || known.has(match[1].trim()))) {
      flush();
      open = true;
      heading = line.trim();
      name = match[1].trim();
      continue;
    }
    open = true;
    lines.push(line);
  }
  flush();
  return blocks;
}

/**
 * 锚点 id：用**层 + 序号**而不是名字（名字里可能有正则元字符、重复、空格）。
 * 绝不把条目名拼进选择器，因此不需要转义，也不会因为重名撞车。
 */
export const previewAnchorId = (layer: WorldBookPromptLayer, index: number): string =>
  `wbpp-block-${layer}-${index}`;

/**
 * 锚点 → 右栏条目：按**完全相等**匹配名字（字符串比较，不走正则）。
 * 重名时取 seq 最小的一条（右栏顺序即 seq 顺序），找不到返回 null。
 */
export function orderUidForBlock(
  order: WorldBookPromptPreviewOrderDTO[] | null | undefined,
  block: InjectionBlock | null | undefined,
): string | null {
  if (!block || !block.name) return null;
  for (const entry of order || []) {
    if (!entry) continue;
    if ((entry.name || entry.uid) === block.name) return entry.uid;
  }
  return null;
}

// ── 插入位置（sites[]）──────────────────────────────────────────────────────

export const HOST_LABELS: Record<string, string> = {
  reference: "<reference> 块",
  world_book: "<world_book> 块",
  system_parts: "system_parts（自由模式）",
};

/** 一块文本的插入位置说明；没有对应 site 时返回空串（不编造位置）。 */
export function describeSite(site: WorldBookPromptPreviewSiteDTO | null | undefined): string {
  if (!site) return "";
  const where = `${HOST_LABELS[site.host] || site.host}：在 ${site.after_block} 之后、${site.before_block} 之前`;
  return site.description ? `${site.description}（${where}）` : where;
}

export const siteOf = (
  sites: WorldBookPromptPreviewSiteDTO[] | null | undefined, layer: WorldBookPromptLayer,
): WorldBookPromptPreviewSiteDTO | null => (sites || []).find((site) => site.layer === layer) || null;

// ── 宿主骨架条（skeleton[]）────────────────────────────────────────────────

export const SKELETON_INSERT_LABELS: Record<string, string> = { before: "前插", after: "后插" };

export interface SkeletonWorldbookBlock {
  /** 在 `skeleton[]` 中的 0-based 位次 */
  index: number;
  id: string;
  label: string;
  insert: "before" | "after" | null;
  /** 「前插」/「后插」；服务端没给 insert 时为空串（不猜） */
  insertLabel: string;
}

/** 定位骨架里的世界书块：返回位次与「前插 / 后插」文案，供骨架条高亮。 */
export function findSkeletonWorldbookBlocks(
  skeleton: WorldBookPromptPreviewSkeletonDTO[] | null | undefined,
): SkeletonWorldbookBlock[] {
  const out: SkeletonWorldbookBlock[] = [];
  (skeleton || []).forEach((block, index) => {
    if (!block || !block.is_worldbook) return;
    const insert = block.insert === "before" || block.insert === "after" ? block.insert : null;
    out.push({
      index, id: block.id, label: block.label, insert,
      insertLabel: insert ? SKELETON_INSERT_LABELS[insert] : "",
    });
  });
  return out;
}

// ── 摘要文案 ────────────────────────────────────────────────────────────────

export interface TotalsSummary {
  stable: string;
  dynamic: string;
  budget: string;
  truncation: string;
  matched: string;
  lines: string[];
}

/**
 * 摘要卡文案。层内**条数**只能由 `order[]` 数出来（`totals` 只给 token），
 * 所以 order 是入参；不传时按 0 条显示，不猜。
 */
export function describeTotals(
  totals: WorldBookPromptPreviewTotalsDTO | null | undefined,
  order: WorldBookPromptPreviewOrderDTO[] | null | undefined = [],
): TotalsSummary {
  const value = totals || {
    stable_tokens: 0, dynamic_tokens: 0, budget_tokens: 0,
    truncated: false, candidate_count: 0, matched_count: 0,
  };
  const stableCount = (order || []).filter((entry) => entry && entry.layer === "stable").length;
  const dynamicCount = (order || []).filter((entry) => entry && entry.layer === "dynamic").length;
  const stable = `稳定层 ${stableCount} 条 / ${value.stable_tokens} token`;
  const dynamic = `动态层 ${dynamicCount} 条 / ${value.dynamic_tokens} token`;
  const budget = value.budget_tokens > 0 ? `预算 ${value.budget_tokens} token` : "未设预算（不限）";
  const truncation = value.truncated ? "已按预算截断：超出的条目没有插进去" : "未截断";
  const matched = `候选 ${value.candidate_count} 条 / 本轮命中 ${value.matched_count} 条`;
  return { stable, dynamic, budget, truncation, matched, lines: [stable, dynamic, budget, truncation, matched] };
}

// ── 命中原因 ────────────────────────────────────────────────────────────────

export const REASON_LABELS: Record<string, string> = {
  always: "起点：基础设定",
  manual: "手动追加",
  requires: "依赖带出",
  full_scope: "全量兼容",
  legacy_full_scope: "全量兼容",
};

/** 命中原因：`reasons`（服务端口径）+ `matched_keys`（关键词命中键）→ 中文短语。 */
export function describeReasons(
  reasons: string[] | null | undefined,
  matchedKeys: string[] | null | undefined = [],
): string[] {
  const out: string[] = [];
  for (const raw of reasons || []) {
    const reason = String(raw || "");
    if (!reason) continue;
    if (reason.startsWith("roster:")) {
      const ids = reason.slice("roster:".length).split(",").map((id) => id.trim()).filter(Boolean);
      out.push(ids.length ? `起点：角色入队（${ids.join("、")}）` : "起点：角色入队");
      continue;
    }
    out.push(REASON_LABELS[reason] || reason);
  }
  for (const key of matchedKeys || []) if (key) out.push(`关键词命中：${key}`);
  return out;
}

// ── 会话最近对话 ────────────────────────────────────────────────────────────

export const RECENT_ROLE_LABELS: Record<string, string> = { user: "用户", assistant: "助手" };

/**
 * 用当前会话的真实 user / assistant 消息拼 `recent_text`：先只保留这两种角色，
 * 再取**最后 N 条**（顺序保持原样）。narrative / narrator / system 等不算真实对话。
 */
export function sessionRecentText(
  messages: ChatMessage[] | null | undefined, limit = 10,
): string {
  const limitValue = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0));
  if (!limitValue) return "";
  const dialogue = (messages || []).filter((message) => message
    && (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string" && message.content.trim());
  return dialogue.slice(-limitValue)
    .map((message) => `${RECENT_ROLE_LABELS[message.role] || message.role}：${message.content.trim()}`)
    .join("\n");
}

/** 当前会话里真实对话（user / assistant）的条数，用于按钮禁用说明。 */
export function recentDialogueCount(messages: ChatMessage[] | null | undefined): number {
  return (messages || []).filter((message) => message
    && (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string" && message.content.trim()).length;
}
