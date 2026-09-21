/**
 * 世界书资料库体验的纯逻辑（无 React、无副作用、不改入参）。
 *
 * 这里只放可以在 Node 里直接断言的决策函数：用途筛选、列表分组、摘录草稿的
 * 初始化与提交载荷折算。UI 组件只负责收集用户输入与显示结果。
 */
import type {
  WorldBookCategoryDTO,
  WorldBookEntryDTO,
  WorldBookExcerptItemDTO,
  WorldBookSummary,
  WorldBookType,
} from "../types";

/** 用途标签与说明：新建/导入时解释两种用途的差别 */
export const BOOK_TYPE_LABELS: Record<WorldBookType, string> = {
  story: "剧情世界书",
  reference: "资料库",
};

export const BOOK_TYPE_HINTS: Record<WorldBookType, string> = {
  story:
    "用于剧情：可被会话绑定、可设为全局默认，条目会按触发词参与注入。",
  reference:
    "存入资料库：只供浏览、检索与摘录，不参与任何会话解析，也不能设为默认或被绑定。",
};

/** 顶层筛选：`all` 之外只留两种真实用途 */
export type BookTypeFilter = "all" | WorldBookType;

/**
 * 读取一本书的用途。旧数据/旧接口可能没有该字段，一律按 story 处理
 * （与后端 `normalize_book_type` 的缺省语义保持一致）。
 */
export function bookTypeOf(book: Pick<WorldBookSummary, "book_type"> | null | undefined): WorldBookType {
  return book?.book_type === "reference" ? "reference" : "story";
}

export function isReference(book: Pick<WorldBookSummary, "book_type"> | null | undefined): boolean {
  return bookTypeOf(book) === "reference";
}

/**
 * 世界书工作台页签 id。
 *
 * 单一来源约定：类型与 `stores/appStore.ts` 的 `WorldBookTab` 同值域，
 * 这里额外提供一个本地别名，供纯逻辑（Node 断言）在不引入 React/store 的情况下使用。
 */
export type WorldBookTabId = "entries" | "load" | "prompt" | "nodes" | "index";

const KNOWN_WORLDBOOK_TABS = new Set<WorldBookTabId>(["entries", "load", "prompt", "nodes", "index"]);

/**
 * 把「期望的页签」收敛到当前这本书**真实可用**的页签。
 *
 * 语义由原 `normalizeDetailTab` 迁移而来（原函数只管详情区两个页签，
 * 现已并进工作台的 5 个页签，见提案 §3.1 的页签状态收敛）：
 *
 * 存在的坑：切换所选书时若沿用上一个页签，用户在剧情书里打开「分类与载入」
 * 再切到资料库，页签按钮与配置内容都被隐藏，而条目页也因为 tab 仍是 load 不渲染
 * —— 详情区就空成一片白。所以 rules 如下：
 * - 资料库（`reference`）只有条目页与本家索引；分类与载入 / Prompt 预览 / 节点视图
 *   都依赖这本书的条目与依赖规则，资料库没有，因此这三个一律归一到 `entries`；
 * - 其余只接受已知的 5 个值，脏值（含 `null` / `undefined` / 未知字符串）兜底到
 *   `entries`，正常值原样返回。
 */
export function normalizeWorldbookTab(
  tab: WorldBookTabId | string | null | undefined,
  book: Pick<WorldBookSummary, "book_type"> | null | undefined,
): WorldBookTabId {
  const known = KNOWN_WORLDBOOK_TABS.has(tab as WorldBookTabId) ? (tab as WorldBookTabId) : "entries";
  if (!isReference(book)) return known;
  // 本家索引管的是内置语料索引 / 会话白名单，与被选中的世界书无关，资料库下同样可达。
  return known === "index" ? "index" : "entries";
}

/** 按用途筛选书列表；`all` 返回原顺序（不重排、不改入参） */
export function filterBooksByType(
  books: readonly WorldBookSummary[],
  filter: BookTypeFilter,
): WorldBookSummary[] {
  if (filter === "all") return [...books];
  return books.filter((book) => bookTypeOf(book) === filter);
}

/** 列表分组：剧情书在前、资料库在后，组内保持原顺序 */
export function groupBooksByType(
  books: readonly WorldBookSummary[],
): { story: WorldBookSummary[]; reference: WorldBookSummary[] } {
  const story: WorldBookSummary[] = [];
  const reference: WorldBookSummary[] = [];
  for (const book of books) {
    (bookTypeOf(book) === "reference" ? reference : story).push(book);
  }
  return { story, reference };
}

/** 可绑定/可设为默认的目标（只有剧情世界书）。用于「加入剧情世界书」的目标下拉 */
export function storyBookTargets(books: readonly WorldBookSummary[]): WorldBookSummary[] {
  return books.filter((book) => bookTypeOf(book) === "story" && book.enabled);
}

/** 一条资料的检索命中（跨书搜索结果的扁平化视图） */
export interface LibraryHit {
  bookId: string;
  bookName: string;
  entry: WorldBookEntryDTO;
}

/**
 * 把跨书搜索结果摊平成「资料条目」列表。
 * 只保留 reference 命中，因此可直接喂给资料库视图。
 */
export function flattenLibraryHits(
  results: readonly { book: WorldBookSummary; matches: WorldBookEntryDTO[] }[],
): LibraryHit[] {
  const hits: LibraryHit[] = [];
  for (const result of results) {
    if (!isReference(result.book)) continue;
    for (const entry of result.matches) {
      hits.push({ bookId: result.book.id, bookName: result.book.name, entry });
    }
  }
  return hits;
}

/** 摘录草稿：默认带入原文，用户可在提交前编辑 */
export interface ExcerptDraft {
  sourceBookId: string;
  sourceBookName: string;
  sourceEntryUid: string;
  name: string;
  content: string;
  triggerKeysText: string;
  secondaryKeysText: string;
  targetBookId: string;
}

export function draftFromEntry(
  source: { bookId: string; bookName: string; entry: WorldBookEntryDTO },
  targetBookId = "",
): ExcerptDraft {
  return {
    sourceBookId: source.bookId,
    sourceBookName: source.bookName,
    sourceEntryUid: source.entry.uid,
    name: source.entry.name || "",
    content: source.entry.content || "",
    triggerKeysText: (source.entry.trigger_keys || []).join(", "),
    secondaryKeysText: (source.entry.secondary_keys || []).join(", "),
    targetBookId,
  };
}

function splitKeys(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 把摘录草稿折算成请求项。
 *
 * 只有用户真的改过的字段才出现在载荷里（`only` 决定哪些字段参与比较）。
 * 这样「原文照搬」与「编辑剧情使用稿」走同一条接口，但服务端能看出差异，
 * 前端也不会把 `name` 之类字段用空串意外覆盖掉来源。
 */
export function excerptItemFromDraft(
  draft: ExcerptDraft,
  original: WorldBookEntryDTO,
): WorldBookExcerptItemDTO {
  const item: WorldBookExcerptItemDTO = {
    source_book_id: draft.sourceBookId,
    source_entry_uid: draft.sourceEntryUid,
  };
  if (draft.name !== (original.name || "")) item.name = draft.name.trim();
  if (draft.content !== (original.content || "")) item.content = draft.content;
  const triggers = splitKeys(draft.triggerKeysText);
  if (triggers.join("\u0000") !== (original.trigger_keys || []).join("\u0000")) {
    item.trigger_keys = triggers;
  }
  const secondary = splitKeys(draft.secondaryKeysText);
  if (secondary.join("\u0000") !== (original.secondary_keys || []).join("\u0000")) {
    item.secondary_keys = secondary;
  }
  return item;
}

/**
 * 摘录前校验：目标必选、正文非空。返回 null 表示可以提交。
 *
 * 正文按**实际会提交的内容**判断：草稿与原文一致时以原文为准
 * （否则「默认带入原文」的流程会被误判成空正文）。
 */
export function validateExcerptDraft(
  draft: ExcerptDraft,
  original: WorldBookEntryDTO,
): string | null {
  if (!draft.targetBookId) return "请选择要加入的剧情世界书";
  const content = draft.content === (original.content || "") ? original.content : draft.content;
  if (!content || !content.trim()) return "条目正文不能为空";
  return null;
}

/**
 * 目标书变更后，把 `category_id` 收敛到目标书真实存在的分类；
 * 不存在时退回未分类（不把条目放进别的书的分类 ID）。
 */
export function resolveCategoryForTarget(
  categoryId: string | undefined,
  targetCategories: readonly WorldBookCategoryDTO[],
): string {
  const known = new Set(targetCategories.map((category) => category.id));
  if (categoryId && known.has(categoryId)) return categoryId;
  return known.has("unclassified") ? "unclassified" : categoryId || "unclassified";
}
