import { useEffect, useId, useRef } from "react";
import type { PlotGraphNodeDTO, StoryTreeNode } from "../../types";
import AppIcon from "../AppIcon";

interface Props {
  node: PlotGraphNodeDTO;
  visits: StoryTreeNode[];
  currentId?: string;
  busy: boolean;
  rollingBack: string | null;
  error: string;
  onRollback: (node: StoryTreeNode) => void;
  onClose: () => void;
}

export default function SessionNodeDetails({ node, visits, currentId, busy, rollingBack, error, onRollback, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!rollingBack && ref.current?.open && !ref.current.contains(document.activeElement)) ref.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [rollingBack]);
  return <dialog ref={ref} className="session-node-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose();
    }}>
    <header className="session-node-heading">
      <h2 id={titleId}>{node.title || "节点详情"}</h2>
      <button type="button" aria-label="关闭节点详情" onClick={onClose} autoFocus><AppIcon name="close" size={18} /></button>
    </header>
    <div className="session-node-scroll">
      {node.content && <section className="session-node-section"><h3>节点内容</h3><p>{node.content}</p></section>}
      {visits.length > 0 && <section className="session-node-section"><h3>会话记录</h3>
        {visits.map(visit => <article key={visit.id} className="session-node-visit">
          <div className="session-node-visit-heading"><h4>{visit.title || node.title}</h4>
            <span>{visit.id === currentId ? "当前节点" : visit.has_state ? "已抵达" : "未到达"}</span></div>
          {visit.round_start != null && <div className="session-node-meta">第 {visit.round_start}–{visit.round_end ?? visit.round_start} 轮</div>}
          {visit.branch_label && visit.branch_label !== "开始" && <div className="session-node-meta">分支：{visit.branch_label}</div>}
          {visit.summary && visit.summary !== node.content && <p>{visit.summary}</p>}
          {visit.intent && <p>{visit.intent}</p>}
          {visit.has_state && visit.id !== currentId && <button type="button" className="app-danger-button session-node-rollback"
            disabled={busy || rollingBack !== null} onClick={() => onRollback(visit)}>
            <AppIcon name="back" size={14} />{rollingBack === visit.id ? "回档中…" : "回档到此节点"}
          </button>}
        </article>)}
      </section>}
      {!visits.some(visit => visit.has_state) && <p className="session-node-meta">此节点暂无可回档的会话记录。</p>}
      {error && <p className="session-node-error" role="alert">{error}</p>}
    </div>
  </dialog>;
}
