/**
 * 角色候选目录 — 「主控角色」与「队友入队」共用的**唯一**数据源与筛选规则。
 *
 * 一个角色只在这份目录里出现一次：新建会话时玩家从同一个列表里挑主控（= 玩家身份）
 * 与队友，主控随即作为阵容成员入队，不再走第二条「玩家身份」通道。因此这里定义的
 * 键（`key`）、来源标注、缺字段兜底与阵容去重规则，界面各处必须共用，不许各写一份。
 *
 * 数据源是 `/api/characters`（角色库全量，含世界书实体）：
 *  - 玩家自己创建 / 导入的角色：index.md frontmatter 没有 `worldbook_id`；
 *  - 世界书里定义的角色：frontmatter 带 `worldbook_id`（导入角色卡时由
 *    `character_card._stamp_worldbook_id` 写入，见 `tests/test_document_worldbook_source.py`）。
 * 后端只给这一个来源标注，因此「自建 / 世界书」只能以此判定：空白串与缺字段一律按
 * 自建（未标注来源）处理，不按名字或正文猜测。
 *
 * 本文件是纯逻辑（无 React、无副作用、不改入参），与 `worldbook*.ts` 同风格。
 */
import type { PlotInfo, WorldBookSummary } from "../types";

/** `/api/characters` 返回的条目（后端 `DocumentInfo.to_dict` 的子集，缺字段按兜底处理） */
export interface CharacterDoc {
  id?: string;
  name?: string;
  title?: string;
  summary?: string;
  /** 来源世界书 id；空串 / 缺字段 = 自建（未标注来源） */
  worldbook_id?: string | null;
}

/** 候选来源：自建 / 世界书 */
export type CharacterSource = "own" | "worldbook";

export const SOURCE_LABELS: Record<CharacterSource, string> = {
  own: "自建",
  worldbook: "世界书",
};

/** 来源筛选项：`all` = 不筛 */
export type CharacterSourceFilter = "all" | CharacterSource;

export interface CharacterCatalogItem {
  /** 阵容 / 主控用的键：角色目录名，可直接拼 `/api/characters/<key>/avatar` */
  key: string;
  /** 展示名 */
  name: string;
  /** 一句话简介；空串 = 角色卡没写 summary */
  summary: string;
  /** 来源世界书 id；空串 = 自建 */
  bookId: string;
  /** 来源世界书显示名；自建时为空串 */
  bookName: string;
  source: CharacterSource;
  /** 缺少的可选字段名（用于界面兜底标注）；空数组 = 字段齐全 */
  missing: string[];
}

export interface CharacterCatalog {
  items: CharacterCatalogItem[];
  /** 既没有 id 也没有名字、无法作为阵容键而被剔除的条目数 */
  skipped: number;
}

/** 简介兜底文案：缺 summary 的角色卡在候选、阵容与预览里显示同一句 */
export const MISSING_SUMMARY_TEXT = "暂无简介（角色卡未写 summary）";

/** 简介展示值：空简介给兜底文案，界面不用各写一份 */
export const summaryText = (item: Pick<CharacterCatalogItem, "summary">): string =>
  item.summary.trim() || MISSING_SUMMARY_TEXT;

const trimmed = (value: string | null | undefined): string => (value || "").trim();

/** 来源世界书显示名：书列表里查不到（书已删 / 未加载）时退回 id，仍能看清来源 */
export const bookDisplayName = (
  bookId: string,
  books: readonly Pick<WorldBookSummary, "id" | "name">[],
): string => {
  if (!bookId) return "";
  return books.find((book) => book.id === bookId)?.name || bookId;
};

/**
 * `/api/characters` 响应 + 书列表 → 候选目录。
 *
 * 兜底口径（世界书角色常常缺字段，不能因此消失或空白）：
 *  - 缺 `id`：用展示名当键（后端按目录名加载，名字即目录名的老数据仍然可用）；
 *  - 连 `id` 与名字都没有：无法作为阵容键 → 剔除并计入 `skipped`，界面如实提示条数；
 *  - 缺 `summary`：`missing` 里记一笔，展示用 `summaryText` 的兜底文案；
 *  - 缺头像：没有字段可判定，交给 `EntityAvatar` 的「首字色块」兜底（头像 404 时自动切换）。
 */
export function buildCharacterCatalog(
  docs: readonly CharacterDoc[],
  books: readonly Pick<WorldBookSummary, "id" | "name">[] = [],
): CharacterCatalog {
  const items: CharacterCatalogItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const doc of docs || []) {
    const key = trimmed(doc?.id) || trimmed(doc?.name) || trimmed(doc?.title);
    if (!key) {
      skipped += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const bookId = trimmed(doc?.worldbook_id);
    const summary = trimmed(doc?.summary);
    const missing: string[] = [];
    if (!trimmed(doc?.id)) missing.push("目录 id");
    if (!summary) missing.push("简介");

    items.push({
      key,
      name: trimmed(doc?.name) || trimmed(doc?.title) || key,
      summary,
      bookId,
      bookName: bookDisplayName(bookId, books),
      source: bookId ? "worldbook" : "own",
      missing,
    });
  }

  return { items, skipped };
}

/** 目录里出现过的来源世界书（供「按来源筛选」的书下拉） */
export function catalogBooks(
  items: readonly CharacterCatalogItem[],
): { id: string; name: string }[] {
  const books = new Map<string, string>();
  for (const item of items) {
    if (item.bookId && !books.has(item.bookId)) books.set(item.bookId, item.bookName || item.bookId);
  }
  return [...books.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 搜索命中：名字 / 键 / 简介 / 来源书名，任一包含关键词即可（大小写不敏感） */
export function matchCatalogItem(item: CharacterCatalogItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [item.name, item.key, item.summary, item.bookName]
    .join("\u0000")
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * 按搜索词 + 来源筛选候选。
 * `bookId` 只在「世界书」筛选下生效（具体某一本书）；`all` 下忽略，避免与自建混淆。
 */
export function filterCharacterCatalog(
  items: readonly CharacterCatalogItem[],
  options: { query?: string; source?: CharacterSourceFilter; bookId?: string } = {},
): CharacterCatalogItem[] {
  const { query = "", source = "all", bookId = "" } = options;
  return items.filter((item) => {
    if (source !== "all" && item.source !== source) return false;
    if (source === "worldbook" && bookId && item.bookId !== bookId) return false;
    return matchCatalogItem(item, query);
  });
}

/**
 * 优先展示本次绑定的世界书里的角色（稳定排序，保持其余相对顺序）。
 *
 * 绑定了世界书时，玩家多半要从这本书里挑主控；把该书角色提到最前，
 * 其余角色顺序不变，来源徽章仍然逐条标注，不隐藏任何候选。
 */
export function sortCatalogForBook(
  items: readonly CharacterCatalogItem[],
  boundBookId?: string | null,
): CharacterCatalogItem[] {
  const bound = (boundBookId || "").trim();
  if (!bound) return [...items];
  const preferred: CharacterCatalogItem[] = [];
  const rest: CharacterCatalogItem[] = [];
  for (const item of items) (item.bookId === bound ? preferred : rest).push(item);
  return [...preferred, ...rest];
}

/**
 * 会话阵容 = 主控 + 队友，按此顺序去重。
 *
 * 这是「同一角色不得因身份与入队两条路径重复」的唯一实现：主控排在第一位且只出现
 * 一次，队友列表里即便又带上主控也会被去重。后端 `SceneManager.get_roster()` 是同一
 * 规则的服务端版本，两端口径必须一致。
 */
export function buildLineup(
  mainControl: string | null | undefined,
  teammates: readonly string[] = [],
): string[] {
  const main = trimmed(mainControl);
  const rest = (teammates || []).map(trimmed).filter(Boolean);
  return [...new Set([...(main ? [main] : []), ...rest])];
}

/**
 * 主控选择校验：返回错误文案，`null` = 可以继续。
 *
 * 没有主控就不能创建会话（后端 `POST /api/sessions` 对显式空 identity 同样直接拒绝），
 * 所以这里给出的是**唯一**提示来源，向导与预览共用。
 */
export function mainControlError(
  key: string | null | undefined,
  items: readonly CharacterCatalogItem[],
): string | null {
  const main = trimmed(key);
  if (!main) return "请选择一名主控角色：它就是你本次的玩家身份，并会同时入队。";
  if (items.length && !items.some((item) => item.key === main)) {
    return `所选主控角色「${main}」已不在角色库中，请重新选择。`;
  }
  return null;
}

/** 阵容默认值：谁当主控、谁入队 */
export interface LineupDefaults {
  /** 默认主控（玩家身份）；空串 = 剧情没声明主控、或声明的角色不在角色库里 */
  main: string;
  /** 默认队友：绑定世界书的角色花名册 + 剧情开场角色，去掉主控、只留候选里存在的 */
  teammates: string[];
}

/** 剧情默认阵容：先决定绑定哪本书，再算阵容默认值 */
export interface PlotDefaults extends LineupDefaults {
  /** 本次要绑定的世界书 id（剧情声明的书未安装时原样保留当前选择） */
  books: string[];
}

/** 剧情里用到的三个字段（`PlotInfo` 的子集，便于纯逻辑单测） */
export type PlotRosterSource = Pick<PlotInfo, "worldbook_id" | "player_identity" | "initial_characters">;

/** 能给出角色花名册的世界书（`/api/worldbook` 摘要的子集） */
export type RosterBook = Pick<WorldBookSummary, "id" | "character_ids">;

/** 绑定世界书的角色花名册：按绑定顺序拼接各书的 `character_ids`，去重保序 */
export function bookRosterKeys(
  bookIds: readonly string[],
  books: readonly RosterBook[] = [],
): string[] {
  const keys: string[] = [];
  for (const bookId of bookIds) {
    const roster = books.find((book) => book.id === bookId)?.character_ids || [];
    for (const key of roster) {
      const name = trimmed(key);
      if (name && !keys.includes(name)) keys.push(name);
    }
  }
  return keys;
}

/**
 * 可作为本次会话角色的候选：绑定世界书的角色 + 各书花名册 + 剧情自带阵容；
 * 未绑书时 = 自建角色 + 剧情自带阵容。
 *
 * 花名册与剧情阵容必须能选：拆分出来的剧情书里，书内条目带 `character_id`，而角色卡
 * frontmatter 的 `worldbook_id` 仍记着来源书（如 `arknights`），只按来源书过滤会让
 * 「这本书的角色」整批消失，自动选中与手动挑选都无从谈起。
 */
export function selectableCatalogItems(
  items: readonly CharacterCatalogItem[],
  bookIds: readonly string[] = [],
  plot: PlotRosterSource | null | undefined = null,
  books: readonly RosterBook[] = [],
): CharacterCatalogItem[] {
  const cast = new Set([
    ...bookRosterKeys(bookIds, books),
    trimmed(plot?.player_identity),
    ...(plot?.initial_characters || []).map(trimmed),
  ].filter(Boolean));
  return items.filter((item) => (bookIds.length
    ? bookIds.includes(item.bookId) || cast.has(item.key)
    : item.source === "own" || cast.has(item.key)));
}

/**
 * 阵容默认值 —— 「选中剧情即自动选中」的**唯一**实现（向导与界面提示共用）。
 *
 * 只处理声明与花名册里**确实写着**的东西，不从名字或正文猜主控：
 *  - 主控：剧情 `player_identity` 优先，缺省回退 `initial_characters` 首位；两者都只认候选里
 *    确实存在的键（角色库里没有的角色不能当主控）；
 *  - 队友：`rosterBookIds` 这些书的角色花名册 ∪ 剧情开场角色，去掉主控，同样只保留候选里
 *    存在的键 —— 「这本书的角色」因此默认全部选中，不必逐个点。
 *
 * `rosterBookIds` 默认等于 `bookIds`（手动全选时用）；**自动**选中只传剧情声明的那本书，
 * 免得手动加上一本几百角色的大书就把阵容静默塞满。
 */
export function resolveLineupDefaults(
  bookIds: readonly string[],
  plot: PlotRosterSource | null | undefined,
  books: readonly RosterBook[] = [],
  catalogItems: readonly CharacterCatalogItem[] = [],
  rosterBookIds: readonly string[] = bookIds,
): LineupDefaults {
  const initial = [...new Set((plot?.initial_characters || []).map(trimmed).filter(Boolean))];
  const declaredMain = trimmed(plot?.player_identity);

  const roster = bookRosterKeys(rosterBookIds, books);
  const available = new Set(
    selectableCatalogItems(catalogItems, bookIds, plot, books).map((item) => item.key));

  const main = [declaredMain, ...initial].find((key) => available.has(key)) || "";
  const teammates = [...new Set([...initial, ...roster])]
    .filter((key) => key !== main && available.has(key));
  return { main, teammates };
}

/**
 * 选中剧情后的默认：先决定绑定哪本书，再按这本书与剧情声明算阵容默认值。
 *
 * 自动选中的花名册只取**剧情声明的那本书**（自动绑定的那本）：手动绑的其它书只进候选，
 * 不静默塞进阵容（要全选走界面上的显式按钮）。
 *
 * 「不绑定」时返回空主控与空队友，调用方据此只做「摘掉已失效选择」的收尾
 * （见 `CreateSessionWizard.pickPlot`），不拿它覆盖玩家自己挑的角色。
 */
export function resolvePlotDefaults(
  plot: PlotRosterSource | null | undefined,
  installedBooks: readonly RosterBook[] = [],
  catalogItems: readonly CharacterCatalogItem[] = [],
  currentBooks: readonly string[] = [],
): PlotDefaults {
  if (!plot) return { books: [...currentBooks], main: "", teammates: [] };

  const declaredBook = trimmed(plot.worldbook_id);
  const autoBound = !!declaredBook && installedBooks.some((book) => book.id === declaredBook);
  const books = autoBound ? [declaredBook] : [...currentBooks];
  // 自动选中的花名册只取自动绑定的那本书；剧情声明的书没装时不猜，只按开场角色选
  const rosterBooks = autoBound ? [declaredBook] : [];
  return { books, ...resolveLineupDefaults(books, plot, installedBooks, catalogItems, rosterBooks) };
}
