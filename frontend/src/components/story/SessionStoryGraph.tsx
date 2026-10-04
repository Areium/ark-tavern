import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { StageDTO, StoryStateDTO } from "../../types";
import { layoutSessionStoryGraph, sessionGraphFitZoom, SESSION_GRAPH_KIND_LABEL, SESSION_GRAPH_STATE_LABEL,
  STORY_GRAPH_MAX_ZOOM, STORY_GRAPH_NODE_HEIGHT, STORY_GRAPH_NODE_WIDTH } from "../../utils/sessionStoryGraph";
import AvatarPlaceholder from "../chat/AvatarPlaceholder";
import AppIcon from "../AppIcon";

export interface SessionStoryGraphProps {
  sessionId: string;
  onOpenLog: () => void;
  onExit: () => void;
}

export default function SessionStoryGraph({ sessionId, onOpenLog, onExit }: SessionStoryGraphProps) {
  const api = useApi();
  const { chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey } = useAppStore();
  const narrationCount = useAppStore(s => s.sessionNarrationCount[sessionId] ?? s.sessions.find(item => item.id === sessionId)?.narration_count ?? 0);
  const streaming = useAppStore(s => s.sessionStreaming[sessionId] ?? false);
  const sending = useAppStore(s => s.sessionSending[sessionId] ?? false);
  const session = useAppStore(s => s.sessions.find(item => item.id === sessionId));
  const [snapshot, setSnapshot] = useState<{ sessionId: string; state: StoryStateDTO; stage: StageDTO | null; round: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [manualZoom, setManualZoom] = useState(1);
  const [fitAll, setFitAll] = useState(true);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const markerId = useId().replace(/:/g, "");
  const state = snapshot?.sessionId === sessionId ? snapshot.state : null;
  const stage = snapshot?.sessionId === sessionId ? snapshot.stage : null;
  const cue = stage?.scene_media?.round === snapshot?.round ? stage?.scene_media : null;
  const layout = useMemo(() => layoutSessionStoryGraph(state, cue), [state, cue]);
  const fitZoom = sessionGraphFitZoom(layout, viewportSize);
  const minZoom = Math.min(.1, fitZoom);
  const zoom = fitAll ? fitZoom : Math.max(minZoom, manualZoom);
  const hasGraph = !!state?.has_plot && !!layout.nodes.length && !error;
  const nodesById = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const current = layout.nodes.find(node => node.state === "current");
  const castNames = [...new Set(stage
    ? [stage.player?.name, ...stage.characters.map(character => character.name)].filter((name): name is string => !!name)
    : [session?.player_identity || "玩家", ...(session?.characters ?? [])])];
  const offsetX = Math.max(0, (viewportSize.width - layout.width * zoom) / 2);
  const offsetY = Math.max(0, (viewportSize.height - layout.height * zoom) / 2);

  useEffect(() => {
    setManualZoom(1);
    setFitAll(true);
    setError("");
  }, [sessionId]);

  useEffect(() => {
    // Commit the roadmap and its narration-bound position together. A late stage
    // response must not move the avatar on an already refreshed session snapshot.
    let cancelled = false;
    if (streaming || sending) { setLoading(false); return; }
    setLoading(true);
    setError("");
    Promise.all([api.getStoryState(sessionId), api.getStage(sessionId, narrationCount || undefined).catch(() => null)])
      .then(([result, stageResult]) => {
        if (!cancelled) setSnapshot({ sessionId, state: result, stage: stageResult, round: narrationCount });
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "剧情节点加载失败");
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, sessionId, narrationCount, chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey, streaming, sending, retry]);

  const locateCurrent = useCallback(() => {
    if (!current || !viewport.current) return;
    viewport.current.scrollTo({
      left: offsetX + (current.x + STORY_GRAPH_NODE_WIDTH / 2) * zoom - viewport.current.clientWidth / 2,
      top: offsetY + (current.y + STORY_GRAPH_NODE_HEIGHT / 2) * zoom - viewport.current.clientHeight / 2,
      behavior: "auto",
    });
  }, [current, zoom, offsetX, offsetY]);
  useEffect(() => {
    if (!viewport.current) return;
    const element = viewport.current;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGraph, sessionId]);
  useEffect(() => {
    if (fitAll) viewport.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
    else locateCurrent();
  }, [fitAll, locateCurrent, viewportSize, hasGraph]);

  const showCurrent = () => {
    setFitAll(false);
    setManualZoom(value => Math.max(.85, value));
    locateCurrent();
  };
  const changeZoom = (factor: number) => {
    setManualZoom(Math.min(STORY_GRAPH_MAX_ZOOM, Math.max(minZoom, zoom * factor)));
    setFitAll(false);
  };

  return (
    <section className="session-story-graph" aria-label="剧情节点图">
      <header className="session-graph-toolbar">
        <div className="session-graph-heading"><AppIcon name="workflow" size={18} />
          <div><h2>{state?.plot_name || "剧情节点图"}</h2><span>{layout.nodes.length} 个节点 · 完整路线</span></div></div>
        <div className="session-graph-tools" role="group" aria-label="节点图操作">
          <button type="button" onClick={onOpenLog}><AppIcon name="docs" size={14} />对话记录</button>
          <button type="button" onClick={onExit}><AppIcon name="back" size={14} />返回舞台</button>
        </div>
      </header>
      <div className="session-graph-navigation">
        <div className="session-graph-legend" aria-label="节点状态图例">
          <span className="is-current"><i />当前位置</span><span className="is-path"><i />已抵达</span><span className="is-locked"><i />未抵达</span>
        </div>
        <div className="session-graph-tools" role="group" aria-label="节点图缩放">
          <button type="button" aria-label="缩小节点图" disabled={zoom <= minZoom || !hasGraph} onClick={() => changeZoom(1 / 1.25)}>−</button>
          <output aria-label="缩放比例">{zoom < .01 ? "<1" : Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大节点图" disabled={zoom >= STORY_GRAPH_MAX_ZOOM || !hasGraph} onClick={() => changeZoom(1.25)}>+</button>
          <button type="button" aria-pressed={fitAll} disabled={!hasGraph} onClick={() => setFitAll(true)}><AppIcon name="maximize" size={14} />适应全图</button>
          <button type="button" onClick={showCurrent} disabled={!current || !hasGraph}>定位当前节点</button>
          <button type="button" aria-label="刷新节点图" disabled={loading || streaming || sending} onClick={() => setRetry(v => v + 1)}><AppIcon name="refresh" size={14} /></button>
        </div>
      </div>
      {error ? (
        <div className="session-graph-empty" role="alert"><h3>剧情节点加载失败</h3><p>{error}</p>
          <button type="button" onClick={() => setRetry(v => v + 1)} disabled={loading || sending || streaming}>重试</button></div>
      ) : !state ? (
        <div className="session-graph-empty"><p>{sending || streaming ? "等待本轮剧情完成" : "正在加载剧情节点…"}</p></div>
      ) : !state.has_plot || !layout.nodes.length ? (
        <div className="session-graph-empty"><AppIcon name="workflow" size={32} />
          <h3>{!state.has_plot ? "当前会话未绑定剧情" : "暂无剧情节点"}</h3>
          <p>{!state.has_plot ? "绑定剧情后，这里会展示完整的节点路线。" : "返回舞台开始故事，节点会随剧情更新。"}</p></div>
      ) : (
        <div className="session-graph-canvas">
          <div ref={viewport} className="session-graph-viewport" role="region" aria-label="剧情节点画布" tabIndex={0}
            onKeyDown={event => {
              const offsets: Record<string, [number, number]> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
              if (offsets[event.key]) { event.preventDefault(); const [left, top] = offsets[event.key]; event.currentTarget.scrollBy({ left, top }); }
              if (event.key === "Home") { event.preventDefault(); showCurrent(); }
            }}
            onPointerDown={event => {
              if (event.pointerType !== "mouse" || event.button !== 0) return;
              drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!drag.current) return;
              event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
              event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
            }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <div style={{ width: Math.max(viewportSize.width, layout.width * zoom), height: Math.max(viewportSize.height, layout.height * zoom), position: "relative" }}>
              <div className="session-graph-plane" style={{ width: layout.width, height: layout.height,
                left: offsetX, top: offsetY, transform: `scale(${zoom})` }}>
                {!!state.roads?.length && <span className="session-graph-section-title" style={{ left: 48, top: 24 }}>完整剧情路线</span>}
                {!!state.tree?.nodes.length && <span className="session-graph-section-title" style={{ left: 48, top: 28 + (state.roads?.length ?? 0) * 224 }}>会话轨迹</span>}
                <svg className="session-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" /></marker></defs>
                  {layout.edges.map(edge => {
                    const from = nodesById.get(edge.source)!; const to = nodesById.get(edge.target)!;
                    const x1 = from.x + STORY_GRAPH_NODE_WIDTH; const y1 = from.y + STORY_GRAPH_NODE_HEIGHT / 2;
                    const x2 = to.x; const y2 = to.y + STORY_GRAPH_NODE_HEIGHT / 2;
                    const bend = Math.max(48, Math.abs(x2 - x1) / 2);
                    return <path key={`${edge.source}:${edge.target}`} className={edge.onPath ? "is-path" : "is-locked"} markerEnd={`url(#${markerId})`}
                      d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2 - 3},${y2}`}><title>{edge.label}</title></path>;
                  })}
                </svg>
                {layout.nodes.map(entry => (
                  <article key={entry.id} className={`session-graph-node ng-node ng-node-${entry.type} is-${entry.state}`}
                    style={{ left: entry.x, top: entry.y, width: STORY_GRAPH_NODE_WIDTH, height: STORY_GRAPH_NODE_HEIGHT }}
                    aria-current={entry.state === "current" ? "step" : undefined} tabIndex={0}
                    aria-label={`${SESSION_GRAPH_KIND_LABEL[entry.type]} · ${SESSION_GRAPH_STATE_LABEL[entry.state]}：${entry.title}`}
                    title={entry.summary || entry.title}>
                    <i className="ng-node-bar" />
                    <div className="ng-node-head"><span className="ng-node-icon"><AppIcon name={entry.type === "combat" ? "combat" : "workflow"} size={14} /></span>
                      <span className="session-graph-node-kind">{SESSION_GRAPH_KIND_LABEL[entry.type]}</span>
                      <span className="session-graph-node-state">{SESSION_GRAPH_STATE_LABEL[entry.state]}</span></div>
                    <strong className="session-graph-node-title">{entry.title}</strong>
                    <span className="session-graph-node-caption">{entry.subtitle}</span>
                    {entry.state === "current" && <span className="session-graph-cast" aria-label={`当前节点角色：${castNames.join("、")}`}>
                      {castNames.slice(0, 4).map(name => <AvatarPlaceholder key={name} name={name} sessionId={sessionId} />)}
                      {castNames.length > 4 && <span>+{castNames.length - 4}</span>}
                    </span>}
                  </article>
                ))}
              </div>
            </div>
          </div>
          <div className="session-graph-canvas-note" role="status">
            {sending || streaming ? "剧情生成中，完成后更新…" : loading ? "正在更新节点…" : current ? `当前位置 · ${current.title}` : "尚未抵达节点"}
            <span>拖动或滚动浏览 · Home 定位</span>
          </div>
        </div>
      )}
    </section>
  );
}
