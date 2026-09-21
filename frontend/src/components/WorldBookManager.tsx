import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAppStore, type WorldBookTab } from "../stores/appStore";
import type {
  WorldBookDetail,
  WorldBookEntryDTO,
  WorldBookImportReport,
  WorldBookSummary,
  WorldBookCategoryDTO,
  WorldBookType,
} from "../types";
import SourceBadge from "./SourceBadge";
import AppIcon from "./AppIcon";
import "../styles/worldbook-graph.css";
import { useDialogMinimize } from "../hooks/useDialogMinimize";
import { useScopePreview, useWorldbookDraft } from "../hooks/useWorldbookDraft";
import { categoryDescendants, flattenCategoryTree } from "../utils/worldbookScope";
import {
  BOOK_TYPE_HINTS,
  BOOK_TYPE_LABELS,
  bookTypeOf,
  draftFromEntry,
  excerptItemFromDraft,
  filterBooksByType,
  flattenLibraryHits,
  isReference,
  normalizeWorldbookTab,
  storyBookTargets,
  validateExcerptDraft,
  type BookTypeFilter,
  type ExcerptDraft,
  type LibraryHit,
} from "../utils/worldbookLibrary";
import EntryDependencyTree from "./worldbook/EntryDependencyTree";
import LoadTab from "./worldbook/tabs/LoadTab";
import NodeViewTab from "./worldbook/tabs/NodeViewTab";
import PromptPreviewTab from "./worldbook/tabs/PromptPreviewTab";
import type { WorldBookPanelProps } from "./worldbook/panel";
// 本家索引是内置语料索引 / 会话白名单的独立页面，照旧按需加载，不拖慢条目页首屏。
const IndexManager = lazy(() => import("./IndexManager"));

/**
 * 工作台页签定义（顺序与文案按提案 §3.1）：`entries` / `load` / `prompt` / `nodes` / `index`。
 *
 * 页签状态只有一份：`stores/appStore.ts` 的 `worldbookTab`（R-4）。原来工作台里那套
 * 单独的详情页签状态已删除，「高级配置」这个说法一并取消——它就是 `load` 页签
 * 里的「分类结构」子视图。
 */
export const WORLDBOOK_PANEL_TABS: ReadonlyArray<{ id: WorldBookTab; label: string; hint: string }> = [
  { id: "entries", label: "条目", hint: "正文、触发条件、导入导出与资料库摘录" },
  { id: "load", label: "分类与载入", hint: "配置概览、条目与角色、分类结构：决定这本书载入什么" },
  { id: "prompt", label: "Prompt 预览", hint: "这一轮真正插进提示词的完整文本、顺序与位置" },
  { id: "nodes", label: "节点视图", hint: "全书条目的注入顺序与依赖展开，一眼看懂谁先谁后" },
  { id: "index", label: "本家索引", hint: "本家索引 · 内置语料索引 · 依赖完整性 · 会话白名单" },
];

/** 本家索引页签的副标题（写死，见提案 §2.2 的结论）。 */
export const WORLDBOOK_INDEX_SUBTITLE = "内置语料索引 · 依赖完整性 · 会话白名单";

/**
 * 当前这本书**可用**的页签（R-4）。
 *
 * 资料库（reference）没有条目依赖与载入规则，只显示 `条目` 与 `本家索引`；
 * `load` / `prompt` / `nodes` 对它既不渲染按钮也不渲染内容，避免出现
 * 「点了页签却是空白详情区」。判定复用 `normalizeWorldbookTab`，
 * 保证按钮与内容只判一次、口径一致。
 */
export function visibleWorldbookTabs(
  book: Pick<WorldBookSummary, "book_type"> | null | undefined,
): ReadonlyArray<{ id: WorldBookTab; label: string; hint: string }> {
  return WORLDBOOK_PANEL_TABS.filter((tab) => normalizeWorldbookTab(tab.id, book) === tab.id);
}

/** 条目编辑器对话框 id（Esc 守卫与恢复入口共用） */
const ENTRY_EDITOR_DIALOG_ID = "worldbook-entry-editor";

/** 资料库检索一次最多渲染的条目数（大书不把全书正文一次铺开） */
const LIBRARY_PAGE_SIZE = 50;

/** 稳定的空数组：预览的依赖项是语义键，但传新引用容易在别处被当依赖用。 */
const EMPTY_UIDS: string[] = [];

/** 条目编辑草稿（触发词/副键用逗号分隔文本编辑） */
interface EntryDraft {
  name: string;
  content: string;
  triggerKeysText: string;
  secondaryKeysText: string;
  alwaysActive: boolean;
  selective: boolean;
  enabled: boolean;
  probability: number;
  position: number;
  depth: number;
  scanDepth: number;
  group: string;
  groupWeight: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  categoryId: string;
  characterId: string;
}

function entryToDraft(e: WorldBookEntryDTO): EntryDraft {
  return {
    name: e.name || "",
    content: e.content || "",
    triggerKeysText: (e.trigger_keys || []).join(", "),
    secondaryKeysText: (e.secondary_keys || []).join(", "),
    alwaysActive: !!e.always_active,
    selective: !!e.selective,
    enabled: !!e.enabled,
    probability: e.probability ?? 100,
    position: e.position ?? 0,
    depth: e.depth ?? 4,
    scanDepth: e.scan_depth ?? 4,
    group: e.group || "",
    groupWeight: e.group_weight ?? 100,
    caseSensitive: !!e.case_sensitive,
    matchWholeWords: !!e.match_whole_words,
    categoryId: e.category_id || "unclassified",
    characterId: e.character_id || "",
  };
}

function draftToEntry(draft: EntryDraft): Partial<WorldBookEntryDTO> {
  const split = (s: string) =>
    s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return {
    name: draft.name.trim(),
    content: draft.content,
    trigger_keys: split(draft.triggerKeysText),
    secondary_keys: split(draft.secondaryKeysText),
    always_active: draft.alwaysActive,
    selective: draft.selective,
    enabled: draft.enabled,
    probability: draft.probability,
    position: draft.position,
    depth: draft.depth,
    scan_depth: draft.scanDepth,
    group: draft.group.trim(),
    group_weight: draft.groupWeight,
    case_sensitive: draft.caseSensitive,
    match_whole_words: draft.matchWholeWords,
    category_id: draft.categoryId.trim(),
    character_id: draft.characterId.trim(),
  };
}

const SOURCE_LABELS: Record<string, string> = {
  sillytavern_v1: "酒馆 v1",
  sillytavern_v2: "酒馆 v2",
  character_card: "角色卡内嵌",
  chat_backup_jsonl: "聊天备份",
  manual: "手动",
  builtin: "整合包",
};

function sourceLabel(fmt: string): string {
  return SOURCE_LABELS[fmt] || fmt;
}

export default function WorldBookManager() {
  const api = useApi();
  const sessions = useAppStore((s) => s.sessions);
  // 工作台页签（A-1 / R-4）：唯一跨组件页签状态，跨组件跳转也都写它
  const worldbookTab = useAppStore((s) => s.worldbookTab);
  const setWorldbookTab = useAppStore((s) => s.setWorldbookTab);
  const worldbookJumpId = useAppStore((s) => s.worldbookJumpId);
  const setWorldbookJumpId = useAppStore((s) => s.setWorldbookJumpId);
  const worldbookScopeJumpId = useAppStore((s) => s.worldbookScopeJumpId);
  const setWorldbookScopeJumpId = useAppStore((s) => s.setWorldbookScopeJumpId);
  const worldbookEntryJump = useAppStore((s) => s.worldbookEntryJump);
  const setWorldbookEntryJump = useAppStore((s) => s.setWorldbookEntryJump);

  const [books, setBooks] = useState<WorldBookSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorldBookDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** 切书时若有未保存改动，先挂起目标书等用户决定（保存并切换 / 放弃并切换 / 取消） */
  const [pendingBook, setPendingBook] = useState<string | null>(null);
  /** 试选阵容：只用于预览「本次范围」，不影响已保存配置 */
  const [roster, setRoster] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  useEffect(() => { setCategoryFilter(""); }, [selectedId]);
  const visibleCategories = categoryFilter ? categoryDescendants(detail?.categories || [], categoryFilter) : null;
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; type: "ok" | "error" } | null>(null);
  const [importReport, setImportReport] = useState<WorldBookImportReport | null>(null);
  const [importCharacter, setImportCharacter] = useState<{ name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importType, setImportType] = useState<WorldBookType>("story");

  // 顶层用途筛选 + 新建用途（新建与导入共用同一个「用这本来做什么」选择）
  const [listFilter, setListFilter] = useState<BookTypeFilter>("all");

  // 书元信息编辑
  const [bookName, setBookName] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("0");

  // 条目列表搜索/筛选（大书不一次铺开全文）
  const [entryQuery, setEntryQuery] = useState("");
  const [entryLimit, setEntryLimit] = useState(LIBRARY_PAGE_SIZE);
  useEffect(() => { setEntryQuery(""); setEntryLimit(LIBRARY_PAGE_SIZE); }, [selectedId]);

  // 资料库检索
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryHits, setLibraryHits] = useState<LibraryHit[]>([]);
  const [librarySearching, setLibrarySearching] = useState(false);
  const [librarySearched, setLibrarySearched] = useState(false);
  const [excerptDraft, setExcerptDraft] = useState<ExcerptDraft | null>(null);
  const [excerptOriginal, setExcerptOriginal] = useState<WorldBookEntryDTO | null>(null);
  const [excerptSaving, setExcerptSaving] = useState(false);

  // 会话绑定
  const [bindSessionId, setBindSessionId] = useState("");
  const [boundBookId, setBoundBookId] = useState<string | null>(null);
  const [effectiveBookId, setEffectiveBookId] = useState<string | null>(null);

  // 条目编辑
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false); // 是否存在未保存修改

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((text: string, type: "ok" | "error" = "ok") => {
    setToast({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // 当前选中的书是否为资料库
  const detailIsReference = !!detail && isReference(detail);
  // 生效页签：跨组件页签状态只有 worldbookTab 一份，资料库只允许「条目 / 本家索引」。
  // 防御性收敛放在这里，按钮与内容共用同一个判定，切书后不会出现空白详情区。
  const effectiveTab = normalizeWorldbookTab(worldbookTab, detail);
  const visibleTabs = visibleWorldbookTabs(detail);
  const storyTargets = useMemo(() => storyBookTargets(books), [books]);
  const visibleBooks = useMemo(() => filterBooksByType(books, listFilter), [books, listFilter]);
  const counts = useMemo(() => ({
    all: books.length,
    story: books.filter((b) => !isReference(b)).length,
    reference: books.filter((b) => isReference(b)).length,
  }), [books]);

  // 条目列表：分类筛选 + 关键词筛选（关键词只用于定位，不影响条目本体）
  const filteredEntries = useMemo(() => {
    const all = detail?.entries || [];
    const q = entryQuery.trim().toLowerCase();
    return all.filter((e) => {
      if (visibleCategories && !visibleCategories.has(e.category_id || "unclassified")) return false;
      if (!q) return true;
      return (
        (e.name || "").toLowerCase().includes(q)
        || (e.content || "").toLowerCase().includes(q)
        || (e.trigger_keys || []).some((k) => k.toLowerCase().includes(q))
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, categoryFilter, entryQuery]);

  // ── 加载书列表 ──
  const loadBooks = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listWorldbooks();
      setBooks(res.books || []);
    } catch (err: any) {
      setError(err.message || "加载世界书列表失败");
    }
  }, [api]);

  useEffect(() => { loadBooks(); }, [loadBooks]);

  // ── 加载书详情 ──
  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const d = await api.getWorldbook(id);
      setDetail(d);
      setBookName(d.name);
      setBudgetTokens(String(d.budget_tokens ?? 0));
    } catch (err: any) {
      showToast(err.message || "加载世界书详情失败", "error");
    } finally {
      setLoadingDetail(false);
    }
  }, [api, showToast]);

  useEffect(() => {
    loadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ── 统一草稿 + 范围预览 + 试选阵容：提到工作台容器，页签只通过 ctx 拿到 ──
  // 一份草稿、一次保存、同一个撤销栈（原「世界书配置」页面的那一套）。
  const {
    draft: bookDraft, patch: patchBookDraft, adoptV3, dirty: draftDirty, saving: draftSaving,
    error: draftSaveError, conflict: draftConflict, save: saveDraft, undo: undoDraft, savedAt,
  } = useWorldbookDraft(detail);
  const { preview, loading: previewing, error: previewError } =
    useScopePreview(detail?.id || "", detail?.updated_at, bookDraft, roster, EMPTY_UIDS, !!detail);
  const reloadDetail = useCallback(async () => { await loadDetail(selectedId); }, [loadDetail, selectedId]);
  const doSaveDraft = useCallback(async () => {
    const ok = await saveDraft();
    // 保存成功后重新拉取：修订号变化才会让草稿回到新基线（dirty 归零）。
    if (ok) await reloadDetail();
  }, [saveDraft, reloadDetail]);
  useEffect(() => { if (savedAt) showToast("已保存：本次改动一次性写入，正文未被改写。"); }, [savedAt, showToast]);
  // 有未保存草稿时防误关（草稿在 409 / 保存失败时都会保留）
  useEffect(() => {
    if (!draftDirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [draftDirty]);

  // ── 切书：有未保存改动时先问用户（保存并切换 / 放弃并切换 / 取消）──
  const applyBookSwitch = useCallback((id: string) => {
    setSelectedId(id);
    // 换书回到「条目」页签：否则在剧情书里停在「分类与载入」再切到资料库，
    // 页签按钮与内容都被隐藏，详情区会空成一片白（原「详情页签归一」的回归场景）。
    setWorldbookTab("entries");
    setRoster([]);
  }, [setWorldbookTab]);
  const selectBook = useCallback((id: string) => {
    if (id === selectedId) return;
    if (draftDirty) { setPendingBook(id); return; }
    applyBookSwitch(id);
  }, [selectedId, draftDirty, applyBookSwitch]);

  // ── 跨组件跳转：全部由工作台消费（消费后清空）──
  // 检索命中 → 选中该书 + 条目页签
  useEffect(() => {
    if (!worldbookJumpId) return;
    selectBook(worldbookJumpId);
    setWorldbookTab("entries");
    setWorldbookJumpId(null);
  }, [worldbookJumpId, selectBook, setWorldbookTab, setWorldbookJumpId]);
  // 依赖相关入口 → 选中该书 + 分类与载入页签
  useEffect(() => {
    if (!worldbookScopeJumpId) return;
    selectBook(worldbookScopeJumpId);
    setWorldbookTab("load");
    setWorldbookScopeJumpId(null);
  }, [worldbookScopeJumpId, selectBook, setWorldbookTab, setWorldbookScopeJumpId]);
  // 指定条目 → 选中该书 + 条目页签；条目编辑器由下方 detail 就绪后的 effect 打开，
  // 因此这里不能提前清空跳转目标。
  useEffect(() => {
    if (!worldbookEntryJump) return;
    selectBook(worldbookEntryJump.bookId);
    setWorldbookTab("entries");
  }, [worldbookEntryJump, selectBook, setWorldbookTab]);

  /** 下发给各页签的统一投影：同一份草稿、同一条预览与保存路径、同一个试选阵容。 */
  const panelProps: WorldBookPanelProps | null = detail && bookDraft ? {
    detail, draft: bookDraft, patch: patchBookDraft, adoptV3,
    dirty: draftDirty, saving: draftSaving, saveError: draftSaveError, conflict: draftConflict,
    save: doSaveDraft, undo: undoDraft, preview, previewing, previewError, roster, setRoster,
  } : null;

  // ── 会话绑定查询 ──
  useEffect(() => {
    if (!bindSessionId) {
      setBoundBookId(null);
      setEffectiveBookId(null);
      return;
    }
    api.resolveWorldbook(bindSessionId)
      .then((res) => {
        setEffectiveBookId(res.book?.id ?? null);
      })
      .catch(() => { /* ignore */ });
    // 从会话列表找到绑定的书（overlay 中的 worldbook_id）
    const session = sessions.find((s) => s.id === bindSessionId);
    setBoundBookId(session?.worldbook_id ?? null);
  }, [bindSessionId, sessions, api]);

  const refreshListAfterMutate = useCallback(async (keepId?: string) => {
    await loadBooks();
    if (keepId) {
      await loadDetail(keepId);
    } else {
      await loadDetail(selectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBooks, loadDetail, selectedId]);

  // ── 创建书 ──
  const createBook = async () => {
    const name = window.prompt(
      `新${BOOK_TYPE_LABELS[importType]}名称：`,
      importType === "reference" ? "未命名资料库" : "未命名世界书",
    );
    if (!name) return;
    try {
      const res = await api.createWorldbook(name.trim(), 0, importType);
      await loadBooks();
      setSelectedId(res.book.id);
      showToast(`已创建${BOOK_TYPE_LABELS[importType]}`);
    } catch (err: any) {
      showToast(err.message || "创建失败", "error");
    }
  };

  // ── 导入 ──
  const describeImportResult = (res: any) => {
    if (res.character) {
      showToast(
        `角色「${res.character.name}」已导入` +
        (res.book ? `，内嵌世界书 ${res.report.imported} 条` : "（未发现内嵌世界书）"),
        "ok"
      );
    } else {
      showToast(`导入完成：${res.report.imported} 条 → ${res.book ? BOOK_TYPE_LABELS[bookTypeOf(res.book)] : ""}`);
    }
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    setImportReport(null);
    setImportCharacter(null);
    try {
      const name = file.name.replace(/\.(json|jsonl|txt|png)$/i, "");
      const res = await api.importWorldbookFile(name, file, importType);
      setImportReport(res.report);
      if (res.character) setImportCharacter(res.character);
      await loadBooks();
      if (res.book) setSelectedId(res.book.id);
      describeImportResult(res);
    } catch (err: any) {
      showToast(err.message || "导入失败", "error");
    } finally {
      setImporting(false);
    }
  };

  const onImportJsonText = async (text: string, name: string) => {
    setImporting(true);
    setImportReport(null);
    setImportCharacter(null);
    try {
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // 交给后端按 .jsonl 解析
        data = text;
      }
      const res = await api.importWorldbookJson(name || "导入的世界书", data, importType);
      setImportReport(res.report);
      if (res.character) setImportCharacter(res.character);
      await loadBooks();
      if (res.book) setSelectedId(res.book.id);
      describeImportResult(res);
    } catch (err: any) {
      showToast(err.message || "导入失败", "error");
    } finally {
      setImporting(false);
    }
  };

  // ── 书元信息保存 ──
  const saveBookMeta = async () => {
    if (!detail) return;
    try {
      await api.updateWorldbook(detail.id, {
        name: bookName.trim() || detail.name,
        budget_tokens: parseInt(budgetTokens || "0", 10) || 0,
      });
      await refreshListAfterMutate(detail.id);
      showToast("已保存");
    } catch (err: any) {
      showToast(err.message || "保存失败", "error");
    }
  };

  const toggleDefault = async (id: string, isDefault: boolean) => {
    try {
      await api.setDefaultWorldbook(id, isDefault);
      await loadBooks();
      showToast(isDefault ? "已设为全局默认书" : "已取消默认");
    } catch (err: any) {
      showToast(err.message || "操作失败", "error");
    }
  };

  /** 切换用途。后端在会造成悬空状态时返回 409，这里原样呈现它的说明。 */
  const changeBookType = async (id: string, next: WorldBookType) => {
    const label = BOOK_TYPE_LABELS[next];
    if (next === "reference" &&
        !window.confirm(`将这本书改为资料库？\n\n${BOOK_TYPE_HINTS.reference}\n\n现有条目不会被删除。`)) {
      return;
    }
    try {
      await api.updateWorldbook(id, { book_type: next });
      await refreshListAfterMutate(id);
      showToast(`已改为${label}`);
    } catch (err: any) {
      showToast(err.message || "切换用途失败", "error");
    }
  };

  // ── 资料库检索与摘录 ──
  const searchLibrary = async () => {
    const q = libraryQuery.trim();
    if (!q) {
      showToast("请输入要检索的关键词", "error");
      return;
    }
    setLibrarySearching(true);
    try {
      const res = await api.searchWorldbooks(q, 30, "reference");
      setLibraryHits(flattenLibraryHits(res.results || []));
      setLibrarySearched(true);
    } catch (err: any) {
      showToast(err.message || "检索失败", "error");
    } finally {
      setLibrarySearching(false);
    }
  };

  const openExcerpt = (hit: LibraryHit) => {
    const targets = storyTargets;
    if (targets.length === 0) {
      showToast("还没有剧情世界书可加入，请先新建或导入一本「用于剧情」的书。", "error");
      return;
    }
    setExcerptOriginal(hit.entry);
    setExcerptDraft(draftFromEntry(hit, targets[0].id));
  };

  const submitExcerpt = async () => {
    if (!excerptDraft || !excerptOriginal) return;
    const problem = validateExcerptDraft(excerptDraft, excerptOriginal);
    if (problem) {
      showToast(problem, "error");
      return;
    }
    setExcerptSaving(true);
    try {
      const res = await api.excerptWorldbookEntries(excerptDraft.targetBookId, [
        excerptItemFromDraft(excerptDraft, excerptOriginal),
      ]);
      const target = res.target;
      setExcerptDraft(null);
      setExcerptOriginal(null);
      await loadBooks();
      showToast(`已加入《${target.name}》（该书共 ${target.entry_count} 条，修订 ${res.revision}）`);
      if (selectedId === target.id) await loadDetail(target.id);
    } catch (err: any) {
      // 保留草稿：409/400 之后用户还要改
      showToast(err.message || "加入失败", "error");
    } finally {
      setExcerptSaving(false);
    }
  };

  const deleteBook = async (id: string) => {
    if (!window.confirm("确定删除这本书吗？绑定它的会话将回落到全局默认书。")) return;
    try {
      await api.deleteWorldbook(id);
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadBooks();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message || "删除失败", "error");
    }
  };

  const toggleEnabled = async (book: WorldBookSummary) => {
    try {
      await api.updateWorldbook(book.id, { enabled: !book.enabled });
      await refreshListAfterMutate(book.id);
      showToast(book.enabled ? "已停用（不再参与解析）" : "已启用");
    } catch (err: any) {
      showToast(err.message || "操作失败", "error");
    }
  };

  const reinstallBook = async (id: string) => {
    if (!window.confirm("将恢复该预装整合包的出厂内容（覆盖当前副本的修改），确定重装？")) return;
    try {
      const res = await api.reinstallWorldbook(id);
      await loadBooks();
      setSelectedId(res.book.id);
      showToast("已重装预装整合包");
    } catch (err: any) {
      showToast(err.message || "重装失败", "error");
    }
  };

  const duplicateBook = async (id: string) => {
    const name = window.prompt("副本名称：", "");
    if (name === null) return;
    try {
      const res = await api.duplicateWorldbook(id, name || undefined);
      await loadBooks();
      setSelectedId(res.book.id);
      showToast("已创建副本（导入书）");
    } catch (err: any) {
      showToast(err.message || "复制失败", "error");
    }
  };

  const exportBook = async (id: string) => {
    try {
      const res = await api.exportWorldbook(id);
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${res.name || id}.worldbook.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showToast(err.message || "导出失败", "error");
    }
  };

  // ── 会话绑定 ──
  const bindToSession = async (bound: boolean) => {
    if (!detail || !bindSessionId) return;
    try {
      await api.bindWorldbook(detail.id, bindSessionId, bound);
      setBoundBookId(bound ? detail.id : null);
      const res = await api.resolveWorldbook(bindSessionId);
      setEffectiveBookId(res.book?.id ?? null);
      showToast(bound ? "已绑定到会话" : "已解绑会话");
    } catch (err: any) {
      showToast(err.message || "绑定失败", "error");
    }
  };

  // ── 条目编辑 ──
  const openCreate = () => {
    setEditorMode("create");
    setEditingUid(null);
    setDirty(false);
    setDraft(entryToDraft({
      uid: "", name: "", content: "", trigger_keys: [], secondary_keys: [],
      always_active: false, selective: true, enabled: true, position: 0,
      depth: 4, scan_depth: 4, probability: 100, group: "", group_weight: 100,
      case_sensitive: false, match_whole_words: false,
    }));
  };

  const openEdit = useCallback((e: WorldBookEntryDTO) => {
    setEditorMode("edit");
    setEditingUid(e.uid);
    setDirty(false);
    setDraft(entryToDraft(e));
  }, []);

  useEffect(() => {
    if (!worldbookEntryJump || detail?.id !== worldbookEntryJump.bookId) return;
    const entry = detail.entries.find((item) => item.uid === worldbookEntryJump.entryUid);
    if (entry) openEdit(entry);
    else showToast("要编辑的条目已不存在，请重新选择。", "error");
    setWorldbookEntryJump(null);
  }, [detail, worldbookEntryJump, openEdit, setWorldbookEntryJump, showToast]);

  const saveEntry = async () => {
    if (!detail || !draft) return;
    if (!draft.content.trim()) {
      showToast("条目内容不能为空", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = draftToEntry(draft);
      if (editorMode === "create") {
        await api.createWorldbookEntry(detail.id, payload);
      } else if (editingUid) {
        await api.updateWorldbookEntry(detail.id, editingUid, payload);
      }
      setEditorMode(null);
      setDraft(null);
      setDirty(false);
      await loadDetail(detail.id);
      showToast("已保存条目");
    } catch (err: any) {
      showToast(err.message || "保存条目失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entryId: string) => {
    if (!detail) return;
    if (!window.confirm("确定删除该条目吗？")) return;
    try {
      await api.deleteWorldbookEntry(detail.id, entryId);
      if (editingUid === entryId) {
        setEditorMode(null);
        setDraft(null);
        setDirty(false);
      }
      await loadDetail(detail.id);
      showToast("已删除条目");
    } catch (err: any) {
      showToast(err.message || "删除条目失败", "error");
    }
  };

  // ── 条目编辑器（模态框）：关闭前提示 + Esc 关闭 + 切换书籍自动关闭 ──
  const cancelEditor = useCallback(() => {
    if (saving) return;
    if (!dirty || window.confirm("有未保存的修改，确定关闭编辑器吗？")) {
      setEditorMode(null);
      setDraft(null);
      setDirty(false);
    }
  }, [dirty, saving]);

  const handleDraftChange = useCallback((patch: Partial<EntryDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }, []);

  // 编辑器是否处于最小化（Esc 守卫用；恢复入口由 EntryEditorModal 注册）
  const editorDialogMinimized = useAppStore((s) => !!s.minimizedDialogs[ENTRY_EDITOR_DIALOG_ID]);

  useEffect(() => {
    // 最小化时不响应 Esc：避免把收起的编辑器静默关闭（关闭仍走 × 或取消）
    if (!editorMode || !draft || editorDialogMinimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorMode, draft, cancelEditor, editorDialogMinimized]);

  // 切换书籍时关闭编辑器，避免把上一本书的草稿保存到新书
  useEffect(() => {
    setEditorMode(null);
    setDraft(null);
    setDirty(false);
  }, [selectedId]);

  // ── 渲染 ──
  return (
    <div className="flex h-full">
      {/* ═══ 左侧：书列表 + 导入 ═══ */}
      <div className="w-80 border-r border-gray-700 overflow-y-auto p-3 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="panel-title">世界书</h2>
          <div className="flex gap-1">
            <button
              className="text-xs px-2 py-1 rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/40 transition-colors"
              onClick={createBook}
              title={`新建${BOOK_TYPE_LABELS[importType]}`}
            >
              ＋新建
            </button>
            <button
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/40 transition-colors ${importing ? "opacity-50 cursor-wait" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title="导入酒馆世界书 JSON / 聊天备份 jsonl / 角色卡 PNG·JSON"
            >
              {importing ? "导入中…" : <><AppIcon name="upload" size={13} />导入</>}
            </button>
          </div>
        </div>

        {/* 新建 / 导入的用途选择：说清两种用途的差别，普通小书直接当剧情书导入 */}
        <div className="mb-2 rounded border border-gray-700 bg-gray-800/40 p-2">
          <p className="text-[11px] text-gray-400 mb-1">新建 / 导入为</p>
          <div className="flex gap-1 mb-1">
            {(["story", "reference"] as WorldBookType[]).map((t) => (
              <button
                key={t}
                aria-pressed={importType === t}
                className={`text-[11px] px-2 py-0.5 rounded ${
                  importType === t
                    ? "bg-blue-600/40 text-blue-100"
                    : "bg-gray-700/60 text-gray-300 hover:bg-gray-600/60"
                }`}
                onClick={() => setImportType(t)}
              >
                {t === "story" ? "用于剧情" : "存入资料库"}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 leading-snug">{BOOK_TYPE_HINTS[importType]}</p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.jsonl,.txt,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportFile(f);
            e.target.value = "";
          }}
        />
        <details className="mb-2 text-xs">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-300 select-none">
            支持的格式说明
          </summary>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
            酒馆世界书导出 JSON（v1/v2）、角色卡内嵌世界书（PNG/JSON，自动连带导入角色）、
            聊天备份 .jsonl。兼容触发词/副键/常驻/概率/插入位置等语义。
          </p>
        </details>

        {/* 粘贴导入 */}
        <details className="mb-3 text-xs">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-200 select-none">
            粘贴 JSON 导入
          </summary>
          <PasteImportBox onImport={onImportJsonText} importing={importing} />
        </details>

        {/* 导入报告 */}
        {importReport && (
          <div className="mb-3 p-2 rounded bg-gray-800 border border-gray-700 text-xs">
            <p className="text-green-400">
              导入成功 {importReport.imported} 条
              {importReport.skipped > 0 && `，跳过 ${importReport.skipped} 条`}
            </p>
            {importCharacter && (
              <p className="text-cyan-300 mt-0.5">🎭 角色「{importCharacter.name}」已连带导入，可在新建会话时入队</p>
            )}
            <p className="text-gray-500 mt-0.5">来源：{sourceLabel(importReport.source_format)}</p>
            {importReport.warnings.length > 0 && (
              <ul className="mt-1 text-amber-400/80 list-disc list-inside max-h-24 overflow-y-auto">
                {importReport.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {importReport.warnings.length > 20 && (
                  <li>…共 {importReport.warnings.length} 条警告</li>
                )}
              </ul>
            )}
          </div>
        )}

        {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

        {/* 用途筛选 */}
        <nav className="wbg-view-tabs mb-2" aria-label="世界书用途筛选">
          {([["all", "全部"], ["story", "剧情世界书"], ["reference", "资料库"]] as [BookTypeFilter, string][]).map(
            ([value, label]) => (
              <button key={value} aria-pressed={listFilter === value} onClick={() => setListFilter(value)}>
                {label} · {counts[value]}
              </button>
            ),
          )}
        </nav>

        {/* 书列表 */}
        <div className="space-y-1.5">
          {visibleBooks.length === 0 && (
            <p className="text-gray-600 text-xs">
              {books.length === 0
                ? "还没有世界书，点击「导入」或「新建」开始。"
                : "该用途下还没有书。"}
            </p>
          )}
          {visibleBooks.map((b) => {
            const reference = isReference(b);
            return (
            <div
              key={b.id}
              onClick={() => setSelectedId(b.id)}
              className={`p-2 rounded-lg border cursor-pointer transition-colors ${
                selectedId === b.id
                  ? "border-blue-600/60 bg-blue-600/10"
                  : "border-gray-700 bg-gray-800/60 hover:border-gray-600"
              } ${!b.enabled && !reference ? "opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm text-gray-200 truncate">{b.name}</span>
                <span className="flex items-center gap-1 shrink-0">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      reference
                        ? "bg-cyan-700/30 text-cyan-200"
                        : "bg-emerald-700/30 text-emerald-200"
                    }`}
                  >
                    {BOOK_TYPE_LABELS[bookTypeOf(b)]}
                  </span>
                  <SourceBadge source={b.source} size="xs" />
                  {b.is_default && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/30 text-amber-300">
                      默认
                    </span>
                  )}
                  {!b.enabled && !reference && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                      停用
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px] text-gray-500">
                <span>{b.entry_count} 条 · {sourceLabel(b.source_format)}</span>
                <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  {!reference && (
                    <button
                      className="hover:text-gray-300"
                      title={b.enabled ? "停用（不再参与解析）" : "启用"}
                      onClick={() => toggleEnabled(b)}
                    >
                      <AppIcon name={b.enabled ? "pause" : "play"} size={14} />
                    </button>
                  )}
                  {!reference && (
                    <button
                      className="hover:text-gray-300"
                      title="设为全局默认书"
                      onClick={() => toggleDefault(b.id, true)}
                    >
                      <AppIcon name="star" size={14} />
                    </button>
                  )}
                  <button
                    className="hover:text-gray-300"
                    title="导出酒馆格式"
                    onClick={() => exportBook(b.id)}
                  >
                    <AppIcon name="download" size={14} />
                  </button>
                  <button
                    className="hover:text-gray-300"
                    title="复制为新导入书"
                    onClick={() => duplicateBook(b.id)}
                  >
                    <AppIcon name="copy" size={14} />
                  </button>
                  {b.is_preinstalled && (
                    <button
                      className="hover:text-cyan-300"
                      title="重装预装整合包（恢复出厂内容）"
                      onClick={() => reinstallBook(b.id)}
                    >
                      <AppIcon name="refresh" size={14} />
                    </button>
                  )}
                  <button
                    className="hover:text-red-400"
                    title="删除（预装包可重装还原）"
                    onClick={() => deleteBook(b.id)}
                  >
                    <AppIcon name="trash" size={14} />
                  </button>
                </span>
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* ═══ 右侧：详情 + 条目管理 ═══ */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        {!detail && (
          <p className="text-gray-600 text-sm mt-8 text-center">
            选择左侧世界书，或导入/新建一本。
          </p>
        )}

        {/* ── 切书确认：有未保存草稿时先问用户（保存并切换 / 放弃并切换 / 取消） ── */}
        {pendingBook !== null && <section role="dialog" aria-label="切换世界书" className="wbg-notice mb-3">
          <span>当前世界书有未保存改动。</span>
          <button disabled={draftSaving} onClick={async () => {
            if (await saveDraft()) { applyBookSwitch(pendingBook); setPendingBook(null); }
          }}>保存并切换</button>
          <button disabled={draftSaving} onClick={() => { applyBookSwitch(pendingBook); setPendingBook(null); }}>放弃并切换</button>
          <button onClick={() => setPendingBook(null)}>取消</button>
        </section>}

        {/* ── 工作台页头：页签栏 + 保存条（脏 / 保存中 / 冲突 / 失败，或停在 load 页签时常驻） ── */}
        <div className="wbg-page-bar mb-3">
          <nav className="wbg-view-tabs" aria-label="世界书工作台页签">
            {visibleTabs.map((tab) => <button key={tab.id} title={tab.hint} aria-pressed={effectiveTab === tab.id}
              disabled={!detail} onClick={() => setWorldbookTab(tab.id)}>{tab.label}</button>)}
          </nav>
          {detail && (draftDirty || draftSaving || draftConflict || !!draftSaveError || effectiveTab === "load") &&
            <div className="wbg-page-status">
              <span className={"wbg-save-state" + (draftDirty ? " is-dirty" : "")}>
                {draftDirty ? "有未保存修改" : "已同步"}
              </span>
              {draftDirty && <button className="wbg-button wbg-button-quiet" disabled={draftSaving} onClick={undoDraft}>撤销</button>}
              <button className="wbg-button wbg-button-primary" disabled={draftSaving || !draftDirty}
                onClick={() => void doSaveDraft()}>{draftSaving ? "保存中…" : "保存"}</button>
            </div>}
        </div>

        {draftSaveError && <div role="alert" className="wbg-notice wbg-error mb-3">
          <span>{draftConflict ? "保存被拒绝：" : "保存失败："}{draftSaveError}
            {draftConflict && "（你的草稿仍完整保留，可先对照最新数据再保存）"}</span>
          <button onClick={() => void doSaveDraft()}>重试保存</button>
        </div>}

        {detail && (
          <>
            {/* ── 书元信息 ── */}
            <div className="mb-4 p-3 rounded-lg bg-gray-800/60 border border-gray-700">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[11px] px-2 py-0.5 rounded ${
                    detailIsReference
                      ? "bg-cyan-700/40 text-cyan-100"
                      : "bg-emerald-700/40 text-emerald-100"
                  }`}
                >
                  {BOOK_TYPE_LABELS[bookTypeOf(detail)]}
                </span>
                <input
                  className="flex-1 min-w-[160px] bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                  value={bookName}
                  onChange={(e) => setBookName(e.target.value)}
                />
                <label className="text-xs text-gray-500 flex items-center gap-1">
                  Token 预算
                  <input
                    className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                    type="number"
                    min={0}
                    value={budgetTokens}
                    onChange={(e) => setBudgetTokens(e.target.value)}
                  />
                  <span title="0 = 不限制">（0=不限）</span>
                </label>
                <button
                  className="text-xs px-2 py-1 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/40"
                  onClick={saveBookMeta}
                >
                  保存
                </button>
                {/* 资料库不显示设为默认：它不参与解析 */}
                {!detailIsReference && (
                  <button
                    className="text-xs px-2 py-1 rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/40"
                    onClick={() => toggleDefault(detail.id, !detail.is_default)}
                  >
                    {detail.is_default ? "取消默认" : "设为全局默认"}
                  </button>
                )}
                <button
                  className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                  onClick={() => changeBookType(detail.id, detailIsReference ? "story" : "reference")}
                  title={
                    detailIsReference
                      ? "改为剧情世界书：可绑定会话、设为默认并参与解析"
                      : "改为资料库：只供浏览、检索与摘录，不参与解析"
                  }
                >
                  {detailIsReference ? "改为剧情世界书" : "改为资料库"}
                </button>
                <button
                  className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                  onClick={() => exportBook(detail.id)}
                >
                  导出酒馆格式
                </button>
                <button
                  className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                  onClick={() => duplicateBook(detail.id)}
                >
                  <AppIcon name="copy" size={14} /> 复制
                </button>
                {detail.is_preinstalled && (
                  <button
                    className="text-xs px-2 py-1 rounded bg-cyan-700/40 text-cyan-200 hover:bg-cyan-700/60"
                    onClick={() => reinstallBook(detail.id)}
                  >
                    <AppIcon name="refresh" size={14} /> 重装整合包
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-500 mt-2 flex items-center gap-1.5 flex-wrap">
                <SourceBadge source={detail.source} size="xs" />
                <span>
                  {detail.entry_count} 条 · 来源 {sourceLabel(detail.source_format)} ·
                  {detailIsReference
                    ? "资料库：只供浏览、检索与摘录，不参与会话解析"
                    : `生效规则：会话绑定 > 全局默认书${detail.is_preinstalled ? " > 预装整合包" : ""}`}
                </span>
                {!detail.enabled && !detailIsReference && (
                  <span className="text-red-400">（已停用，不参与解析）</span>
                )}
              </p>
            </div>

            {/* ── 页签内容：非条目页签都在这里，条目页签紧接其后 ── */}
            {effectiveTab === "index" && <p className="wbg-help mb-2">本家索引 · {WORLDBOOK_INDEX_SUBTITLE}</p>}
            {effectiveTab === "index" && <div className="wbg-index-shell">
              <Suspense fallback={<p className="text-xs text-gray-400">加载本家索引…</p>}><IndexManager /></Suspense>
            </div>}
            {(effectiveTab === "load" || effectiveTab === "prompt" || effectiveTab === "nodes") && panelProps && <>
              {effectiveTab === "load" && <LoadTab ctx={panelProps} onNotice={(text) => showToast(text)} onReload={reloadDetail} />}
              {effectiveTab === "prompt" && <PromptPreviewTab ctx={panelProps} onNotice={(text) => showToast(text)} onReload={reloadDetail} />}
              {effectiveTab === "nodes" && <NodeViewTab ctx={panelProps} onNotice={(text) => showToast(text)} onReload={reloadDetail} />}
            </>}
            {(effectiveTab === "load" || effectiveTab === "prompt" || effectiveTab === "nodes") && !panelProps &&
              <p role="status" className="text-xs text-gray-400">正在准备配置草稿…</p>}

            {/* ── 资料库：跨书检索 + 加入剧情世界书（属于条目页签） ── */}
            {effectiveTab === "entries" && detailIsReference && (
              <div className="mb-4 p-3 rounded-lg bg-cyan-900/10 border border-cyan-800/40">
                <h3 className="text-xs text-cyan-200 mb-2">检索资料库，挑条目加入剧情世界书</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    className="flex-1 min-w-[200px] bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                    placeholder="关键词：角色名 / 地点 / 触发词…"
                    value={libraryQuery}
                    onChange={(e) => setLibraryQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") searchLibrary(); }}
                  />
                  <button
                    className="text-xs px-2 py-1 rounded bg-cyan-700/40 text-cyan-100 hover:bg-cyan-700/60 disabled:opacity-50"
                    onClick={searchLibrary}
                    disabled={librarySearching}
                  >
                    {librarySearching ? "检索中…" : "检索全部资料库"}
                  </button>
                  {storyTargets.length === 0 && (
                    <span className="text-[11px] text-amber-400">
                      还没有剧情世界书可加入，先新建或导入一本「用于剧情」的书。
                    </span>
                  )}
                </div>

                {librarySearched && libraryHits.length === 0 && (
                  <p className="text-[11px] text-gray-500 mt-2">
                    没有匹配的资料条目。换个关键词，或在左侧「全部」里确认资料库已被导入。
                  </p>
                )}
                {libraryHits.length > 0 && (
                  <div className="mt-2 space-y-1.5 max-h-80 overflow-y-auto">
                    <p className="text-[11px] text-gray-500">
                      命中 {libraryHits.length} 条（最多展示 100 条）
                    </p>
                    {libraryHits.slice(0, 100).map((hit) => (
                      <div
                        key={`${hit.bookId}:${hit.entry.uid}`}
                        className="flex items-start justify-between gap-2 p-2 rounded border border-gray-700 bg-gray-800/60"
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-gray-200 truncate">
                            {hit.entry.name || hit.entry.content.slice(0, 24) || "(未命名)"}
                            <span className="text-[10px] text-gray-500 ml-1.5">
                              《{hit.bookName}》
                            </span>
                          </p>
                          <p className="text-[11px] text-gray-500 line-clamp-2 mt-0.5">
                            {hit.entry.content.slice(0, 120)}
                          </p>
                        </div>
                        <button
                          className="text-xs px-2 py-1 rounded bg-emerald-700/30 text-emerald-200 hover:bg-emerald-700/50 shrink-0"
                          onClick={() => openExcerpt(hit)}
                        >
                          加入剧情世界书
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── 会话绑定：资料库不参与解析，不显示（属于条目页签） ── */}
            {effectiveTab === "entries" && !detailIsReference && (
            <div className="mb-4 p-3 rounded-lg bg-gray-800/60 border border-gray-700">
              <h3 className="text-xs text-gray-400 mb-2">会话绑定</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 max-w-[240px]"
                  value={bindSessionId}
                  onChange={(e) => setBindSessionId(e.target.value)}
                >
                  <option value="">选择会话…</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {bindSessionId && (
                  <>
                    {boundBookId === detail.id ? (
                      <button
                        className="text-xs px-2 py-1 rounded bg-red-600/20 text-red-300 hover:bg-red-600/40"
                        onClick={() => bindToSession(false)}
                      >
                        解绑该会话
                      </button>
                    ) : (
                      <button
                        className="text-xs px-2 py-1 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/40"
                        onClick={() => bindToSession(true)}
                      >
                        绑定该会话
                      </button>
                    )}
                    <span className="text-[11px] text-gray-500">
                      {boundBookId === detail.id
                        ? "该会话已绑定本书"
                        : effectiveBookId
                          ? "该会话当前生效其他书"
                          : "该会话当前生效全局默认书"}
                    </span>
                  </>
                )}
              </div>
            </div>
            )}

            {/* ── 条目页签：筛选 / 分页 / 正文列表（依赖逐层展开的挂载点） ── */}
            {effectiveTab === "entries" && <>
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <h3 className="panel-title">条目（{detail.entries.length}）</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 max-w-[200px]"
                  aria-label="按分类筛选条目"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="">全部分类</option>
                  {flattenCategoryTree(detail.categories || []).map(({ category, level }) => (
                    <option key={category.id} value={category.id}>{"　".repeat(level)}{category.name}</option>
                  ))}
                </select>
                <input
                  className="w-48 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                  placeholder="筛选条目名 / 正文 / 触发词"
                  value={entryQuery}
                  onChange={(e) => setEntryQuery(e.target.value)}
                />
                <button
                  className="text-xs px-2 py-1 rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/40"
                  onClick={openCreate}
                >
                  ＋新增条目
                </button>
              </div>
            </div>

            {loadingDetail && <p className="text-gray-500 text-xs">加载中…</p>}

            {/* 条目列表：先筛选再分页渲染，大书不一次铺开全书正文 */}
            {!loadingDetail && detail.entries.length === 0 && (
              <p className="text-gray-600 text-xs">
                {detailIsReference
                  ? "这本资料库还没有条目。可用上方检索从其它资料库摘录，或在此新增。"
                  : "本书暂无条目。"}
              </p>
            )}
            {!loadingDetail && detail.entries.length > 0 && filteredEntries.length === 0 && (
              <p className="text-gray-600 text-xs">没有匹配「{entryQuery}」的条目。</p>
            )}
            <div className="space-y-2">
              {filteredEntries.slice(0, entryLimit).map((e) => (
                <div
                  key={e.uid}
                  className={`p-2.5 rounded-lg border transition-colors ${
                    editingUid === e.uid
                      ? "border-amber-600/60 bg-amber-600/5"
                      : "border-gray-700 bg-gray-800/60"
                  }`}
                  onDoubleClick={(ev) => {
                    if ((ev.target as HTMLElement).closest("button")) return;
                    openEdit(e);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-200 truncate">
                      {e.name || e.content.slice(0, 24) || "(未命名)"}
                      {!e.enabled && <span className="text-gray-600 ml-1">[停用]</span>}
                      {e.always_active && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-purple-600/30 text-purple-300 ml-1">
                          常驻
                        </span>
                      )}
                      {e.excerpt_source && (
                        <span
                          className="text-[10px] px-1 py-0.5 rounded bg-cyan-700/30 text-cyan-200 ml-1"
                          title={`摘录自《${e.excerpt_source.source_book_name || e.excerpt_source.source_book_id}》的条目 ${e.excerpt_source.source_entry_uid}`}
                        >
                          摘录
                        </span>
                      )}
                    </span>
                    <span className="flex gap-1 shrink-0">
                      <button
                        className="text-xs px-1.5 py-0.5 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200"
                        onClick={() => openEdit(e)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-xs px-1.5 py-0.5 rounded hover:bg-red-600/20 text-gray-400 hover:text-red-300"
                        onClick={() => deleteEntry(e.uid)}
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
                    {e.trigger_keys.length > 0 && (
                      <span title="触发词">
                        🔑 {e.trigger_keys.slice(0, 4).join(", ")}
                        {e.trigger_keys.length > 4 && ` +${e.trigger_keys.length - 4}`}
                      </span>
                    )}
                    {e.secondary_keys.length > 0 && (
                      <span title="副键">
                        🔸 {e.secondary_keys.slice(0, 4).join(", ")}
                        {e.secondary_keys.length > 4 && ` +${e.secondary_keys.length - 4}`}
                      </span>
                    )}
                    <span>位置：{e.position === 0 ? "卡前" : "卡后"}</span>
                    <span>深度：{e.depth}</span>
                    {e.probability < 100 && <span>概率：{e.probability}%</span>}
                    {e.group && <span>组：{e.group}</span>}
                    {(e.case_sensitive || e.match_whole_words) && (
                      <span>
                        {e.case_sensitive ? "区分大小写" : ""}
                        {e.case_sensitive && e.match_whole_words ? " · " : ""}
                        {e.match_whole_words ? "全词匹配" : ""}
                      </span>
                    )}
                  </div>
                  {/* A-3：依赖逐层展开的挂载点（展开状态由组件自己持有，不影响本列表的筛选与分页） */}
                  {bookDraft && <EntryDependencyTree detail={detail} rootUids={[e.uid]} draft={bookDraft}
                    patch={patchBookDraft} onNotice={(text) => showToast(text)} />}
                  <p className="mt-1 text-xs text-gray-400 line-clamp-2">
                    {e.content.slice(0, 120)}
                  </p>
                </div>
              ))}
            </div>
            {filteredEntries.length > entryLimit && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
                <span>已显示 {entryLimit} / {filteredEntries.length} 条（其余仍可被触发词命中）</span>
                <button
                  className="px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 hover:bg-gray-600/60"
                  onClick={() => setEntryLimit((n) => n + LIBRARY_PAGE_SIZE)}
                >
                  显示更多
                </button>
              </div>
            )}
            </>}
          </>
        )}
      </div>

      {/* ── 条目编辑模态框（居中弹出，无需滚动定位） ── */}
      {editorMode && draft && (
        <EntryEditorModal
          key={editingUid ?? "create"}
          mode={editorMode}
          title={
            editorMode === "create"
              ? "新增条目"
              : `编辑条目：${draft.name || "(未命名)"}`
          }
          draft={draft}
          categories={detail?.categories || []}
          saving={saving}
          onChange={handleDraftChange}
          onCancel={cancelEditor}
          onSave={saveEntry}
        />
      )}

      {/* ── 摘录：加入剧情世界书（默认带入原文，可先编辑再提交） ── */}
      {excerptDraft && excerptOriginal && (
        <ExcerptModal
          draft={excerptDraft}
          original={excerptOriginal}
          targets={storyTargets}
          saving={excerptSaving}
          onChange={(patch) => setExcerptDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
          onCancel={() => { setExcerptDraft(null); setExcerptOriginal(null); }}
          onSubmit={submitExcerpt}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-12 right-4 px-3 py-2 rounded-lg text-sm shadow-lg ${
            toast.type === "ok"
              ? "bg-green-700/90 text-white"
              : "bg-red-700/90 text-white"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

/** 条目编辑模态框：打开即居中显示，不依赖列表滚动位置 */
function EntryEditorModal({
  mode,
  title,
  draft,
  categories,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  title: string;
  draft: EntryDraft;
  categories: WorldBookCategoryDTO[];
  saving: boolean;
  onChange: (patch: Partial<EntryDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  // 最小化：保留草稿与滚动位置，与关闭（取消）互相独立
  const dialog = useDialogMinimize(ENTRY_EDITOR_DIALOG_ID, title, true);

  // 打开时自动聚焦：新增 → 名称，编辑 → 内容
  useEffect(() => {
    (mode === "create" ? nameRef.current : contentRef.current)?.focus();
  }, [mode]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 ${dialog.minimizedClass}`}
      onClick={onCancel}
    >
      <div
        ref={dialog.containerRef}
        tabIndex={-1}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-lg border border-amber-600/40 bg-gray-900 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <h3 className="text-sm text-amber-300 truncate">{title}</h3>
          <div className="flex items-center gap-1">
            <button
              className="text-gray-400 hover:text-gray-200 text-sm px-1 shrink-0"
              onClick={dialog.minimize}
              title="最小化（保留草稿）"
              aria-label="最小化对话框"
            >
              —
            </button>
            <button
              className="text-gray-400 hover:text-gray-200 text-sm px-1 shrink-0"
              onClick={onCancel}
              title="关闭（Esc）"
              aria-label="关闭对话框"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 表单（超高时内部滚动） */}
        <div className="overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-400 col-span-2">
              名称（comment）
              <input
                ref={nameRef}
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.name}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400 col-span-2">
              内容（content）
              <textarea
                ref={contentRef}
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 min-h-[120px]"
                value={draft.content}
                onChange={(e) => onChange({ content: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSave();
                }}
              />
            </label>
            <label className="text-xs text-gray-400">
              触发词（正则，逗号分隔）
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.triggerKeysText}
                onChange={(e) => onChange({ triggerKeysText: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              副键（逗号分隔）
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.secondaryKeysText}
                onChange={(e) => onChange({ secondaryKeysText: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              分组
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.group}
                onChange={(e) => onChange({ group: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              分类
              <select className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200" value={draft.categoryId} onChange={(e) => onChange({ categoryId: e.target.value, characterId: categories.find((c) => c.id === e.target.value)?.scope_type === "character" ? draft.characterId : "" })}>
                {flattenCategoryTree(categories).map(({ category, level }) => <option key={category.id} value={category.id}>{"　".repeat(level)}{category.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              关联角色目录名（角色类条目必填）
              <input disabled={categories.find((c) => c.id === draft.categoryId)?.scope_type !== "character"} className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-40" value={draft.characterId} onChange={(e) => onChange({ characterId: e.target.value })} />
            </label>
            <label className="text-xs text-gray-400">
              插入位置
              <select
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.position}
                onChange={(e) => onChange({ position: Number(e.target.value) })}
              >
                <option value={0}>0 - 卡前（稳定层）</option>
                <option value={1}>1 - 卡后（动态层）</option>
              </select>
            </label>
            <label className="text-xs text-gray-400">
              深度
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                type="number" min={0} max={20}
                value={draft.depth}
                onChange={(e) => onChange({ depth: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs text-gray-400">
              扫描回溯消息数
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                type="number" min={1} max={50}
                value={draft.scanDepth}
                onChange={(e) => onChange({ scanDepth: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs text-gray-400">
              概率 %
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                type="number" min={0} max={100}
                value={draft.probability}
                onChange={(e) => onChange({ probability: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs text-gray-400">
              组权重
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                type="number"
                value={draft.groupWeight}
                onChange={(e) => onChange({ groupWeight: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-4 flex-wrap text-xs text-gray-300">
            {[
              ["alwaysActive", "常驻（constant）"],
              ["selective", "选择性（主键命中才查副键）"],
              ["enabled", "启用"],
              ["caseSensitive", "区分大小写"],
              ["matchWholeWords", "全词匹配"],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft[key as keyof EntryDraft] as boolean}
                  onChange={(e) => onChange({ [key]: e.target.checked } as Partial<EntryDraft>)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex gap-2 px-4 py-3 border-t border-gray-700 shrink-0">
          <button
            className="text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存条目"}
          </button>
          <button
            className="text-xs px-3 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </button>
          <span className="ml-auto text-[10px] text-gray-600 self-center">
            Ctrl+Enter 保存 · Esc 关闭
          </span>
        </div>
      </div>
    </div>
  );
}

/** 摘录模态框：选目标剧情世界书 + 提交前编辑标题/正文/触发词（默认带入原文） */
function ExcerptModal({
  draft,
  original,
  targets,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ExcerptDraft;
  original: WorldBookEntryDTO;
  targets: WorldBookSummary[];
  saving: boolean;
  onChange: (patch: Partial<ExcerptDraft>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const dialog = useDialogMinimize("worldbook-excerpt", "加入剧情世界书", true);
  const contentChanged = draft.content !== (original.content || "");
  const item = excerptItemFromDraft(draft, original);
  const editedFields = Object.keys(item).filter(
    (key) => key !== "source_book_id" && key !== "source_entry_uid",
  );

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 ${dialog.minimizedClass}`}
      onClick={onCancel}
    >
      <div
        ref={dialog.containerRef}
        tabIndex={-1}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-lg border border-cyan-700/40 bg-gray-900 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <h3 className="text-sm text-cyan-200 truncate">加入剧情世界书</h3>
          <div className="flex items-center gap-1">
            <button
              className="text-gray-400 hover:text-gray-200 text-sm px-1 shrink-0"
              onClick={dialog.minimize}
              title="最小化（保留草稿）"
              aria-label="最小化对话框"
            >
              —
            </button>
            <button
              className="text-gray-400 hover:text-gray-200 text-sm px-1 shrink-0"
              onClick={onCancel}
              title="关闭（Esc）"
              aria-label="关闭对话框"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4">
          <p className="text-[11px] text-gray-500 mb-3">
            来源：《{draft.sourceBookName}》 · 条目 {draft.sourceEntryUid}
            <span className="ml-1">（来源书不会被修改；目标书会生成新 UID）</span>
          </p>
          <div className="grid grid-cols-1 gap-3">
            <label className="text-xs text-gray-400">
              加入哪本剧情世界书
              <select
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.targetBookId}
                onChange={(e) => onChange({ targetBookId: e.target.value })}
              >
                {targets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}（{b.entry_count} 条）
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              标题
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.name}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              正文
              {contentChanged && <span className="ml-1 text-amber-400">（已改写）</span>}
              <textarea
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 min-h-[140px]"
                value={draft.content}
                onChange={(e) => onChange({ content: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              触发词（逗号分隔）
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.triggerKeysText}
                onChange={(e) => onChange({ triggerKeysText: e.target.value })}
              />
            </label>
            <label className="text-xs text-gray-400">
              副键（逗号分隔）
              <input
                className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                value={draft.secondaryKeysText}
                onChange={(e) => onChange({ secondaryKeysText: e.target.value })}
              />
            </label>
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            {editedFields.length === 0
              ? "未做任何编辑：将完整复制原文条目。"
              : `将按你的编辑提交：${editedFields.join("、")}`}
          </p>
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-gray-700 shrink-0">
          <button
            className="text-xs px-3 py-1 rounded bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-50"
            onClick={onSubmit}
            disabled={saving || !draft.targetBookId}
          >
            {saving ? "提交中…" : "加入剧情世界书"}
          </button>
          <button
            className="text-xs px-3 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 粘贴 JSON 导入小面板 */
function PasteImportBox({
  onImport,
  importing,
}: {
  onImport: (text: string, name: string) => void;
  importing: boolean;
}) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  return (
    <div className="mt-2 space-y-1.5">
      <input
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
        placeholder="书名（可选）"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 min-h-[90px] font-mono"
        placeholder='粘贴 {"entries": {...}} 或多行 .jsonl 内容'
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="text-xs px-2 py-1 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/40 disabled:opacity-50"
        disabled={!text.trim() || importing}
        onClick={() => onImport(text, name)}
      >
        {importing ? "导入中…" : "导入"}
      </button>
    </div>
  );
}
