/**
 * 角色 — 主页一级入口（原「内容中心」的角色内容 / 资产 / 卡牌三模块并入此处）。
 *
 * 内设四个模块页签：
 *  - 角色库（= 角色内容）：浏览全部可用角色，导入角色卡，查看详情，跳转编辑设定/卡牌。
 *  - 玩家身份：创建、编辑、删除多个玩家身份角色，供创建/切换会话时使用。
 *  - 资产 / 卡牌：自原「内容中心」迁入的图片资产与卡牌管理，功能与入口完全等价。
 *
 * 角色库只有一种形态：按来源世界书分组。来源取角色目录 index.md frontmatter 的
 * `worldbook_id`（导入角色卡时后端写入，随卡自带的内嵌世界书即由此标注），缺字段的旧数据
 * 一律归入「未分类」并排在最后。早先与之并列的「平铺」维度展示的是同一份列表，只差不分组，
 * 已撤销；点分组头上的「全部」即可回到不按来源过滤的状态。
 *
 * 页签状态放在 store（`characterTab`）：角色卡详情「编辑卡牌」等跨组件跳转要落到指定页签。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "../hooks/useApi";
import { useAppStore, type CharacterTab } from "../stores/appStore";
import { useWorldbookGroups } from "../hooks/useWorldbookGroups";
import type { WorldBookSummary } from "../types";
import MarkdownRenderer from "./MarkdownRenderer";
import AssetManager from "./AssetManager";
import CardManager from "./CardManager";
import CardEditor from "./combat/CardEditor";
import CharacterStatsEditor from "./roles/CharacterStatsEditor";
import CharacterAssets from "./roles/CharacterAssets";
import WorldbookGroupList from "./WorldbookGroupList";
import AppIcon, { type AppIconName } from "./AppIcon";
import EntityAvatar, { characterAvatarUrl } from "./roles/EntityAvatar";
import {
  ActionButton, EmptyState, FoldAllButton, PanelHeader, SearchInput, SourceBookBadge,
} from "./roles/RoleWidgets";
import "../styles/roles.css";

interface CharacterSummary {
  id: string;
  name: string;
  title?: string;
  /** 来源世界书 id；空串 / 缺字段 = 未分类 */
  worldbook_id?: string;
}

/** /api/characters 的响应 → 列表项（缺 worldbook_id 的旧数据按未分类处理） */
const toCharacterSummaries = (data: unknown): CharacterSummary[] =>
  ((data as any[]) || []).map((c: any) => ({
    id: c.id || c.name || "",
    name: c.name || c.title || c.id || "",
    title: c.title,
    worldbook_id: c.worldbook_id || "",
  }));

interface IdentitySummary {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  worldbook_id: string;
}

interface CharacterDetail {
  metadata: Record<string, any>;
  content: string;
}

/** 角色页模块页签（角色库 / 玩家身份是角色自身内容；资产 / 卡牌自内容中心迁入） */
const MODULE_TABS: { id: CharacterTab; label: string; icon: AppIconName; hint: string }[] = [
  { id: "characters", label: "角色库", icon: "characters", hint: "浏览角色库、导入角色卡、查看详情" },
  { id: "identities", label: "玩家身份", icon: "identity", hint: "创建与管理玩家身份（你自己的角色卡）" },
  { id: "images", label: "资产", icon: "images", hint: "图片资产：上传 / 裁剪 / 默认图 / 来源世界书" },
  { id: "cards", label: "卡牌", icon: "cards", hint: "角色与职业卡牌编辑 / 所属世界书" },
];

/** 左列表 + 右详情的双栏骨架只服务于角色库 / 玩家身份两个模块 */
const ROLE_MODULE_TABS = new Set<CharacterTab>(["characters", "identities"]);

/** 角色详情页签：资料（设定）/ 数值（全局默认值）/ 资产（本角色的图片）/ 卡牌（专属卡牌） */
export type CharacterDetailTab = "profile" | "stats" | "assets" | "cards";
export const CHARACTER_DETAIL_TABS: ReadonlyArray<{ id: CharacterDetailTab; label: string; icon: AppIconName; hint: string }> = [
  { id: "profile", label: "资料", icon: "characters", hint: "属性、标签与背景设定" },
  { id: "stats", label: "数值", icon: "index", hint: "按所属世界书的统一字段编辑全局默认值" },
  { id: "assets", label: "资产", icon: "images", hint: "这个角色的头像 / 立绘 / 卡面" },
  { id: "cards", label: "卡牌", icon: "cards", hint: "这个角色的专属战斗卡牌" },
];

const ATTR_LABELS: Record<string, string> = {
  strength: "力量",
  intelligence: "智力",
  emotional_stability: "情绪",
  combat_skill: "战斗",
  originium_arts: "特殊技艺",
  charisma: "魅力",
  endurance: "耐力",
  agility: "敏捷",
};

/** 属性展示顺序：已知键按 ATTR_LABELS 的顺序，其余键（本家角色的中文键）保持原样排在后面 */
const orderAttrs = (attrs: Record<string, number>): [string, number][] => {
  const known = Object.keys(ATTR_LABELS).filter((k) => k in attrs).map((k): [string, number] => [k, attrs[k]]);
  const rest = Object.entries(attrs).filter(([k]) => !(k in ATTR_LABELS));
  return [...known, ...rest];
};

/** 角色详情页头的分类小标签（职业 / 种族 / 阵营） */
function Chip({ tone, children }: { tone: "blue" | "purple" | "green"; children: ReactNode }) {
  const cls = tone === "blue"
    ? "bg-blue-700/50 text-blue-200"
    : tone === "purple"
      ? "bg-purple-700/50 text-purple-200"
      : "bg-green-800/50 text-green-200";
  return <span className={`px-1.5 py-0.5 rounded text-[12px] ${cls}`}>{children}</span>;
}

/** 左栏列表行：头像 + 名称 + 一行说明，角色库与玩家身份共用 */
function ListRow({
  id, name, sub, selected, onClick, worldbookId,
}: {
  id: string;
  name: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
  worldbookId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left border transition-colors ${
        selected
          ? "bg-amber-600/20 text-amber-300 border-amber-600/30"
          : "text-gray-300 hover:bg-gray-800 border-transparent"
      }`}
    >
      <EntityAvatar name={name} src={characterAvatarUrl(id, worldbookId)} size={30} />
      <div className="min-w-0">
        <div className="text-xs font-medium truncate">{name}</div>
        {sub && <div className="text-[12px] text-gray-500 truncate">{sub}</div>}
      </div>
    </button>
  );
}

export default function CharacterManager() {
  const api = useApi();
  const { setCurrentView, setCharacterTab, setWorldbookJumpId } = useAppStore();

  // 模块页签来自 store（跨组件跳转可指定落点）
  const tab = useAppStore((state) => state.characterTab);
  const isRoleModule = ROLE_MODULE_TABS.has(tab);

  // ── 角色库 ──
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [charSearch, setCharSearch] = useState("");
  const [worldbooks, setWorldbooks] = useState<WorldBookSummary[]>([]);
  /** 角色库的来源选择："" = 全部，"__none__" = 未分类，否则为 book id */
  const [charBookFilter, setCharBookFilter] = useState("");
  const [selectedChar, setSelectedChar] = useState<string | null>(null);
  const [selectedCharBookId, setSelectedCharBookId] = useState("");
  const [charDetail, setCharDetail] = useState<CharacterDetail | null>(null);
  const [charLoading, setCharLoading] = useState(false);
  const [charImporting, setCharImporting] = useState(false);
  // 角色详情页签：资产与卡牌并入角色之下，切换角色回到「资料」
  const [charDetailTab, setCharDetailTab] = useState<CharacterDetailTab>("profile");
  useEffect(() => { setCharDetailTab("profile"); }, [selectedChar, selectedCharBookId]);

  // ── 玩家身份 ──
  const [identities, setIdentities] = useState<IdentitySummary[]>([]);
  const [identitySearch, setIdentitySearch] = useState("");
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [selectedIdentityBookId, setSelectedIdentityBookId] = useState("");
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // 编辑草稿
  const [draftName, setDraftName] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftAttrs, setDraftAttrs] = useState<Record<string, number>>({});

  const charFileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toast, setToast] = useState<{ text: string; type: "ok" | "error" } | null>(null);

  const showToast = (text: string, type: "ok" | "error" = "ok") => {
    setToast({ text, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const initDraft = (name: string, detail: CharacterDetail | null) => {
    const meta = detail?.metadata || {};
    setDraftName(meta.name || name);
    setDraftSummary(meta.summary || "");
    setDraftTags((meta.tags || []).join("、"));
    setDraftContent(detail?.content || "");
    setDraftAttrs(meta.attributes || {});
  };

  const resetIdentityForm = () => {
    setDraftName("");
    setDraftSummary("");
    setDraftTags("");
    setDraftContent("");
    setDraftAttrs({});
  };

  // ── 加载角色库 ──
  // 玩家身份就是角色目录，新建 / 删除身份后角色库也要跟着刷新（本组件在切页签时不卸载）
  const loadCharacters = () => {
    api.getCharacters()
      .then((data) => setCharacters(toCharacterSummaries(data)))
      .catch(() => {});
  };

  useEffect(() => {
    loadCharacters();
  }, [api]);

  // ── 加载世界书列表（把来源 id 解析为书名；后端不可用时不阻塞角色库）──
  useEffect(() => {
    let cancelled = false;
    api.listWorldbooks()
      .then((res) => { if (!cancelled) setWorldbooks(res.books || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  // ── 加载玩家身份列表 ──
  const loadIdentities = () => {
    api.getPlayerIdentities()
      .then((data) => setIdentities(data || []))
      .catch(() => setIdentities([]));
  };

  useEffect(() => {
    loadIdentities();
  }, [api]);

  // ── 加载角色详情 ──
  useEffect(() => {
    if (!selectedChar || tab !== "characters") {
      setCharDetail(null);
      return;
    }
    let cancelled = false;
    setCharLoading(true);
    api.getCharacter(selectedChar, selectedCharBookId)
      .then((d) => { if (!cancelled) setCharDetail(d); })
      .catch(() => { if (!cancelled) setCharDetail(null); })
      .finally(() => { if (!cancelled) setCharLoading(false); });
    return () => { cancelled = true; };
  }, [selectedChar, selectedCharBookId, tab, api]);

  // ── 加载身份详情 ──
  useEffect(() => {
    if (!selectedIdentity || tab !== "identities") {
      return;
    }
    let cancelled = false;
    setIdentityLoading(true);
    api.getCharacter(selectedIdentity, selectedIdentityBookId)
      .then((d) => {
        if (!cancelled) {
          initDraft(selectedIdentity, d);
        }
      })
      .catch(() => { if (!cancelled) initDraft(selectedIdentity, null); })
      .finally(() => { if (!cancelled) setIdentityLoading(false); });
    return () => { cancelled = true; };
  }, [selectedIdentity, selectedIdentityBookId, tab, api]);

  // ── 导入角色卡 ──
  const handleImportCharacterCard = async (file: File) => {
    setCharImporting(true);
    try {
      const res = await api.importCharacterCard(file);
      showToast(`角色「${res.character?.name || file.name}」已导入`);
      loadCharacters();
      if (res.character?.name) {
        setCharacterTab("characters");
        setSelectedChar(res.character.name);
        setSelectedCharBookId("");
      }
    } catch (err: any) {
      showToast(err.message || "导入失败", "error");
    } finally {
      setCharImporting(false);
    }
  };

  // ── 新建玩家身份：唯一入口在左栏工具栏，空状态只做文字引导 ──
  const startCreateIdentity = () => {
    resetIdentityForm();
    setSelectedIdentity(null);
    setSelectedIdentityBookId("");
    setIsCreating(true);
  };

  // ── 保存玩家身份 ──
  const handleSaveIdentity = async () => {
    const name = (isCreating ? draftName : selectedIdentity) || "";
    if (!name.trim()) {
      showToast("身份名称不能为空", "error");
      return;
    }
    setIdentitySaving(true);
    try {
      const tags = draftTags.split(/[、,，]/).map((t) => t.trim()).filter(Boolean);
      const metadata: Record<string, any> = {
        name: draftName.trim() || name,
        summary: draftSummary.trim(),
        tags,
        player_identity: true,
      };
      if (Object.keys(draftAttrs).length > 0) {
        metadata.attributes = draftAttrs;
      }
      await api.savePlayerIdentity(name.trim(), metadata, draftContent, selectedIdentityBookId);
      showToast(isCreating ? "已创建玩家身份" : "已保存玩家身份");
      loadIdentities();
      loadCharacters();
      if (isCreating) {
        setIsCreating(false);
        setSelectedIdentity(name.trim());
      }
    } catch (err: any) {
      showToast(err.message || "保存失败", "error");
    } finally {
      setIdentitySaving(false);
    }
  };

  // ── 删除玩家身份 ──
  const handleDeleteIdentity = async (name: string, bookId: string) => {
    if (!window.confirm(`确定删除玩家身份「${name}」吗？`)) return;
    try {
      await api.deletePlayerIdentity(name, bookId);
      showToast("已删除玩家身份");
      setIdentities((prev) => prev.filter((i) => i.id !== name || i.worldbook_id !== bookId));
      setCharacters((prev) => prev.filter((c) => c.id !== name));
      if (selectedChar === name) setSelectedChar(null);
      if (selectedIdentity === name && selectedIdentityBookId === bookId) {
        setSelectedIdentity(null);
        setSelectedIdentityBookId("");
      }
    } catch (err: any) {
      showToast(err.message || "删除失败", "error");
    }
  };

  // ── 跳转编辑 ──
  // 角色资料已迁移至世界书（整合包/来源标注），跳转世界书页编辑
  const jumpToWorldbook = () => {
    const bookId = selectedCharBookId;
    setWorldbookJumpId(bookId || null);
    setCurrentView("worldbook");
  };

  const jumpToCards = () => {
    // 卡牌已并入角色详情：直接切到本角色的「卡牌」页签
    setCharDetailTab("cards");
  };

  const filteredCharacters = useMemo(() => {
    const q = charSearch.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter((c) =>
      (c.name || "").toLowerCase().includes(q) ||
      (c.id || "").toLowerCase().includes(q)
    );
  }, [characters, charSearch]);

  const filteredIdentities = useMemo(() => {
    const q = identitySearch.trim().toLowerCase();
    if (!q) return identities;
    return identities.filter((i) =>
      (i.name || "").toLowerCase().includes(q) ||
      (i.summary || "").toLowerCase().includes(q) ||
      (i.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }, [identities, identitySearch]);

  // ── 角色库的来源世界书分组（唯一形态）──
  // 在搜索命中的角色上再分组，因此搜索与来源选择可以叠加。
  const {
    groups: charWorldbookGroups,
    collapsedKeys: collapsedCharBookKeys,
    toggleCollapsed: toggleCharBookCollapsed,
    expandAll: expandAllCharBooks,
    collapseAll: collapseAllCharBooks,
    allCollapsed: allCharBooksCollapsed,
  } = useWorldbookGroups(
    filteredCharacters,
    (c) => c.worldbook_id,
    worldbooks,
    charBookFilter,
  );

  const renderCharRow = (c: CharacterSummary) => (
    <ListRow
      key={`${c.worldbook_id || ""}:${c.id}`}
      id={c.id}
      worldbookId={c.worldbook_id}
      name={c.name || c.id}
      // 本家角色的 title 常与 name 同值，同值时不再重复显示一行
      sub={c.title && c.title !== c.name ? c.title : undefined}
      selected={selectedChar === c.id && selectedCharBookId === (c.worldbook_id || "")}
      onClick={() => { setSelectedChar(c.id); setSelectedCharBookId(c.worldbook_id || ""); }}
    />
  );

  const renderCharDetail = () => {
    if (!selectedChar) {
      return (
        <EmptyState
          icon="characters"
          text="从左侧选择一个角色查看详情"
          sub="导入的角色卡与本家角色都在这里，按来源世界书分组"
        />
      );
    }
    if (charLoading) {
      return <EmptyState icon="characters" text="加载中…" />;
    }
    const meta = charDetail?.metadata || {};
    const displayName = String(meta.name || selectedChar);
    const attrs: Record<string, number> = meta.attributes || {};
    const tags: string[] = meta.tags || [];
    const summary = String(meta.summary || "").trim();
    // 归属由角色实际所在的世界书文件夹决定。
    const sourceBookId = selectedCharBookId;
    const sourceBookName = sourceBookId
      ? worldbooks.find((b) => b.id === sourceBookId)?.name || sourceBookId
      : "";
    return (
      <div className="h-full flex flex-col min-h-0">
        <PanelHeader
          size="lg"
          eyebrow="角色库"
          icon="characters"
          title={displayName}
          leading={<EntityAvatar name={displayName} src={characterAvatarUrl(selectedChar, sourceBookId)} size={64} />}
          actions={
            <>
              <ActionButton
                icon="worldbook"
                variant="blue"
                onClick={jumpToWorldbook}
                title="角色设定已迁移至世界书，跳转世界书页编辑"
              >
                编辑世界书设定
              </ActionButton>
              <ActionButton icon="cards" variant="amber" onClick={jumpToCards} title="切到本角色的「卡牌」页签">
                编辑战斗卡牌
              </ActionButton>
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {meta.class && <Chip tone="blue">{String(meta.class)}</Chip>}
            {meta.race && <Chip tone="purple">{String(meta.race)}</Chip>}
            {meta.faction && <Chip tone="green">{String(meta.faction)}</Chip>}
            <SourceBookBadge size="xs" name={sourceBookName} />
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-300 text-[12px]">{t}</span>
              ))}
            </div>
          )}
        </PanelHeader>

        {/* 详情页签：资料 / 数值 / 资产 / 卡牌 —— 资产与卡牌就在角色之下管理 */}
        <nav className="roles-detail-tabs" aria-label="角色详情页签">
          {CHARACTER_DETAIL_TABS.map((item) => (
            <button key={item.id} type="button" aria-pressed={charDetailTab === item.id} title={item.hint}
              onClick={() => setCharDetailTab(item.id)}>
              <AppIcon name={item.icon} size={13} />{item.label}
            </button>
          ))}
        </nav>

        {charDetailTab === "cards" ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <CardEditor key={`char-cards-${selectedChar}-${sourceBookId}`} embedded entityName={selectedChar} entityType="character" worldbookId={sourceBookId} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {charDetailTab === "stats" && <CharacterStatsEditor key={`stats-${selectedChar}-${sourceBookId}`} characterId={selectedChar} worldbookId={sourceBookId} />}
            {charDetailTab === "assets" && <CharacterAssets key={`assets-${selectedChar}-${sourceBookId}`} characterId={selectedChar} worldbookId={sourceBookId} />}
            {charDetailTab === "profile" && (
              <>
                {summary && <p className="text-[14px] text-gray-300 leading-relaxed">{summary}</p>}

                {Object.keys(attrs).length > 0 && (
                  <section>
                    <h3 className="roles-section">属性</h3>
                    <div className="grid grid-cols-4 gap-2">
                      {orderAttrs(attrs).map(([k, v]) => (
                        <div key={k} className="stat-cell flex flex-col items-center px-2 py-1.5">
                          <span className="text-[12px] text-gray-500">{ATTR_LABELS[k] || k}</span>
                          <span className="text-gray-200 font-mono text-sm">{v}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {charDetail?.content && (
                  <section>
                    <h3 className="roles-section">背景</h3>
                    <div className="detail-section text-sm text-gray-300 leading-relaxed p-4">
                      <MarkdownRenderer content={charDetail.content} />
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderIdentityDetail = () => {
    if (isCreating) {
      return renderIdentityEditor();
    }
    if (!selectedIdentity) {
      return (
        <EmptyState
          icon="identity"
          text="从左侧选择一个玩家身份"
          sub="或点击左上角「新建身份」创建；玩家身份就是一份特殊的角色卡，保存后可在创建会话时选用"
        />
      );
    }
    if (identityLoading) {
      return <EmptyState icon="identity" text="加载中…" />;
    }
    return renderIdentityEditor();
  };

  const renderIdentityEditor = () => {
    const headerName = isCreating
      ? (draftName.trim() || "新建玩家身份")
      : (draftName.trim() || selectedIdentity || "");
    const fieldCls = "mt-1 w-full bg-gray-900 border border-gray-700 rounded-md px-2.5 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:border-amber-500/50";
    return (
      <div className="h-full flex flex-col min-h-0">
        <PanelHeader
          eyebrow={isCreating ? "新建玩家身份" : "玩家身份"}
          icon="identity"
          title={headerName}
          leading={
            <EntityAvatar
              name={headerName}
              src={!isCreating && selectedIdentity ? characterAvatarUrl(selectedIdentity, selectedIdentityBookId) : null}
              size={44}
            />
          }
          actions={
            !isCreating && selectedIdentity ? (
              <ActionButton icon="trash" variant="danger" onClick={() => handleDeleteIdentity(selectedIdentity, selectedIdentityBookId)}>
                删除
              </ActionButton>
            ) : undefined
          }
        />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="max-w-2xl space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-gray-400">
                身份名称
                <input
                  className={fieldCls}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="例如：旅者、城镇卫兵、调查员"
                />
              </label>
              <label className="block text-xs text-gray-400">
                简介
                <input
                  className={fieldCls}
                  value={draftSummary}
                  onChange={(e) => setDraftSummary(e.target.value)}
                  placeholder="一句话描述这个身份"
                />
              </label>
            </div>

            <label className="block text-xs text-gray-400">
              保存位置
              {isCreating ? (
                <select className={fieldCls} value={selectedIdentityBookId}
                  onChange={(e) => setSelectedIdentityBookId(e.target.value)}>
                  <option value="">个人资料（不随世界书复制）</option>
                  {worldbooks.filter((book) => book.enabled).map((book) => (
                    <option key={book.id} value={book.id}>{book.name}</option>
                  ))}
                </select>
              ) : (
                <div className="mt-1 text-sm text-gray-300">
                  {selectedIdentityBookId
                    ? worldbooks.find((book) => book.id === selectedIdentityBookId)?.name || selectedIdentityBookId
                    : "个人资料（不随世界书复制）"}
                </div>
              )}
            </label>

            <label className="block text-xs text-gray-400">
              标签（顿号或逗号分隔）
              <input
                className={fieldCls}
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
                placeholder="例如：指挥官、学者、战术专家"
              />
            </label>

            <section>
              <h3 className="roles-section">属性（可选，1–10）</h3>
              <div className="grid grid-cols-4 gap-2">
                {Object.entries(ATTR_LABELS).map(([key, label]) => (
                  <label key={key} className="stat-cell flex flex-col items-center gap-1 px-2 py-1.5">
                    <span className="text-[12px] text-gray-500">{label}</span>
                    <input
                      className="w-full bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-xs text-center text-gray-200 font-mono"
                      type="number"
                      min={1}
                      max={10}
                      value={draftAttrs[key] ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setDraftAttrs((prev) => {
                          const next = { ...prev };
                          if (raw === "") delete next[key];
                          else next[key] = Math.max(1, Math.min(10, parseInt(raw, 10) || 1));
                          return next;
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
            </section>

            <label className="block text-xs text-gray-400">
              身份背景
              <textarea
                className={`${fieldCls} min-h-[160px] leading-relaxed`}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                placeholder="描述这个身份的背景、性格、目标……"
              />
            </label>

            <div className="flex items-center gap-2 pt-1">
              <ActionButton
                icon="save"
                variant="solid"
                onClick={handleSaveIdentity}
                disabled={identitySaving || !draftName.trim()}
              >
                {identitySaving ? "保存中…" : "保存身份"}
              </ActionButton>
              {isCreating && (
                <ActionButton variant="ghost" onClick={() => { setIsCreating(false); resetIdentityForm(); }}>
                  取消
                </ActionButton>
              )}
            </div>

            <p className="flex items-start gap-1.5 text-[12px] text-gray-500 leading-relaxed">
              <AppIcon name="info" size={13} className="mt-0.5" />
              <span>
                玩家身份保存为角色目录 <code className="font-mono">characters/{(isCreating ? draftName.trim() : selectedIdentity) || "<身份名>"}/</code>，
                创建会话或在会话大厅切换身份时可选用。头像放进该目录的 <code className="font-mono">avatar/</code> 子目录，
                在「资产」页可查看并设为默认头像。
              </span>
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="roles-shell flex flex-col h-full">
      {/* ── 模块页签：角色库（角色内容）/ 玩家身份 / 资产 / 卡牌 ── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700/70 bg-gray-900/60 shrink-0">
        <nav className="flex items-center gap-1 overflow-x-auto" aria-label="角色页模块">
          {MODULE_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setCharacterTab(item.id)}
              title={item.hint}
              aria-pressed={tab === item.id}
              className={
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors " +
                (tab === item.id
                  ? "bg-amber-600/20 text-amber-300 font-medium border border-amber-500/30"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 border border-transparent")
              }
            >
              <AppIcon name={item.icon} size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {isRoleModule ? (
        <div className="flex flex-1 min-h-0">
          {/* ── 左侧列表 ── */}
          <div className="w-72 border-r border-gray-700 flex flex-col shrink-0">
            {/* 工具栏：搜索 + 折叠；主动作（导入 / 新建）单独一行 */}
            <div className="p-2 border-b border-gray-700 space-y-2">
              {tab === "characters" ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <SearchInput value={charSearch} onChange={setCharSearch} placeholder="搜索角色…" />
                    <FoldAllButton
                      collapsed={allCharBooksCollapsed}
                      onToggle={() => (allCharBooksCollapsed ? expandAllCharBooks() : collapseAllCharBooks())}
                      what="世界书分组"
                      disabled={charWorldbookGroups.length === 0}
                    />
                  </div>
                  <ActionButton
                    icon="upload"
                    variant="amber"
                    className="w-full justify-center"
                    onClick={() => charFileRef.current?.click()}
                    disabled={charImporting}
                    title="导入 SillyTavern 角色卡（PNG / JSON），随卡自带的世界书会一并导入"
                  >
                    {charImporting ? "导入中…" : "导入角色卡"}
                  </ActionButton>
                  <input
                    ref={charFileRef}
                    type="file"
                    accept=".png,.json,.webp,.jpg,.jpeg"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) { void handleImportCharacterCard(f); e.target.value = ""; }
                    }}
                  />
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <SearchInput value={identitySearch} onChange={setIdentitySearch} placeholder="搜索身份…" />
                  </div>
                  <ActionButton
                    icon="plus"
                    variant="amber"
                    className="w-full justify-center"
                    onClick={startCreateIdentity}
                    disabled={isCreating}
                  >
                    新建身份
                  </ActionButton>
                </>
              )}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {tab === "characters" ? (
                <WorldbookGroupList
                  groups={charWorldbookGroups}
                  totalCount={filteredCharacters.length}
                  activeKey={charBookFilter}
                  collapsedKeys={collapsedCharBookKeys}
                  onSelect={setCharBookFilter}
                  onToggleCollapse={toggleCharBookCollapsed}
                  renderItems={(items) =>
                    items.length === 0 ? (
                      <p className="text-xs text-gray-600 italic pl-1">(空)</p>
                    ) : (
                      items.map(renderCharRow)
                    )
                  }
                  emptyHint={
                    <p className="text-xs text-gray-600 text-center py-4">
                      {charSearch ? "未找到匹配角色" : "暂无可用角色"}
                    </p>
                  }
                />
              ) : (
                filteredIdentities.length === 0 ? (
                  <div className="text-center py-6 space-y-1">
                    <p className="text-xs text-gray-500">
                      {identitySearch ? "未找到匹配身份" : "还没有玩家身份"}
                    </p>
                    {!identitySearch && !isCreating && (
                      <p className="text-[12px] text-gray-600">点上方「新建身份」创建你自己的角色卡</p>
                    )}
                  </div>
                ) : (
                  filteredIdentities.map((i) => (
                    <ListRow
                      key={`${i.worldbook_id}:${i.id}`}
                      id={i.id}
                      name={i.name || i.id}
                      sub={[i.summary, i.worldbook_id ? worldbooks.find((book) => book.id === i.worldbook_id)?.name || i.worldbook_id : "个人资料"].filter(Boolean).join(" · ")}
                      selected={selectedIdentity === i.id && selectedIdentityBookId === (i.worldbook_id || "") && !isCreating}
                      onClick={() => { setIsCreating(false); setSelectedIdentity(i.id); setSelectedIdentityBookId(i.worldbook_id || ""); }}
                    />
                  ))
                )
              )}
            </div>
          </div>

          {/* ── 右侧详情 ── */}
          <div className="flex-1 min-w-0 bg-gray-900/30">
            {tab === "characters" ? renderCharDetail() : renderIdentityDetail()}
          </div>
        </div>
      ) : (
        /* 资产 / 卡牌：自原「内容中心」迁入，本体不变，只换挂载点 */
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "images" ? <AssetManager key="am" /> : <CardManager key="cm" />}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-12 right-4 px-3 py-2 rounded-lg text-sm shadow-lg z-50 ${
            toast.type === "ok" ? "bg-green-700/90 text-white" : "bg-red-700/90 text-white"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
