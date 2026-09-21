import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../../stores/appStore";
import {
  DEFAULT_EXPAND_NODE_BUDGET, DOWNSTREAM_EDGE_LIMIT, NODE_HEIGHT, NODE_WIDTH, SUBTREE_NODE_LIMIT,
  TRACK_VIRTUALIZE_THRESHOLD, buildNodeViewModel, canAddRequiresEdge, defaultExpandedKeys,
  depthForNodeBudget, downstreamCount, edgeGeometry, edgeVisual, expandKeysToDepth, layoutTrack,
  summarize, trackNodeKey, visibleBandKeys,
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

/** 灰节点口径（提案 §3.4.3 + 契约 R-10 澄清）——必须写死，避免被读成「绝对不会注入」 */
export const NODE_VIEW_GRAY_NOTE =
  "灰节点 = 同一 uid 的非主到达：已插入过（路径 A → B → X），不重复插入。判定口径与服务端一致——"
  + "条目在轨道上有位置的，轨道节点是唯一主节点，它向下的出现位置（含 cross 边带来的重复到达）一律灰；"
  + "轨道上没有位置的（已停用 / 空正文），只有 first_parent_uid 指向的那次到达是主节点，其余到达为灰。"
  + "灰节点不重复进入候选范围，但是否实际注入仍由关键词、概率、token 预算决定，见「Prompt 预览」。";

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
  const [expanded, setExpanded] = useState<string[]>(() => defaultExpandedKeys(model));
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
  const grayPath = selected && selected.isRepeated ? pathText(selected) : "";

  /* ── 交互 ── */

  const toggleExpanded = (key: string) => {
    setExpanded((current) => (current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key].sort()));
  };

  const jumpToFirst = (node: NodeViewNode) => {
    const primary = model.byKey[trackNodeKey(node.uid)]
      || model.nodes.find((item) => item.uid === node.uid && item.isPrimary);
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
          <span role="listitem"><b>已在范围内</b>{stats.inScope}</span>
          <span role="listitem"><b>未被任何起点覆盖</b>{stats.uncovered}</span>
          <span role="listitem"><b>依赖环</b>{stats.cycles}</span>
          <span role="listitem"><b>超深度边</b>{stats.cappedEdges}</span>
          <span role="listitem" className={classNames(stats.hidden > 0 && "is-warn")}><b>隐藏节点数</b>{stats.hidden}</span>
          <span className="wbnv-stats-note">统计与序号只算主节点；灰节点只体现在边上与展开里。</span>
        </div>

        <div className="wbnv-toolbar">
          <button type="button" className="wbg-button" onClick={() => setExpanded(expandKeysToDepth(model, expandDepth))}>
            展开到 {expandDepth} 层（约 {DEFAULT_EXPAND_NODE_BUDGET} 个节点）
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
          <span className="wbnv-legend-item"><i className="wbnv-swatch is-gray" />灰节点 = 已插入过，不重复插入</span>
        </p>
        <p className="wbnv-gray-help">{NODE_VIEW_GRAY_NOTE}</p>
        <p className="wbnv-help">
          {NODE_VIEW_READONLY_NOTE}
          {virtualize ? ` 轨道条目 ${model.track.length} > ${TRACK_VIRTUALIZE_THRESHOLD}：已启用虚拟化，只渲染视口内的节点与其已展开子树。` : ""}
        </p>

        {previewing && <p className="wbnv-warning">正在按当前统一草稿重新计算候选范围…</p>}
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
                  return (
                    <div
                      key={node.key}
                      role="button"
                      tabIndex={0}
                      className={classNames(
                        "wbnv-node",
                        `is-${node.kind}`,
                        node.isRepeated && "is-gray",
                        node.isPrimary && node.rootBadge && "is-root",
                        node.loose && "is-loose",
                        node.problems.length > 0 && "has-problem",
                        selectedKey === node.key && "is-selected",
                        place.truncated && "is-truncated",
                      )}
                      style={{ left: place.x, top: place.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      title={node.isRepeated
                        ? `已插入过（路径 ${pathText(node)}），不重复插入；不重复进入候选范围，是否实际注入仍由关键词、概率、token 预算决定`
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
                      {node.isRepeated && (
                        <span className="wbnv-chip is-gray" title={`已插入过（路径 ${pathText(node)}），不重复插入`}>
                          {node.isExtraArrival ? "重复到达 · 不重复插入" : "灰色 · 不重复插入"}
                        </span>
                      )}
                      {node.isPrimary && node.hasRepeatedArrival && (
                        <span className="wbnv-chip is-repeat-hint"
                          title="服务端 display_tree.repeated：这个条目在闭包内有多条 requires 入边，因此在本视图里还会以灰节点出现">
                          另有灰出现
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
                      {node.isRepeated && (
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
                  <div><dt>重复到达</dt><dd>闭包内有多条 requires 入边，另有灰出现</dd></div>
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
                {selected.isRepeated && <p className="wbnv-gray-help">已插入过（路径 {grayPath}），不重复插入。</p>}
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
