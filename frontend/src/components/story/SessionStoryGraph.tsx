import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { PlotGraphDocDTO, StageDTO, StoryStateDTO } from "../../types";
import { applySessionGraphPositions, sessionGraphDocument, sessionGraphProgress, sessionPositionKey, type SessionGraphPositions } from "../../utils/sessionStoryGraph";
import GraphCanvas, { type GraphCanvasApi } from "../combat/GraphCanvas";
import { type ViewState } from "../combat/graphModel";
import AvatarPlaceholder from "../chat/AvatarPlaceholder";
import AppIcon from "../AppIcon";

export interface SessionStoryGraphProps { sessionId: string; onOpenLog: () => void; onExit: () => void }
const noop = () => {};
type Snapshot = { sessionId: string; state: StoryStateDTO; doc: PlotGraphDocDTO; stage: StageDTO | null; round: number };

export default function SessionStoryGraph({ sessionId, onOpenLog, onExit }: SessionStoryGraphProps) {
  const api = useApi();
  const { chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey } = useAppStore();
  const session = useAppStore(s => s.sessions.find(item => item.id === sessionId));
  const narrationCount = useAppStore(s => s.sessionNarrationCount[sessionId] ?? session?.narration_count ?? 0);
  const streaming = useAppStore(s => s.sessionStreaming[sessionId] ?? false);
  const sending = useAppStore(s => s.sessionSending[sessionId] ?? false);
  const booksKey = JSON.stringify(session?.worldbook_ids ?? []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [positions, setPositions] = useState<{ key: string; values: SessionGraphPositions }>({ key: "", values: {} });
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const canvasApi = useRef<GraphCanvasApi | null>(null);
  const initialized = useRef("");
  const state = snapshot?.sessionId === sessionId ? snapshot.state : null;
  const stage = snapshot?.sessionId === sessionId ? snapshot.stage : null;
  const cue = stage?.scene_media?.round === snapshot?.round ? stage?.scene_media : null;
  const graph = useMemo(() => state && snapshot ? sessionGraphProgress(state, snapshot.doc, cue) : null, [state, snapshot, cue]);
  const layoutKey = `session-story-layout:${sessionId}:${state?.plot_id || ""}:${snapshot?.doc.worldbook_id || ""}`;
  const doc = useMemo(() => graph ? applySessionGraphPositions(graph.doc, positions.key === layoutKey ? positions.values : {}) : null, [graph, positions, layoutKey]);
  const castNames = [...new Set(stage ? [stage.player?.name, ...stage.characters.map(character => character.name)].filter((name): name is string => !!name)
    : [session?.player_identity || "玩家", ...(session?.characters ?? [])])];

  useEffect(() => {
    let cancelled = false;
    if (streaming || sending) { setLoading(false); return; }
    setLoading(true); setError("");
    (async () => {
      const [result, stageResult] = await Promise.all([api.getStoryState(sessionId), api.getStage(sessionId, narrationCount || undefined).catch(() => null)]);
      let sourceDoc: PlotGraphDocDTO | undefined;
      if (result.has_plot && result.plot_id) {
        const bookIds = JSON.parse(booksKey) as string[];
        for (const bookId of bookIds) {
          const source = await api.getCombatNodeGraph(bookId, sessionId);
          const flow = source.plots.find(plot => plot.plot_id === result.plot_id);
          if (!flow) continue;
          const owner = flow.worldbook_id || bookId;
          if (!bookIds.includes(owner)) continue;
          const saved = await api.getPlotGraph(result.plot_id, owner);
          sourceDoc = sessionGraphDocument(result, flow, saved.graph);
          break;
        }
      }
      if (!cancelled) setSnapshot(previous => ({ sessionId, state: result, doc: sourceDoc ?? sessionGraphDocument(result), round: narrationCount,
        stage: stageResult ?? (previous?.sessionId === sessionId && previous.round === narrationCount && previous.state.tree?.current_id === result.tree?.current_id ? previous.stage : null) }));
    })().catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "剧情节点加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, sessionId, booksKey, narrationCount, chatRefreshKey, envRefreshKey, sceneSwitchKey, characterRefreshKey, streaming, sending, retry]);

  useEffect(() => {
    let values: SessionGraphPositions = {};
    try { const saved = JSON.parse(localStorage.getItem(layoutKey) || "{}"); if (saved && typeof saved === "object") values = saved; } catch { /* Layout storage is optional. */ }
    setPositions({ key: layoutKey, values }); setSelected(null);
  }, [layoutKey]);
  useEffect(() => {
    if (!doc?.nodes.length || positions.key !== layoutKey || initialized.current === layoutKey) return;
    initialized.current = layoutKey;
    const frame = requestAnimationFrame(() => canvasApi.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [doc, layoutKey, positions.key]);

  const moveNodes = (next: PlotGraphDocDTO) => {
    if (!doc) return;
    const values = { ...(positions.key === layoutKey ? positions.values : {}) };
    for (const node of doc.nodes) {
      const moved = next.nodes.find(item => item.id === node.id);
      if (moved && (moved.x !== node.x || moved.y !== node.y)) values[sessionPositionKey(node)] = { x: moved.x, y: moved.y };
    }
    setPositions({ key: layoutKey, values });
    try { localStorage.setItem(layoutKey, JSON.stringify(values)); } catch { /* Dragging works without storage. */ }
  };

  return <section className="session-story-graph" aria-label="剧情节点图">
    <header className="session-graph-toolbar">
      <div className="session-graph-heading"><AppIcon name="workflow" size={18} /><h2>{state?.plot_name || "剧情节点图"}</h2></div>
      <div className="session-graph-tools" role="group" aria-label="节点图操作">
        <button type="button" disabled={!graph?.currentId} onClick={() => graph?.currentId && canvasApi.current?.focusNode(graph.currentId, 1)}>定位当前节点</button>
        <button type="button" aria-label="刷新节点图" disabled={loading || streaming || sending} onClick={() => setRetry(v => v + 1)}><AppIcon name="refresh" size={14} /></button>
        <button type="button" onClick={onOpenLog}><AppIcon name="docs" size={14} />对话记录</button>
        <button type="button" onClick={onExit}><AppIcon name="back" size={14} />返回舞台</button>
      </div>
    </header>
    {error ? <div className="session-graph-empty" role="alert"><h3>剧情节点加载失败</h3><p>{error}</p><button onClick={() => setRetry(v => v + 1)}>重试</button></div>
      : !state ? <div className="session-graph-empty"><p>{sending || streaming ? "等待本轮剧情完成" : "正在加载剧情节点…"}</p></div>
      : !state.has_plot || !doc?.nodes.length ? <div className="session-graph-empty"><h3>{!state.has_plot ? "当前会话未绑定剧情" : "暂无剧情节点"}</h3></div>
      : <div className="session-graph-canvas">
        <GraphCanvas mode="session" doc={doc} view={view} onViewChange={setView} selected={selected} onSelect={setSelected}
          onDocChange={moveNodes} displays={graph!.displays} canvasApiRef={canvasApi}
          onOpenNode={noop} onRequestDeleteNode={noop} onCreateCombat={noop} onAddBeat={noop} onAddCombatNode={noop}
          onImportLayout={noop} onResetPositions={noop} availableBeats={[]} availableCombats={[]}
          renderNodeOverlay={node => node.id === graph?.currentId ? <span className="session-graph-cast" aria-label={`当前节点角色：${castNames.join("、")}`}>
            {castNames.slice(0, 4).map(name => <AvatarPlaceholder key={name} name={name} sessionId={sessionId} />)}
            {castNames.length > 4 && <span>+{castNames.length - 4}</span>}
          </span> : null} />
        {(sending || streaming || loading) && <span className="session-graph-status" role="status">{sending || streaming ? "剧情生成中，完成后更新…" : "正在更新节点…"}</span>}
      </div>}
  </section>;
}
