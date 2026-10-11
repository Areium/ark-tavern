import { useEffect, useId, useRef, useState } from "react";
import type { PlotGraphNodeDTO, StoryTreeNode } from "../../types";
import AppIcon from "../AppIcon";

interface Props {
  node: PlotGraphNodeDTO;
  visits: StoryTreeNode[];
  currentId?: string;
  currentRound: number;
  busy: boolean;
  rollingBack: string | null;
  error: string;
  onRollback: (node: StoryTreeNode) => void;
  onClose: () => void;
}

export default function SessionNodeDetails({ node, visits, currentId, currentRound, busy, rollingBack, error, onRollback, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restorePoints = visits.filter(visit => visit.has_state && (visit.round_end ?? 0) <= currentRound
    && !((visit.runtime_node_id || visit.id) === currentId && visit.round_end === currentRound));
  const requestClose = () => setClosing(true);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => closeRef.current(), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [closing]);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!rollingBack && ref.current?.open && !ref.current.contains(document.activeElement)) ref.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [rollingBack]);
  return <dialog ref={ref} className="session-node-dialog" data-closing={closing || undefined} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) requestClose();
    }}>
    <header className="session-node-heading">
      <h2 id={titleId}>{node.title || "节点详情"}</h2>
      <button type="button" aria-label="关闭节点详情" onClick={requestClose} autoFocus><AppIcon name="close" size={18} /></button>
    </header>
    <div className="session-node-scroll">
      <section className="session-node-section" aria-label="节点内容">
        {node.content ? <p>{node.content}</p> : <p className="session-node-meta">暂无节点内容。</p>}
      </section>
      {error && <p className="session-node-error" role="alert">{error}</p>}
    </div>
    {restorePoints.length > 0 && <footer className="session-node-actions" aria-label="节点回档">
      {restorePoints.map(visit => <div key={visit.id} className="session-node-restore">
        <span className="session-node-meta">第 {visit.round_end ?? 0} 轮{restorePoints.length > 1 && visit.title ? ` · ${visit.title}` : ""}</span>
        {visit.rollback_unavailable_reason ? <span className="session-node-meta">存档数据不完整，无法回档。</span> : <button type="button" className="app-danger-button session-node-rollback"
          disabled={closing || busy || rollingBack !== null} onClick={() => onRollback(visit)}>
          <AppIcon name="back" size={14} />{rollingBack === visit.id ? "回档中…" : "回档到此节点"}
        </button>}
      </div>)}
    </footer>}
  </dialog>;
}
