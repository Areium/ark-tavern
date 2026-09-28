import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { StageDTO, StoryStateDTO, StoryTreeNode } from "../../types";
import { layoutSessionStoryGraph, sessionGraphFitZoom, sessionGraphIncoming, sessionGraphKindLabel,
  STORY_GRAPH_MAX_ZOOM, STORY_GRAPH_NODE_HEIGHT, STORY_GRAPH_NODE_WIDTH, type SessionGraphNode } from "../../utils/sessionStoryGraph";
import AvatarPlaceholder from "../chat/AvatarPlaceholder";
import AppIcon from "../AppIcon";

export interface SessionStoryGraphProps {
  sessionId: string;
  onOpenLog: () => void;
  onExit: () => void;
}

const STATE_LABEL = { current: "当前节点", path: "当前路径", branch: "其他分支" };

export function SessionStoryGraphDetails({ entry, parent, castNames, castError }: {
  entry: SessionGraphNode; parent?: StoryTreeNode; castNames: string[]; castError: boolean;
}) {
  const { node } = entry;
  const incoming = sessionGraphIncoming(node, parent);
  return <>
    <header className="session-graph-detail-heading">
      <h3>{node.title || entry.id}</h3><span>只读查看 · 不会回档</span>
    </header>
    <p className="session-graph-detail-meta">{sessionGraphKindLabel(node.kind)} · {STATE_LABEL[entry.state]}
      {node.round_start != null ? ` · 第 ${node.round_start}–${node.round_end ?? node.round_start} 轮` : ""}</p>
    <div className="session-graph-detail-content">
      <section aria-label="节点内容">
        <h4>节点内容</h4>
        <p>{node.summary || "此节点暂无摘要。"}</p>
        {node.intent && <dl><dt>节点意图</dt><dd>{node.intent}</dd></dl>}
        {entry.state === "current" && <p>同处当前节点：{castNames.join("、")}{castError ? "（场景角色加载失败，暂仅显示玩家）" : ""}</p>}
      </section>
      <section aria-label="到达此节点">
        <h4>到达此节点</h4>
        <dl>
          <dt>来源节点</dt><dd>{node.parent_id ? parent?.title || node.parent_id : "无（起点）"}</dd>
          <dt>入边选项</dt><dd>{incoming.label || "未记录入边选项"}</dd>
          {incoming.intent && <><dt>选项意图</dt><dd>{incoming.intent}</dd></>}
          {incoming.branch?.target_beat_id && <><dt>目标节拍</dt><dd>{incoming.branch.target_beat_id}</dd></>}
          {node.branch_label && incoming.label !== node.branch_label && <><dt>节点保存的分支标签</dt><dd>{node.branch_label}</dd></>}
        </dl>
        {!incoming.branch && node.parent_id && <p className="session-graph-detail-note">未找到 child_id 对应的父节点选项，以上为此节点保存的记录。</p>}
      </section>
      <section className="session-graph-detail-branches" aria-label="节点分支记录">
        <h4>节点分支 <span>{node.branches?.length ?? 0}</span></h4>
        <p className="session-graph-detail-note">仅展示已记录的选项与经过状态，不代表当前可推进条件。</p>
        {node.branches?.length ? <ul>{node.branches.map((branch, index) => <li key={`${branch.id}-${index}`}>
          <div className="session-graph-branch-heading"><strong>{branch.label || "未命名选项"}</strong>
            <span className={branch.taken === true ? "is-taken" : undefined}>{branch.taken === true ? "已走过" : branch.taken === false ? "未走过" : "未记录"}</span></div>
          <dl><dt>意图</dt><dd>{branch.intent || "未记录"}</dd>
            <dt>目标节拍</dt><dd>{branch.target_beat_id || "未指定"}</dd></dl>
        </li>)}</ul> : <p>此节点尚无分支记录。</p>}
      </section>
    </div>
  </>;
}

export default function SessionStoryGraph({ sessionId, onOpenLog, onExit }: SessionStoryGraphProps) {
  const api = useApi();
  const { chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey } = useAppStore();
  const narrationCount = useAppStore(s => s.sessionNarrationCount[sessionId] ?? 0);
  const streaming = useAppStore(s => s.sessionStreaming[sessionId] ?? false);
  const sending = useAppStore(s => s.sessionSending[sessionId] ?? false);
  const session = useAppStore(s => s.sessions.find(item => item.id === sessionId));
  const [snapshot, setSnapshot] = useState<{ sessionId: string; state: StoryStateDTO } | null>(null);
  const [cast, setCast] = useState<{ sessionId: string; stage: StageDTO } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [castError, setCastError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [manualZoom, setManualZoom] = useState(1);
  const [fitAll, setFitAll] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const markerId = useId().replace(/:/g, "");
  const detailId = useId();
  const state = snapshot?.sessionId === sessionId ? snapshot.state : null;
  const stage = cast?.sessionId === sessionId ? cast.stage : null;
  const layout = useMemo(() => layoutSessionStoryGraph(state?.tree), [state?.tree]);
  const fitZoom = sessionGraphFitZoom(layout, viewportSize);
  const minZoom = Math.min(.1, fitZoom);
  const zoom = fitAll ? fitZoom : Math.max(minZoom, manualZoom);
  const hasGraph = !!state?.has_plot && !!layout.nodes.length && !error;
  const nodesById = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const current = nodesById.get(state?.tree?.current_id ?? "");
  const selected = nodesById.get(selectedId ?? "") ?? current;
  const castNames = [...new Set(stage
    ? [stage.player?.name, ...stage.characters.map(character => character.name)].filter((name): name is string => !!name)
    : [session?.player_identity || "玩家"])];

  useEffect(() => {
    setSelectedId(null);
    setManualZoom(1);
    setFitAll(false);
    setError("");
    setCastError(false);
  }, [sessionId]);

  useEffect(() => {
    // API helpers do not accept AbortSignal: invalidate both results on cleanup.
    // Narration count increments before SSE; only fetch the committed state after it ends.
    let cancelled = false;
    if (streaming || sending) { setLoading(false); return; }
    setLoading(true);
    setError("");
    api.getStoryState(sessionId).then(result => {
      if (!cancelled) setSnapshot({ sessionId, state: result });
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "剧情状态加载失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    api.getStage(sessionId).then(result => {
      if (!cancelled) { setCast({ sessionId, stage: result }); setCastError(false); }
    }).catch(() => {
      if (!cancelled) { setCast(null); setCastError(true); }
    });
    return () => { cancelled = true; };
  }, [api, sessionId, narrationCount, chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey, streaming, sending, retry]);

  const locateCurrent = useCallback(() => {
    if (!current || !viewport.current) return;
    viewport.current.scrollTo({
      left: (current.x + STORY_GRAPH_NODE_WIDTH / 2) * zoom - viewport.current.clientWidth / 2,
      top: (current.y + STORY_GRAPH_NODE_HEIGHT / 2) * zoom - viewport.current.clientHeight / 2,
      behavior: "auto",
    });
  }, [current, zoom]);
  useEffect(() => {
    if (!viewport.current) return;
    const element = viewport.current;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGraph, sessionId]);
  // Resizing keeps a fitted graph fitted, instead of recentering on one node.
  useEffect(() => {
    if (fitAll) viewport.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
    else locateCurrent();
  }, [fitAll, locateCurrent, viewportSize, hasGraph]);

  useEffect(() => { detail.current?.scrollTo({ top: 0, behavior: "auto" }); }, [selected?.id]);

  const showCurrent = () => {
    setFitAll(false);
    setManualZoom(value => Math.max(.75, value));
    locateCurrent();
  };
  const changeZoom = (factor: number) => {
    setManualZoom(Math.min(STORY_GRAPH_MAX_ZOOM, Math.max(minZoom, zoom * factor)));
    setFitAll(false);
  };

  return (
    <section className="session-story-graph" aria-label="实时剧情节点图">
      <header className="session-graph-toolbar">
        <div className="session-graph-heading"><AppIcon name="workflow" size={18} /><h2>剧情轨迹</h2>
          <span>{layout.nodes.length} 个节点</span></div>
        <div className="session-graph-tools" role="group" aria-label="节点图操作">
          <button type="button" onClick={onOpenLog}><AppIcon name="docs" size={14} />对话记录</button>
          <button type="button" onClick={onExit}><AppIcon name="back" size={14} />返回舞台</button>
        </div>
      </header>
      <div className="session-graph-navigation">
        <p>当前节点 <strong>{current?.node.title || current?.id || "尚未生成"}</strong></p>
        <div className="session-graph-tools" role="group" aria-label="节点图缩放">
          <button type="button" aria-label="缩小节点图" disabled={zoom <= minZoom || !hasGraph} onClick={() => changeZoom(1 / 1.25)}>−</button>
          <output aria-label="缩放比例">{zoom < .01 ? "<1" : Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大节点图" disabled={zoom >= STORY_GRAPH_MAX_ZOOM || !hasGraph} onClick={() => changeZoom(1.25)}>+</button>
          <button type="button" aria-pressed={fitAll} disabled={!hasGraph} onClick={() => {
            setFitAll(true); viewport.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
          }}><AppIcon name="maximize" size={14} />适应全图</button>
          <button type="button" onClick={showCurrent} disabled={!current || !hasGraph}>定位当前节点</button>
          <button type="button" aria-label="刷新节点图" disabled={loading || streaming || sending} onClick={() => setRetry(v => v + 1)}><AppIcon name="refresh" size={14} /></button>
        </div>
      </div>
      <div className="session-graph-status" role="status">
        {sending || streaming ? "剧情生成中，完成后更新轨迹…" : loading ? "正在更新剧情轨迹…" : "实线为当前路径 · 虚线为其他分支 · 拖动或滚动浏览 · 点击节点查看详情（键盘 Enter / 空格）"}
      </div>
      {error ? (
        <div className="session-graph-empty" role="alert"><h3>剧情轨迹加载失败</h3><p>{error}</p>
          <button type="button" onClick={() => setRetry(v => v + 1)} disabled={loading || sending || streaming}>重试</button></div>
      ) : !state ? (
        <div className="session-graph-empty"><p>{sending || streaming ? "等待本轮剧情完成" : "正在加载剧情轨迹…"}</p></div>
      ) : !state.has_plot || !layout.nodes.length ? (
        <div className="session-graph-empty"><AppIcon name="workflow" size={32} />
          <h3>{!state.has_plot ? "当前会话未绑定剧情" : "尚未生成剧情轨迹"}</h3>
          <p>{!state.has_plot ? "绑定剧情后，这里会展示会话实际经历的节点。" : "在下方输入行动开始故事，生成的节点会自动出现在这里。"}</p></div>
      ) : (
        <>
          <div ref={viewport} className="session-graph-viewport" role="region" aria-label="剧情节点画布" tabIndex={0}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              const offsets: Record<string, [number, number]> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
              if (offsets[event.key]) { event.preventDefault(); const [left, top] = offsets[event.key]; event.currentTarget.scrollBy({ left, top }); }
              if (event.key === "Home") { event.preventDefault(); showCurrent(); }
            }}
            onPointerDown={event => {
              if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
              drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!drag.current) return;
              event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
              event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
            }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <div style={{ width: layout.width * zoom, height: layout.height * zoom, position: "relative", overflow: "hidden" }}>
              <div className="session-graph-plane" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                <svg className="session-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" /></marker></defs>
                  {layout.edges.map(edge => {
                    const from = nodesById.get(edge.source)!; const to = nodesById.get(edge.target)!;
                    const x1 = from.x + STORY_GRAPH_NODE_WIDTH; const y1 = from.y + STORY_GRAPH_NODE_HEIGHT / 2;
                    const x2 = to.x; const y2 = to.y + STORY_GRAPH_NODE_HEIGHT / 2;
                    return <path key={edge.target} className={edge.onPath ? "is-path" : "is-branch"} markerEnd={`url(#${markerId})`}
                      d={`M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2 - 3},${y2}`} />;
                  })}
                </svg>
                {layout.nodes.map(entry => (
                  <button type="button" key={entry.id} className={`session-graph-node is-${entry.state}`}
                    style={{ left: entry.x, top: entry.y, width: STORY_GRAPH_NODE_WIDTH, height: STORY_GRAPH_NODE_HEIGHT }}
                    aria-current={entry.state === "current" ? "step" : undefined} aria-pressed={selected?.id === entry.id}
                    aria-controls={detailId}
                    aria-label={`${sessionGraphKindLabel(entry.node.kind)} · ${STATE_LABEL[entry.state]}：${entry.node.title || entry.id}，查看节点详情`}
                    onClick={event => {
                      setSelectedId(entry.id);
                      // Native buttons activate on Enter/Space. Move keyboard users to
                      // the detail region without tabbing through the remaining graph.
                      if (event.detail === 0) requestAnimationFrame(() => detail.current?.focus({ preventScroll: true }));
                    }} onDoubleClick={() => {
                      setSelectedId(entry.id);
                      requestAnimationFrame(() => detail.current?.focus({ preventScroll: true }));
                    }}>
                    <span className="session-graph-node-top"><span className="session-graph-node-kind">{sessionGraphKindLabel(entry.node.kind)}</span>
                      <span className="session-graph-node-meta">{STATE_LABEL[entry.state]}{entry.node.round_start != null ? ` · 第 ${entry.node.round_start}–${entry.node.round_end ?? entry.node.round_start} 轮` : ""}</span></span>
                    <strong>{entry.node.title || entry.id}</strong>
                    <span className="session-graph-node-caption">{entry.node.branch_label || entry.node.summary || "查看节点详情"}</span>
                    {entry.state === "current" && <span className="session-graph-cast" aria-label={`同处当前节点：${castNames.join("、")}`}>
                      {castNames.slice(0, 4).map(name => <AvatarPlaceholder key={name} name={name} sessionId={sessionId} />)}
                      <span>{castNames.length > 4 ? `+${castNames.length - 4} · ` : ""}同处此节点</span>
                    </span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {selected && <aside ref={detail} id={detailId} className="session-graph-detail" aria-label="节点详情" tabIndex={0}>
            <SessionStoryGraphDetails entry={selected} parent={nodesById.get(selected.node.parent_id ?? "")?.node} castNames={castNames} castError={castError} />
          </aside>}
        </>
      )}
      {castError && !error && <div className="session-graph-status">场景角色加载失败。<button type="button" disabled={loading || sending || streaming} onClick={() => setRetry(v => v + 1)}>重试角色加载</button></div>}
    </section>
  );
}
