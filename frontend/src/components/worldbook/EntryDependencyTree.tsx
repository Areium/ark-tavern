import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import type { WorldBookDependencyTreeDTO, WorldBookDetail } from "../../types";
import type { WorldBookDraft } from "../../hooks/useWorldbookDraft";
import {
  MAX_DEPENDENCY_TREE_ROWS, RELATION_LABELS, STATIC_RELATION_NOTE,
  buildDependencyTree, type DependencyTreeResult, type DependencyTreeRow,
} from "../../utils/worldbookDependencyTree";
import "../../styles/worldbook-prompt-preview.css";

/**
 * 条目依赖逐层展开（A-3）。
 *
 * 这是**行内**组件：工作台「条目」列表与「分类与载入 → 条目与角色」列表的每一行各挂一个，
 * 因此
 *  - 展开状态由本组件自己持有 → 两处列表互不影响（提案 §3.3），也不碰列表的筛选与分页；
 *  - **首次展开才请求**：挂载即请求会让 261 条的书一次打 261 个请求；
 *  - 三角的有无只按统一草稿里的 `requires` 出边判断，不为了画三角先打一次网络。
 *
 * 数据只来自 `GET /api/worldbook/<id>/dependency-tree`（与后端 `resolve_v3_scope` 同一段 BFS）。
 * 前端不自行截断依赖闭包：`remaining==0` 与环内节点都是服务端已经终止遍历的情况。
 */
export interface EntryDependencyTreeProps {
  detail: WorldBookDetail;
  rootUids: string[];
  draft: WorldBookDraft;
  patch: (changes: Partial<WorldBookDraft>) => void;
  onNotice: (text: string) => void;
}

const SWALLOW = "\u0000";

/** 依赖树请求：防抖 + 过时响应保护（照抄 `hooks/useWorldbookDraft.ts` 的 `useScopePreview`）。 */
function useDependencyTree(bookId: string, rootKey: string, enabled: boolean) {
  const api = useApi();
  const [data, setData] = useState<WorldBookDependencyTreeDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    const seq = ++sequence.current;
    if (!enabled || !bookId || !rootKey) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      // 一次传全部起点 uid，拿回整棵子树，避免逐层往返
      api.getWorldbookDependencyTree(bookId, rootKey.split(SWALLOW))
        .then((value) => { if (seq === sequence.current) { setData(value); setError(""); } })
        .catch((e) => {
          if (seq !== sequence.current) return;      // 过时响应直接丢弃
          setData(null);
          setError(e instanceof Error ? e.message : "依赖树加载失败");
        })
        .finally(() => { if (seq === sequence.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [api, bookId, rootKey, enabled, nonce]);

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, retry };
}

/**
 * 纯展示层：把 `buildDependencyTree` 的结果渲染成静态标记。
 * 不发请求、不读草稿，SSR 与纯逻辑测试直接渲染它。
 */
export function DependencyTreeRows({
  tree, requiresOnly, onToggleRow, onForceRow, renderEdit,
}: {
  tree: DependencyTreeResult;
  requiresOnly: boolean;
  onToggleRow?: (row: DependencyTreeRow) => void;
  onForceRow?: (row: DependencyTreeRow) => void;
  renderEdit?: (row: DependencyTreeRow) => React.ReactNode;
}) {
  const renderRow = (row: DependencyTreeRow): React.ReactNode => <div key={row.key} className="wbd-node">
    <div className={"wbd-row" + (row.dimmed ? " is-dim" : "") + (row.viaCycleEdge ? " is-cycle" : "")}
      data-wbd-depth={row.depth} data-wbd-repeat={row.repeated ? "1" : "0"}>
      {row.expandable
        ? <button type="button" className="wbd-tri" aria-expanded={row.expanded}
            aria-label={`${row.expanded ? "折叠" : "展开"} ${row.name} 的必要依赖`}
            onClick={() => onToggleRow?.(row)}>{row.expanded ? "▾" : "▸"}</button>
        : <span className="wbd-tri is-empty" aria-hidden="true">•</span>}
      <strong className="wbd-name">{row.name}</strong>
      <span className="wbd-uid">{row.uid}</span>
      <span className="wbd-badge is-requires" title="必要依赖：参与展开">{RELATION_LABELS.requires}</span>
      {row.requiresChildCount > 0 && <span className="wbd-count" title="requires 出边数">{row.requiresChildCount}</span>}
      {row.viaCycleEdge && <span className="wbd-badge is-cycle">依赖环</span>}
      {row.statusLabel && <span className="wbd-badge is-status">{row.statusLabel}</span>}
      <span className="wbd-remaining">{row.remainingLabel}</span>
    </div>

    {row.repeated && <div className="wbd-dup">
      已在上层展开（路径：{row.duplicatePath || row.pathLabel}）
      {row.forceable && <> · <button type="button" className="wbd-force"
        onClick={() => onForceRow?.(row)}>仍要展开（仅查看）</button></>}
    </div>}

    {!requiresOnly && row.relatedUids.length > 0 && <div className="wbd-related">
      <span className="wbd-badge is-related">{RELATION_LABELS.related}</span>
      <span>{row.relatedUids.map((item) => item.name).join("、")}（不参与展开）</span>
    </div>}

    {row.stopNote && !row.repeated && <div className="wbd-note">{row.stopNote}</div>}

    {onToggleRow && renderEdit && row.expanded && renderEdit(row)}

    {row.children.length > 0 && <div className="wbd-children">{row.children.map(renderRow)}</div>}
  </div>;

  return <div className="wbd-list">
    <div className="wbd-note is-static" role="note">{STATIC_RELATION_NOTE}</div>
    {tree.rows.map(renderRow)}
    {tree.truncated && <div className="wbd-note">
      显示已截断：只渲染前 {MAX_DEPENDENCY_TREE_ROWS} 行下游节点，收窄展开层数可看全（只影响显示，不影响候选）。
    </div>}
  </div>;
}

/** 单行右侧的编辑入口：关系选择器 + 目标条目下拉，写进统一草稿（不做拖拽连线）。 */
function RowEdgeEditor({
  row, detail, draft, patch, onNotice,
}: {
  row: { uid: string; name: string };
  detail: WorldBookDetail;
  draft: WorldBookDraft;
  patch: (changes: Partial<WorldBookDraft>) => void;
  onNotice: (text: string) => void;
}) {
  const [relation, setRelation] = useState<"requires" | "related">("requires");
  const [target, setTarget] = useState("");
  const targets = useMemo(
    () => detail.entries.filter((entry) => entry.uid !== row.uid)
      .map((entry) => ({ uid: entry.uid, name: entry.name || entry.uid }))
      .sort((a, b) => (a.name === b.name ? a.uid.localeCompare(b.uid) : a.name.localeCompare(b.name))),
    [detail.entries, row.uid],
  );
  const outEdges = useMemo(() => [
    ...draft.requires_edges.filter((edge) => edge.from_uid === row.uid)
      .map((edge) => ({ ...edge, relation: "requires" as const })),
    ...draft.related_edges.filter((edge) => edge.from_uid === row.uid)
      .map((edge) => ({ ...edge, relation: "related" as const })),
  ], [draft.requires_edges, draft.related_edges, row.uid]);
  const nameOfUid = (uid: string) =>
    detail.entries.find((entry) => entry.uid === uid)?.name || uid;

  const addEdge = () => {
    if (!target) return;
    if (target === row.uid) { onNotice("条目不能依赖自己（自环会被后端拒绝）。"); return; }
    const list = relation === "requires" ? draft.requires_edges : draft.related_edges;
    if (list.some((edge) => edge.from_uid === row.uid && edge.to_uid === target)) {
      onNotice("这条依赖已经在草稿里了。");
      return;
    }
    const next = [...list, { from_uid: row.uid, to_uid: target }];
    patch(relation === "requires" ? { requires_edges: next } : { related_edges: next });
    setTarget("");
    onNotice(`已写入草稿：${row.name} → ${nameOfUid(target)}（由页头「保存」一次提交）。`);
  };

  const removeEdge = (edgeRelation: "requires" | "related", toUid: string) => {
    const list = edgeRelation === "requires" ? draft.requires_edges : draft.related_edges;
    const next = list.filter((edge) => !(edge.from_uid === row.uid && edge.to_uid === toUid));
    patch(edgeRelation === "requires" ? { requires_edges: next } : { related_edges: next });
    onNotice(`已从草稿移除：${row.name} → ${nameOfUid(toUid)}（保存后生效）。`);
  };

  return <div className="wbd-edit">
    <select aria-label={`${row.name} 的关系类型`} value={relation}
      onChange={(event) => setRelation(event.target.value === "related" ? "related" : "requires")}>
      <option value="requires">必要依赖（参与展开）</option>
      <option value="related">仅提示相关（不展开）</option>
    </select>
    <select aria-label={`${row.name} 的目标条目`} value={target}
      onChange={(event) => setTarget(event.target.value)}>
      <option value="">选择目标条目…</option>
      {targets.map((item) => <option key={item.uid} value={item.uid}>{item.name}（{item.uid}）</option>)}
    </select>
    <button type="button" onClick={addEdge} disabled={!target}>＋加依赖</button>
    {outEdges.map((edge) => <button type="button" key={`${edge.relation}:${edge.to_uid}`}
      aria-label={`移除 ${row.name} 的${edge.relation === "requires" ? "必要依赖" : "关联补充"} ${nameOfUid(edge.to_uid)}`}
      onClick={() => removeEdge(edge.relation, edge.to_uid)}>
      －移除 {nameOfUid(edge.to_uid)}
    </button>)}
  </div>;
}

export default function EntryDependencyTree({ detail, rootUids, draft, patch, onNotice }: EntryDependencyTreeProps) {
  const [open, setOpen] = useState(false);
  // 默认展开 1 层
  const [expandedDepth, setExpandedDepth] = useState(1);
  const [depthInput, setDepthInput] = useState("1");
  const [requiresOnly, setRequiresOnly] = useState(false);
  const [forced, setForced] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const rootKey = rootUids.join(SWALLOW);
  const roots = useMemo(() => (rootKey ? rootKey.split(SWALLOW) : []), [rootKey]);
  const { data, loading, error, retry } = useDependencyTree(detail.id, rootKey, open);

  // 三角的有无只看草稿里的 requires 出边（related 出边不算展开来源）
  const rootRequiresCount = useMemo(
    () => draft.requires_edges.filter((edge) => roots.includes(edge.from_uid)).length,
    [draft.requires_edges, roots],
  );
  const rootRelatedCount = useMemo(
    () => draft.related_edges.filter((edge) => roots.includes(edge.from_uid)).length,
    [draft.related_edges, roots],
  );
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of detail.entries) map[entry.uid] = entry.name || entry.uid;
    return map;
  }, [detail.entries]);

  const tree = useMemo(() => (data ? buildDependencyTree(data, {
    rootUids: roots, expandedDepth, requiresOnly, forced, collapsed,
    relatedEdges: draft.related_edges, names,
  }) : null), [data, roots, expandedDepth, requiresOnly, forced, collapsed, draft.related_edges, names]);

  const toggleRow = useCallback((row: DependencyTreeRow) => {
    if (row.expanded) {
      setForced((list) => list.filter((key) => key !== row.key));
      setCollapsed((list) => (list.includes(row.key) ? list : [...list, row.key]));
      return;
    }
    setCollapsed((list) => list.filter((key) => key !== row.key));
    setForced((list) => (list.includes(row.key) ? list : [...list, row.key]));
  }, []);

  const applyDepth = () => {
    const parsed = Number.parseInt(depthInput, 10);
    const value = Number.isFinite(parsed) ? Math.min(32, Math.max(0, parsed)) : 1;
    setDepthInput(String(value));
    setExpandedDepth(value);
    setCollapsed([]);
    setForced([]);
  };
  const collapseAll = () => {
    setExpandedDepth(0);
    setDepthInput("0");
    setCollapsed([]);
    setForced([]);
  };

  if (!roots.length) return <div className="wbd">
    <p className="wbd-note">这条条目没有可展开的依赖。</p>
  </div>;

  if (!rootRequiresCount) {
    const rootName = detail.entries.find((entry) => entry.uid === roots[0])?.name || roots[0];
    return <div className="wbd">
      <p className="wbd-note" title="只有「必要依赖（requires）」出边才参与展开">
        没有可展开的必要依赖{rootRelatedCount
          ? `；另有 ${rootRelatedCount} 条关联补充（仅提示、不参与展开）`
          : ""}。
      </p>
      {/* 没有依赖的条目也要能在这里加第一条（仍然只写统一草稿，由页头一次保存） */}
      <RowEdgeEditor row={{ uid: roots[0], name: rootName }} detail={detail} draft={draft}
        patch={patch} onNotice={onNotice} />
    </div>;
  }

  return <div className="wbd">
    <button type="button" className="wbd-toggle" aria-expanded={open}
      onClick={() => setOpen((value) => !value)}>
      <span className="wbd-tri" aria-hidden="true">{open ? "▾" : "▸"}</span>
      依赖展开
      <span className="wbd-count" title="requires 出边数">{rootRequiresCount}</span>
    </button>

    {open && <div className="wbd-toolbar">
      <label>展开到
        <input type="number" min={0} max={32} value={depthInput} aria-label="展开层数"
          onChange={(event) => setDepthInput(event.target.value)} />
        层
      </label>
      <button type="button" onClick={applyDepth}>展开到 N 层</button>
      <button type="button" onClick={collapseAll}>折叠全部</button>
      <label>
        <input type="checkbox" checked={requiresOnly}
          onChange={(event) => setRequiresOnly(event.target.checked)} />
        只看 requires（隐藏 related）
      </label>
      <button type="button" onClick={retry} disabled={loading}>{loading ? "读取中…" : "重新读取"}</button>
    </div>}

    {open && loading && !tree && <p className="wbd-note">正在读取依赖树…</p>}
    {open && error && <div className="wbd-note is-static" role="alert">
      依赖树加载失败：{error}
      <button type="button" className="wbd-force" onClick={retry}>重试</button>
    </div>}
    {open && tree && <DependencyTreeRows tree={tree} requiresOnly={requiresOnly}
      onToggleRow={toggleRow} onForceRow={toggleRow}
      renderEdit={(row) => <RowEdgeEditor row={row} detail={detail} draft={draft}
        patch={patch} onNotice={onNotice} />} />}
    {open && tree && !tree.rows.length && !error && <p className="wbd-note">
      服务端没有返回这条条目的依赖节点。
    </p>}
  </div>;
}
