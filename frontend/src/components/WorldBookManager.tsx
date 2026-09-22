import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "../hooks/useApi";
import { useAppStore, type WorldBookTab } from "../stores/appStore";
import type { WorldBookDetail, WorldBookEntryDTO, WorldBookSearchHit, WorldBookSummary, WorldBookType } from "../types";
import { useScopePreview, useWorldbookDraft } from "../hooks/useWorldbookDraft";
import { BOOK_TYPE_LABELS, bookTypeOf, filterBooksByType, isReference,
  normalizeWorldbookTab, type BookTypeFilter } from "../utils/worldbookLibrary";
import { LAYER_HINTS, LAYER_LABELS, bookEntryStats, entryLayer, entryTokens,
  summaryEntryStats, type WorldBookEntryLayer } from "../utils/worldbookLayer";
import type { WorldBookPanelProps } from "./worldbook/panel";
import CoverPicker from "./worldbook/CoverPicker";
import EntryDependencyTree from "./worldbook/EntryDependencyTree";
import PromptPreviewTab from "./worldbook/tabs/PromptPreviewTab";
import PlotGraphPage from "./combat/PlotGraphPage";
import AppIcon from "./AppIcon";
import "../styles/worldbook-entry-refresh.css";

// 展示用 token 估算与分层口径都在 utils/worldbookLayer.ts 里（与后端同口径）。
// 这里保留 re-export：scripts/test_worldbook_library_ui.cjs 直接从本模块取它断言。
export { estimateDisplayTokens } from "../utils/worldbookLayer";

const IndexManager = lazy(() => import("./IndexManager"));

export const WORLDBOOK_PANEL_TABS: ReadonlyArray<{ id: WorldBookTab; label: string; hint: string }> = [
  { id: "entries", label: "条目", hint: "阅读、编辑、排序与依赖展开" },
  { id: "prompt", label: "Prompt 预览", hint: "查看本世界书的静态与动态插入内容" },
  { id: "graph", label: "节点图", hint: "按剧情编辑节点图：整页画布增删节点与连线" },
  { id: "index", label: "会话条目", hint: "浏览世界书默认条目，单独调整会话开关" },
];
export const WORLDBOOK_INDEX_SUBTITLE = "世界书默认 · 单会话条目开关";

export function visibleWorldbookTabs(book: Pick<WorldBookSummary, "book_type"> | null | undefined) {
  return WORLDBOOK_PANEL_TABS.filter((tab) => normalizeWorldbookTab(tab.id, book) === tab.id);
}

interface EntryDraft {
  changedFields: string[];
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

function entryToDraft(entry: WorldBookEntryDTO): EntryDraft {
  return {
    changedFields: [],
    name: entry.name || "", content: entry.content || "",
    triggerKeysText: (entry.trigger_keys || []).join(", "),
    secondaryKeysText: (entry.secondary_keys || []).join(", "),
    alwaysActive: !!entry.always_active, selective: !!entry.selective,
    enabled: entry.enabled !== false, probability: entry.probability ?? 100,
    position: entry.position ?? 0, depth: entry.depth ?? 4,
    scanDepth: entry.scan_depth ?? 4, group: entry.group || "",
    groupWeight: entry.group_weight ?? 100, caseSensitive: !!entry.case_sensitive,
    matchWholeWords: !!entry.match_whole_words,
    categoryId: entry.category_id || "unclassified", characterId: entry.character_id || "",
  };
}

function draftToEntry(draft: EntryDraft, isNew = false): Partial<WorldBookEntryDTO> {
  const split = (value: string) => value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const full: Partial<WorldBookEntryDTO> = {
    name: draft.name.trim(), content: draft.content,
    trigger_keys: split(draft.triggerKeysText), secondary_keys: split(draft.secondaryKeysText),
    always_active: draft.alwaysActive, selective: draft.selective, enabled: draft.enabled,
    probability: draft.probability, position: draft.position, depth: draft.depth,
    scan_depth: draft.scanDepth, group: draft.group.trim(), group_weight: draft.groupWeight,
    case_sensitive: draft.caseSensitive, match_whole_words: draft.matchWholeWords,
    category_id: draft.categoryId, character_id: draft.characterId,
  };
  if (isNew) return full;
  const output: Partial<WorldBookEntryDTO> = {};
  const changed = new Set(draft.changedFields);
  if (changed.has("name")) output.name = full.name;
  if (changed.has("content")) output.content = full.content;
  if (changed.has("triggerKeysText")) output.trigger_keys = full.trigger_keys;
  if (changed.has("group")) output.group = full.group;
  if (changed.has("categoryId")) { output.category_id = full.category_id; output.character_id = full.character_id; }
  if (changed.has("alwaysActive")) output.always_active = full.always_active;
  if (changed.has("position")) output.position = full.position;
  if (changed.has("enabled")) output.enabled = full.enabled;
  return output;
}

function pendingEntryDto(uid: string, draft: EntryDraft): WorldBookEntryDTO {
  return { uid, name: draft.name, content: draft.content,
    trigger_keys: draft.triggerKeysText.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
    secondary_keys: [], always_active: draft.alwaysActive, selective: draft.selective,
    enabled: draft.enabled, position: draft.position, depth: draft.depth, scan_depth: draft.scanDepth,
    probability: draft.probability, group: draft.group, group_weight: draft.groupWeight,
    case_sensitive: draft.caseSensitive, match_whole_words: draft.matchWholeWords,
    category_id: draft.categoryId, character_id: draft.characterId, raw: {} };
}

function safeCover(value: string | undefined): string {
  const src = String(value || "").trim();
  return /^(https?:\/\/|data:image\/)/i.test(src) ? src : "";
}

type SavePhase = { state: "idle" | "waiting" | "saving" | "saved" | "error"; message?: string };
type ApiLike = ReturnType<typeof useApi>;
const AUTOSAVE_STORAGE = "arknights-tavern.worldbook.pending.v1";

type StoredTasks = Record<string, { bookId: string; uid?: string; kind: "entry" | "meta" | "order";
  generation: number; payload: EntryDraft | { name: string; description: string; cover: string } | string[] }>;

function readStoredTasks(): StoredTasks {
  try { return JSON.parse(sessionStorage.getItem(AUTOSAVE_STORAGE) || "{}"); }
  catch { return {}; }
}

function writeStoredTask(key: string, value: StoredTasks[string] | null) {
  try {
    const tasks = readStoredTasks();
    if (value) tasks[key] = value; else delete tasks[key];
    sessionStorage.setItem(AUTOSAVE_STORAGE, JSON.stringify(tasks));
  } catch { /* sessionStorage may be unavailable in SSR/private contexts */ }
}

function clearStoredTaskIfGeneration(key: string, generation: number) {
  try {
    const tasks = readStoredTasks();
    if (tasks[key]?.generation !== generation) return false;
    delete tasks[key]; sessionStorage.setItem(AUTOSAVE_STORAGE, JSON.stringify(tasks)); return true;
  } catch { return false; }
}

/** Module-lifetime coordinator state: navigating away does not destroy queues or drafts. */
const SHARED_SAVE = {
  revisions: new Map<string, number>(), queues: new Map<string, Promise<unknown>>(),
  metaTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  entryTimers: new Map<string, ReturnType<typeof setTimeout>>(), generations: new Map<string, number>(),
  metaCache: new Map<string, { name: string; description: string; cover: string }>(),
  draftCache: new Map<string, EntryDraft>(), persistedUids: new Set<string>(),
  retryTasks: new Map<string, () => void>(), pendingOrders: new Map<string, string[]>(),
  deletedEntries: new Set<string>(), inFlightEntries: new Set<string>(),
};

type SharedSaveEvent =
  | { status: "success"; kind: "entry"; bookId: string; key: string; generation: number;
      editRevision: number; entry: WorldBookEntryDTO }
  | { status: "success"; kind: "meta"; bookId: string; key: string; generation: number;
      editRevision: number; book: WorldBookSummary }
  | { status: "success"; kind: "order"; bookId: string; key: string; generation: number;
      editRevision: number; order: string[] }
  | { status: "success"; kind: "delete"; bookId: string; key: string; generation: number;
      editRevision: number; uid: string }
  | { status: "error"; kind: "entry" | "meta" | "order" | "delete"; bookId: string;
      key: string; generation: number; message: string };

const SHARED_SAVE_LISTENERS = new Set<(event: SharedSaveEvent) => void>();
function publishSaveEvent(event: SharedSaveEvent) {
  for (const listener of SHARED_SAVE_LISTENERS) listener(event);
}

export default function WorldBookManager({ __api }: { __api?: ApiLike } = {}) {
  const hookApi = useApi();
  const api = __api || hookApi;
  const worldbookTab = useAppStore((state) => state.worldbookTab);
  const setWorldbookTab = useAppStore((state) => state.setWorldbookTab);
  const worldbookJumpId = useAppStore((state) => state.worldbookJumpId);
  const setWorldbookJumpId = useAppStore((state) => state.setWorldbookJumpId);
  const worldbookScopeJumpId = useAppStore((state) => state.worldbookScopeJumpId);
  const setWorldbookScopeJumpId = useAppStore((state) => state.setWorldbookScopeJumpId);
  const worldbookGraphJumpId = useAppStore((state) => state.worldbookGraphJumpId);
  const setWorldbookGraphJumpId = useAppStore((state) => state.setWorldbookGraphJumpId);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const indexSessionId = useAppStore((state) => state.indexSessionId);
  const setIndexSessionId = useAppStore((state) => state.setIndexSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const worldbookEntryJump = useAppStore((state) => state.worldbookEntryJump);
  const setWorldbookEntryJump = useAppStore((state) => state.setWorldbookEntryJump);

  const [books, setBooks] = useState<WorldBookSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorldBookDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [listFilter, setListFilter] = useState<BookTypeFilter>("all");
  const [query, setQuery] = useState("");
  // 分层筛选：系统层条目（节点图 / 节点绑定）不是注入条目，单独成一档。
  const [layerFilter, setLayerFilter] = useState<"all" | WorldBookEntryLayer>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [savePhase, setSavePhase] = useState<SavePhase>({ state: "idle" });
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editingMeta, setEditingMeta] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCover, setNewCover] = useState("");
  const [newType, setNewType] = useState<WorldBookType>("story");
  const [creating, setCreating] = useState(false);
  const [bookName, setBookName] = useState("");
  const [bookDescription, setBookDescription] = useState("");
  const [bookCover, setBookCover] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryResults, setLibraryResults] = useState<any[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [targetBookId, setTargetBookId] = useState("");
  const [pasteJson, setPasteJson] = useState("");
  // 统一检索（迁自原「内容中心」顶栏）：跨世界书条目检索 → 命中选中该书并预填条目筛选
  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfHits, setShelfHits] = useState<WorldBookSearchHit[]>([]);
  const [shelfSearching, setShelfSearching] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const shelfSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  const revisions = useRef(SHARED_SAVE.revisions);
  const queues = useRef(SHARED_SAVE.queues);
  const metaTimers = useRef(SHARED_SAVE.metaTimers);
  const entryTimers = useRef(SHARED_SAVE.entryTimers);
  const generations = useRef(SHARED_SAVE.generations);
  const metaCache = useRef(SHARED_SAVE.metaCache);
  const draftCache = useRef(SHARED_SAVE.draftCache);
  const persistedUids = useRef(SHARED_SAVE.persistedUids);
  const retryTasks = useRef(SHARED_SAVE.retryTasks);
  const pendingOrders = useRef(SHARED_SAVE.pendingOrders);
  const deletedEntries = useRef(SHARED_SAVE.deletedEntries);
  const inFlightEntries = useRef(SHARED_SAVE.inFlightEntries);
  const detailRequest = useRef(0);
  const reloadDetailRef = useRef<(bookId: string) => void>(() => undefined);
  const restoredTasks = useRef(false);
  const restoreRetriesWired = useRef(false);
  const orderRetriesWired = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const editingUidRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  editingUidRef.current = editingUid;
  if (!restoredTasks.current) {
    restoredTasks.current = true;
    for (const [key, task] of Object.entries(readStoredTasks())) {
      generations.current.set(key, task.generation);
      if (task.kind === "entry" && task.uid) draftCache.current.set(key, task.payload as EntryDraft);
      if (task.kind === "meta") metaCache.current.set(task.bookId,
        task.payload as { name: string; description: string; cover: string });
      if (task.kind === "order") pendingOrders.current.set(task.bookId, task.payload as string[]);
    }
  }

  const markTaskSuccess = useCallback((key: string, generation: number, message: string) => {
    retryTasks.current.delete(key);
    clearStoredTaskIfGeneration(key, generation);
    setSavePhase(retryTasks.current.size
      ? { state: "error", message: `仍有 ${retryTasks.current.size} 项保存失败` }
      : { state: "saved", message });
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? "" : current), 2600);
  }, []);

  const enqueue = useCallback(<T,>(bookId: string, work: (revision: number) => Promise<T>): Promise<T> => {
    const previous = queues.current.get(bookId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => work(revisions.current.get(bookId) || 0));
    queues.current.set(bookId, next);
    void next.then(
      () => { if (queues.current.get(bookId) === next) queues.current.delete(bookId); },
      () => { if (queues.current.get(bookId) === next) queues.current.delete(bookId); },
    );
    return next;
  }, []);

  const loadBooks = useCallback(async () => {
    try {
      const result = await api.listWorldbooks();
      setBooks(result.books);
      setSelectedId((current) => current || result.books[0]?.id || null);
    } catch (reason: any) { setError(reason?.message || "世界书列表加载失败"); }
  }, [api]);

  const loadDetail = useCallback(async (bookId: string | null) => {
    const requestId = ++detailRequest.current;
    if (!bookId) { setDetail(null); return; }
    setLoading(true);
    try {
      const value = await api.getWorldbook(bookId);
      if (requestId !== detailRequest.current || selectedRef.current !== bookId) return;
      const knownRevision = revisions.current.get(bookId) || 0;
      if ((value.edit_revision || 0) < knownRevision) {
        queueMicrotask(() => reloadDetailRef.current(bookId));
        return;
      }
      revisions.current.set(bookId, value.edit_revision || 0);
      value.entries = value.entries.filter((entry) => !deletedEntries.current.has(`${bookId}:${entry.uid}`));
      value.entries = value.entries.map((entry) => {
        const pending = draftCache.current.get(`${bookId}:${entry.uid}`);
        return pending ? { ...entry, ...draftToEntry(pending, false) } as WorldBookEntryDTO : entry;
      });
      value.entry_count = value.entries.length;
      value.entry_order = value.entry_order?.filter((uid) => !deletedEntries.current.has(`${bookId}:${uid}`));
      for (const entry of value.entries) persistedUids.current.add(`${bookId}:${entry.uid}`);
      const serverUids = new Set(value.entries.map((entry) => entry.uid));
      const pendingEntries: WorldBookEntryDTO[] = [];
      for (const [key, pending] of draftCache.current) {
        if (!key.startsWith(`${bookId}:`)) continue;
        const uid = key.slice(bookId.length + 1);
        if (!serverUids.has(uid) && !deletedEntries.current.has(key)) pendingEntries.push(pendingEntryDto(uid, pending));
      }
      if (pendingEntries.length) {
        value.entries = [...value.entries, ...pendingEntries];
        value.entry_count = value.entries.length;
        value.entry_order = [...(value.entry_order || []), ...pendingEntries.map((entry) => entry.uid)];
      }
      const cachedMeta = metaCache.current.get(bookId);
      const cachedOrder = pendingOrders.current.get(bookId);
      if (cachedOrder) { value.entry_order = cachedOrder; value.has_explicit_entry_order = true; }
      if (cachedMeta) {
        value.name = cachedMeta.name; value.description = cachedMeta.description;
        value.cover_image = cachedMeta.cover;
      }
      setDetail(value);
      setBookName(cachedMeta?.name ?? value.name);
      setBookDescription(cachedMeta?.description ?? value.description ?? "");
      setBookCover(cachedMeta?.cover ?? value.cover_image ?? "");
      setError("");
    } catch (reason: any) {
      if (selectedRef.current === bookId) setError(reason?.message || "世界书详情加载失败");
    } finally { if (selectedRef.current === bookId) setLoading(false); }
  }, [api]);
  reloadDetailRef.current = (bookId) => { void loadDetail(bookId); };

  useEffect(() => { void loadBooks(); }, [loadBooks]);
  useEffect(() => {
    if (!indexSessionId) return;
    const boundBookId = sessions.find((session) => session.id === indexSessionId)?.worldbook_id;
    if (!boundBookId) { setIndexSessionId(null); return; }
    setSelectedId(boundBookId);
    setWorldbookTab("index");
  }, [indexSessionId, sessions, setIndexSessionId, setWorldbookTab]);
  useEffect(() => { setDetail(null); void loadDetail(selectedId); setExpanded(new Set()); setEditingUid(null); setEntryDraft(null); }, [selectedId, loadDetail]);

  useEffect(() => {
    if (worldbookJumpId) { setSelectedId(worldbookJumpId); setWorldbookTab("entries"); setWorldbookJumpId(null); }
  }, [worldbookJumpId, setWorldbookJumpId, setWorldbookTab]);
  useEffect(() => {
    if (worldbookScopeJumpId) { setSelectedId(worldbookScopeJumpId); setWorldbookTab("entries"); setWorldbookScopeJumpId(null); }
  }, [worldbookScopeJumpId, setWorldbookScopeJumpId, setWorldbookTab]);
  // 节点图入口（战斗页「编辑此节点」）：定位该书并直接落到「节点图」页签
  useEffect(() => {
    if (!worldbookGraphJumpId) return;
    setSelectedId(worldbookGraphJumpId);
    setWorldbookTab("graph");
    setWorldbookGraphJumpId(null);
  }, [worldbookGraphJumpId, setWorldbookGraphJumpId, setWorldbookTab]);

  // 统一检索（迁自原「内容中心」顶栏）：250ms 防抖跨全部世界书查条目，序号过时响应丢弃
  useEffect(() => {
    const term = shelfQuery.trim();
    if (!term) { setShelfHits([]); setShelfOpen(false); setShelfSearching(false); return; }
    const seq = ++shelfSeq.current;
    setShelfSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.searchWorldbooks(term, 8);
        if (seq !== shelfSeq.current) return;
        setShelfHits(result.results || []);
        setShelfOpen(true);
      } catch {
        if (seq === shelfSeq.current) setShelfHits([]);
      } finally {
        if (seq === shelfSeq.current) setShelfSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [shelfQuery, api]);

  /** 命中 → 选中该书 + 条目页签 + 把检索词预填进条目筛选（原内容中心同款联动） */
  const jumpToHit = (bookId: string) => {
    setSelectedId(bookId);
    setWorldbookTab("entries");
    setQuery(shelfQuery.trim());
    setShelfQuery("");
    setShelfHits([]);
    setShelfOpen(false);
  };
  useEffect(() => {
    if (!worldbookEntryJump || detail?.id !== worldbookEntryJump.bookId) return;
    const entry = detail.entries.find((item) => item.uid === worldbookEntryJump.entryUid);
    if (entry) {
      setExpanded((value) => new Set(value).add(entry.uid));
      setEditingUid(entry.uid);
      setEntryDraft(draftCache.current.get(`${detail.id}:${entry.uid}`) || entryToDraft(entry));
    }
    setWorldbookEntryJump(null);
  }, [detail, setWorldbookEntryJump, worldbookEntryJump]);

  const effectiveTab = normalizeWorldbookTab(worldbookTab, detail);
  const visibleTabs = visibleWorldbookTabs(detail);
  const { draft: configDraft, patch, adoptV3, dirty: configDirty, saving: configSaving,
    save: saveConfig, undo: undoConfig, error: configError, conflict: configConflict } = useWorldbookDraft(detail);
  const { preview, loading: previewing, error: previewError } = useScopePreview(
    detail?.id || "", detail?.updated_at, configDraft, [], [], !!detail && !isReference(detail));
  const panelProps: WorldBookPanelProps | null = detail && configDraft ? {
    detail, draft: configDraft, patch, adoptV3, dirty: configDirty, saving: configSaving,
    save: async () => { await saveConfig(); }, undo: undoConfig, saveError: configError,
    conflict: configConflict, preview, previewing, previewError, roster: [], setRoster: () => undefined,
  } : null;

  const orderedEntries = useMemo(() => {
    if (!detail) return [];
    const byUid = new Map(detail.entries.map((entry) => [entry.uid, entry]));
    const order = detail.entry_order?.length ? detail.entry_order : detail.entries.map((entry) => entry.uid);
    const result = order.map((uid) => byUid.get(uid)).filter(Boolean) as WorldBookEntryDTO[];
    if (detail.has_explicit_entry_order) result.sort((left, right) => {
      // 展示顺序按层分组：稳定层 → 动态层 → 系统层。系统层条目（节点图 / 节点绑定）
      // 不是叙事内容，排在最后不干扰阅读；持久化的 entry_order 不受影响。
      const rank: Record<WorldBookEntryLayer, number> = { stable: 0, dynamic: 1, system: 2 };
      const leftLayer = rank[entryLayer(left)];
      const rightLayer = rank[entryLayer(right)];
      return leftLayer - rightLayer || order.indexOf(left.uid) - order.indexOf(right.uid);
    });
    return result;
  }, [detail]);
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byLayer = layerFilter === "all"
      ? orderedEntries
      : orderedEntries.filter((entry) => entryLayer(entry) === layerFilter);
    if (!needle) return byLayer;
    return byLayer.filter((entry) => [entry.name, entry.content, ...(entry.trigger_keys || [])]
      .some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
  }, [orderedEntries, query, layerFilter]);
  /**
   * 实时统计：勾选 / 取消勾选、改正文都直接改 `detail.entries`，所以这里立刻跟着变。
   * 口径与后端 `book_entry_stats` 一致 —— 停用条目与系统层条目都不计入「条目 / token」。
   */
  const liveStats = useMemo(() => bookEntryStats(detail?.entries), [detail]);
  const layerCounts = useMemo(() => {
    const counts: Record<WorldBookEntryLayer, number> = { stable: 0, dynamic: 0, system: 0 };
    for (const entry of orderedEntries) counts[entryLayer(entry)] += 1;
    return counts;
  }, [orderedEntries]);
  const visibleBooks = useMemo(() => filterBooksByType(books, listFilter), [books, listFilter]);
  const storyBooks = useMemo(() => books.filter((book) => !isReference(book)), [books]);

  const updateLocalEntry = useCallback((bookId: string, entry: WorldBookEntryDTO) => {
    if (selectedRef.current !== bookId) return;
    setDetail((current) => current?.id === bookId ? {
      ...current,
      entries: current.entries.some((item) => item.uid === entry.uid)
        ? current.entries.map((item) => item.uid === entry.uid ? entry : item)
        : [...current.entries, entry],
      entry_count: current.entries.some((item) => item.uid === entry.uid)
        ? current.entry_count : current.entry_count + 1,
      entry_order: current.entry_order?.includes(entry.uid)
        ? current.entry_order : [...(current.entry_order || []), entry.uid],
    } : current);
  }, []);

  useEffect(() => {
    const listener = (event: SharedSaveEvent) => {
      if ((generations.current.get(event.key) || 0) !== event.generation) return;
      if (event.status === "error") {
        if (selectedRef.current === event.bookId) setSavePhase({ state: "error", message: event.message });
        return;
      }
      revisions.current.set(event.bookId, event.editRevision);
      if (selectedRef.current !== event.bookId) return;
      if (event.kind === "entry") {
        updateLocalEntry(event.bookId, event.entry);
        if (editingUidRef.current === event.entry.uid && !draftCache.current.has(event.key)) {
          setEntryDraft(entryToDraft(event.entry));
        }
      } else if (event.kind === "meta") {
        setBooks((current) => current.map((book) => book.id === event.bookId ? { ...book, ...event.book } : book));
        setDetail((current) => current?.id === event.bookId ? { ...current,
          name: event.book.name, description: event.book.description,
          cover_image: event.book.cover_image, edit_revision: event.editRevision } : current);
        if (!metaCache.current.has(event.bookId)) {
          setBookName(event.book.name); setBookDescription(event.book.description || "");
          setBookCover(event.book.cover_image || "");
        }
      } else if (event.kind === "order") {
        setDetail((current) => current?.id === event.bookId ? { ...current,
          entry_order: event.order, has_explicit_entry_order: true, edit_revision: event.editRevision } : current);
      } else {
        setDetail((current) => current?.id === event.bookId ? { ...current,
          entries: current.entries.filter((entry) => entry.uid !== event.uid),
          entry_count: current.entries.filter((entry) => entry.uid !== event.uid).length,
          entry_order: current.entry_order?.filter((uid) => uid !== event.uid),
          edit_revision: event.editRevision } : current);
      }
      setSavePhase(retryTasks.current.size
        ? { state: "error", message: `仍有 ${retryTasks.current.size} 项保存失败` }
        : { state: "saved", message: event.kind === "order" ? "排序已保存" : "已自动保存" });
      void loadDetail(event.bookId);
    };
    SHARED_SAVE_LISTENERS.add(listener);
    return () => { SHARED_SAVE_LISTENERS.delete(listener); };
  }, [loadDetail, updateLocalEntry]);

  const performEntrySave = useCallback((bookId: string, uid: string, draft: EntryDraft, generation: number) => {
    if (!draft.content.trim()) {
      setSavePhase({ state: "error", message: "正文不能为空，草稿已保留" });
      return;
    }
    setSavePhase({ state: "saving" });
    const taskKey = `${bookId}:${uid}`;
    inFlightEntries.current.add(taskKey);
    const run = () => enqueue(bookId, async (revision) => {
      if (deletedEntries.current.has(taskKey)) return null;
      const alreadyPersisted = persistedUids.current.has(taskKey);
      const payload = { ...draftToEntry(draft, !alreadyPersisted), expected_revision: revision };
      const result = alreadyPersisted
        ? await api.updateWorldbookEntry(bookId, uid, payload)
        : await api.createWorldbookEntry(bookId, { ...payload, uid });
      if (!result) return null;
      persistedUids.current.add(taskKey);
      revisions.current.set(bookId, result.edit_revision);
      if (deletedEntries.current.has(taskKey)) return result;
      const latest = generations.current.get(`${bookId}:${uid}`) || generation;
      if (latest === generation) {
        draftCache.current.delete(taskKey);
        updateLocalEntry(bookId, result.entry);
        markTaskSuccess(taskKey, generation, "已自动保存");
        publishSaveEvent({ status: "success", kind: "entry", bookId, key: taskKey, generation,
          editRevision: result.edit_revision, entry: result.entry });
      }
      void loadBooks();
      return result;
    });
    return run().catch((reason: any) => {
      if (deletedEntries.current.has(taskKey)) return undefined;
      setSavePhase({ state: "error", message: reason?.message || "自动保存失败，草稿已保留" });
      retryTasks.current.set(taskKey, () => {
        void api.getWorldbook(bookId).then((fresh) => {
          revisions.current.set(bookId, fresh.edit_revision || 0);
          if (fresh.entries.some((entry) => entry.uid === uid)) persistedUids.current.add(taskKey);
          void performEntrySave(bookId, uid, draftCache.current.get(`${bookId}:${uid}`) || draft,
            generations.current.get(`${bookId}:${uid}`) || generation)?.catch(() => undefined);
        }).catch((failure: any) => setSavePhase({ state: "error", message: failure?.message || "重试失败" }));
      });
      if ((generations.current.get(taskKey) || 0) === generation) publishSaveEvent({
        status: "error", kind: "entry", bookId, key: taskKey, generation,
        message: reason?.message || "自动保存失败，草稿已保留",
      });
      throw reason;
    }).finally(() => { inFlightEntries.current.delete(taskKey); });
  }, [api, enqueue, loadBooks, markTaskSuccess, updateLocalEntry]);

  const scheduleEntrySave = useCallback((bookId: string, uid: string, draft: EntryDraft) => {
    const key = `${bookId}:${uid}`;
    draftCache.current.set(key, draft);
    const generation = (generations.current.get(key) || 0) + 1;
    generations.current.set(key, generation);
    writeStoredTask(key, { bookId, uid, kind: "entry", generation, payload: draft });
    const oldTimer = entryTimers.current.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    setSavePhase({ state: "waiting", message: "等待自动保存…" });
    entryTimers.current.set(key, setTimeout(() => {
      entryTimers.current.delete(key);
      void performEntrySave(bookId, uid, draftCache.current.get(key) || draft, generation)?.catch(() => undefined);
    }, 650));
  }, [performEntrySave]);

  const changeDraft = (changes: Partial<EntryDraft>) => {
    if (!detail || !editingUid || !entryDraft) return;
    const next = { ...entryDraft, ...changes,
      changedFields: [...new Set([...entryDraft.changedFields, ...Object.keys(changes).filter((key) => key !== "changedFields")])] };
    setEntryDraft(next);
    const current = detail.entries.find((entry) => entry.uid === editingUid);
    if (current) updateLocalEntry(detail.id, { ...current, ...draftToEntry(next, false) });
    scheduleEntrySave(detail.id, editingUid, next);
  };

  const performMetaSave = useCallback((bookId: string,
    next: { name: string; description: string; cover: string }, generation: number) => {
    const key = `${bookId}:meta`;
    setSavePhase({ state: "saving" });
    return enqueue(bookId, async (revision) => {
      const result = await api.updateWorldbook(bookId, {
        name: next.name, description: next.description, cover_image: next.cover,
        expected_revision: revision,
      });
      revisions.current.set(bookId, result.book.edit_revision || revision + 1);
      if ((generations.current.get(key) || 0) === generation) {
        markTaskSuccess(key, generation, "已自动保存");
        metaCache.current.delete(bookId);
        setBooks((current) => current.map((book) => book.id === bookId ? {
          ...book, name: result.book.name, description: result.book.description,
          cover_image: result.book.cover_image, edit_revision: result.book.edit_revision,
        } : book));
        if (selectedRef.current === bookId) setDetail((current) => current ? {
          ...current, name: result.book.name, description: result.book.description,
          cover_image: result.book.cover_image, edit_revision: result.book.edit_revision,
        } : current);
        publishSaveEvent({ status: "success", kind: "meta", bookId, key, generation,
          editRevision: result.book.edit_revision || revision + 1, book: result.book });
      }
      return result;
    }).catch((reason: any) => {
      setSavePhase({ state: "error", message: reason?.message || "自动保存失败，草稿已保留" });
      retryTasks.current.set(key, () => {
        void api.getWorldbook(bookId).then((fresh) => {
          revisions.current.set(bookId, fresh.edit_revision || 0);
          return performMetaSave(bookId, metaCache.current.get(bookId) || next,
            generations.current.get(key) || generation);
        }).catch(() => undefined);
      });
      if ((generations.current.get(key) || 0) === generation) publishSaveEvent({
        status: "error", kind: "meta", bookId, key, generation,
        message: reason?.message || "自动保存失败，草稿已保留",
      });
      throw reason;
    });
  }, [api, enqueue, markTaskSuccess]);

  const scheduleMetaSave = useCallback((bookId: string, next: { name: string; description: string; cover: string }) => {
    metaCache.current.set(bookId, next);
    const key = `${bookId}:meta`;
    const generation = (generations.current.get(key) || 0) + 1;
    generations.current.set(key, generation);
    writeStoredTask(key, { bookId, kind: "meta", generation, payload: next });
    const previous = metaTimers.current.get(bookId);
    if (previous) clearTimeout(previous);
    setSavePhase({ state: "waiting", message: "等待自动保存…" });
    metaTimers.current.set(bookId, setTimeout(() => {
      metaTimers.current.delete(bookId);
      void performMetaSave(bookId, metaCache.current.get(bookId) || next, generation).catch(() => undefined);
    }, 700));
  }, [performMetaSave]);

  useEffect(() => {
    if (restoreRetriesWired.current) return;
    restoreRetriesWired.current = true;
    const tasks = readStoredTasks();
    for (const [key, task] of Object.entries(tasks)) {
      retryTasks.current.set(key, () => {
        void api.getWorldbook(task.bookId).then((fresh) => {
          revisions.current.set(task.bookId, fresh.edit_revision || 0);
          for (const entry of fresh.entries) persistedUids.current.add(`${task.bookId}:${entry.uid}`);
          if (task.kind === "entry" && task.uid) {
            const latest = draftCache.current.get(key) || task.payload as EntryDraft;
            void performEntrySave(task.bookId, task.uid, latest,
              generations.current.get(key) || task.generation)?.catch(() => undefined);
          } else if (task.kind === "meta") {
            const latest = metaCache.current.get(task.bookId)
              || task.payload as { name: string; description: string; cover: string };
            void performMetaSave(task.bookId, latest,
              generations.current.get(key) || task.generation).catch(() => undefined);
          }
        }).catch((reason: any) => setSavePhase({ state: "error", message: reason?.message || "恢复保存失败" }));
      });
    }
    if (Object.keys(tasks).length) setSavePhase({ state: "error", message: `有 ${Object.keys(tasks).length} 项修改等待重试` });
  }, [api, performEntrySave, performMetaSave]);

  const changeMeta = (field: "name" | "description" | "cover", value: string) => {
    if (!detail) return;
    const next = { name: bookName, description: bookDescription, cover: bookCover, [field]: value };
    if (field === "name") setBookName(value);
    if (field === "description") setBookDescription(value);
    if (field === "cover") setBookCover(value);
    scheduleMetaSave(detail.id, next);
  };

  const flushOnUnmount = useRef<() => void>(() => undefined);
  flushOnUnmount.current = () => {
    // Flush the latest in-memory drafts on unmount. Queues remain serialized even
    // after the component disappears; failures stay in the per-book caches.
    for (const [bookId, timer] of metaTimers.current) {
      clearTimeout(timer);
      const cached = metaCache.current.get(bookId);
      if (cached) void performMetaSave(bookId, cached, generations.current.get(`${bookId}:meta`) || 1).catch(() => undefined);
    }
    for (const [key, timer] of entryTimers.current) {
      clearTimeout(timer);
      const draft = draftCache.current.get(key);
      const split = key.indexOf(":");
      if (draft && split > 0) void performEntrySave(key.slice(0, split), key.slice(split + 1), draft,
        generations.current.get(key) || 1)?.catch(() => undefined);
    }
  };
  useEffect(() => () => flushOnUnmount.current(), []);

  const flushBook = useCallback(async (bookId: string) => {
    const pending: Array<Promise<unknown>> = [];
    const metaTimer = metaTimers.current.get(bookId);
    if (metaTimer) {
      clearTimeout(metaTimer); metaTimers.current.delete(bookId);
      const latest = metaCache.current.get(bookId);
      if (latest) pending.push(performMetaSave(bookId, latest,
        generations.current.get(`${bookId}:meta`) || 1));
    }
    for (const [key, timer] of [...entryTimers.current]) {
      if (!key.startsWith(`${bookId}:`)) continue;
      clearTimeout(timer); entryTimers.current.delete(key);
      const uid = key.slice(bookId.length + 1); const draft = draftCache.current.get(key);
      if (draft) {
        const result = performEntrySave(bookId, uid, draft, generations.current.get(key) || 1);
        if (result) pending.push(result);
      }
    }
    const results = await Promise.allSettled(pending);
    const queued = queues.current.get(bookId);
    if (queued) await queued.catch(() => undefined);
    const stored = Object.values(readStoredTasks()).some((task) => task.bookId === bookId);
    if (results.some((item) => item.status === "rejected") || stored
      || [...retryTasks.current.keys()].some((key) => key.startsWith(`${bookId}:`))) {
      throw new Error("仍有修改尚未保存，请重试成功后再继续");
    }
  }, [performEntrySave, performMetaSave]);

  const clearBookTasks = useCallback((bookId: string, uid?: string) => {
    const prefix = uid ? `${bookId}:${uid}` : `${bookId}:`;
    const matches = (key: string) => uid ? key === prefix : key.startsWith(prefix);
    for (const [key, timer] of [...entryTimers.current]) if (matches(key)) {
      clearTimeout(timer); entryTimers.current.delete(key); draftCache.current.delete(key);
      retryTasks.current.delete(key); writeStoredTask(key, null);
    }
    if (uid) {
      draftCache.current.delete(prefix); retryTasks.current.delete(prefix); writeStoredTask(prefix, null);
    }
    if (!uid) {
      const timer = metaTimers.current.get(bookId); if (timer) clearTimeout(timer);
      metaTimers.current.delete(bookId); metaCache.current.delete(bookId);
      for (const key of [...retryTasks.current.keys()]) if (matches(key)) retryTasks.current.delete(key);
      for (const key of Object.keys(readStoredTasks())) if (matches(key)) writeStoredTask(key, null);
    }
  }, []);

  const createBook = async () => {
    if (!newName.trim()) { setCreateError("请填写世界书名称"); return; }
    setCreating(true);
    try {
      const result = await api.createWorldbook(newName.trim(), 0, newType, {
        description: newDescription, cover_image: newCover,
      });
      setCreateOpen(false); setCreateError(""); setNewName(""); setNewDescription(""); setNewCover("");
      await loadBooks(); setSelectedId(result.book.id); showToast("世界书已创建");
    } catch (reason: any) { setCreateError(reason?.message || "创建失败"); }
    finally { setCreating(false); }
  };

  const closeCreate = useCallback(() => {
    setCreateOpen(false); setCreateError("");
    window.setTimeout(() => createButton.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!createOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !creating) closeCreate(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeCreate, createOpen, creating]);

  const importFile = async (file: File) => {
    try {
      const result = await api.importWorldbookFile(file.name.replace(/\.[^.]+$/, ""), file, newType);
      await loadBooks(); setSelectedId(result.book.id); showToast(`已导入 ${result.report.imported} 条`);
    } catch (reason: any) { setError(reason?.message || "导入失败"); }
  };

  const exportBook = async () => {
    if (!detail) return;
    try {
      await flushBook(detail.id);
      const result = await api.exportWorldbook(detail.id);
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${result.name || "worldbook"}.json`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason: any) { setError(reason?.message || "导出失败：最新修改尚未保存"); }
  };

  const deleteBook = async () => {
    if (!detail || !window.confirm(`确定删除《${detail.name}》吗？`)) return;
    try {
      clearBookTasks(detail.id);
      const queued = queues.current.get(detail.id); if (queued) await queued.catch(() => undefined);
      await api.deleteWorldbook(detail.id); setSelectedId(null); setDetail(null); await loadBooks();
    }
    catch (reason: any) { setError(reason?.message || "删除失败"); }
  };

  const updateBookOption = async (changes: { enabled?: boolean; book_type?: WorldBookType }) => {
    if (!detail) return;
    try {
      await flushBook(detail.id);
      const result = await enqueue(detail.id, (revision) => api.updateWorldbook(detail.id,
        { ...changes, expected_revision: revision }));
      revisions.current.set(detail.id, result.book.edit_revision || 0);
      await loadBooks(); await loadDetail(detail.id);
    } catch (reason: any) { setError(reason?.message || "更新世界书失败"); }
  };

  const reinstallBook = async () => {
    if (!detail || !window.confirm("从整合包恢复会覆盖当前内容，确定继续？")) return;
    try { await flushBook(detail.id); await api.reinstallWorldbook(detail.id); await loadBooks(); await loadDetail(detail.id); }
    catch (reason: any) { setError(reason?.message || "重装失败"); }
  };

  const importPastedJson = async () => {
    if (!pasteJson.trim()) return;
    try {
      const parsed = JSON.parse(pasteJson);
      const result = await api.importWorldbookJson("粘贴导入的世界书", parsed, newType);
      if (!result.book) throw new Error("导入结果缺少世界书");
      setPasteJson(""); await loadBooks(); setSelectedId(result.book.id); showToast("粘贴内容已导入");
    } catch (reason: any) { setError(reason?.message || "粘贴内容不是可导入的 JSON"); }
  };

  const createEntry = () => {
    if (!detail) return;
    const entry: WorldBookEntryDTO = {
      uid: `entry-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, name: "新条目", content: "", trigger_keys: [], secondary_keys: [],
      always_active: true, selective: true, enabled: true, position: 0, depth: 4,
      scan_depth: 4, probability: 100, group: "", group_weight: 100,
      case_sensitive: false, match_whole_words: false, category_id: "unclassified", raw: {},
    };
    setExpanded((value) => new Set(value).add(entry.uid));
    setEditingUid(entry.uid); setEntryDraft(entryToDraft(entry));
    setDetail({ ...detail, entries: [...detail.entries, entry], entry_count: detail.entry_count + 1,
      entry_order: [...(detail.entry_order || detail.entries.map((item) => item.uid)), entry.uid] });
  };

  const deleteEntry = async (entry: WorldBookEntryDTO) => {
    if (!detail || !window.confirm(`删除条目「${entry.name || entry.uid}」？`)) return;
    const taskKey = `${detail.id}:${entry.uid}`;
    const generation = (generations.current.get(taskKey) || 0) + 1;
    generations.current.set(taskKey, generation);
    deletedEntries.current.add(taskKey);
    const timer = entryTimers.current.get(taskKey); if (timer) clearTimeout(timer);
    entryTimers.current.delete(taskKey); draftCache.current.delete(taskKey);
    retryTasks.current.delete(taskKey); writeStoredTask(taskKey, null);
    setDetail({ ...detail, entries: detail.entries.filter((item) => item.uid !== entry.uid),
      entry_count: Math.max(0, detail.entry_count - 1), entry_order: detail.entry_order?.filter((uid) => uid !== entry.uid) });
    const bookId = detail.id;
    const attemptDelete = async (): Promise<void> => {
      try {
        const after = await enqueue(bookId, async () => {
        const fresh = await api.getWorldbook(detail.id);
        if (fresh.entries.some((item) => item.uid === entry.uid)) {
          await api.deleteWorldbookEntry(detail.id, entry.uid);
        }
        const after = await api.getWorldbook(detail.id);
        revisions.current.set(detail.id, after.edit_revision || 0);
        persistedUids.current.delete(taskKey);
        return after;
        });
        if ((generations.current.get(taskKey) || 0) !== generation) return;
        retryTasks.current.delete(taskKey); deletedEntries.current.delete(taskKey);
        publishSaveEvent({ status: "success", kind: "delete", bookId, key: taskKey, generation,
          editRevision: after.edit_revision || revisions.current.get(bookId) || 0, uid: entry.uid });
        await loadBooks(); showToast("条目已删除");
      } catch (reason: any) {
        const message = reason?.message || "删除失败，条目仍保持待删除状态";
        retryTasks.current.set(taskKey, () => { void attemptDelete(); });
        setSavePhase({ state: "error", message });
        publishSaveEvent({ status: "error", kind: "delete", bookId, key: taskKey, generation, message });
      }
    };
    await attemptDelete();
  };

  const toggleEntry = (entry: WorldBookEntryDTO) => {
    if (!detail) return;
    const cached = draftCache.current.get(`${detail.id}:${entry.uid}`);
    const base = cached || entryToDraft(entry);
    const draft = { ...base, enabled: !entry.enabled,
      changedFields: [...new Set([...base.changedFields, "enabled"])] };
    updateLocalEntry(detail.id, { ...entry, enabled: draft.enabled });
    if (editingUid === entry.uid) setEntryDraft(draft);
    scheduleEntrySave(detail.id, entry.uid, draft);
  };

  const persistOrder = useCallback((bookId: string, order: string[], requestedGeneration?: number) => {
    const key = `${bookId}:order`;
    const generation = requestedGeneration ?? ((generations.current.get(key) || 0) + 1);
    generations.current.set(key, generation);
    pendingOrders.current.set(bookId, order);
    writeStoredTask(key, { bookId, kind: "order", generation, payload: order });
    setSavePhase({ state: "saving", message: "正在保存排序…" });
    enqueue(bookId, async (revision) => {
      const result = await api.reorderWorldbookEntries(bookId, order, revision);
      revisions.current.set(bookId, result.edit_revision);
      if ((generations.current.get(key) || 0) === generation) {
        pendingOrders.current.delete(bookId);
        markTaskSuccess(key, generation, "排序已保存");
        if (selectedRef.current === bookId) setDetail((current) => current ? { ...current,
          entry_order: result.entry_order, has_explicit_entry_order: true, edit_revision: result.edit_revision } : current);
        publishSaveEvent({ status: "success", kind: "order", bookId, key, generation,
          editRevision: result.edit_revision, order: result.entry_order });
      }
      return result;
    }).catch((reason: any) => {
      setSavePhase({ state: "error", message: reason?.message || "排序保存失败，当前顺序已保留" });
      retryTasks.current.set(key, () => {
        void api.getWorldbook(bookId).then((fresh) => {
          revisions.current.set(bookId, fresh.edit_revision || 0);
          const pending = pendingOrders.current.get(bookId);
          if (pending) persistOrder(bookId, pending, generations.current.get(key) || generation);
        });
      });
      if ((generations.current.get(key) || 0) === generation) publishSaveEvent({
        status: "error", kind: "order", bookId, key, generation,
        message: reason?.message || "排序保存失败，当前顺序已保留",
      });
    });
  }, [api, enqueue, markTaskSuccess]);

  useEffect(() => {
    if (orderRetriesWired.current) return;
    orderRetriesWired.current = true;
    for (const [key, task] of Object.entries(readStoredTasks())) {
      if (task.kind !== "order") continue;
      retryTasks.current.set(key, () => {
        void api.getWorldbook(task.bookId).then((fresh) => {
          revisions.current.set(task.bookId, fresh.edit_revision || 0);
          persistOrder(task.bookId, pendingOrders.current.get(task.bookId) || task.payload as string[],
            generations.current.get(key) || task.generation);
        });
      });
    }
  }, [api, persistOrder]);

  const reorder = (targetUid: string) => {
    if (!detail || !dragUid || dragUid === targetUid || query.trim() || layerFilter !== "all") return;
    const source = detail.entries.find((entry) => entry.uid === dragUid);
    const target = detail.entries.find((entry) => entry.uid === targetUid);
    if (!source || !target) return;
    if (entryLayer(source) !== entryLayer(target)) {
      showToast(source && entryLayer(source) === "system"
        ? "系统层条目（节点图 / 节点绑定）不参与注入，只能在系统层内部排序。"
        : "稳定层与动态层属于不同插入位置，只能在同层内拖动排序。");
      setDragUid(null); return;
    }
    const previous = [...(detail.entry_order || orderedEntries.map((entry) => entry.uid))];
    const next = previous.filter((uid) => uid !== dragUid);
    next.splice(next.indexOf(targetUid), 0, dragUid);
    setDetail({ ...detail, entry_order: next, has_explicit_entry_order: true }); setDragUid(null);
    persistOrder(detail.id, next);
  };

  const searchLibrary = async () => {
    if (!libraryQuery.trim()) return;
    setLibraryBusy(true);
    try { const result = await api.searchWorldbooks(libraryQuery.trim(), 40, "reference"); setLibraryResults(result.results); }
    catch (reason: any) { setError(reason?.message || "资料库检索失败"); }
    finally { setLibraryBusy(false); }
  };
  const excerpt = async (bookId: string, entry: WorldBookEntryDTO) => {
    const target = !isReference(detail) ? detail?.id : targetBookId || storyBooks[0]?.id;
    if (!target) { setError("请先选择一本剧情世界书作为摘录目标"); return; }
    try {
      await api.excerptWorldbookEntries(target, [{ source_book_id: bookId, source_entry_uid: entry.uid }]);
      if (selectedId === target) await loadDetail(target); await loadBooks(); showToast("已加入剧情世界书");
    } catch (reason: any) { setError(reason?.message || "摘录失败"); }
  };

  return <main className={"wber-shell" + (effectiveTab === "graph" ? " is-graph" : "")}>
    <aside className="wber-shelf" aria-label="世界书书架">
      <header className="wber-shelf-head">
        <div><span className="wber-eyebrow">LORE LIBRARY</span><h2>世界书</h2></div>
        <div className="wber-head-actions">
          <button ref={createButton} type="button" className="is-primary" onClick={() => { setCreateError(""); setCreateOpen(true); }}><AppIcon name="book" size={14} />新建</button>
          <button type="button" onClick={() => fileInput.current?.click()}><AppIcon name="upload" size={14} />导入</button>
        </div>
      </header>
      <input ref={fileInput} className="wber-hidden" type="file" accept=".json,.jsonl,.txt,.png"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
      <nav className="wber-filters" aria-label="书架筛选">
        {(["all", "story", "reference"] as BookTypeFilter[]).map((value) => <button key={value}
          aria-pressed={listFilter === value} onClick={() => setListFilter(value)}>
          {value === "all" ? "全部" : value === "story" ? "剧情" : "资料"}
        </button>)}
      </nav>
      {/* 统一检索：跨全部世界书查条目，命中直接选中该书（原「内容中心」顶栏搜索的迁入位置） */}
      <div className="wber-shelf-search">
        <label className="wber-search"><AppIcon name="search" size={14} />
          <input value={shelfQuery} placeholder="搜索全部世界书条目" aria-label="跨世界书检索"
            onChange={(event) => setShelfQuery(event.target.value)}
            onFocus={() => { if (shelfQuery.trim()) setShelfOpen(true); }}
            onBlur={() => window.setTimeout(() => setShelfOpen(false), 180)} /></label>
        {shelfSearching && <span className="wber-shelf-search-state" role="status">…</span>}
        {shelfOpen && shelfQuery.trim() && <div className="wber-shelf-hits">
          {shelfHits.length > 0 ? shelfHits.map((hit) => <button type="button" key={hit.book.id}
            onClick={() => jumpToHit(hit.book.id)} title={`${hit.book.name} · ${hit.match_count} 条命中`}>
            <span className="wber-shelf-hit-name">{hit.book.name}</span>
            <span className="wber-shelf-hit-count">{hit.match_count} 条命中</span>
          </button>) : !shelfSearching && <p className="wber-shelf-hit-empty">无匹配结果</p>}
        </div>}
      </div>
      <div className="wber-book-list">
        {visibleBooks.map((book) => {
          const cover = safeCover(book.cover_image);
          // 选中的书用实时统计（勾选后立刻变），其余书用服务端摘要里的同口径字段。
          const stats = book.id === detail?.id ? liveStats : summaryEntryStats(book);
          return <button type="button" className="wber-book" data-active={selectedId === book.id}
            key={book.id} onClick={() => setSelectedId(book.id)}
            title={stats.system
              ? `${book.name}（${stats.injectable} 条注入 + ${stats.system} 条系统层）`
              : book.name}>
            <span className="wber-book-cover">{cover ? <img src={cover} alt="" /> : <span>{book.name.slice(0, 1) || "书"}</span>}</span>
            <span className="wber-book-copy"><strong>{book.name}</strong><small>
              {stats.injectable} 条 · 约 {stats.tokens} token
              {!!stats.system && <em className="wber-book-system">系统 {stats.system}</em>}
            </small></span>
          </button>;
        })}
        {!visibleBooks.length && <p className="wber-empty">书架还是空的。新建一本，或导入已有世界书。</p>}
      </div>
    </aside>

    <section className={"wber-main" + (effectiveTab === "graph" ? " is-graph" : "")}>
      {createOpen && <div className="wber-create" role="dialog" aria-label="新建世界书">
        <div className="wber-create-card">
          <h3>新建世界书</h3><p>先建立书籍资料，创建后即可添加条目。</p>
          <label>名称<input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
          <label>简介<textarea rows={3} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} /></label>
          <div className="wber-create-cover">
            <span className="wber-field-label">封面</span>
            <CoverPicker value={newCover} onChange={setNewCover} emptyLabel="选择本地图片" />
          </div>
          <div className="wber-type-choice">{(["story", "reference"] as WorldBookType[]).map((value) => <button
            type="button" key={value} aria-pressed={newType === value} onClick={() => setNewType(value)}>{BOOK_TYPE_LABELS[value]}</button>)}</div>
          {createError && <div className="wber-alert" role="alert">{createError}</div>}
          <div className="wber-dialog-actions"><button type="button" className="is-ghost" onClick={closeCreate}>取消</button>
            <button type="button" className="is-primary" disabled={creating} onClick={() => void createBook()}>{creating ? "创建中…" : "创建"}</button></div>
        </div>
      </div>}

      {!detail && <div className="wber-blank">{loading ? "正在读取…" : "从左侧书架选一本世界书"}</div>}
      {detail && <>
        <section className="wber-hero">
          <div className="wber-hero-cover">
            {safeCover(bookCover) ? <img src={safeCover(bookCover)} alt={`${bookName} 封面`} /> : <span>{bookName.slice(0, 1) || "书"}</span>}
            {/* 封面直接可换：点封面上这颗按钮就是从本地选图，压缩后随书保存与导出。 */}
            <CoverPicker variant="overlay" value={bookCover}
              onChange={(next) => changeMeta("cover", next)} onNotice={showToast} />
          </div>
          <div className="wber-hero-content">
            <span className="wber-eyebrow">{BOOK_TYPE_LABELS[bookTypeOf(detail)]}</span>
            {editingMeta ? <div className="wber-meta-editor">
              <input className="wber-title-input" value={bookName} aria-label="世界书名称" onChange={(event) => changeMeta("name", event.target.value)} />
              <textarea className="wber-description" rows={2} value={bookDescription} aria-label="世界书简介"
                placeholder="写一段简短介绍…" onChange={(event) => changeMeta("description", event.target.value)} />
              <CoverPicker value={bookCover} onChange={(next) => changeMeta("cover", next)}
                onNotice={showToast} emptyLabel="选择本地封面图片" />
              <button type="button" className="is-sm is-primary" onClick={() => setEditingMeta(false)}>完成</button>
            </div> : <div className="wber-meta-reading">
              <h1 title={bookName}>{bookName}</h1>
              <p>{bookDescription || "还没有简介。"}</p>
              <button type="button" className="is-sm is-ghost" onClick={() => setEditingMeta(true)}>编辑介绍</button>
            </div>}
            {/* 统计口径：条目 / token 只算**启用的非系统条目**，勾选后立刻变。 */}
            <div className="wber-stats">
              <span title="会注入的条目：已启用且不属于系统层"><b>{liveStats.injectable}</b> 条目
                {liveStats.total !== liveStats.injectable && <small> / 共 {liveStats.total}</small>}</span>
              <span title="启用条目的展示估算，勾选 / 取消勾选会立刻变化"><b>约 {liveStats.tokens}</b> token</span>
              {!!liveStats.disabled && <span className="is-muted" title="已停用：不注入，也不计入条目与 token">
                {liveStats.disabled} 条已停用</span>}
              {!!liveStats.system && <span className="is-system"
                title="系统层：节点图 / 节点绑定。只服务画布与系统判定，永不注入，也不计入 token">
                {liveStats.system} 条系统层</span>}
              <span className={`wber-save is-${savePhase.state}`}>{savePhase.message || "已同步"}</span>
              {savePhase.state === "error" && <button type="button" className="is-sm" onClick={() => {
                for (const retry of retryTasks.current.values()) retry();
              }}><AppIcon name="refresh" size={13} />重试</button>}</div>
          </div>
          <div className="wber-hero-actions"><button type="button" onClick={() => void exportBook()}><AppIcon name="download" size={14} />导出</button>
            <details className="wber-more"><summary>更多<AppIcon name="expand" size={14} /></summary><div>
              {!isReference(detail) && <button type="button" onClick={() => void updateBookOption({ enabled: !detail.enabled })}>{detail.enabled ? "停用整书" : "启用整书"}</button>}
              <button type="button" onClick={() => void updateBookOption({ book_type: isReference(detail) ? "story" : "reference" })}>
                {isReference(detail) ? "改为剧情世界书" : "移入资料库"}</button>
              {detail.is_preinstalled && <button type="button" onClick={() => void reinstallBook()}>重装整合包</button>}
              <button type="button" className="is-danger" onClick={() => void deleteBook()}><AppIcon name="trash" size={14} />删除</button>
            </div></details></div>
        </section>

        <nav className="wber-tabs" aria-label="世界书工作台页签">{visibleTabs.map((tab) => <button type="button" key={tab.id}
          aria-pressed={effectiveTab === tab.id} title={tab.hint} onClick={() => setWorldbookTab(tab.id)}>{tab.label}</button>)}</nav>
        {/* 依赖配置保存条：配置草稿的编辑 UI 是旧「分类与载入」子视图（LoadTab /
            WorldBookConfigOverview），当前未挂载 —— 本保存条实际不可达，保留原路径待接线。
            页签收敛后挂在条目页，不再依附已删除的「节点视图」页签。 */}
        {effectiveTab === "entries" && configDirty && <div className="wber-config-save">
          <span>节点配置有未保存修改</span><button type="button" className="is-sm is-ghost" onClick={undoConfig}>撤销</button>
          <button type="button" className="is-sm is-primary" disabled={configSaving} onClick={async () => {
            if (await saveConfig()) { await loadDetail(detail.id); showToast("节点配置已保存"); }
          }}>{configSaving ? "保存中…" : "保存节点配置"}</button>
        </div>}
        {effectiveTab === "entries" && configError && <div className="wber-alert">{configError}</div>}
        {error && <div className="wber-alert" role="alert">{error}<button type="button" className="is-icon is-sm is-ghost" aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
        {toast && <div className="wber-toast" role="status">{toast}</div>}

        {effectiveTab === "entries" && <div className="wber-entries-page">
          <div className="wber-entry-toolbar">
            <label className="wber-search"><AppIcon name="search" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或触发词" aria-label="搜索条目" /></label>
            {/* 分层筛选：系统层（节点图 / 节点绑定）不是注入条目，单独成一档。 */}
            <div className="wber-layer-filter" role="group" aria-label="按分层筛选条目">
              <button type="button" aria-pressed={layerFilter === "all"} onClick={() => setLayerFilter("all")}>
                全部 <span>{orderedEntries.length}</span></button>
              {(["stable", "dynamic", "system"] as WorldBookEntryLayer[]).map((value) => <button key={value}
                type="button" aria-pressed={layerFilter === value} title={LAYER_HINTS[value]}
                onClick={() => setLayerFilter(layerFilter === value ? "all" : value)}>
                {LAYER_LABELS[value]} <span>{layerCounts[value]}</span></button>)}
            </div>
            <button type="button" className="is-primary" onClick={createEntry}>＋ 新增条目</button></div>
          {(query || layerFilter !== "all") && <p className="wber-order-note">
            {query ? "搜索结果" : `${LAYER_LABELS[layerFilter as WorldBookEntryLayer]}筛选中`}暂不拖动排序；
            清空搜索并回到「全部」可恢复完整插入顺序。
          </p>}
          <div className="wber-entry-list">{visibleEntries.map((entry, index) => {
            const open = expanded.has(entry.uid); const editing = editingUid === entry.uid;
            const layer = entryLayer(entry);
            const system = layer === "system";
            return <article key={entry.uid}
              className={`wber-entry${entry.enabled ? "" : " is-disabled"}${system ? " is-system" : ""}`}
              draggable={!query && layerFilter === "all"} onDragStart={() => setDragUid(entry.uid)}
              onDragOver={(event) => event.preventDefault()} onDrop={() => reorder(entry.uid)}>
              <header className="wber-entry-head">
                <span className="wber-drag" title="拖动排序" aria-hidden="true">⠿</span>
                {/* 系统层条目不参与注入，勾选对它没有意义 —— 不给一个按键却什么都不做的开关。 */}
                <input type="checkbox" checked={entry.enabled} disabled={system}
                  title={system ? "系统层条目由节点图 / 节点绑定维护，不参与注入开关" : undefined}
                  aria-label={system ? `${entry.name || entry.uid} 是系统层条目，不参与注入`
                    : `${entry.enabled ? "停用" : "启用"} ${entry.name || entry.uid}`}
                  onChange={() => toggleEntry(entry)} />
                <button type="button" className="wber-entry-toggle" aria-expanded={open}
                  onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(entry.uid); else next.add(entry.uid); return next; })}>
                  <AppIcon name="forward" size={15} className="wber-chevron" /><strong>{entry.name || "未命名条目"}</strong>
                </button>
                <span className={`wber-layer is-${layer}`} title={LAYER_HINTS[layer]}>{LAYER_LABELS[layer]}</span>
                {system
                  ? <span className="wber-token is-system" title="系统层条目永不注入，不计入 token 统计与 Prompt 预览">不注入</span>
                  : <span className="wber-token">约 {entryTokens(entry)} token</span>}
                <span className="wber-seq">#{index + 1}</span>
              </header>
              {open && <div className="wber-entry-body">
                {system && <p className="wber-system-note" role="note">
                  系统层条目：由「节点图」画布 / 节点绑定维护，只服务系统判定，<b>永不注入</b>，
                  也不计入条目数与 token。直接改正文可能让画布数据无法解析，建议回「节点图」页签修改。
                </p>}
                <div className="wber-entry-actions"><button type="button" className={editing ? "is-sm" : "is-sm is-primary"} onClick={() => {
                  if (editing) { setEditingUid(null); setEntryDraft(null); return; }
                  setEditingUid(entry.uid); setEntryDraft(draftCache.current.get(`${detail.id}:${entry.uid}`) || entryToDraft(entry));
                }}>{editing ? "返回阅读" : "编辑"}</button>
                  <button type="button" className="is-sm is-danger" onClick={() => void deleteEntry(entry)}><AppIcon name="trash" size={13} />删除</button></div>
                {editing && entryDraft ? <EntryEditor draft={entryDraft} detail={detail} onChange={changeDraft} /> : <>
                  <div className="wber-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || "_（正文为空）_"}</ReactMarkdown></div>
                  <div className="wber-entry-meta"><span>触发词：{entry.trigger_keys?.join("、") || "无"}</span>
                    <span>分组：{entry.group || "无"}</span><span>分类：{detail.categories?.find((item) => item.id === entry.category_id)?.name || "未分类"}</span>
                    {system ? <span>{LAYER_LABELS.system}：由节点图 / 节点绑定维护，不注入</span>
                      : <span>{entry.always_active ? "常驻" : "关键词触发"}</span>}</div>
                  {configDraft && persistedUids.current.has(`${detail.id}:${entry.uid}`) && <EntryDependencyTree detail={detail} rootUids={[entry.uid]} draft={configDraft} />}
                </>}
              </div>}
            </article>;
          })}</div>
          {!visibleEntries.length && <p className="wber-empty">没有匹配的条目。</p>}

          <details className="wber-library-search" open={isReference(detail)}>
            <summary><strong>资料库检索与摘录</strong><span>从资料库查找并加入剧情世界书</span></summary>
            <div className="wber-library-controls"><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void searchLibrary(); }} placeholder="搜索资料库" />
              {isReference(detail) && <select value={targetBookId} onChange={(event) => setTargetBookId(event.target.value)}>
                <option value="">选择摘录目标…</option>{storyBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select>}
              <button type="button" onClick={() => void searchLibrary()} disabled={libraryBusy}>{libraryBusy ? "检索中…" : "检索"}</button></div>
            {libraryResults.map((result) => <div className="wber-library-result" key={result.book.id}><strong>{result.book.name}</strong>
              {result.matches.map((entry: WorldBookEntryDTO) => <div key={entry.uid}><span>{entry.name || entry.content.slice(0, 30)}</span>
                <button type="button" className="is-sm" onClick={() => void excerpt(result.book.id, entry)}>加入剧情书</button></div>)}</div>)}
          </details>
          <details className="wber-paste-import"><summary>从剪贴板 JSON 导入另一本世界书</summary>
            <textarea rows={5} value={pasteJson} onChange={(event) => setPasteJson(event.target.value)} placeholder="粘贴世界书 JSON" />
            <button type="button" className="is-sm is-primary" onClick={() => void importPastedJson()}><AppIcon name="upload" size={13} />导入</button>
          </details>
        </div>}

        {effectiveTab === "prompt" && panelProps && <PromptPreviewTab ctx={panelProps} onNotice={showToast} onReload={() => loadDetail(detail.id)} />}
        {/* 节点图（迁自「内容中心 → 节点图」）：按当前选中的世界书编辑，整页画布。
            不常驻挂载：画布自带全局 Ctrl+S / Ctrl+Z 快捷键，常驻会在其它页签抢键。 */}
        {effectiveTab === "graph" && <div className="wber-graph">
          <PlotGraphPage sessionId={activeSessionId} bookId={detail.id} />
        </div>}
        {effectiveTab === "index" && <div className="wber-index">
          <Suspense fallback={<p>正在加载会话条目…</p>}><IndexManager key={detail.id} book={detail}
            onRefresh={() => loadDetail(detail.id)} onEditDefaults={() => setWorldbookTab("entries")} /></Suspense></div>}
      </>}
    </section>
  </main>;
}

function EntryEditor({ draft, detail, onChange }: { draft: EntryDraft; detail: WorldBookDetail; onChange: (changes: Partial<EntryDraft>) => void }) {
  const categories = detail.categories || [];
  const currentKind = categories.find((item) => item.id === draft.categoryId)?.scope_type;
  return <div className="wber-editor">
    <label>名称<input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></label>
    <label className="is-wide">正文<textarea rows={10} value={draft.content} onChange={(event) => onChange({ content: event.target.value })} placeholder="支持 Markdown。写下这条设定的正文…" /></label>
    <label>触发词<input value={draft.triggerKeysText} onChange={(event) => onChange({ triggerKeysText: event.target.value })} placeholder="逗号分隔" /></label>
    <label>分组<input value={draft.group} onChange={(event) => onChange({ group: event.target.value })} /></label>
    <label>分类<select value={draft.categoryId} onChange={(event) => {
      const next = event.target.value;
      const kind = categories.find((item) => item.id === next)?.scope_type;
      if (kind === "character" && !draft.characterId) return;
      onChange({ categoryId: next, characterId: kind === "character" ? draft.characterId : "" });
    }}><option value="unclassified">未分类</option>{categories.filter((category) => category.id !== "unclassified").map((category) => <option key={category.id} value={category.id}
      disabled={category.scope_type === "character" && !draft.characterId}>{category.name}</option>)}</select>
      {currentKind === "character" && <small>沿用原有角色关联：{draft.characterId}</small>}
      {!draft.characterId && <small>角色分类需要已有角色关联。</small>}</label>
    <label className="wber-check"><input type="checkbox"
      checked={!draft.alwaysActive || draft.position !== 0}
      onChange={(event) => onChange({ alwaysActive: !event.target.checked, position: event.target.checked ? 1 : 0 })} />动态插入</label>
    <small>默认常驻静态层；勾选后改为按触发条件进入动态层。</small>
    <p className="wber-editor-note">修改会即时自动保存。</p>
  </div>;
}
