/**
 * 来源世界书分组列表 — 「角色库 / 资产 / 卡牌」三个界面共用的分组渲染。
 *
 * 一级按来源世界书分组，组标题用世界书名称，「未分类」固定排在最后；每个分组可单独
 * 展开/折叠，点组标题即选中该来源（只渲染该分组的条目），再点一次或点顶部「全部」回到
 * 全部来源。条目本体由调用方通过 `renderItems` 提供，因此三个界面各自保留原有的行样式
 * 与组内排序——组内顺序就是调用方传入的顺序，本组件只管来源这一维。
 */
import type { ReactNode } from "react";
import AppIcon, { type AppIconName } from "./AppIcon";
import { isGroupExpanded, type WorldbookSourceGroup } from "../utils/worldbookGrouping";

interface WorldbookGroupListProps<T> {
  groups: WorldbookSourceGroup<T>[];
  /** 当前筛选（含搜索）命中的条目总数，用于「全部」计数 */
  totalCount: number;
  /** `""` = 全部；`UNCLASSIFIED_KEY` = 未分类；否则为世界书 id */
  activeKey: string;
  collapsedKeys: ReadonlySet<string>;
  onSelect: (key: string) => void;
  onToggleCollapse: (key: string) => void;
  renderItems: (items: T[], group: WorldbookSourceGroup<T>) => ReactNode;
  /** 「全部」行的文案 */
  allLabel?: string;
  /** 没有任何条目时的占位内容 */
  emptyHint?: ReactNode;
}

export default function WorldbookGroupList<T>({
  groups,
  totalCount,
  activeKey,
  collapsedKeys,
  onSelect,
  onToggleCollapse,
  renderItems,
  allLabel = "全部",
  emptyHint,
}: WorldbookGroupListProps<T>) {
  if (groups.length === 0) {
    return <>{emptyHint ?? null}</>;
  }

  const allSelected = activeKey === "";
  // 选中的来源在本次搜索里没有命中：分组头仍在（可切换），但一条都不展开，
  // 这时必须给一句话，否则列表看起来像坏了。
  const activeMissing = !allSelected && !groups.some((g) => g.key === activeKey);

  return (
    <div className="space-y-1">
      {/* 「全部」：固定在最上，任何时候都能回到不按来源过滤的状态 */}
      <button
        type="button"
        onClick={() => onSelect("")}
        aria-pressed={allSelected}
        title="不按来源过滤，显示全部世界书的条目"
        className={
          "w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs transition-colors " +
          (allSelected
            ? "bg-amber-600/20 text-amber-300 border border-amber-500/30"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 border border-transparent")
        }
      >
        <AppIcon name="content" size={13} />
        <span className="truncate">{allLabel}</span>
        <span className="text-[12px] text-gray-500 ml-auto">({totalCount})</span>
      </button>

      {activeMissing && (
        <p className="text-[11px] text-gray-600 text-center py-1">
          当前来源下无匹配条目，点上方「{allLabel}」查看其它来源
        </p>
      )}

      {groups.map((group) => {
        const selected = activeKey === group.key;
        const expanded = isGroupExpanded(group, activeKey, collapsedKeys);
        return (
          <div key={group.key}>
            <div
              className={
                "group flex items-center gap-1 rounded text-xs transition-colors select-none " +
                (selected
                  ? "bg-amber-600/20 text-amber-300"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50")
              }
            >
              {/* 折叠箭头与选中分开：点箭头只折叠，点标题才切换来源 */}
              <button
                type="button"
                onClick={() => onToggleCollapse(group.key)}
                aria-expanded={expanded}
                aria-label={expanded ? `折叠 ${group.label}` : `展开 ${group.label}`}
                className="w-4 shrink-0 flex items-center justify-center text-gray-500 hover:text-gray-300"
              >
                <AppIcon name={expanded ? "expand" : "forward"} size={12} />
              </button>
              <button
                type="button"
                onClick={() => onSelect(selected ? "" : group.key)}
                aria-pressed={selected}
                title={selected ? "取消选择，回到全部来源" : `只显示来源世界书「${group.label}」的条目`}
                className="flex-1 min-w-0 flex items-center gap-1 py-0.5 text-left"
              >
                <AppIcon
                  name={group.unclassified ? "folder" : "worldbook"}
                  size={12}
                />
                <span className="truncate">{group.label}</span>
                <span className="text-[12px] text-gray-500 shrink-0">
                  ({group.items.length})
                </span>
              </button>
            </div>
            {expanded && (
              <div className="ml-2 pl-2 border-l border-gray-700/30 mt-0.5">
                {renderItems(group.items, group)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface DimensionOption<T extends string> {
  id: T;
  label: string;
  icon: AppIconName;
  hint?: string;
}

/**
 * 分组维度切换 — 在「原有分类维度」与「来源世界书维度」之间切换。
 * 两个维度并列存在：原有维度的渲染逻辑一行未改，本组件只决定当前显示哪一个。
 * 不自带外边距，行距由调用方的工具栏统一控制。
 */
export function GroupDimensionToggle<T extends string>({
  value,
  options,
  onChange,
  extra,
}: {
  value: T;
  options: DimensionOption<T>[];
  onChange: (id: T) => void;
  /** 右侧附加控件（如分组全展开/全折叠） */
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <div
        className="flex items-center gap-0.5 p-0.5 rounded-md bg-gray-800/60 border border-gray-700"
        role="group"
        aria-label="分组维度"
      >
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            title={opt.hint}
            aria-pressed={value === opt.id}
            className={
              "flex items-center gap-1 px-2 py-0.5 rounded text-[12px] whitespace-nowrap transition-colors " +
              (value === opt.id
                ? "bg-amber-600/25 text-amber-300"
                : "text-gray-500 hover:text-gray-300")
            }
          >
            <AppIcon name={opt.icon} size={13} />
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
      <div className="flex-1" />
      {extra}
    </div>
  );
}
