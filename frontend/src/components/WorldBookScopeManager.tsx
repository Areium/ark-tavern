import { useEffect, useId, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { confirmAction } from "../stores/confirmStore";
import { useAppStore } from "../stores/appStore";
import type {
  WorldBookActivation, WorldBookCategoryDTO, WorldBookClassificationDTO,
  WorldBookDetail, WorldBookExpansion,
} from "../types";
import type { WorldBookDraft } from "../hooks/useWorldbookDraft";
import { categoryDescendants, flattenCategoryTree } from "../utils/worldbookScope";
import {
  batchAddEdges, batchMove, batchRemoveEdges, batchRoots, categoryEntryUids, knownUids,
} from "../utils/worldbookBatch";
import WorldBookGraphIcon from "./WorldBookGraphIcon";
import WorldBookScopePreview from "./WorldBookScopePreview";
import { ACTIVATION_LABELS, EXPANSION_LABELS, type WorldBookPanelProps } from "./worldbook/panel";
import "../styles/worldbook-graph.css";

/**
 * 分类结构工作台（原「高级图谱」的 taxonomy 视图，D-1 / D-3 缩减后）。
 *
 * 只剩 **分类树列表 + 条目归属表 + 批量操作 + 侧栏** 四件事：
 *  - 分类的增删改、条目归属（移入分类）、角色关联、按元数据自动分类；
 *  - 起点（v3）的批量与逐条设置：`activation`（基础设定 / 角色入队 / 手动追加）
 *    与 `expansion`（只含自身 / 补齐必要依赖 / 按旧深度展开 +N）；
 *  - 依赖边的批量增删与逐条增删；
 *  - 候选范围预览（`WorldBookScopePreview` 侧栏）。
 *
 * 画布（力导向关系网络 / 分层依赖树）、拖动布局、框选、在图上连线、缩略图、
 * 五种依赖角色词表与筛选全部随 D-1 / D-3 删除。批量选择改由**列表复选框**驱动
 * （R-20），批量建立依赖改为在批量栏用目标条目下拉选择。
 *
 * 全部改动只落在页面级的**统一草稿**上，由工作台页头一次原子保存：
 * 本组件不写盘、不重新加载书，草稿在保存失败或 409 冲突时原样保留。
 */
const KINDS = { worldview: "世界观", character: "角色", other: "其他" };
/** 自动分类的线索名 → 界面文案（与后端 worldbook_classify 的信号名对应）。 */
const SIGNALS: Record<string, string> = { "uid-prefix": "uid 前缀", group: "group 字段", "name-suffix": "名称后缀" };
const classificationName = (value: WorldBookClassificationDTO, id: string) =>
  value.categories.find((category) => category.id === id)?.name
  || value.proposal.find((category) => category.id === id)?.name || id;
/** 归属表一次渲染的最大行数：大书仍以搜索与分类筛选定位。 */
const TABLE_LIMIT = 300;
const edgeKey = (from: string, to: string) => `${from}\u0000${to}`;
/** 激活方式的短标签（侧栏与归属表用；完整口径见 panel.ts 的 ACTIVATION_LABELS）。 */
const ACTIVATION_SHORT: Record<WorldBookActivation, string> = {
  always: "基础设定", roster_any: "角色入队", manual: "手动追加",
};

export interface WorldBookScopeManagerProps extends WorldBookPanelProps {
  /**
   * 兼容旧调用保留的视图开关。
   *
   * 本组件只剩「分类结构」（taxonomy）一种视图：历史取值 `dependencies` / `tree`
   * 随画布一起删除（D-1 / D-3），因此**任何**取值都按分类结构渲染。
   */
  view?: string;
  /** 外部数据已变更（重新拉取 detail）；分类结构视图自身不写盘，故可省略。 */
  onChanged?: () => void | Promise<void>;
}

export default function WorldBookScopeManager(props: WorldBookScopeManagerProps) {
  const {
    detail: detailProp, draft, patch, dirty, saving, save, undo, preview, previewError,
    roster, setRoster,
  } = props;
  const api = useApi();
  const store = useAppStore();
  const controlId = useId();

  /**
   * 把草稿里的分类与条目归属叠到 detail 上：分类结构看到的
   * 就是「保存后会变成的样子」，不需要维护第二份草稿。
   */
  const detail = useMemo(() => {
    const moves = draft.entry_moves;
    const updates = draft.entry_updates;
    return {
      ...detailProp,
      categories: draft.categories,
      entries: detailProp.entries.map((entry) => {
        const entryPatch = updates[entry.uid];
        const category_id = entryPatch?.category_id ?? moves[entry.uid] ?? entry.category_id;
        const character_id = entryPatch?.character_id ?? entry.character_id;
        return category_id === entry.category_id && character_id === entry.character_id
          ? entry : { ...entry, category_id, character_id };
      }),
    } as WorldBookDetail;
  }, [draft.categories, draft.entry_moves, draft.entry_updates, detailProp]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [selection, setSelection] = useState<{ kind: "entry" | "category"; id: string } | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<WorldBookCategoryDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState("unclassified");
  const [assignment, setAssignment] = useState({ category_id: "unclassified", character_id: "" });
  const [characters, setCharacters] = useState<Array<{ id: string; name?: string; title?: string }> | null>(null);
  const [edgeTo, setEdgeTo] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [batchActivation, setBatchActivation] = useState<WorldBookActivation>("always");
  const [batchExpansion, setBatchExpansion] = useState<WorldBookExpansion>("none");
  const [batchTarget, setBatchTarget] = useState("");
  const [batchCategory, setBatchCategory] = useState("unclassified");
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [batchNote, setBatchNote] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [panel, setPanel] = useState<"inspector" | "preview" | "classify" | null>(null);
  const [classification, setClassification] = useState<WorldBookClassificationDTO | null>(null);
  const [classifyError, setClassifyError] = useState("");

  const categories = detail.categories || [];
  const rows = useMemo(() => flattenCategoryTree(categories), [categories]);
  const byUid = useMemo(() => new Map(detail.entries.map((entry) => [entry.uid, entry])), [detail.entries]);
  const focusedUid = selection?.kind === "entry" ? selection.id : "";
  const focused = byUid.get(focusedUid);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const label = (uid: string) => byUid.get(uid)?.name || uid;
  const categoryName = (id: string) => categories.find((category) => category.id === id)?.name || id;
  const selectedCategories = useMemo(() => categoryId ? categoryDescendants(categories, categoryId) : null, [categories, categoryId]);
  const rootOf = (uid: string) => draft.roots.find((root) => root.entry_uid === uid);
  const requiresFrom = (uid: string) => draft.requires_edges.filter((edge) => edge.from_uid === uid);
  const requiresTo = (uid: string) => draft.requires_edges.filter((edge) => edge.to_uid === uid);
  const filtered = detail.entries.filter((entry) =>
    (!selectedCategories || selectedCategories.has(entry.category_id || "unclassified"))
    && (!query.trim() || [entry.name, entry.uid, entry.character_id,
      categories.find((category) => category.id === entry.category_id)?.name,
      ...(entry.trigger_keys || [])].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const editingDescendants = categoryDraft ? categoryDescendants(categories, categoryDraft.id) : new Set<string>();
  const assignmentKind = categories.find((category) => category.id === assignment.category_id)?.scope_type;

  useEffect(() => {
    setCategoryId(""); setSelection(null); setCategoryDraft(null); setError("");
    setEdgeTo(""); setPanel(null);
    setQuery(""); setClassification(null); setClassifyError("");
    setPicked([]); setBatchNote(""); setRowMenu(null); setBatchTarget("");
    // 试选阵容属于工作台页面级状态（试算用，不进草稿），换书由工作台清空，这里不动它。
  }, [detailProp.id]);
  useEffect(() => {
    setAssignment({ category_id: focused?.category_id || "unclassified", character_id: focused?.character_id || "" });
    setEdgeTo("");
  }, [focused]);
  // 书重新加载后（条目被删/被改动），把批量选择与批量目标里的陈旧 UID 清掉。
  useEffect(() => {
    setPicked((current) => {
      const next = current.filter((uid) => byUid.has(uid));
      return next.length === current.length ? current : next;
    });
    setBatchTarget((current) => (current && !byUid.has(current) ? "" : current));
  }, [byUid]);
  // 分类行菜单：点空白处或 Esc 关闭，避免菜单一直挂在目录上。
  useEffect(() => {
    if (!rowMenu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest(".wbg-tree-row")) setRowMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setRowMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [rowMenu]);
  useEffect(() => {
    let cancelled = false;
    api.getCharacters().then((items) => { if (!cancelled) setCharacters(items || []); })
      .catch(() => { if (!cancelled) setCharacters(null); });
    return () => { cancelled = true; };
  }, [api]);

  /** 草稿写回：只改这一份统一草稿，不写盘。 */
  const rootPatch = (next: WorldBookDraft): Partial<WorldBookDraft> => ({ roots: next.roots });
  /** 起点批量写回（R-17）：`activation === null` 表示移除这些条目的起点。 */
  const applyRoots = (uids: string[], activation: WorldBookActivation | null,
    expansion: WorldBookExpansion) => {
    const next = batchRoots(draft, detail, uids, activation, expansion);
    // 起点已处于目标状态时不写草稿：避免无意义的脏标记（batchRoots 会稳定排序）。
    if (JSON.stringify(next.roots) === JSON.stringify(draft.roots)) return false;
    patch(rootPatch(next));
    return true;
  };
  const filterCategory = (id: string) => { setCategoryId(id); };

  const pickMany = (uids: string[], additive: boolean) => {
    setBatchNote("");
    setPicked((current) => (additive ? [...new Set([...current, ...knownUids(detail, uids)])] : knownUids(detail, uids)));
  };
  const togglePick = (uid: string) => setPicked((current) =>
    current.includes(uid) ? current.filter((item) => item !== uid) : [...current, uid]);
  /** 分类行的复选框：整棵子树下的条目一起选 / 一起取消（R-20）。 */
  const togglePickCategory = (id: string) => {
    const uids = categoryEntryUids(detail, id);
    setBatchNote("");
    setPicked((current) => {
      const scope = new Set(uids);
      const allPicked = uids.length > 0 && uids.every((uid) => current.includes(uid));
      return allPicked ? current.filter((uid) => !scope.has(uid)) : [...new Set([...current, ...uids])];
    });
    setRowMenu(null);
  };
  const pickCategory = (id: string) => {
    const uids = categoryEntryUids(detail, id);
    setPicked(uids); setBatchNote(`已选中「${categoryName(id)}」下的 ${uids.length} 个条目。`);
    setRowMenu(null);
  };

  const addEdge = (from: string, to: string) => {
    if (!byUid.has(from) || !byUid.has(to)) return;
    if (from === to) { setError("不能让条目依赖自身，请选择另一个条目。"); return; }
    if (draft.requires_edges.some((edge) => edge.from_uid === from && edge.to_uid === to)) {
      setError("这条依赖已经存在。"); return;
    }
    setError("");
    patch({ requires_edges: [...draft.requires_edges, { from_uid: from, to_uid: to }] });
    setEdgeTo("");
  };
  const removeEdge = (from: string, to: string) =>
    patch({ requires_edges: draft.requires_edges.filter((edge) => edge.from_uid !== from || edge.to_uid !== to) });

  // ── 批量操作：全部只改统一草稿，照常走页头那一次保存 ──
  const runBatchRoots = (activation: WorldBookActivation | null) => {
    const expansion: WorldBookExpansion = activation === null ? "none" : batchExpansion;
    const changed = applyRoots(picked, activation, expansion);
    setBatchNote(!changed ? "所选条目已处于该状态。"
      : activation === null ? `已移除 ${picked.length} 个条目的起点。`
        : `已把 ${picked.length} 个条目设为起点：${ACTIVATION_SHORT[activation]} · ${EXPANSION_LABELS[expansion]}`
          + "。");
  };
  const runBatchLink = (direction: "to" | "from") => {
    if (!batchTarget) { setError("请先选择批量依赖的目标条目。"); return; }
    const { requires_edges, added, skipped } = batchAddEdges(draft, detail, picked, batchTarget, direction);
    if (!added.length) { setError(`没有新增依赖：${skipped} 条已存在或指向自身。`); return; }
    setError(""); patch({ requires_edges });
    setBatchNote(direction === "to"
      ? `已建立 ${added.length} 条依赖：所选 → ${label(batchTarget)}。`
      : `已建立 ${added.length} 条依赖：${label(batchTarget)} → 所选。`);
  };
  const runBatchUnlink = (uids: string[], scope: string) => {
    const { requires_edges, removed } = batchRemoveEdges(draft, detail, uids);
    if (removed) patch({ requires_edges });
    setBatchNote(removed ? `已清除 ${scope} 的 ${removed} 条依赖边。` : `${scope}没有可清除的依赖边。`);
  };
  const runBatchMove = () => {
    const moves = batchMove(detail, picked, batchCategory);
    if (!Object.keys(moves).length) return;
    patch({ entry_moves: { ...draft.entry_moves, ...moves } });
    setBatchNote(`已将 ${Object.keys(moves).length} 个条目移入「${categoryName(batchCategory)}」（尚未保存）。`);
    setPicked([]);
  };

  const inspectEntry = (uid: string) => {
    setSelection({ kind: "entry", id: uid }); setCategoryDraft(null); setPanel("inspector");
  };
  const inspectCategory = (id: string) => {
    const category = categories.find((item) => item.id === id);
    setSelection({ kind: "category", id }); setPanel("inspector");
    setCategoryDraft(category && category.id !== "unclassified" ? { ...category } : null);
    setDeleteTarget("unclassified");
    setRowMenu(null);
  };
  const newCategory = () => {
    const parentId = categoryId && categoryId !== "unclassified" ? categoryId : null;
    setCategoryDraft({ id: "cat-" + crypto.randomUUID(), parent_id: parentId, name: "",
      scope_type: categories.find((category) => category.id === parentId)?.scope_type || "other", sort_order: categories.length * 10 });
    setSelection(null); setPanel("inspector");
  };
  /** 编辑正文：跳回工作台「条目」页签并由工作台打开条目编辑器。 */
  const editEntry = (uid: string) => {
    store.setWorldbookEntryJump({ bookId: detailProp.id, entryUid: uid });
    store.setWorldbookTab("entries");
  };
  const saveCategory = () => {
    if (!categoryDraft || !categoryDraft.name.trim() || !Number.isInteger(categoryDraft.sort_order)) return;
    const next = categories.filter((category) => category.id !== categoryDraft.id).map((category) =>
      editingDescendants.has(category.id) ? { ...category, scope_type: categoryDraft.scope_type } : category);
    next.push(categoryDraft);
    patch({ categories: next });
    setSelection({ kind: "category", id: categoryDraft.id }); setCategoryDraft(null); setPanel(null);
  };
  const deleteCategory = async () => {
    if (!categoryDraft || editingDescendants.has(deleteTarget)) return;
    const moved = detail.entries.filter((entry) => editingDescendants.has(entry.category_id || ""));
    if (!await confirmAction("删除该分类及子分类，并将 " + moved.length + " 个条目移入所选目标？条目内容不会删除。", { title: "删除分类", confirmLabel: "删除分类及子分类" })) return;
    const kept = categories.filter((category) => !editingDescendants.has(category.id));
    const moves = Object.fromEntries(moved.map((entry) => [entry.uid, deleteTarget]));
    patch({ categories: kept, entry_moves: { ...draft.entry_moves, ...moves } });
    setCategoryDraft(null); setSelection(null); setPanel(null);
    if (editingDescendants.has(categoryId)) filterCategory("");
  };
  const openClassification = async () => {
    if (panel === "classify") { setPanel(null); return; }
    setPanel("classify"); setSelection(null); setCategoryDraft(null);
    setClassification(null); setClassifyError(""); setBusy(true);
    try { setClassification(await api.previewWorldbookClassification(detailProp.id)); }
    catch (e) { setClassifyError(e instanceof Error ? e.message : "读取分类线索失败"); }
    finally { setBusy(false); }
  };
  /**
   * 应用自动分类：只给统一草稿打一个补丁（分类 + 条目归属 + 角色关联），
   * 由工作台页头一次保存。不调用旧写入接口，也就不会重新加载书、丢掉其它草稿。
   */
  const applyClassification = () => {
    if (!classification?.matched) return;
    const patchData = classification.draft_patch;
    if (!patchData) { setError("这次分类没有可应用的结论。"); return; }
    patch({
      categories: patchData.categories,
      entry_moves: { ...draft.entry_moves, ...patchData.entry_moves },
      entry_updates: { ...draft.entry_updates, ...patchData.entry_updates },
    });
    setPanel(null); setError("");
  };
  /** 归属分类 + 角色关联：走草稿，与其它改动共用同一个撤销栈和同一次保存。 */
  const saveAssignment = (uid: string) => {
    if (!uid) return;
    const kind = categories.find((category) => category.id === assignment.category_id)?.scope_type;
    patch({ entry_updates: { ...draft.entry_updates,
      [uid]: { category_id: assignment.category_id, character_id: kind === "character" ? assignment.character_id : "" } } });
    setBatchNote(`已更新「${label(uid)}」的归属（尚未保存）。`);
  };

  const rootLabel = (uid: string) => {
    const root = rootOf(uid);
    if (!root) return { text: "未配置起点", title: "不参与遍历展开；仍可能由关键词触发" };
    return {
      text: ACTIVATION_SHORT[root.activation],
      title: `${ACTIVATION_LABELS[root.activation] || root.activation} · ${EXPANSION_LABELS[root.expansion] || root.expansion}`,
    };
  };

  return <section className="wbg-workbench" aria-label="世界书分类结构工作台">
    <header className="wbg-header">
      <div className="wbg-heading"><WorldBookGraphIcon name="graph" size={22} /><div>
        <h3>分类结构</h3>
        <p>分类组织内容，条目归属与角色关联；起点与依赖在「条目与角色」里逐条配置</p>
      </div></div>
      <div className="wbg-header-actions">
        <button className="wbg-button wbg-button-quiet" disabled={!dirty} onClick={undo}>撤销草稿</button>
        <button className="wbg-button wbg-button-primary" disabled={saving || !dirty || !preview || !!previewError}
          onClick={() => void save()}>
          {saving ? "保存中…" : dirty ? "保存策略" : "已保存"}
        </button>
      </div>
    </header>
    <div className="wbg-toolbar">
      <button className={"wbg-button wbg-button-quiet" + (libraryOpen ? " is-active" : "")} aria-expanded={libraryOpen}
        onClick={() => setLibraryOpen(!libraryOpen)}><WorldBookGraphIcon name="panel" />分类目录</button>
      <div className="wbg-breadcrumb"><button onClick={() => filterCategory("")}>全部分类</button>
        {categoryId && <><span>/</span><span>{categoryName(categoryId)}</span></>}</div>
      <button className={"wbg-button wbg-button-quiet" + (panel === "classify" ? " is-active" : "")} aria-expanded={panel === "classify"}
        title="按条目自带的 uid 前缀 / group / 名称后缀推断分类，先预览再决定是否应用" onClick={() => void openClassification()}>
        <WorldBookGraphIcon name="tag" />自动分类
      </button>
      <button className="wbg-button wbg-button-quiet" onClick={newCategory}>＋ 新建分类</button>
      <div className="wbg-toolbar-spacer" />
      <span className={"wbg-save-state" + (dirty ? " is-dirty" : "")}>{dirty ? "有未保存修改" : "已同步"}</span>
      <button className={"wbg-button" + (panel === "preview" ? " is-active" : "")} aria-expanded={panel === "preview"}
        onClick={() => setPanel(panel === "preview" ? null : "preview")}><WorldBookGraphIcon name="preview" />导入预览
        {preview && <span className="wbg-count">{preview.entry_count}</span>}</button>
    </div>
    {!!picked.length && <div className="wbg-toolbar wbg-batch-bar" aria-label="批量操作">
      <span className="wbg-batch-count"><WorldBookGraphIcon name="tag" size={13} />已选 <b>{picked.length}</b> 个条目</span>
      <div className="wbg-batch-group">
        <label className="wbg-form-label wbg-inline-field">起点
          <select className="wbg-field wbg-batch-target" aria-label="批量起点激活方式" value={batchActivation}
            onChange={(event) => setBatchActivation(event.target.value as WorldBookActivation)}>
            {(["always", "roster_any", "manual"] as WorldBookActivation[]).map((value) =>
              <option key={value} value={value}>{ACTIVATION_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="wbg-form-label wbg-inline-field">展开
          <select className="wbg-field wbg-batch-target" aria-label="批量起点展开方式" value={batchExpansion}
            onChange={(event) => setBatchExpansion(event.target.value as WorldBookExpansion)}>
            {Object.entries(EXPANSION_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <button className="wbg-button wbg-button-quiet" onClick={() => runBatchRoots(batchActivation)}>设为起点</button>
        <button className="wbg-button wbg-button-quiet" onClick={() => runBatchRoots(null)}>移除起点</button>
        {batchActivation === "roster_any" && <small className="wbg-help">
          「角色入队时选用」需要在「条目与角色」里为条目选择角色，否则保存会被拒绝。
        </small>}
      </div>
      <div className="wbg-batch-group">
        <label className="wbg-form-label wbg-inline-field">依赖目标
          <select className="wbg-field wbg-batch-target" aria-label="批量依赖目标" value={batchTarget}
            onChange={(event) => setBatchTarget(event.target.value)}>
            <option value="">选择条目</option>
            {detail.entries.filter((entry) => !pickedSet.has(entry.uid))
              .map((entry) => <option key={entry.uid} value={entry.uid}>{entry.name || entry.uid}</option>)}
          </select>
        </label>
        <button className="wbg-button wbg-button-quiet" disabled={!batchTarget} onClick={() => runBatchLink("to")}>所选 → 目标</button>
        <button className="wbg-button wbg-button-quiet" disabled={!batchTarget} onClick={() => runBatchLink("from")}>目标 → 所选</button>
        <button className="wbg-button wbg-button-quiet" onClick={() => runBatchUnlink(picked, "所选条目")}>清空所选依赖</button>
      </div>
      <div className="wbg-batch-group">
        <label className="wbg-form-label wbg-inline-field">归属分类
          <select className="wbg-field wbg-batch-target" aria-label="批量归属分类" value={batchCategory}
            onChange={(event) => setBatchCategory(event.target.value)}>
            {rows.map(({ category, level }) => <option key={category.id} value={category.id}>{"　".repeat(level)}{category.name}</option>)}
          </select>
        </label>
        <button className="wbg-button wbg-button-quiet" onClick={runBatchMove}>批量移入该分类</button>
      </div>
      <div className="wbg-toolbar-spacer" />
      <button className="wbg-button wbg-button-quiet" onClick={() => { setPicked([]); setBatchNote(""); }}>清除选择</button>
    </div>}
    {batchNote && <div className="wbg-notice wbg-batch-notice" role="status">
      <span>{batchNote}</span>
      <button aria-label="关闭批量操作提示" onClick={() => setBatchNote("")}>×</button>
    </div>}
    {previewError && <div role="alert" className="wbg-notice wbg-error">
      <span>预览未通过：{previewError}（保存按钮已停用，先按提示修正草稿）</span>
    </div>}
    {error && <div role="alert" className="wbg-notice wbg-error">
      <span>{error}</span>
      <button aria-label="关闭错误提示" onClick={() => setError("")}>×</button>
    </div>}
    <div className="wbg-body">
      {libraryOpen && <aside className="wbg-library" aria-label="分类目录">
        <div className="wbg-panel-heading"><span>分类目录</span>
          <button className="wbg-icon-button" aria-label="收起分类目录" onClick={() => setLibraryOpen(false)}>
            <WorldBookGraphIcon name="close" /></button></div>
        <label className="wbg-search"><WorldBookGraphIcon name="search" />
          <input placeholder="搜索名称、UID、关键词" aria-label="搜索条目" value={query}
            onChange={(event) => setQuery(event.target.value)} />
          {query && <button aria-label="清空搜索" onClick={() => setQuery("")}>×</button>}
        </label>
        <div className="wbg-library-scroll">
          <div className="wbg-section-label">分类树 <span>{categories.length}</span></div>
          <nav className="wbg-category-tree" aria-label="分类树">
            {rows.map(({ category, level }) => {
              const uids = categoryEntryUids(detail, category.id);
              const allPicked = uids.length > 0 && uids.every((uid) => pickedSet.has(uid));
              return <div key={category.id}
                className={"wbg-tree-row" + (categoryId === category.id ? " is-active" : "") + (rowMenu === category.id ? " is-open" : "")}
                style={{ paddingLeft: 10 + Math.min(level, 8) * 13 }}>
                <input type="checkbox" checked={allPicked} disabled={!uids.length}
                  aria-label={`选择分类 ${category.name} 下的条目`} onChange={() => togglePickCategory(category.id)} />
                <button className="wbg-tree-main" title={category.name + " · " + KINDS[category.scope_type]}
                  onClick={() => { filterCategory(category.id); inspectCategory(category.id); }}>
                  <i className="wbg-type-dot" data-wbg-kind={category.scope_type} /><span>{category.name}</span>
                  <small>{detail.entries.filter((entry) => (entry.category_id || "unclassified") === category.id).length}</small>
                </button>
                <button className="wbg-tree-more" aria-label={`${category.name} 的分类批量操作`} aria-expanded={rowMenu === category.id}
                  title="分类批量操作"
                  onClick={() => setRowMenu(rowMenu === category.id ? null : category.id)}>⋯</button>
                {rowMenu === category.id && <div className="wbg-row-menu" role="menu" aria-label={`${category.name} 的分类操作`}>
                  <button role="menuitem" onClick={() => pickCategory(category.id)}>
                    选中该分类下 {uids.length} 个条目
                  </button>
                  <button role="menuitem" onClick={() => runBatchUnlink(uids, `分类「${category.name}」`)}>清空整类依赖</button>
                  <button role="menuitem" onClick={() => { filterCategory(category.id); inspectCategory(category.id); }}>聚焦并编辑该分类</button>
                </div>}
              </div>;
            })}
          </nav>
        </div>
        <p className="wbg-library-foot">勾选分类会整棵子树一起选；勾选条目在右侧归属表里完成。</p>
      </aside>}
      <main className="wbg-stage wbg-own" aria-label="条目归属表">
        <div className="wbg-own-head">
          <h4>条目归属 <span className="wbg-count">{filtered.length}</span></h4>
          <div className="wbg-own-actions">
            <button className="wbg-button wbg-button-quiet" disabled={!filtered.length}
              onClick={() => pickMany(filtered.map((entry) => entry.uid), false)}>全选当前列表</button>
            {!!picked.length && <button className="wbg-button wbg-button-quiet"
              onClick={() => { setPicked([]); setBatchNote(""); }}>清除选择</button>}
          </div>
        </div>
        <div className="wbg-own-scroll">
          {!filtered.length && <p className="wbg-help">没有匹配条目，试试其他关键词或清空分类筛选。</p>}
          {filtered.slice(0, TABLE_LIMIT).map((entry) => {
            const root = rootLabel(entry.uid);
            const category = categories.find((item) => item.id === (entry.category_id || "unclassified"));
            return <div key={entry.uid}
              className={"wbg-own-row" + (focusedUid === entry.uid ? " is-active" : "") + (pickedSet.has(entry.uid) ? " is-picked" : "")}>
              <input type="checkbox" checked={pickedSet.has(entry.uid)}
                aria-label={`选择条目 ${entry.name || entry.uid}`} onChange={() => togglePick(entry.uid)} />
              <button className="wbg-own-main" title={entry.name + " · " + entry.uid} onClick={() => inspectEntry(entry.uid)}>
                <i className="wbg-entry-dot" data-wbg-kind={category?.scope_type || "other"} />
                <span><strong>{entry.name || entry.uid}</strong>
                  <small>{entry.uid}{!entry.enabled ? " · 已停用" : ""}</small></span>
              </button>
              <span className="wbg-chip" title="归属分类">{category?.name || "未分类"}</span>
              <span className="wbg-chip" title="关联角色">{entry.character_id || "未关联角色"}</span>
              <span className="wbg-chip" data-wbg-root={rootOf(entry.uid)?.activation || "none"} title={root.title}>{root.text}</span>
              <span className="wbg-own-degree" title="出边 / 入边依赖数">
                {requiresFrom(entry.uid).length} → · ← {requiresTo(entry.uid).length}
              </span>
              <button className="wbg-text-button" onClick={() => editEntry(entry.uid)}>编辑正文 ↗</button>
            </div>;
          })}
        </div>
        {filtered.length > TABLE_LIMIT && <p className="wbg-help wbg-own-foot">
          显示前 {TABLE_LIMIT} 条，请通过搜索或分类筛选定位更多条目。
        </p>}
      </main>
      {panel && <aside className="wbg-inspector" aria-label={panel === "preview" ? "候选范围预览面板" : panel === "classify" ? "自动分类面板" : "分类与条目属性"}>
        <div className="wbg-panel-heading">
          <span>{panel === "preview" ? "候选范围预览" : panel === "classify" ? "自动分类" : categoryDraft ? "分类属性" : focused ? "条目属性" : "分类概览"}</span>
          <button className="wbg-icon-button" aria-label="关闭属性面板" onClick={() => setPanel(null)}><WorldBookGraphIcon name="close" /></button>
        </div>
        <div className="wbg-inspector-scroll">
          {panel === "classify" ? <>
            <div className="wbg-inspector-section"><p className="wbg-eyebrow">AUTO CLASSIFY</p><h4>按条目自带的类别分类</h4>
              <p className="wbg-help">只认 uid 前缀、group 字段与名称后缀三类显式线索，识别不出就保持未分类，不按名字或正文猜测。应用只改分类与角色关联，不改载入模式与起点策略。</p>
            </div>
            {classifyError && <div role="alert" className="wbg-notice wbg-error"><span>{classifyError}</span>
              <button onClick={() => void openClassification()}>重试</button></div>}
            {!classification && !classifyError && <p className="wbg-help" role="status">正在读取条目的分类线索…</p>}
            {classification && (classification.matched === 0 ? <p className="wbg-help">{classification.reason || "没有可用的分类线索，已保持原样。"}</p> : <>
              <div className="wbg-metric-row">
                <span>可归类 <b>{classification.matched}</b></span>
                <span>无线索 <b>{classification.unmatched_count}</b></span>
                <span>角色关联 <b>{classification.character_links}</b></span>
                <span>线索冲突 <b>{classification.conflicts.length}</b></span>
              </div>
              <div className="wbg-inspector-section">
                <h5>将写入的分类</h5>
                <div className="wbg-classify-list">
                  {classification.categories.map((category) => <div key={category.id}>
                    <i data-wbg-kind={category.scope_type} />
                    <span>{category.parent_id ? "↳ " : ""}{category.name}<small>{KINDS[category.scope_type]}</small></span>
                    <b>{category.count}</b>
                  </div>)}
                </div>
                <p className="wbg-help">共 {classification.categories.length} 个分类；条目归属会按上表替换。</p>
              </div>
              {!!Object.keys(classification.signals).length && <p className="wbg-help">线索来源：
                {Object.entries(classification.signals).map(([signal, count]) => `${SIGNALS[signal] || signal} ${count} 条`).join(" · ")}</p>}
              {!!classification.unmatched_count && <details className="wbg-details"><summary>未识别条目 <span>{classification.unmatched_count}</span></summary>
                <div className="wbg-tree-path">{classification.unmatched.map((uid) => <button key={uid} className="wbg-text-button" onClick={() => inspectEntry(uid)}>{label(uid)}</button>)}</div>
                <p className="wbg-help">这些条目保持各自原有分类（默认未分类），正文不受影响。</p>
              </details>}
              {!!classification.conflicts.length && <details className="wbg-details"><summary>线索冲突 <span>{classification.conflicts.length}</span></summary>
                {classification.conflicts.map((item) => <p key={item.uid} className="wbg-help">{label(item.uid)}：
                  {Object.entries(item.votes).map(([signal, categoryId]) => `${SIGNALS[signal] || signal} → ${classificationName(classification, categoryId)}`).join("；")}</p>)}
                <p className="wbg-help">结论按 uid 前缀 &gt; group 字段 &gt; 名称后缀 取值；冲突条目可以人工复核。</p>
              </details>}
              <button className="wbg-button wbg-button-primary" disabled={busy} onClick={applyClassification}>
                <WorldBookGraphIcon name="tag" />应用分类（{classification.matched} 条）
              </button>
              <p className="wbg-help">分类与条目归属会并入当前草稿，和别的改动一起用工作台页头「保存」一次性写入；载入模式与起点策略保持不变。</p>
            </>)}
          </> : panel === "preview" ? <>
            <div className="wbg-inspector-section"><p className="wbg-eyebrow">IMPORT SCOPE</p><h4>载入前，先看候选范围</h4>
              <p className="wbg-help">预览不会修改会话。基础设定、入队角色、手动追加与依赖展开合并后去重。</p></div>
            <details className="wbg-details"><summary>预览阵容 <span>{roster.length} 位</span></summary><div className="wbg-roster-list">
              {characters?.map((character) => <label key={character.id} className="wbg-checkbox-label">
                <input type="checkbox" checked={roster.includes(character.id)}
                  onChange={(event) => setRoster((current) => event.target.checked ? [...current, character.id] : current.filter((id) => id !== character.id))} />
                {character.name || character.title || character.id}</label>)}
              {characters?.length === 0 && <p className="wbg-help">暂无可用角色。</p>}
              {characters === null && <p className="wbg-help">角色目录暂不可用，仍可预览基础设定与依赖展开。</p>}
            </div></details>
            {preview ? <div className="wbg-preview-content"><WorldBookScopePreview value={preview} /></div>
              : <p className="wbg-help" role="status">{previewError || "正在计算候选范围…"}</p>}
            <details className="wbg-details" open><summary>起点 <span>{draft.roots.length} 个</span></summary>
              {draft.roots.map((root) => <div className="wbg-source-row" key={root.entry_uid}>
                <button className="wbg-text-button" onClick={() => inspectEntry(root.entry_uid)}>{label(root.entry_uid)}</button>
                <span className="wbg-chip" title={ACTIVATION_LABELS[root.activation] || root.activation}>{ACTIVATION_SHORT[root.activation]}</span>
                <span className="wbg-chip" title="展开方式">{EXPANSION_LABELS[root.expansion] || root.expansion}
                  </span>
                <button className="wbg-icon-button" aria-label={"移除起点 " + label(root.entry_uid)}
                  onClick={() => { applyRoots([root.entry_uid], null, "none"); }}>×</button>
              </div>)}
              {!draft.roots.length && <p className="wbg-help">还没有起点：在「条目与角色」里把条目设为「加入基础设定」，或在归属表里勾选后批量设为起点。</p>}
            </details>
            <p className="wbg-help">保存后影响后续新建会话；已有会话保留候选快照，调整阵容或重新绑定时才重算。</p>
          </> : <>
            {categoryDraft && <fieldset className="wbg-form">
              <p className="wbg-eyebrow">CATEGORY</p><h4>{categories.some((category) => category.id === categoryDraft.id) ? categoryDraft.name : "新建分类"}</h4>
              <label className="wbg-form-label">名称<input className="wbg-field" value={categoryDraft.name} placeholder="例如：探索者协会 / 地区设定"
                onChange={(event) => setCategoryDraft({ ...categoryDraft, name: event.target.value })} /></label>
              <label className="wbg-form-label">父分类<select className="wbg-field" value={categoryDraft.parent_id || ""} onChange={(event) => {
                const parent = categories.find((category) => category.id === event.target.value);
                setCategoryDraft({ ...categoryDraft, parent_id: parent?.id || null, scope_type: parent?.scope_type || categoryDraft.scope_type });
              }}><option value="">根分类</option>{rows.filter(({ category }) => category.id !== "unclassified" && !editingDescendants.has(category.id)).map(({ category, level }) => <option key={category.id} value={category.id}>{"　".repeat(level)}{category.name}</option>)}</select></label>
              <div className="wbg-form-pair"><label className="wbg-form-label">类型<select className="wbg-field" value={categoryDraft.scope_type} disabled={!!categoryDraft.parent_id}
                onChange={(event) => setCategoryDraft({ ...categoryDraft, scope_type: event.target.value as WorldBookCategoryDTO["scope_type"] })}>
                {Object.entries(KINDS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
                <label className="wbg-form-label">排序<input className="wbg-field" type="number" step={1} value={categoryDraft.sort_order}
                  onChange={(event) => setCategoryDraft({ ...categoryDraft, sort_order: Number(event.target.value) })} /></label></div>
              {categoryDraft.parent_id && <p className="wbg-help">子分类沿用父分类的类型。</p>}
              <button className="wbg-button wbg-button-primary" disabled={!categoryDraft.name.trim() || !Number.isInteger(categoryDraft.sort_order)}
                onClick={saveCategory}>保存分类</button>
              {categories.some((category) => category.id === categoryDraft.id) && <details className="wbg-details wbg-delete-section"><summary>删除分类…</summary>
                <p className="wbg-help">包含子分类。条目内容保留，并移动到下方分类。</p>
                <label className="wbg-form-label">条目移至<select className="wbg-field" value={deleteTarget} onChange={(event) => setDeleteTarget(event.target.value)}>
                  {rows.filter(({ category }) => !editingDescendants.has(category.id)).map(({ category }) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                <button className="app-danger-button wbg-button wbg-danger" onClick={deleteCategory}>删除分类及子分类</button>
              </details>}
            </fieldset>}
            {selection?.kind === "category" && !categoryDraft && <>
              <div className="wbg-inspector-section"><p className="wbg-eyebrow">CATEGORY</p>
                <h4>{categoryName(selection.id)}</h4>
                <p className="wbg-help">{selection.id === "unclassified" ? "未分类是永久保留的归档分类，不能删除。" : "分类只用于组织与筛选；分类连线不会自动形成条目依赖。"}</p></div>
              <button className="wbg-button" onClick={() => filterCategory(selection.id)}>聚焦此分类</button>
              <div className="wbg-inspector-section">
                <h5>分类批量操作</h5>
                <p className="wbg-help">该分类及子分类共 {categoryEntryUids(detail, selection.id).length} 个条目；操作只改草稿，随后照常点「保存策略」。</p>
                <button className="wbg-button" onClick={() => pickCategory(selection.id)}>
                  <WorldBookGraphIcon name="tag" size={13} />选中这些条目（{categoryEntryUids(detail, selection.id).length}）
                </button>
                <button className="wbg-button wbg-button-quiet" onClick={() => runBatchUnlink(categoryEntryUids(detail, selection.id), `分类「${categoryName(selection.id)}」`)}>清空整类依赖</button>
              </div>
            </>}
            {focused && <>
              <div className="wbg-inspector-section">
                <span className="wbg-kind-label" data-wbg-kind={categories.find((category) => category.id === focused.category_id)?.scope_type || "other"}>
                  {KINDS[categories.find((category) => category.id === focused.category_id)?.scope_type || "other"]}</span>
                <h4>{focused.name || focused.uid}</h4><p className="wbg-uid">{focused.uid}</p>
                {!focused.enabled && <p className="wbg-warning">此条目已停用，不参与实际注入。</p>}
                <p className="wbg-entry-excerpt">{focused.content?.slice(0, 180) || "暂无正文"}</p>
              </div>
              <fieldset className="wbg-form">
                <div className="wbg-inspector-section">
                  <div className="wbg-section-heading"><h5>起点</h5>
                    <span className="wbg-chip">{rootLabel(focused.uid).text}</span></div>
                  <p className="wbg-help">起点决定这条内容怎么进入候选范围；展开方式决定要不要顺带把它的必要依赖一起带进来。</p>
                  <label className="wbg-form-label">激活方式<select className="wbg-field" aria-label="起点激活方式"
                    value={rootOf(focused.uid)?.activation || ""} onChange={(event) => {
                      const value = event.target.value as WorldBookActivation | "";
                      if (!value) { applyRoots([focused.uid], null, "none"); return; }
                      const expansion = rootOf(focused.uid)?.expansion
                        || (value === "roster_any" ? "requires_closure" : "none");
                      applyRoots([focused.uid], value, expansion);
                    }}>
                    <option value="">不作为起点</option>
                    {(["always", "roster_any", "manual"] as WorldBookActivation[]).map((value) =>
                      <option key={value} value={value}>{ACTIVATION_LABELS[value]}</option>)}
                  </select></label>
                  <label className="wbg-form-label">展开方式<select className="wbg-field" aria-label="起点展开方式" disabled={!rootOf(focused.uid)}
                    value={rootOf(focused.uid)?.expansion || "none"} onChange={(event) => {
                      const root = rootOf(focused.uid);
                      if (!root) return;
                      applyRoots([focused.uid], root.activation, event.target.value as WorldBookExpansion);
                    }}>
                    {Object.entries(EXPANSION_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select></label>
                  {rootOf(focused.uid)?.activation === "roster_any" && <p className="wbg-warning">
                    这条起点只在指定角色入队时激活：请到「条目与角色」页签为它选择角色，否则保存会被拒绝。
                  </p>}
                  {rootOf(focused.uid)?.activation === "roster_any" && !!rootOf(focused.uid)?.character_ids?.length &&
                    <p className="wbg-help">角色：{rootOf(focused.uid)!.character_ids!.join("、")}</p>}
                </div>
                <div className="wbg-inspector-section">
                  <div className="wbg-section-heading"><h5>必要依赖</h5>
                    <span className="wbg-chip">{requiresFrom(focused.uid).length} 条出边</span></div>
                  <p className="wbg-help">必要条件：上方起点展开时会把它们一起补进来。仅标记相关的关系在「条目与角色」里维护。</p>
                  <label className="wbg-form-label">依赖目标<select className="wbg-field" aria-label="依赖目标条目" value={edgeTo}
                    onChange={(event) => setEdgeTo(event.target.value)}><option value="">选择一个条目</option>
                    {detail.entries.filter((entry) => entry.uid !== focused.uid).map((entry) =>
                      <option key={entry.uid} value={entry.uid}>{entry.name || entry.uid}</option>)}</select></label>
                  <button className="wbg-button" disabled={!edgeTo} onClick={() => addEdge(focused.uid, edgeTo)}>
                    <WorldBookGraphIcon name="link" />添加依赖</button>
                  <div className="wbg-relation-list">
                    {requiresFrom(focused.uid).map((edge) => <div key={edgeKey(edge.from_uid, edge.to_uid)}>
                      <span>→</span><button className="wbg-text-button" onClick={() => inspectEntry(edge.to_uid)}>{label(edge.to_uid)}</button>
                      <button className="wbg-icon-button" aria-label={"删除边 " + label(edge.from_uid) + " → " + label(edge.to_uid)}
                        onClick={() => removeEdge(edge.from_uid, edge.to_uid)}>×</button>
                    </div>)}
                    {requiresTo(focused.uid).map((edge) => <div key={"in:" + edgeKey(edge.from_uid, edge.to_uid)}>
                      <span>←</span><button className="wbg-text-button" onClick={() => inspectEntry(edge.from_uid)}>{label(edge.from_uid)}</button>
                      <button className="wbg-icon-button" aria-label={"删除边 " + label(edge.from_uid) + " → " + label(edge.to_uid)}
                        onClick={() => removeEdge(edge.from_uid, edge.to_uid)}>×</button>
                    </div>)}
                  </div>
                </div>
                <label className="wbg-form-label">归属分类<select className="wbg-field" aria-label="归属分类" value={assignment.category_id} onChange={(event) => {
                  const category = categories.find((item) => item.id === event.target.value);
                  setAssignment({ category_id: event.target.value, character_id: category?.scope_type === "character" ? assignment.character_id : "" });
                }}>{rows.map(({ category, level }) => <option key={category.id} value={category.id}>{"　".repeat(level)}{category.name}</option>)}</select></label>
                {assignmentKind === "character" && <label className="wbg-form-label">关联角色
                  <input className="wbg-field" list={controlId + "-characters"} placeholder="角色目录名" value={assignment.character_id}
                    onChange={(event) => setAssignment({ ...assignment, character_id: event.target.value })} />
                  <datalist id={controlId + "-characters"}>{characters?.map((character) =>
                    <option key={character.id} value={character.id}>{character.name || character.title || character.id}</option>)}</datalist>
                  {characters && assignment.character_id && !characters.some((character) => character.id === assignment.character_id) &&
                    <small className="wbg-warning">角色不存在：保留关联值，但不能自动入队载入。</small>}
                </label>}
                <button className="wbg-button wbg-button-primary" onClick={() => saveAssignment(focused.uid)}>保存归属</button>
              </fieldset>
              <button className="wbg-button wbg-button-quiet" onClick={() => editEntry(focused.uid)}>编辑条目正文 ↗</button>
            </>}
            {!focused && selection?.kind !== "category" && !categoryDraft && <p className="wbg-help">
              从左侧分类树或右侧归属表选择一项：分类可改名与调整层级，条目可设置起点、依赖与归属。
            </p>}
          </>}
        </div>
      </aside>}
    </div>
    <footer className="wbg-taxonomy-foot">
      分类调整不会自动改变候选范围；起点与依赖在「条目与角色」里逐条配置，
      保存前可用「导入预览」核对候选范围。
    </footer>
  </section>;
}
