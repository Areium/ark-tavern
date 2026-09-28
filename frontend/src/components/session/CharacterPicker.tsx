/**
 * 角色候选选择器 — 「主控角色」与「队友入队」**共用**的同一套选择逻辑与界面。
 *
 * 数据来自 `buildCharacterCatalog(/api/characters)`：自建角色与世界书角色在同一列表里，
 * 逐条标注来源，可搜索、可按来源（自建 / 世界书 / 具体某一本书）筛选。新建会话向导的
 * 主控步骤、队友步骤与会话大厅的「添加角色入队」都用这一个组件，避免出现第二份实现。
 *
 * 缺字段兜底（世界书角色常见）：
 *  - 头像：`EntityAvatar` 头像 404 时切「按名取色的首字色块」，不再留一个隐形空方块；
 *  - 简介：空简介显示统一兜底文案，并标「缺简介」，让人知道是角色卡没写而不是加载失败；
 *  - id：没有目录 id 的条目用展示名当键（见 util），完全无法成键的在构建目录时剔除。
 */
import { useId, useMemo, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  catalogBooks,
  filterCharacterCatalog,
  sortCatalogForBook,
  summaryText,
  SOURCE_LABELS,
  type CharacterCatalogItem,
  type CharacterSourceFilter,
} from "../../utils/characterCatalog";
import AppIcon from "../AppIcon";
import EntityAvatar, { characterAvatarUrl } from "../roles/EntityAvatar";
import { SourceBookBadge } from "../roles/RoleWidgets";
import "../../styles/roles.css";

const FILTERS: { id: CharacterSourceFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "own", label: "自建" },
  { id: "worldbook", label: "世界书" },
];

interface FloatingDescription {
  key: string;
  name: string;
  summary: string;
  left: number;
  top: number;
  placement: "above" | "below";
}

const TOOLTIP_WIDTH = 288;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_OFFSET = 14;

interface CharacterPickerProps {
  items: CharacterCatalogItem[];
  /** 已选键。`single` 模式取第一个，`multi` 模式是全部入队角色 */
  selected: string[];
  onSelect: (key: string) => void;
  /** `single`：点一下即选中（主控，单选）；`multi`：点一下切换入队 */
  mode: "single" | "multi";
  /** 已在阵容里、不参与候选的键（队友步骤传主控，主控已经在队里） */
  lockedKeys?: readonly string[];
  /** 锁定项的标签，如「主控（你）」 */
  lockedLabel?: string;
  /** 本次会话绑定的世界书 id：该书角色排在最前，更醒目 */
  preferredBookId?: string | null;
  /** 构建目录时被剔除（既无 id 也无名字）的条目数，>0 时如实提示 */
  skippedCount?: number;
  /** 选中项角标文案（单选模式），如「本次主控」 */
  selectedBadge?: string;
  searchPlaceholder: string;
  /** 精简场景可隐藏搜索框，来源筛选仍保留 */
  showSearch?: boolean;
  /** 精简场景可隐藏“全部 / 自建 / 世界书”来源筛选 */
  showSourceFilters?: boolean;
  /** 默认展示简介；精简场景改为悬停或键盘聚焦磁贴时展示 */
  descriptionOnHover?: boolean;
  emptyText: string;
  gridClassName?: string;
  listClassName?: string;
}

export default function CharacterPicker({
  items,
  selected,
  onSelect,
  mode,
  lockedKeys = [],
  lockedLabel = "已在阵容",
  preferredBookId = null,
  skippedCount = 0,
  selectedBadge = "已选",
  searchPlaceholder,
  showSearch = true,
  showSourceFilters = true,
  descriptionOnHover = false,
  emptyText,
  gridClassName = "grid-cols-2 sm:grid-cols-3 md:grid-cols-4",
  listClassName = "max-h-72",
}: CharacterPickerProps) {
  const descriptionIdPrefix = useId();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<CharacterSourceFilter>("all");
  const [bookId, setBookId] = useState("");
  const [floatingDescription, setFloatingDescription] = useState<FloatingDescription | null>(null);
  const floatingDescriptionId = `${descriptionIdPrefix}-floating-description`;

  const books = useMemo(() => catalogBooks(items), [items]);
  // 有效书筛选：书被删掉后残留的 bookId 不应把列表筛空
  const effectiveBookId = source === "worldbook" && books.some((b) => b.id === bookId) ? bookId : "";
  const filtered = useMemo(
    () => filterCharacterCatalog(
      sortCatalogForBook(items, preferredBookId),
      { query, source, bookId: effectiveBookId },
    ),
    [items, preferredBookId, query, source, effectiveBookId],
  );

  const locked = lockedKeys.filter((key) => items.some((item) => item.key === key));
  const selectedSet = new Set(selected);

  const resetFilters = () => { setQuery(""); setSource("all"); setBookId(""); };
  const filtersActive = !!query.trim() || source !== "all" || !!effectiveBookId;

  const clampTooltipLeft = (desiredLeft: number) => {
    const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - TOOLTIP_MARGIN * 2);
    return Math.min(Math.max(desiredLeft, TOOLTIP_MARGIN), window.innerWidth - width - TOOLTIP_MARGIN);
  };

  const showDescriptionAtPointer = (item: CharacterCatalogItem, event: MouseEvent<HTMLButtonElement>) => {
    const placement = event.clientY > 150 ? "above" : "below";
    setFloatingDescription({
      key: item.key,
      name: item.name,
      summary: summaryText(item),
      left: clampTooltipLeft(event.clientX + TOOLTIP_OFFSET),
      top: placement === "above" ? event.clientY - TOOLTIP_OFFSET : event.clientY + TOOLTIP_OFFSET,
      placement,
    });
  };

  const showDescriptionAtFocus = (item: CharacterCatalogItem, event: FocusEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - TOOLTIP_MARGIN * 2);
    const placement = rect.top > 150 ? "above" : "below";
    setFloatingDescription({
      key: item.key,
      name: item.name,
      summary: summaryText(item),
      left: clampTooltipLeft(rect.left + rect.width / 2 - width / 2),
      top: placement === "above" ? rect.top - 8 : rect.bottom + 8,
      placement,
    });
  };

  return (
    <div className="space-y-2">
      {/* 工具栏：搜索 + 来源筛选 */}
      <div className={`flex flex-wrap items-center gap-2 ${!showSearch && !showSourceFilters ? "justify-end" : ""}`}>
        {showSearch && (
          <div className="relative flex-1 min-w-[10rem]">
            <AppIcon
              name="search"
              size={13}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
            />
            <input
              className="input text-xs w-full pl-7"
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {showSourceFilters && (
          <div className="flex items-center gap-1" role="group" aria-label="按来源筛选">
            {FILTERS.map((filter) => {
              const active = source === filter.id;
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={active}
                  title={filter.id === "own"
                    ? "玩家自己创建或导入的角色（角色卡未标注来源世界书）"
                    : filter.id === "worldbook"
                      ? "来源世界书里定义的角色（随书导入，带 worldbook_id 标注）"
                      : "自建与世界书角色一起显示"}
                  onClick={() => { setSource(filter.id); if (filter.id !== "worldbook") setBookId(""); }}
                  className={`text-[12px] px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? "bg-amber-600/25 text-amber-200 border-amber-500/40"
                      : "bg-gray-800/60 text-gray-400 border-gray-700 hover:text-gray-200"
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
        )}
        {showSourceFilters && source === "worldbook" && books.length > 0 && (
          <select
            className="bg-gray-800/80 border border-gray-700 rounded-md px-1.5 py-1 text-[12px] text-gray-300 max-w-[12rem]"
            value={effectiveBookId}
            onChange={(e) => setBookId(e.target.value)}
            aria-label="按世界书筛选"
          >
            <option value="">全部世界书（{books.length}）</option>
            {books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
          </select>
        )}
        <span className="text-[12px] text-gray-500 whitespace-nowrap">
          候选 {filtered.length}/{items.length}
        </span>
      </div>

      {/* 已在阵容的角色：不参与候选，避免同一角色被两条路径重复添加 */}
      {locked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-gray-500">{lockedLabel}：</span>
          {locked.map((key) => {
            const item = items.find((entry) => entry.key === key);
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full bg-purple-600/20 text-purple-200 border border-purple-500/30"
              >
                <EntityAvatar name={item?.name || key} src={characterAvatarUrl(key)} size={16} shape="circle" />
                {item?.name || key}
              </span>
            );
          })}
        </div>
      )}

      {skippedCount > 0 && (
        <p className="text-[12px] text-amber-300" role="status">
          有 {skippedCount} 个角色卡既没有 id 也没有名称，无法作为阵容键，已从候选中跳过。
        </p>
      )}

      {/* 候选磁贴 */}
      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-6" role="status">
          {filtersActive ? "没有符合条件的角色" : emptyText}
          {filtersActive && (
            <button type="button" onClick={resetFilters} className="ml-2 text-blue-400 hover:underline">
              清除筛选
            </button>
          )}
        </p>
      ) : (
        <div className={`grid gap-2 overflow-y-auto lobby-scroll pr-1 ${gridClassName} ${listClassName}`}>
          {filtered.map((item) => {
            const isSelected = selectedSet.has(item.key);
            const isLocked = lockedKeys.includes(item.key);
            const inBoundBook = !!preferredBookId && item.bookId === preferredBookId;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={isSelected}
                aria-describedby={descriptionOnHover && floatingDescription?.key === item.key
                  ? floatingDescriptionId : undefined}
                disabled={isLocked}
                title={isLocked
                  ? `${item.name} 已经在阵容里（${lockedLabel}）`
                  : mode === "single"
                    ? `选择「${item.name}」作为主控（玩家身份）`
                    : isSelected ? `将「${item.name}」移出阵容` : `将「${item.name}」加入阵容`}
                onClick={() => onSelect(item.key)}
                onMouseMove={descriptionOnHover ? (event) => showDescriptionAtPointer(item, event) : undefined}
                onMouseLeave={descriptionOnHover ? () => setFloatingDescription(null) : undefined}
                onFocus={descriptionOnHover ? (event) => showDescriptionAtFocus(item, event) : undefined}
                onBlur={descriptionOnHover ? () => setFloatingDescription(null) : undefined}
                className={`char-tile p-2.5 flex flex-col items-center gap-1.5 text-left ${
                  isSelected ? "selected" : ""} ${isLocked ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <div className="relative w-full flex justify-center">
                  <EntityAvatar name={item.name} src={characterAvatarUrl(item.key)} size={40} />
                  {isSelected && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-black text-[11px] font-bold flex items-center justify-center shadow">
                      ✓
                    </span>
                  )}
                </div>
                <span className={`text-xs truncate w-full text-center ${isSelected ? "text-amber-300 font-medium" : "text-gray-200"}`}>
                  {item.name}
                </span>
                {!descriptionOnHover && (
                  <span className="text-[11px] text-gray-500 text-center line-clamp-2 w-full leading-snug">
                    {summaryText(item)}
                  </span>
                )}
                <span className="flex flex-wrap items-center justify-center gap-1">
                  {item.source === "worldbook" ? (
                    <SourceBookBadge name={item.bookName || item.bookId} size="xs" />
                  ) : (
                    <span
                      className="text-[11px] px-1 py-px rounded bg-violet-600/20 text-violet-300 border border-violet-500/30"
                      title="玩家自己创建或导入的角色：角色卡未标注来源世界书"
                    >
                      {SOURCE_LABELS.own}
                    </span>
                  )}
                  {inBoundBook && (
                    <span className="text-[11px] px-1 py-px rounded bg-emerald-600/20 text-emerald-300 border border-emerald-500/30">
                      本次绑定
                    </span>
                  )}
                  {item.missing.includes("简介") && (
                    <span className="text-[11px] px-1 py-px rounded bg-gray-700/60 text-gray-400" title="角色卡缺少 summary 字段">
                      缺简介
                    </span>
                  )}
                  {isSelected && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-600/30 text-amber-300">
                      {selectedBadge}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {descriptionOnHover && floatingDescription && typeof document !== "undefined" && createPortal(
        <div
          id={floatingDescriptionId}
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-amber-400/20 bg-gray-950/95 px-3 py-2 text-left shadow-xl"
          style={{
            left: floatingDescription.left,
            top: floatingDescription.top,
            transform: floatingDescription.placement === "above" ? "translateY(-100%)" : undefined,
          }}
        >
          <div className="text-xs font-medium text-amber-300">{floatingDescription.name}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-gray-200">{floatingDescription.summary}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
