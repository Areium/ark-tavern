import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorldBookDetail } from "../../types";
import type { WorldBookDraft } from "../../hooks/useWorldbookDraft";
import {
  MAX_DEPENDENCY_TREE_ROWS, RELATION_LABELS, STATIC_RELATION_NOTE,
  type DependencyTreeResult, type DependencyTreeRow,
} from "../../utils/worldbookDependencyTree";
import "../../styles/worldbook-prompt-preview.css";

/**
 * 条目依赖逐层展开（A-3）。
 *
 * 条目页的只读依赖阅读器。它直接使用当前详情与统一配置草稿，逐层展示正文；
 * 环、重复路径和深度上限都会停止继续展开，避免异常数据造成无限递归。
 */
export interface EntryDependencyTreeProps {
  detail: WorldBookDetail;
  rootUids: string[];
  draft: WorldBookDraft;
  /** Legacy callers may still pass these; the entries page is deliberately read-only. */
  patch?: (changes: Partial<WorldBookDraft>) => void;
  onNotice?: (text: string) => void;
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

export default function EntryDependencyTree({ detail, rootUids, draft }: EntryDependencyTreeProps) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const entries = useMemo(() => new Map(detail.entries.map((entry) => [entry.uid, entry])), [detail.entries]);
  const children = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of draft.requires_edges) {
      const list = map.get(edge.from_uid) || [];
      if (!list.includes(edge.to_uid)) list.push(edge.to_uid);
      map.set(edge.from_uid, list);
    }
    return map;
  }, [draft.requires_edges]);
  const direct = rootUids.flatMap((uid) => children.get(uid) || []);
  if (!direct.length) return null;

  let rendered = 0;
  const renderRow = (uid: string, depth: number, path: string[]): React.ReactNode => {
    if (rendered++ >= 80) return <div className="wber-dep-limit" key={`${uid}-${depth}`}>其余依赖已省略</div>;
    const entry = entries.get(uid);
    if (!entry) return <div className="wber-dep-node" key={`${path.join(">")}>${uid}`}
      style={{ marginLeft: `${Math.min(depth, 8) * 18}px` }}>
      <div className="wber-dep-row is-missing"><span>•</span><strong>{uid}</strong><small>条目不可用</small></div>
    </div>;
    const cycle = path.includes(uid);
    const capped = depth >= 8;
    const key = `${path.join(">")}>${uid}`;
    const isOpen = opened.has(key);
    const descendants = children.get(uid) || [];
    return <div className="wber-dep-node" key={key} style={{ marginLeft: `${Math.min(depth, 8) * 18}px` }}>
      <button type="button" className="wber-dep-row" disabled={cycle}
        aria-expanded={!cycle && isOpen} onClick={() => setOpened((current) => {
          const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
        })}>
        <span>{cycle || capped || (!entry.content && !descendants.length) ? "•" : isOpen ? "▾" : "▸"}</span>
        <strong>{entry.name || entry.uid}</strong>
        {cycle && <small>形成环，已停止</small>}{capped && !cycle && <small>已到显示上限</small>}
      </button>
      {isOpen && !cycle && <div className="wber-dep-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || "_（正文为空）_"}</ReactMarkdown>
      </div>}
      {isOpen && !cycle && !capped && descendants.map((child) => renderRow(child, depth + 1, [...path, uid]))}
    </div>;
  };

  return <div className="wber-dependencies">
    <button type="button" className="wber-dep-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "▾" : "▸"} 依赖条目 <span>{direct.length}</span>
    </button>
    {open && <div className="wber-dep-tree">{direct.map((uid) => renderRow(uid, 0, rootUids))}</div>}
  </div>;
}
