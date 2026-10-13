import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import type { PlotAuthoringDTO } from "../../types";

export interface StoryNodeInput {
  source_revision: string;
  chapter_idx: number | null;
  title: string;
  content: string;
}

interface Props {
  bookId: string;
  plotId: string;
  beatId?: string;
  onCreate?: (input: StoryNodeInput) => Promise<void>;
  onChanged?: () => void;
  onClose: () => void;
}

/** Edits the authoritative story source, never a graph-only note. */
export default function StoryNodeForm({ bookId, plotId, beatId, onCreate, onChanged, onClose }: Props) {
  const api = useApi();
  const [authoring, setAuthoring] = useState<PlotAuthoringDTO | null>(null);
  const [chapter, setChapter] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setAuthoring(null);
    void api.getPlotAuthoring(plotId, bookId).then(result => {
      if (!active) return;
      const beat = result.chapters.flatMap(ch => ch.beats).find(row => row.id === beatId);
      if (beatId && !beat) throw new Error("剧情节点已被移除，请重新打开节点图");
      setAuthoring(result);
      setChapter(result.chapters[0]?.idx ?? null);
      setTitle(beat?.title || ""); setContent(beat?.content || "");
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "剧情内容读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, bookId, plotId, beatId, retry]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!authoring || !title.trim() || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (beatId) {
        const result = await api.updatePlotBeat(plotId, bookId, beatId, {
          source_revision: authoring.source_revision, title: title.trim(), content,
        });
        if (!alive.current) return;
        setAuthoring(result.authoring);
        setNotice("已保存到世界书");
        onChanged?.();
      } else {
        await onCreate?.({ source_revision: authoring.source_revision, chapter_idx: chapter, title: title.trim(), content });
      }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "剧情节点保存失败");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <form onSubmit={submit} className="ng-media-panel flex flex-col min-h-0 max-h-full p-5" aria-label={beatId ? "编辑剧情节点" : "新建剧情节点"}
    onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab" || !event.currentTarget.closest('[role="dialog"]')) return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'));
      const target = event.shiftKey ? controls[controls.length - 1] : controls[0];
      const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
      if (target && document.activeElement === boundary) { event.preventDefault(); target.focus(); }
    }}>
    <header className="flex items-center justify-between gap-3 mb-4">
      <h2 className="text-sm font-medium">{beatId ? "编辑剧情节点" : "新建剧情节点"}</h2>
      <button type="button" disabled={busy} onClick={onClose}>关闭</button>
    </header>
    {loading && <p role="status">正在读取…</p>}
    {error && <p role="alert" className="text-xs text-red-300 mb-3">{error}</p>}
    {error && authoring && <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>重新读取剧情内容</button>}
    {!loading && !authoring && <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button>}
    {authoring && <div className="space-y-3 overflow-y-auto min-h-0">
      {!beatId && <label className="ng-media-field">章节
        <select aria-label="剧情节点章节" value={chapter ?? ""} disabled={busy} onChange={event => setChapter(event.target.value ? Number(event.target.value) : null)}>
          {authoring.chapters.length ? authoring.chapters.map(ch => <option key={ch.idx} value={ch.idx}>{ch.title}</option>) : <option value="">第一章</option>}
        </select>
      </label>}
      <label className="ng-media-field">标题
        <input autoFocus aria-label="剧情节点标题" maxLength={200} required value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
      </label>
      <label className="ng-media-field">正文
        <textarea aria-label="剧情节点正文" rows={10} value={content} disabled={busy} onChange={event => setContent(event.target.value)} />
      </label>
    </div>}
    {notice && <p role="status" className="text-xs mt-3">{notice}</p>}
    <footer className="ng-media-footer mt-4">
      <button type="submit" disabled={!authoring || busy || !title.trim()}>{busy ? "保存中…" : beatId ? "保存剧情节点" : "创建并上图"}</button>
    </footer>
  </form>;
}
