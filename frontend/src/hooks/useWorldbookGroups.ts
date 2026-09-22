/**
 * 使用来源世界书分组 — 「角色库 / 资产 / 卡牌」三个界面共用的状态与派生分组。
 *
 * 只持有「分组折叠状态」这一份界面状态；当前选中的来源（`activeKey`）由调用方控制，
 * 因为资产/卡牌界面已有自己的来源筛选状态，两者必须是同一份，不能各存一个。
 *
 * 派生分组刻意不做 useMemo：调用方传入的 `getBookId` 通常是内联箭头函数，每次渲染
 * 都是新引用，memo 起不到作用；三处列表规模都在数十到数百条量级，直接算与现有代码
 * 里逐个 `filter` 的做法一致。
 */
import { useCallback, useState } from "react";
import type { WorldBookSummary } from "../types";
import {
  groupByWorldbook,
  makeBookNameResolver,
} from "../utils/worldbookGrouping";

export function useWorldbookGroups<T>(
  items: readonly T[],
  getBookId: (item: T) => string | null | undefined,
  worldbooks: readonly WorldBookSummary[],
  activeKey: string,
) {
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const resolveBookName = useCallback(makeBookNameResolver(worldbooks), [worldbooks]);
  const groups = groupByWorldbook(items, getBookId, resolveBookName);
  const groupKeys = groups.map((g) => g.key);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsedKeys(new Set<string>()), []);
  // groupKeys 每次渲染都是新数组，这两个回调无需（也无法）稳定引用
  const collapseAll = () => setCollapsedKeys(new Set(groupKeys));

  const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsedKeys.has(k));

  /** 当前选中来源下的条目；`""`（全部）时即传入的全部条目 */
  const selectedItems: readonly T[] =
    activeKey === "" ? items : groups.find((g) => g.key === activeKey)?.items ?? [];

  return {
    groups,
    collapsedKeys,
    toggleCollapsed,
    expandAll,
    collapseAll,
    allCollapsed,
    selectedItems,
  };
}
