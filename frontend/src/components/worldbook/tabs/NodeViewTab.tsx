import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../../stores/appStore";
import {
  DEFAULT_EXPAND_NODE_BUDGET, DOWNSTREAM_EDGE_LIMIT, NODE_HEIGHT, NODE_WIDTH, SUBTREE_NODE_LIMIT,
  TRACK_VIRTUALIZE_THRESHOLD, buildNodeViewModel, canAddRequiresEdge, defaultExpandedKeys,
  depthForNodeBudget, downstreamCount, edgeGeometry, edgeVisual, expandKeysToDepth, layoutTrack,
  summarize, visibleBandKeys,
  type NodeViewEdge, type NodeViewNode,
} from "../../../utils/worldbookNodeView";
import type { WorldBookEdgeStatus } from "../../../types";
import type { WorldBookTabProps } from "./types";
import "../../../styles/worldbook-node-view.css";

/** 假设说明（提案 §3.4.2 / §8 假设 1）——「先后」是静态注入顺序键，不是本轮实际命中序列 */
export const NODE_VIEW_ORDER_NOTE =
  "这里的「先后」指静态注入顺序键（position 升序 → group_weight 降序 → depth 升序 → uid 升序），"
  + "不是「本轮一定按这个顺序全部插入」：每轮实际命中是关键词 / 概率 / token 预算决定的子集，"
  + "轨道顺序表达的是「若都被命中时的插入次序」。";

/**
 * 灰节点口径（提案 §3.4.3 + 契约 R-10 澄清）——必须写死。
 *
 * **灰节点有两种来源，文案必须分开**（提案 §8 风险表点名的「灰节点被误读」就在这两种之间）：
 * ① 重复到达（轨道优先 / `cross` 边）：这个 uid 已在别处出现过 → 「已插入过，不重复插入」；
 * ② 灰色只读子树带出的下游：它**可能从未在别处出现过**（`primaryKeys` 里没有它），
 *    只是位于一条重复到达的展开路径上 → 只能说「位于灰色只读子树内，不单独插入」。
 */
export const NODE_VIEW_GRAY_NOTE =
  "灰节点 = 同一 uid 的非主到达，或整条落在灰色只读子树里，来源有两种："
  + "① 重复到达（轨道优先 / cross 边）＝已插入过（路径 A → B → X），不重复插入；"
  + "② 灰色只读子树带出的下游＝它可能从未在别处出现过，只沿这条重复路径出现，不单独插入。"
  + "判定口径与服务端一致——条目在轨道上有位置的，轨道节点是唯一主节点，它向下的出现位置"
  + "（含 cross 边带来的重复到达）一律灰；轨道上没有位置的（已停用 / 空正文），"
  + "只有 first_parent_uid 指向的那次到达是主节点，其余到达为灰；"
  + "灰节点的下游整棵子树同为灰色只读视图（仍保留展开手柄，但只读）。"
  + "灰节点不重复进入候选范围，但是否实际注入仍由关键词、概率、token 预算决定，见「Prompt 预览」。";

/** 灰来源 ② 的固定说法（灰只读子树带出的下游，没有别的主到达位置） */
export const NODE_VIEW_READONLY_SUBTREE_HINT = "位于灰色只读子树内";

/** 空态（提案 §3.4.5） */
export const NODE_VIEW_EMPTY_HINT =
  "先选一本剧情世界书；工作台会按当前统一草稿计算候选范围，再渲染节点视图。";

/** 截断口径（提案 §3.4.7） */
export const NODE_VIEW_TRUNCATE_NOTE = "截断只影响显示，不影响真实候选。";

/** Prompt 预览联动为空时的引导（提案 §3.4.2） */
export const NODE_VIEW_MATCH_HINT = "跑一次「Prompt 预览」后，这里会叠加本轮实际命中的序号。";

/** 只读口径（提案 §3.4.6） */
export const NODE_VIEW_READONLY_NOTE =
  "本页只读：不提供节点拖拽、画布平移缩放、框选、在图上连线，也不持久化节点位置；"
  + "同一份输入永远得到同一张图。";

/**
 * 提案 §3.4.2 的第四档徽标：「全量兼容」。
 *
 * 它不是起点激活方式（`panel.ts` 的 `ACTIVATION_LABELS` 只有 always / roster_any / manual 三档），
 * 而是**本次预览的整档语义**（`preview.full_scope === true`：所有条目都在候选里、依赖闭包不决定范围）。
 * 因此这里本地补一个标签，只在全量兼容提示条上显示，不给 262 个节点各挂一个徽标。
 */
export const FULL_SCOPE_ACTIVATION_LABEL = "全量兼容";

/**
 * 全量兼容下「已在范围内 / 未被任何起点覆盖 / 依赖环」三项统一显示「不适用」的原因说明
 * （F-8：这三项都是依赖闭包的产物，而全量兼容下服务端不解析闭包，`resolved_edges` 为空）。
 */
const FULL_SCOPE_STATS_TITLE =
  "本次为全量兼容（full_scope）：不解析依赖闭包，因此这一项不反映本次范围。";

const DEFAULT_VIEWPORT_WIDTH = 1200;
const LAYER_LABELS: Record<string, string> = { stable: "稳定层", dynamic: "动态层" };
const PROBLEM_LABELS: Record<string, string> = {
  disabled_entry: "停用",
  empty_content: "空正文",
  missing_entry: "缺失",
};

const classNames = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** 节点角标：position（0/1）与 group_weight（非 100 才显示） */
function meterParts(node: NodeViewNode): string[] {
  const parts = [`position ${node.position}`, `depth ${node.entryDepth}`];
  if (node.groupWeight !== 100) parts.push(`weight ${node.groupWeight}`);
  return parts;
}

const pathText = (node: NodeViewNode) => node.path.map((step) => step.name || step.uid).join(" → ");

/**
 * 灰节点是不是「重复到达」（来源 ①）——只有这一类才可以说「已插入过」。
 *
 * 判定只用现成字段，不新造概念：`isExtraArrival`（cross 边带来的重复到达）或该 uid 存在主节点
 * （`primaryKeys`，即它在轨道上或在自己的 `first_parent_uid` 那次到达上已经出现过）。
 * 两者都不成立时（来源 ②）该节点只活在灰色只读子树里，**从未在别处出现过**，不能写成「已插入过」。
 */
const isRepeatArrival = (node: NodeViewNode, primaryKeys: Record<string, string>): boolean =>
  node.isExtraArrival || !!primaryKeys[node.uid];

/** 灰色节点卡片的 hover 说明（两种来源分开写，尾部保留「是否实际注入」的写死口径） */
const grayNodeTitle = (node: NodeViewNode, primaryKeys: Record<string, string>): string => {
  const path = pathText(node);
  return isRepeatArrival(node, primaryKeys)
    ? `已插入过（路径 ${path}），不重复插入；不重复进入候选范围，是否实际注入仍由关键词、概率、token 预算决定`
    : `${NODE_VIEW_READONLY_SUBTREE_HINT}（路径 ${path}）：它只沿这条重复路径出现，别处没有首次出现的位置，不单独插入；`
      + "是否实际注入仍由关键词、概率、token 预算决定";
};

/** 灰色节点卡片上的角标文案 */
const grayNodeChip = (node: NodeViewNode, primaryKeys: Record<string, string>): string => {
  if (node.isExtraArrival) return "重复到达 · 不重复插入";
  return isRepeatArrival(node, primaryKeys) ? "已插入过 · 不重复插入" : "只读子树 · 不单独插入";
};

/**
 * 工作台第 4 个页签：节点视图（A-4，提案 §3.4 全部小节）。
 *
 * 数据只来自 `ctx.preview`（`POST /api/worldbook/<id>/scope-preview` 的结果），不新增解析接口；
 * 所有布局 / 去重投影 / 统计都在 `utils/worldbookNodeView.ts` 的纯函数里，组件只负责渲染与交互
 * （且交互全部只读：不改条目、不连线、不拖拽、不持久化节点位置）。
 *
 * `initialSelectedKey` 是**非契约字段**：不属冻结的 `WorldBookTabProps`，工作台不传，
 * 只供本单元在 SSR 里预设选中节点以断言右侧属性栏，不参与任何线上行为。
 */
export default function NodeViewTab(
  { ctx, onNotice, onReload, initialSelectedKey = "" }:
  WorldBookTabProps & { initialSelectedKey?: string },
) {
  const { detail, preview, previewing, previewError, draft, patch } = ctx;
  const promptPreviewOrder = useAppStore((state) => state.promptPreviewOrder);
  const setWorldbookEntryJump = useAppStore((state) => state.setWorldbookEntryJump);
  const setWorldbookTab = useAppStore((state) => state.setWorldbookTab);

  // 渲染模型先算：默认展开状态要按它取（已激活起点的子树），SSR 第一帧也才有展开结果。
  const model = useMemo(
    () => buildNodeViewModel(preview, detail, promptPreviewOrder),
    [preview, detail, promptPreviewOrder],
  );

  const [selectedKey, setSelectedKey] = useState(initialSelectedKey);
  // 默认只展开已激活起点的子树；若预设了选中节点（深链 / SSR 断言），把它的到达路径一并展开，
  // 否则选中的节点根本不在渲染集合里。
  const [expanded, setExpanded] = useState<string[]>(() => {
    const keys = new Set(defaultExpandedKeys(model));
    let cursor = initialSelectedKey ? model.byKey[initialSelectedKey]?.parentKey || null : null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      keys.add(cursor);
      cursor = model.byKey[cursor]?.parentKey || null;
    }
    return [...keys].sort();
  });
  const [expandedFor, setExpandedFor] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [problemFilter, setProblemFilter] = useState("");
  const [onlyRoots, setOnlyRoots] = useState(false);
  const [onlyMatched, setOnlyMatched] = useState(false);
  const [linkTarget, setLinkTarget] = useState("");
  const [viewport, setViewport] = useState({ left: 0, width: DEFAULT_VIEWPORT_WIDTH });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // 换书 / 重算结果规模变化时重新取默认展开；不动用户的手工展开（除非换了书）。
  const modelSignature = `${detail?.id || ""}|${detail?.content_revision || ""}|${model.track.length}|${model.nodes.length}|${model.promptOrderApplied ? "m" : "-"}`;
  useEffect(() => {
    if (expandedFor === modelSignature) return;
    const changed = expandedFor !== "";
    setExpandedFor(modelSignature);
    setExpanded(defaultExpandedKeys(model));
    if (changed) setSelectedKey("");
  }, [expandedFor, model, modelSignature]);

  const syncViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewport({ left: element.scrollLeft, width: element.clientWidth || DEFAULT_VIEWPORT_WIDTH });
  }, []);

  useEffect(() => {
    syncViewport();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, [syncViewport, modelSignature]);

  const coveredSet = useMemo(() => new Set(model.coveredUids), [model]);
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const node of model.nodes) {
      if (node.categoryId && node.categoryName) seen.set(node.categoryId, node.categoryName);
    }
    return [...seen.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }, [model]);

  // 筛选器：分类 / 问题类型 / 只看起点与依赖闭包 / 只看本轮命中（提案 §3.4.6）
  const filtering = !!categoryFilter || !!problemFilter || onlyRoots || onlyMatched;
  const trackUids = useMemo(() => {
    if (!filtering) return null;
    const keep = new Set<string>();
    for (const row of model.track) {
      const node = model.byKey[row.key];
      if (!node) continue;
      if (categoryFilter && node.categoryId !== categoryFilter) continue;
      if (problemFilter && !node.problems.some((problem) => problem.code === problemFilter)) continue;
      if (onlyRoots && !node.rootBadge && !coveredSet.has(row.uid)) continue;
      if (onlyMatched && node.actualSeq === null) continue;
      keep.add(row.uid);
    }
    return keep;
  }, [categoryFilter, coveredSet, filtering, model, onlyMatched, onlyRoots, problemFilter]);

  const layout = useMemo(
    () => layoutTrack(model, { expanded, trackUids, limit: SUBTREE_NODE_LIMIT }),
    [expanded, model, trackUids],
  );
  const stats = useMemo(() => summarize(model, preview, layout.hiddenCount), [layout.hiddenCount, model, preview]);

  // 轨道条目 > 120 时虚拟化：只渲染与视口相交的轨道带及其子树（R-13）
  const virtualize = model.track.length > TRACK_VIRTUALIZE_THRESHOLD;
  const visibleBands = useMemo(
    () => (virtualize ? visibleBandKeys(layout.bands, viewport.left, viewport.width) : null),
    [layout.bands, viewport.left, viewport.width, virtualize],
  );
  const visibleNodes = useMemo(
    () => (visibleBands ? layout.nodes.filter((node) => visibleBands.has(node.bandKey)) : layout.nodes),
    [layout.nodes, visibleBands],
  );
  const visibleKeys = useMemo(() => new Set(visibleNodes.map((node) => node.key)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => layout.edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to)),
    [layout.edges, visibleKeys],
  );
  const nodeIndex = useMemo(() => new Map(visibleNodes.map((node) => [node.key, node])), [visibleNodes]);

  const selected = selectedKey ? model.byKey[selectedKey] || null : null;
  const expandDepth = useMemo(() => depthForNodeBudget(model), [model]);
  const grayPath = selected && selected.dimmed ? pathText(selected) : "";
  // 「展开到 N 层」是**预算**口径（提案 §3.4.6 只说默认覆盖约 60 个节点），不是固定文案：
  // 本书下游本来就少于预算时直接说「展开全部下游」，不谎报 60。
  const downstreamTotal = useMemo(
    () => model.nodes.filter((node) => node.kind !== "track").length,
    [model],
  );
  const expandLabel = downstreamTotal <= DEFAULT_EXPAND_NODE_BUDGET
    ? `展开全部下游（${downstreamTotal} 个节点）`
    : `展开到覆盖约 ${DEFAULT_EXPAND_NODE_BUDGET} 个节点（${expandDepth} 层）`;

  /* ── 交互 ── */

  const toggleExpanded = (key: string) => {
    setExpanded((current) => (current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key].sort()));
  };

  /**
   * 跳到该 uid 的「首次出现」（主节点）。主节点缺失是合法状态：整条 uid 只出现在灰色只读子树里时
   * 它没有主节点（那时不渲染这个按钮，见节点卡片）。
   */
  const jumpToFirst = (node: NodeViewNode) => {
    const primaryKey = model.primaryKeys[node.uid];
    const primary = primaryKey ? model.byKey[primaryKey] : null;
    if (!primary) return;
    setSelectedKey(primary.key);
    const band = layout.bands.find((item) => item.key === primary.key || item.uid === primary.uid);
    const element = scrollRef.current;
    if (band && element) element.scrollLeft = Math.max(0, band.x0 - 40);
  };

  const jumpToBand = (key: string) => {
    const band = layout.bands.find((item) => item.key === key);
    const element = scrollRef.current;
    if (band && element) element.scrollLeft = Math.max(0, band.x0 - 40);
  };

  const scrollToRatio = (ratio: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const max = Math.max(0, layout.width - element.clientWidth);
    element.scrollLeft = Math.max(0, Math.min(max, ratio * layout.width - element.clientWidth / 2));
    syncViewport();
  };

  const minimapRatio = (clientX: number) => {
    const element = minimapRef.current;
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const editEntry = (node: NodeViewNode) => {
    if (!detail) return;
    setWorldbookEntryJump({ bookId: detail.id, entryUid: node.uid });
    setWorldbookTab("entries");
    onNotice(`已跳到「条目」页签：${node.name}`);
  };

  const addDependency = (node: NodeViewNode) => {
    if (!detail || !linkTarget) return;
    const check = canAddRequiresEdge(draft.requires_edges, node.uid, linkTarget);
    if (!check.ok) {
      onNotice(check.reason);
      return;
    }
    patch({ requires_edges: [...draft.requires_edges, { from_uid: node.uid, to_uid: linkTarget }] });
    onNotice(`已加入统一草稿：${node.name} → ${detail.entries.find((entry) => entry.uid === linkTarget)?.name || linkTarget}（保存后生效）`);
    setLinkTarget("");
  };

  /* ── 状态分支：加载 / 错误 / 空态（提案 §3.4.5）── */

  const state = !detail
    ? { kind: "empty" as const, text: NODE_VIEW_EMPTY_HINT }
    : previewing && !preview
      ? { kind: "loading" as const, text: "正在按当前统一草稿计算候选范围…" }
      : previewError && !preview
        ? { kind: "error" as const, text: `候选范围预览失败：${previewError}` }
        : !preview
          ? { kind: "empty" as const, text: NODE_VIEW_EMPTY_HINT }
          : null;

  const outwardEdges = useMemo(() => {
    type OutwardRow = {
      key: string; edge: NodeViewEdge | null; from: string; to: string;
      relation: "requires" | "related"; status: WorldBookEdgeStatus;
    };
    if (!selected || !preview) return [] as OutwardRow[];
    const rows: OutwardRow[] = [];
    for (const edge of preview.resolved_edges || []) {
      if (edge.from_uid !== selected.uid && edge.to_uid !== selected.uid) continue;
      const drawn = model.edges.find((item) => item.fromUid === edge.from_uid && item.toUid === edge.to_uid) || null;
      rows.push({
        key: `${edge.from_uid}|${edge.to_uid}|${edge.relation}`,
        edge: drawn, from: edge.from_uid, to: edge.to_uid,
        relation: edge.relation,
        status: edge.status || (edge.relation === "related" ? "idle" : "idle"),
      });
      if (rows.length >= DOWNSTREAM_EDGE_LIMIT) break;
    }
    return rows;
  }, [model.edges, preview, selected]);

  const downstream = useMemo(
    () => (selected && preview ? downstreamCount(preview.resolved_edges, selected.uid) : 0),
    [preview, selected],
  );

  return (
    <section className="wbnv" aria-label="节点视图">
      <header className="wbnv-head">
        <div className="wbnv-head-main">
          <p className="wbg-eyebrow">NODE VIEW · A-4</p>
          <h3>节点视图{detail ? ` · ${detail.name}` : ""}</h3>
        </div>
        <p className="wbnv-order-note">{NODE_VIEW_ORDER_NOTE}</p>
      </header>

      {state ? (
        <div className={classNames("wbnv-state", state.kind === "error" && "is-error")}>
          <p className="wbnv-state-text">{state.text}</p>
          {state.kind === "loading" && <p className="wbnv-help">按需载入的书会在这里展开依赖；数据来自已有的候选范围预览，不新增解析接口。</p>}
          {state.kind === "error" && <>
            <p className="wbnv-help">重试会重新拉取这本书的详情并重算候选范围；也可以改一下统一草稿（分类 / 起点 / 依赖）触发重算。</p>
            <button type="button" className="wbg-button" onClick={() => { void onReload(); }}>重试</button>
          </>}
        </div>
      ) : <>
        <div className="wbnv-stats" role="list" aria-label="节点视图统计">
          <span role="listitem"><b>起点数</b>{stats.roots}</span>
          <span role="listitem" title={stats.fullScope ? FULL_SCOPE_STATS_TITLE : undefined}>
            <b>已在范围内</b>{stats.fullScope ? "不适用" : stats.inScope}
          </span>
          <span role="listitem" title={stats.fullScope ? FULL_SCOPE_STATS_TITLE : undefined}>
            <b>未被任何起点覆盖</b>{stats.fullScope ? "不适用" : stats.uncovered}
          </span>
          {/*
            全量兼容下 `resolved_edges` 为空（服务端不解析依赖闭包），照常渲染会显示「依赖环 0 个」，
            与提示条自相矛盾且事实上错误（这本书书级有 2 个环）。这里选**标为不适用**而不是改用
            `detail.dependency_edges` 算书级环：统计条整体是「本次范围」口径，混进一个书级数字会
            出现第二个语义来源；书级依赖关系本身仍可在「分类与载入」与节点属性栏逐条查看。
          */}
          <span role="listitem" title={stats.fullScope
            ? `${FULL_SCOPE_STATS_TITLE}书级依赖关系仍可在「分类与载入」或节点属性栏逐条查看。`
            : `口径：环的个数（一个二元环算 1 个）。环内边共 ${stats.cycleEdges} 条。`}>
            <b>依赖环</b>{stats.fullScope
              ? "不适用"
              : <>{stats.cycles} 个<span className="wbnv-stats-sub">（环内边 {stats.cycleEdges} 条）</span></>}
          </span>
          <span role="listitem"><b>超深度边</b>{stats.cappedEdges}</span>
          <span role="listitem" className={classNames(stats.hidden > 0 && "is-warn")}><b>隐藏节点数</b>{stats.hidden}</span>
          <span className="wbnv-stats-note">统计与序号只算主节点；灰节点只体现在边上与展开里。</span>
        </div>

        <div className="wbnv-toolbar">
          <button type="button" className="wbg-button"
            title={`本书下游共 ${downstreamTotal} 个节点（不含轨道）。`}
            onClick={() => setExpanded(expandKeysToDepth(model, expandDepth))}>
            {expandLabel}
          </button>
          <button type="button" className="wbg-button" onClick={() => setExpanded([])}>折叠全部</button>
          <span className="wbnv-toolbar-sep" />
          <label className="wbg-checkbox-label">
            <input type="checkbox" checked={onlyRoots} onChange={(event) => setOnlyRoots(event.target.checked)} />
            只看起点与依赖闭包
          </label>
          <label className="wbg-checkbox-label" title={NODE_VIEW_MATCH_HINT}>
            <input type="checkbox" checked={onlyMatched} onChange={(event) => setOnlyMatched(event.target.checked)} />
            只看本轮命中
          </label>
          <label className="wbnv-select-label">分类
            <select className="wbg-field" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="">全部分类</option>
              {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="wbnv-select-label">问题
            <select className="wbg-field" value={problemFilter} onChange={(event) => setProblemFilter(event.target.value)}>
              <option value="">全部条目</option>
              <option value="disabled_entry">停用</option>
              <option value="empty_content">空正文</option>
              <option value="missing_entry">缺失</option>
            </select>
          </label>
          {filtering && <button type="button" className="wbg-button wbg-button-quiet" onClick={() => {
            setCategoryFilter(""); setProblemFilter(""); setOnlyRoots(false); setOnlyMatched(false);
          }}>清除筛选</button>}
          <span className="wbnv-toolbar-count">
            {filtering ? `筛选中：显示 ${trackUids ? trackUids.size : model.track.length} / ${model.track.length} 条轨道` : `轨道 ${model.track.length} 条`}
          </span>
        </div>

        <p className="wbnv-legend">
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-solid" />实线箭头 = requires · skeleton（主路径）</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-solid-muted" />灰实线 = requires · cross（目标已被覆盖，渲染为灰节点）</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-dashed" />灰虚线 = requires · capped（遍历深度用尽）</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-dotted" />点线 = related（仅图示，不参与展开）</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-cycle" />红虚线 = 位于依赖环内</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-gray" />灰节点 ① = 重复到达（已插入过，不重复插入）</span>
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-gray" />灰节点 ② = 灰色只读子树带出的下游（只读、不单独插入）</span>
          <span className="wbnv-legend-item">灰 ≠ 一定不注入：是否实际注入仍由关键词、概率、token 预算决定</span>
        </p>
        <p className="wbnv-gray-help">{NODE_VIEW_GRAY_NOTE}</p>
        <p className="wbnv-help">
          {NODE_VIEW_READONLY_NOTE}
          {virtualize ? ` 轨道条目 ${model.track.length} > ${TRACK_VIRTUALIZE_THRESHOLD}：已启用虚拟化，只渲染视口内的节点与其已展开子树。` : ""}
        </p>

        {previewing && <p className="wbnv-warning">正在按当前统一草稿重新计算候选范围…</p>}
        {model.fullScope && (
          <p className="wbnv-full-scope">
            <span className="wbnv-chip is-full-scope">{FULL_SCOPE_ACTIVATION_LABEL}</span>
            本次预览是「全量兼容」（全书条目都在候选里），因此节点视图<strong>不显示依赖闭包</strong>：
            不标「游离」，「已在范围内 / 未被任何起点覆盖 / 依赖环」一律显示为不适用。
            依赖数据本身照旧可读 —— 要看单轮实际注入请用「Prompt 预览」。
          </p>
        )}
        {model.warnings.map((warning) => <p className="wbnv-warning" key={warning}>{warning}</p>)}
        {layout.hiddenCount > 0 && (
          <p className="wbnv-warning">
            已隐藏 {layout.hiddenCount} 个下游节点，可用筛选或展开层级收窄。{NODE_VIEW_TRUNCATE_NOTE}
          </p>
        )}
        {model.promptOrderApplied ? (
          <p className="wbnv-hit-note">
            本轮命中叠加已生效（{LAYER_LABELS[model.promptMode || ""] || "—"}）：节点右下的实心圆点与数字是「本轮实际注入序号」，
            左上的数字是轨道上的「静态注入位次」——两个序号含义不同。
          </p>
        ) : (
          <p className="wbnv-hit-note is-empty">
            {NODE_VIEW_MATCH_HINT}
            {promptPreviewOrder && detail && promptPreviewOrder.bookId !== detail.id
              ? `（当前叠加来自另一本书：${promptPreviewOrder.bookId}）` : ""}
            <button type="button" className="wbg-text-button" onClick={() => setWorldbookTab("prompt")}>去跑 Prompt 预览</button>
          </p>
        )}

        <div className="wbnv-body">
          <div className="wbnv-stage">
            <div className="wbnv-scroll" ref={scrollRef} onScroll={syncViewport}>
              <div className="wbnv-canvas" style={{ width: layout.width, height: layout.height }}>
                <svg className="wbnv-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  <defs>
                    <marker id="wbnv-arrow-primary" className="wbnv-arrow-primary" viewBox="0 0 8 8"
                      refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" />
                    </marker>
                    <marker id="wbnv-arrow-muted" className="wbnv-arrow-muted" viewBox="0 0 8 8"
                      refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" />
                    </marker>
                    <marker id="wbnv-arrow-cycle" className="wbnv-arrow-cycle" viewBox="0 0 8 8"
                      refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" />
                    </marker>
                  </defs>
                  {visibleEdges.map((edge) => {
                    const from = nodeIndex.get(edge.from);
                    const to = nodeIndex.get(edge.to);
                    if (!from || !to) return null;
                    const visual = edgeVisual(edge.status, edge.relation, edge.inCycle);
                    const geometry = edgeGeometry(from, to);
                    const arrowId = visual.colorRole === "primary" ? "wbnv-arrow-primary"
                      : visual.colorRole === "cycle" ? "wbnv-arrow-cycle" : "wbnv-arrow-muted";
                    return (
                      <g key={edge.key} className={classNames("wbnv-edge", `line-${visual.lineStyle}`, `role-${visual.colorRole}`)}>
                        <title>{`${edge.fromUid} → ${edge.toUid}：${visual.label}`}</title>
                        <path d={geometry.d} markerEnd={visual.arrow ? `url(#${arrowId})` : undefined} />
                      </g>
                    );
                  })}
                </svg>

                {visibleNodes.map((place) => {
                  const node = model.byKey[place.key];
                  if (!node) return null;
                  const visual = node.arrivalStatus ? edgeVisual(node.arrivalStatus, "requires", false) : null;
                  const primaryKey = model.primaryKeys[node.uid] || "";
                  const canJumpToFirst = node.dimmed && !!primaryKey && primaryKey !== node.key;
                  return (
                    <div
                      key={node.key}
                      role="button"
                      tabIndex={0}
                      className={classNames(
                        "wbnv-node",
                        `is-${node.kind}`,
                        node.dimmed && "is-gray",
                        node.isPrimary && node.rootBadge && "is-root",
                        node.loose && "is-loose",
                        node.problems.length > 0 && "has-problem",
                        selectedKey === node.key && "is-selected",
                        place.truncated && "is-truncated",
                      )}
                      style={{ left: place.x, top: place.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      title={node.dimmed
                        ? grayNodeTitle(node, model.primaryKeys)
                        : `${node.name}（${node.uid}）`}
                      onClick={() => setSelectedKey(node.key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(node.key); }
                      }}
                    >
                      {node.trackSeq !== null && <span className="wbnv-seq" title="静态注入位次（position → group_weight → depth → uid）">{node.trackSeq + 1}</span>}
                      <span className="wbnv-node-name">{node.name}</span>
                      <span className="wbnv-node-uid">{node.uid}</span>
                      <span className="wbnv-node-meter">{meterParts(node).join(" · ")}</span>
                      {node.rootBadge && (
                        <span className="wbnv-chip is-root" title={`起点：${node.rootBadge.activationLabel} · ${node.rootBadge.expansionLabel}`}>
                          {node.rootBadge.activationLabel} · {node.rootBadge.expansionLabel}
                        </span>
                      )}
                      {node.loose && <span className="wbnv-chip is-loose" title="未被任何起点覆盖（游离条目）">游离</span>}
                      {node.isRoot && !node.rootBadge && <span className="wbnv-chip is-root">起点</span>}
                      {node.problems.slice(0, 2).map((problem) => (
                        <span className="wbnv-chip is-problem" key={problem.code}
                          title={problem.message}>{PROBLEM_LABELS[problem.code] || problem.code}</span>
                      ))}
                      {node.dimmed && (
                        <span className="wbnv-chip is-gray" title={grayNodeTitle(node, model.primaryKeys)}>
                          {grayNodeChip(node, model.primaryKeys)}
                        </span>
                      )}
                      {node.isPrimary && node.hasRepeatedArrival && (
                        <span className="wbnv-chip is-repeat-hint"
                          title="服务端 display_tree.repeated：该 uid 在闭包内多于一次到达（另有被遍历的 requires 入边或作为起点被激活）。这个标记只说明「另有到达」，灰出现的全部来源不止于此">
                          另有到达
                        </span>
                      )}
                      {node.actualSeq !== null && (
                        <span className="wbnv-hit" title={`本轮实际命中序号 #${node.actualSeq + 1}（${LAYER_LABELS[node.actualLayer || ""] || "—"}）`}>
                          ● {node.actualSeq + 1}
                        </span>
                      )}
                      {place.hasChildren && (
                        <button type="button" className="wbnv-handle"
                          title={place.expanded ? "折叠这个分支" : `展开这个分支（${node.childKeys.length} 个直接下游）`}
                          onClick={(event) => { event.stopPropagation(); toggleExpanded(node.key); }}>
                          {place.expanded ? "−" : "+"}{node.childKeys.length}
                        </button>
                      )}
                      {canJumpToFirst && (
                        <button type="button" className="wbnv-jump"
                          onClick={(event) => { event.stopPropagation(); jumpToFirst(node); }}>
                          跳到首次出现
                        </button>
                      )}
                      {visual && node.arrivalStatus !== "skeleton" && (
                        <span className="wbnv-chip is-edge" title={visual.label}>{node.arrivalStatus}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              className="wbnv-minimap"
              ref={minimapRef}
              title="缩略进度条：点击或拖动跳到轨道对应位置"
              onPointerDown={(event) => { draggingRef.current = true; scrollToRatio(minimapRatio(event.clientX)); }}
              onPointerMove={(event) => { if (draggingRef.current) scrollToRatio(minimapRatio(event.clientX)); }}
              onPointerUp={() => { draggingRef.current = false; }}
              onPointerLeave={() => { draggingRef.current = false; }}
            >
              <div className="wbnv-minimap-bands">
                {layout.bands.map((band) => (
                  <span key={band.key} className={classNames("wbnv-minimap-band", band.topLevel === false && "is-sub")}
                    style={{ left: `${(band.x0 / Math.max(1, layout.width)) * 100}%`, width: `${Math.max(0.2, ((band.x1 - band.x0) / Math.max(1, layout.width)) * 100)}%` }}
                    title={band.seq === null ? band.uid : `#${band.seq + 1} ${band.uid}`} />
                ))}
              </div>
              <div className="wbnv-minimap-view" style={{
                left: `${(viewport.left / Math.max(1, layout.width)) * 100}%`,
                width: `${Math.max(2, (viewport.width / Math.max(1, layout.width)) * 100)}%`,
              }} />
            </div>
          </div>

          <aside className="wbnv-inspector" aria-label="节点属性">
            {!selected ? (
              <p className="wbnv-help">点一个节点，这里显示它的 uid、分类、position / depth / group_weight、是否被起点激活、到达路径、下游规模与问题列表。</p>
            ) : <>
              <h4>{selected.name}</h4>
              <p className="wbnv-uid">{selected.uid}</p>
              <dl className="wbnv-facts">
                <div><dt>分类</dt><dd>{selected.categoryName || "未分类"}</dd></div>
                <div><dt>position</dt><dd>{selected.position}</dd></div>
                <div><dt>depth</dt><dd>{selected.entryDepth}</dd></div>
                <div><dt>group_weight</dt><dd>{selected.groupWeight}</dd></div>
                <div><dt>静态位次</dt><dd>{selected.trackSeq === null ? "不在轨道上" : `#${selected.trackSeq + 1}`}</dd></div>
                <div><dt>本轮命中</dt><dd>{selected.actualSeq === null ? "本轮未命中（或还没跑 Prompt 预览）" : `#${selected.actualSeq + 1} · ${LAYER_LABELS[selected.actualLayer || ""] || "—"}`}</dd></div>
                <div><dt>起点激活</dt><dd>{selected.rootBadge
                  ? `${selected.rootBadge.activationLabel} · ${selected.rootBadge.expansionLabel}`
                  : "不是起点"}</dd></div>
                <div><dt>下游规模</dt><dd>{downstream} 条（requires 闭包去重）</dd></div>
                <div><dt>这次到达</dt><dd>{selected.kind === "track" ? "轨道自身（注入位次）"
                  : selected.isExtraArrival ? `cross 边重复到达 ← ${selected.arrivalFrom || "?"}`
                    : `主到达 ← ${selected.arrivalFrom || "起点"}`}</dd></div>
                {selected.hasRepeatedArrival && (
                  <div><dt>另有到达</dt><dd>闭包内多于一次到达（被遍历的 requires 入边 / 作为起点激活）</dd></div>
                )}
              </dl>

              <section className="wbnv-block">
                <h5>到达路径</h5>
                <div className="wbnv-crumbs">
                  {selected.path.map((step, index) => (
                    <span className="wbnv-crumb-item" key={`${step.uid}-${index}`}>
                      {index > 0 && <span className="wbnv-crumb-sep">→</span>}
                      {index === selected.path.length - 1 || !step.key
                        ? <span className="wbnv-crumb is-current">{step.name}</span>
                        : <button type="button" className="wbnv-crumb"
                          onClick={() => { setSelectedKey(step.key); jumpToBand(step.key); }}>{step.name}</button>}
                    </span>
                  ))}
                </div>
                {selected.dimmed && <p className="wbnv-gray-help">
                  {isRepeatArrival(selected, model.primaryKeys)
                    ? `已插入过（路径 ${grayPath}），不重复插入。`
                    : `${NODE_VIEW_READONLY_SUBTREE_HINT}（路径 ${grayPath}）：它只沿这条重复路径出现，`
                      + "别处没有首次出现的位置，不单独插入。"}
                  是否实际注入仍由关键词、概率、token 预算决定，见「Prompt 预览」。
                </p>}
                {selected.isPrimary && selected.hasRepeatedArrival && (
                  <p className="wbnv-help">
                    服务端 repeated 只说明「闭包内多于一次到达」；它与灰出现是单向关系——
                    灰集合是它的超集（轨道优先与灰色传播都会产生灰出现），所以本节点不是灰的
                    不代表这个条目没有灰出现。
                  </p>
                )}
              </section>

              {selected.problems.length > 0 && (
                <section className="wbnv-block">
                  <h5>问题</h5>
                  <ul className="wbnv-issue-list">
                    {selected.problems.map((problem, index) => (
                      <li key={`${problem.code}-${index}`}>
                        <b>{PROBLEM_LABELS[problem.code] || problem.code}</b>{problem.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="wbnv-block">
                <h5>依赖边（共 {outwardEdges.length} 条）</h5>
                {outwardEdges.length === 0
                  ? <p className="wbnv-help">这条没有 requires / related 关系。</p>
                  : <ul className="wbnv-edge-list">
                    {outwardEdges.map((row) => {
                      const visual = edgeVisual(row.status as never, row.relation, !!row.edge?.inCycle);
                      return (
                        <li key={row.key}>
                          <i className={classNames("wbnv-swatch", `is-${visual.lineStyle}`, `role-${visual.colorRole}`)} />
                          <span className="wbnv-edge-text">
                            {row.from === selected.uid ? "→" : "←"} {row.from === selected.uid ? row.to : row.from}
                          </span>
                          <small>{visual.label}</small>
                        </li>
                      );
                    })}
                  </ul>}
              </section>

              <div className="wbnv-actions">
                <button type="button" className="wbg-button wbg-button-primary" onClick={() => editEntry(selected)}>编辑条目</button>
                <div className="wbnv-add-dep">
                  <select className="wbg-field" value={linkTarget} onChange={(event) => setLinkTarget(event.target.value)}>
                    <option value="">选择要依赖的条目…</option>
                    {detail?.entries.map((entry) => (
                      <option key={entry.uid} value={entry.uid}>{entry.name || entry.uid}</option>
                    ))}
                  </select>
                  <button type="button" className="wbg-button" disabled={!linkTarget}
                    onClick={() => addDependency(selected)}>加依赖</button>
                </div>
                <p className="wbnv-help">
                  「加依赖」只写统一草稿（自环与重复边会被拦住），保存由工作台一次原子写入；本页不连线、不拖拽、不持久化节点位置。
                </p>
              </div>
            </>}
          </aside>
        </div>
      </>}
    </section>
  );
}
