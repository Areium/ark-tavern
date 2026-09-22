/**
 * 卡牌管理 — 角色卡牌与职业卡牌编辑。
 *
 * 由「角色 → 卡牌」页签挂载（原 DocumentManager 卡牌 Tab 独立成组件）。
 *
 * 来源标注：每个角色/职业条目显示所属世界书（index.md frontmatter 的
 * worldbook_id），详情面板可修改归属。
 *
 * 分组维度两个，并列存在：
 *  - 按类型（默认，原有维度）：角色卡牌 / 职业卡牌两组；
 *  - 按世界书：一级按来源世界书分组，组内保持「角色在前、职业在后」的原有顺序，
 *    行内图标仍区分角色/职业。两个维度的来源选择共用同一个 `bookFilter` 状态。
 *
 * 工具栏只有一个「折叠 / 展开」，作用于当前维度的一级分组。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useWorldbookGroups } from "../hooks/useWorldbookGroups";
import { UNCLASSIFIED_KEY } from "../utils/worldbookGrouping";
import type { CardsTreeDTO, WorldBookSummary } from "../types";
import CardEditor from "./combat/CardEditor";
import WorldbookGroupList, { GroupDimensionToggle } from "./WorldbookGroupList";
import AppIcon from "./AppIcon";
import {
  EmptyState, FoldAllButton, PanelHeader, SearchInput, SourceBookBadge, ToolIconButton, WorldbookSelect,
} from "./roles/RoleWidgets";
import "../styles/roles.css";

interface ToastState {
  message: string;
  type: "success" | "error";
}

/** 卡牌条目的两个来源分类维度 */
type CardDimension = "type" | "worldbook";

type EntityType = "character" | "class";

/** 卡牌条目（角色卡牌 / 职业卡牌），按世界书分组时用 */
interface CardEntry {
  type: EntityType;
  name: string;
}

export default function CardManager() {
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;

  // ── 数据 ──
  const [cardsTree, setCardsTree] = useState<CardsTreeDTO | null>(null);
  const [worldbooks, setWorldbooks] = useState<WorldBookSummary[]>([]);
  const [search, setSearch] = useState("");
  /** 来源筛选："" = 全部，`UNCLASSIFIED_KEY` = 未分类，否则为 book id */
  const [bookFilter, setBookFilter] = useState("");
  const [dimension, setDimension] = useState<CardDimension>("type");
  const [collapsed, setCollapsed] = useState<{ characters: boolean; classes: boolean }>({ characters: false, classes: false });
  const [selectedCardEntity, setSelectedCardEntity] = useState<string | null>(null);
  const [selectedCardEntityType, setSelectedCardEntityType] = useState<EntityType | null>(null);

  // ── Toast ──
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const loadCardsTree = useCallback(async () => {
    try {
      const data = await apiRef.current.getCardsTree();
      setCardsTree(data);
    } catch { /* ignore */ }
  }, []);

  const loadWorldbooks = useCallback(async () => {
    try {
      const res = await apiRef.current.listWorldbooks();
      setWorldbooks(res.books || []);
    } catch { /* 后端不可用时不阻塞卡牌管理 */ }
  }, []);

  useEffect(() => {
    loadCardsTree();
    loadWorldbooks();
  }, [loadCardsTree, loadWorldbooks]);

  const bookName = (id: string) => worldbooks.find((b) => b.id === id)?.name || id;
  const bookOf = (type: EntityType, name: string) =>
    (type === "character"
      ? cardsTree?.worldbook_map?.characters?.[name]
      : cardsTree?.worldbook_map?.classes?.[name]) || "";

  /** 修改角色/职业的所属世界书标注 */
  const handleSetWorldbook = async (type: EntityType, name: string, bookId: string) => {
    const category = type === "character" ? "characters" : "classes";
    try {
      await apiRef.current.setEntityWorldbook(category, name, bookId);
      showToast(bookId ? "所属世界书已标注" : "已清除标注");
      setCardsTree((prev) => {
        if (!prev?.worldbook_map) return prev;
        const map = prev.worldbook_map;
        return {
          ...prev,
          worldbook_map: {
            characters: type === "character" ? { ...map.characters, [name]: bookId } : { ...map.characters },
            classes: type === "class" ? { ...map.classes, [name]: bookId } : { ...map.classes },
          },
        };
      });
    } catch (err: any) {
      showToast(err.message || "标注失败", "error");
    }
  };

  // ── 筛选：名称搜索（两个维度都生效）+ 来源（只在按类型维度生效，见下）──
  const query = search.trim().toLowerCase();
  const matchSearch = (name: string) => !query || name.toLowerCase().includes(query);
  const matchBook = (type: EntityType, name: string) => {
    if (!bookFilter) return true;
    const id = bookOf(type, name);
    return bookFilter === UNCLASSIFIED_KEY ? !id : id === bookFilter;
  };

  const characters = (cardsTree?.characters || []).filter((n) => matchSearch(n) && matchBook("character", n));
  const classes = (cardsTree?.classes || []).filter((n) => matchSearch(n) && matchBook("class", n));

  // ── 来源世界书维度（与「按类型」并列）──
  // 条目顺序保持原有的「角色在前、职业在后」；刻意不先按 bookFilter 过滤，
  // 否则未被选中的分组会全部显示为 0 条，没法直接切换来源。
  const allCardEntries: CardEntry[] = [
    ...(cardsTree?.characters || []).filter(matchSearch).map((name): CardEntry => ({ type: "character", name })),
    ...(cardsTree?.classes || []).filter(matchSearch).map((name): CardEntry => ({ type: "class", name })),
  ];
  const {
    groups: worldbookGroups,
    collapsedKeys: collapsedBookKeys,
    toggleCollapsed: toggleBookCollapsed,
    expandAll: expandAllBooks,
    collapseAll: collapseAllBooks,
    allCollapsed: allBooksCollapsed,
  } = useWorldbookGroups(allCardEntries, (e) => bookOf(e.type, e.name), worldbooks, bookFilter);

  // 折叠按钮作用于当前维度的一级分组：按类型 = 角色/职业两组；按世界书 = 各书
  const typeAllCollapsed = collapsed.characters && collapsed.classes;
  const foldCollapsed = dimension === "worldbook" ? allBooksCollapsed : typeAllCollapsed;
  const toggleFoldAll = () => {
    if (dimension === "worldbook") {
      if (allBooksCollapsed) expandAllBooks(); else collapseAllBooks();
    } else {
      setCollapsed({ characters: !typeAllCollapsed, classes: !typeAllCollapsed });
    }
  };

  const selectEntity = (type: EntityType, name: string) => {
    setSelectedCardEntity(name);
    setSelectedCardEntityType(type);
  };

  const renderEntityRow = (type: EntityType, name: string) => {
    const selected = selectedCardEntity === name && selectedCardEntityType === type;
    const bookId = bookOf(type, name);
    const classOf = type === "character" ? cardsTree?.character_class_map[name] : undefined;
    return (
      <button
        type="button"
        key={`${type}-${name}`}
        onClick={() => selectEntity(type, name)}
        aria-pressed={selected}
        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left text-xs border transition-colors ${
          selected
            ? "bg-amber-600/20 text-amber-300 border-amber-600/30"
            : "text-gray-300 hover:bg-gray-800 border-transparent"
        }`}
      >
        <AppIcon
          name={type === "character" ? "user" : "class"}
          size={13}
          className={type === "character" ? "text-purple-400" : "text-amber-500"}
        />
        <span className="truncate">{name}</span>
        {classOf && <span className="text-[10px] text-gray-500 shrink-0">{classOf}</span>}
        <span className="flex-1" />
        {/* 来源徽章只在「按类型」维度显示；「按世界书」维度下分组标题已经标明来源。
            未标注的条目不占位，免得 9 个职业各拖一个「未分类」 */}
        {dimension === "type" && bookId && (
          <SourceBookBadge size="xs" name={bookName(bookId)} title={`所属世界书：${bookName(bookId)}`} />
        )}
      </button>
    );
  };

  const renderTypeGroup = (key: "characters" | "classes", label: string, type: EntityType, names: string[]) => {
    const isCollapsed = collapsed[key];
    return (
      <div>
        <button
          type="button"
          className="w-full flex items-center gap-1 py-1 px-1 rounded text-xs font-medium text-gray-400 hover:text-gray-200 select-none"
          onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
          aria-expanded={!isCollapsed}
        >
          <AppIcon name={isCollapsed ? "forward" : "expand"} size={12} className="text-gray-500" />
          <AppIcon name={type === "character" ? "user" : "class"} size={13} className={type === "character" ? "text-purple-400" : "text-amber-500"} />
          <span>{label}</span>
          <span className="text-[11px] text-gray-600 font-normal">({names.length})</span>
        </button>
        {!isCollapsed && (
          <div className="ml-2 pl-2 border-l border-gray-700/30 space-y-0.5">
            {names.length === 0 ? (
              <p className="text-xs text-gray-600 italic pl-2 py-1">(空)</p>
            ) : (
              names.map((name) => renderEntityRow(type, name))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="roles-shell flex h-full">
      {/* ── 卡牌树侧栏 ── */}
      <div className="w-72 border-r border-gray-700 flex flex-col shrink-0">
        <div className="p-2 border-b border-gray-700 space-y-2">
          <div className="flex items-center gap-1.5">
            <SearchInput value={search} onChange={setSearch} placeholder="搜索角色 / 职业…" />
            <ToolIconButton icon="refresh" label="刷新" onClick={() => void loadCardsTree()} />
            <FoldAllButton
              collapsed={foldCollapsed}
              onToggle={toggleFoldAll}
              what={dimension === "worldbook" ? "世界书分组" : "分组"}
              disabled={!cardsTree || (dimension === "worldbook" && worldbookGroups.length === 0)}
            />
          </div>
          <GroupDimensionToggle
            value={dimension}
            onChange={setDimension}
            options={[
              { id: "type", label: "按类型", icon: "cards", hint: "角色卡牌 / 职业卡牌两组" },
              { id: "worldbook", label: "按世界书", icon: "worldbook", hint: "按来源世界书分组" },
            ]}
          />
          {dimension === "type" && (
            <select
              className="w-full bg-gray-800/80 border border-gray-700 rounded-md px-2 py-1 text-[11px] text-gray-300"
              value={bookFilter}
              onChange={(e) => setBookFilter(e.target.value)}
              title="按所属世界书筛选"
            >
              <option value="">全部世界书</option>
              <option value={UNCLASSIFIED_KEY}>未分类</option>
              {worldbooks.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {!cardsTree ? (
            <p className="text-gray-500 text-xs text-center py-4">加载中…</p>
          ) : dimension === "worldbook" ? (
            <WorldbookGroupList
              groups={worldbookGroups}
              totalCount={allCardEntries.length}
              activeKey={bookFilter}
              collapsedKeys={collapsedBookKeys}
              onSelect={setBookFilter}
              onToggleCollapse={toggleBookCollapsed}
              renderItems={(items) =>
                items.length === 0 ? (
                  <p className="text-xs text-gray-600 italic pl-1">(空)</p>
                ) : (
                  items.map((e) => renderEntityRow(e.type, e.name))
                )
              }
              emptyHint={
                <p className="text-gray-500 text-xs text-center py-4">
                  {search ? "无匹配条目" : "暂无卡牌条目"}
                </p>
              }
            />
          ) : (
            <div className="space-y-2">
              {renderTypeGroup("characters", "角色卡牌", "character", characters)}
              {renderTypeGroup("classes", "职业卡牌", "class", classes)}
            </div>
          )}
        </div>
      </div>

      {/* ── 卡牌编辑器面板 ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900/30">
        {!selectedCardEntity || !selectedCardEntityType ? (
          <EmptyState
            icon="cards"
            text="选择左侧条目编辑卡牌"
            sub="角色的专属卡牌与职业共享的职业卡牌都在这里编辑"
          />
        ) : (
          <>
            <PanelHeader
              eyebrow={selectedCardEntityType === "character" ? "角色卡牌" : "职业卡牌"}
              icon={selectedCardEntityType === "character" ? "user" : "class"}
              title={selectedCardEntity}
              actions={
                <>
                  <span className="text-[11px] text-gray-500">所属世界书</span>
                  <WorldbookSelect
                    value={bookOf(selectedCardEntityType, selectedCardEntity)}
                    worldbooks={worldbooks}
                    onChange={(id) => handleSetWorldbook(selectedCardEntityType, selectedCardEntity, id)}
                  />
                  <ToolIconButton
                    icon="close"
                    label="关闭编辑器"
                    onClick={() => { setSelectedCardEntity(null); setSelectedCardEntityType(null); }}
                  />
                </>
              }
            />
            <div className="flex-1 overflow-hidden">
              <CardEditor
                key={`${selectedCardEntityType}-${selectedCardEntity}`}
                embedded
                entityName={selectedCardEntity}
                entityType={selectedCardEntityType}
              />
            </div>
          </>
        )}
      </div>

      {toast && (
        <div
          className={`fixed bottom-12 right-4 px-3 py-2 rounded-lg shadow-lg text-sm z-50 ${
            toast.type === "success"
              ? "bg-green-800/90 text-green-100"
              : "bg-red-800/90 text-red-100"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
