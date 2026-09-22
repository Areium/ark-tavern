/**
 * 世界书来源分组 — 「角色 → 角色库 / 资产 / 卡牌」三个界面共用的分组维度。
 *
 * 条目可能来自三种途径：从某本世界书导入、随角色卡自带（导入角色卡时一并导入的
 * 内嵌世界书，后端会把它记进实体的 `worldbook_id`）、或用户手动创建。三者在数据上
 * 只在「来源世界书」这一项上区分：能确定来源的按书分组，确定不了的统一归入「未分类」。
 *
 * 判定只看来源字段本身，不读条目其它字段；字段缺失 / null / 空白串一律按未分类处理，
 * 因此旧数据不会因为多了这一维度而报错。
 *
 * 组内顺序保持调用方传入的既有顺序（不重排）；组间顺序见 `groupByWorldbook`。
 */
import type { WorldBookSummary } from "../types";

/** 「未分类」分组键。与后端 worldbook_id 的空串一一对应，不会与真实书 id 撞车。 */
export const UNCLASSIFIED_KEY = "__none__";

/** 「未分类」分组标题 */
export const UNCLASSIFIED_LABEL = "未分类";

/** 一个来源世界书分组（未分类也是其中一个，固定排在最后） */
export interface WorldbookSourceGroup<T> {
  /** 分组键：世界书 id，或 `UNCLASSIFIED_KEY`（未分类） */
  key: string;
  /** 组标题：世界书名称，或「未分类」 */
  label: string;
  /** 是否为「未分类」组。等于 `key === UNCLASSIFIED_KEY`，供渲染直接取用 */
  unclassified: boolean;
  /** 组内条目，保持传入顺序 */
  items: T[];
}

/** 中文字典序（按拼音）。模块级复用，避免每次比较都构造 collator。 */
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/**
 * 把任意来源字段值归一化为分组键。
 * 空白串 / null / undefined / 缺失字段 → 未分类。
 */
export const worldbookKeyOf = (bookId: string | null | undefined): string => {
  const id = (bookId ?? "").trim();
  return id === "" ? UNCLASSIFIED_KEY : id;
};

/**
 * 世界书 id → 展示名。
 * 查不到（书已删除、停用、列表尚未加载完）时回落为 id 本身，保证分组标题永远非空。
 */
export const makeBookNameResolver =
  (worldbooks: readonly WorldBookSummary[]) =>
  (bookId: string): string =>
    worldbooks.find((b) => b.id === bookId)?.name || bookId;

/**
 * 一级按来源世界书分组。
 *
 * 组间排序选「按世界书名称」（中文字典序）而不是「按条目数倒序」：固定维度下组的位置
 * 只由书名决定，不随条目增删、也不随搜索/筛选改变命中数量而跳动——用户凭书名定位分组时
 * 位置稳定；条目数倒序会让分组在用户输入搜索词的过程中不断重排，反而找不到东西。
 *
 * 未分类恒排最后（无论名称序如何）。
 */
export const groupByWorldbook = <T>(
  items: readonly T[],
  getBookId: (item: T) => string | null | undefined,
  resolveBookName: (bookId: string) => string,
): WorldbookSourceGroup<T>[] => {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = worldbookKeyOf(getBookId(item));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: WorldbookSourceGroup<T>[] = [];
  for (const [key, groupItems] of buckets) {
    if (key === UNCLASSIFIED_KEY) continue;
    // 书名分辨率保持与 id 一致；同名的书用 id 兜底，排序结果稳定可复现
    groups.push({
      key,
      label: resolveBookName(key) || key,
      unclassified: false,
      items: groupItems,
    });
  }
  groups.sort(
    (a, b) => collator.compare(a.label, b.label) || collator.compare(a.key, b.key),
  );

  const unclassified = buckets.get(UNCLASSIFIED_KEY);
  if (unclassified && unclassified.length > 0) {
    groups.push({
      key: UNCLASSIFIED_KEY,
      label: UNCLASSIFIED_LABEL,
      unclassified: true,
      items: unclassified,
    });
  }
  return groups;
};

/**
 * 该分组在当前选择下是否展开。
 *
 * - `activeKey === ""`（全部）：跟随分组自身的折叠状态；
 * - 已选中某分组：只有该分组可展开，其余分组只留标题，便于直接切换来源。
 */
export const isGroupExpanded = <T>(
  group: WorldbookSourceGroup<T>,
  activeKey: string,
  collapsedKeys: ReadonlySet<string>,
): boolean =>
  (activeKey === "" || activeKey === group.key) && !collapsedKeys.has(group.key);
