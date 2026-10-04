import type { PlotFlowDTO, PlotGraphDocDTO, PlotGraphNodeDTO, StageDTO, StoryStateDTO } from "../types";
import type { GraphNodeDisplay } from "../components/combat/GraphCanvas";
import { importLayoutFromFlow, nodeIdentity, NODE_W, LAYOUT_H_GAP } from "../components/combat/graphModel";

export type SessionGraphPositions = Record<string, { x: number; y: number }>;
export const sessionPositionKey = (node: PlotGraphNodeDTO) => node.id.startsWith("scene:") ? node.id : nodeIdentity(node);

/** The same worldbook ordering/layout, including when only a session roadmap exists. */
export function sessionPlotFlow(state: StoryStateDTO): PlotFlowDTO {
  return { plot_id: state.plot_id || "session", name: state.plot_name || "剧情节点图", summary: "",
    worldbook_id: "", source: "outline", combat_nodes: [],
    chapters: (state.roads ?? []).map(road => ({ idx: road.chapter_idx + 1, id: road.id,
      title: road.title, summary: road.summary, label: road.title, kind: road.kind, combat_nodes: [],
      beats: road.beats.map(beat => ({ id: beat.id, title: beat.title, summary: beat.summary,
        keep_on_deviate: !!beat.keep_on_deviate, choice_required: beat.choice_required,
        branches: beat.authored_branches, combat_nodes: [] })) })) };
}

/** Keep saved positions/edges, completing missing authored nodes with the shared importer. */
export function sessionGraphDocument(state: StoryStateDTO, flow = sessionPlotFlow(state), saved?: PlotGraphDocDTO | null): PlotGraphDocDTO {
  const generated = importLayoutFromFlow(flow, new Map());
  if (!saved?.nodes.length) return generated;
  const nodes = saved.nodes.map(node => ({ ...node }));
  const byIdentity = new Map(nodes.map(node => [nodeIdentity(node), node]));
  const mapped = new Map<string, string>();
  const added = new Set<string>();
  for (const node of generated.nodes) {
    let target = byIdentity.get(nodeIdentity(node));
    if (!target) {
      target = { ...node, id: `session:${node.id}` };
      nodes.push(target); added.add(target.id); byIdentity.set(nodeIdentity(node), target);
    }
    mapped.set(node.id, target.id);
  }
  const edges = [...saved.edges];
  for (const edge of generated.edges) {
    const from = mapped.get(edge.from)!; const to = mapped.get(edge.to)!;
    if ((added.has(from) || added.has(to)) && !edges.some(e => e.from === from && e.to === to)) edges.push({ ...edge, id: `session:${edge.id}`, from, to });
  }
  return { ...saved, nodes, edges };
}

export function applySessionGraphPositions(doc: PlotGraphDocDTO, positions: SessionGraphPositions): PlotGraphDocDTO {
  return { ...doc, nodes: doc.nodes.map(node => {
    const pos = positions[sessionPositionKey(node)];
    return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { ...node, x: pos.x, y: pos.y } : node;
  }) };
}

/** Tree refs can already point ahead; use the round-bound scene cue for arrival. */
export function sessionGraphProgress(state: StoryStateDTO, base: PlotGraphDocDTO, cue?: StageDTO["scene_media"] | null) {
  let doc = base;
  const displays = new Map<string, GraphNodeDisplay>();
  const arrived = new Set<string>();
  const completed = new Set(state.completed_beats ?? []);
  for (const road of state.roads ?? []) for (const beat of road.beats) {
    if (beat.state === "done" || completed.has(beat.id) || beat.round_start != null) arrived.add(`${road.chapter_idx + 1}:${beat.id}`);
  }
  const tree = state.tree?.has_tree ? state.tree : undefined;
  const currentScene = tree?.nodes.find(node => node.id === tree.current_id);
  let current: PlotGraphNodeDTO | undefined;
  if (!tree || currentScene) {
    if (currentScene?.kind === "combat") current = doc.nodes.find(node => node.type === "combat" && node.ref?.node_id === currentScene.combat_node_id);
    else {
      const beatId = cue?.round ? cue.beat_id : !tree ? state.beat?.id : undefined;
      const chapterIdx = cue?.round ? cue.chapter_idx : (state.chapter?.idx ?? -1) + 1;
      current = doc.nodes.find(node => node.type === "beat" && node.ref?.beat_id === beatId && node.ref?.chapter_idx === chapterIdx);
    }
  }
  // A scene without an author anchor stays a normal shared card on the same canvas.
  if (doc.nodes.length <= 1 && doc.nodes.every(node => node.type === "plot") && tree) {
    const nodes: PlotGraphNodeDTO[] = [];
    const records = new Map(tree.nodes.map(node => [node.id, node]));
    const placed = new Set<string>();
    const children = new Map<string, string[]>();
    for (const node of tree.nodes) {
      const siblings = children.get(node.parent_id || "") ?? [];
      siblings.push(node.id); children.set(node.parent_id || "", siblings);
    }
    let lane = 0;
    for (const root of [...tree.nodes.filter(node => !node.parent_id || !records.has(node.parent_id)), ...tree.nodes]) {
      const stack = [{ id: root.id, depth: 0 }];
      while (stack.length) {
        const item = stack.pop()!;
        if (placed.has(item.id)) continue;
        placed.add(item.id);
        const record = records.get(item.id)!;
        nodes.push({ id: `scene:${record.id}`, type: record.kind || "beat", title: record.title || record.id,
          content: record.summary, x: 40 + item.depth * (NODE_W + LAYOUT_H_GAP), y: 200 + lane++ * 160 });
        for (const id of [...(children.get(item.id) ?? [])].reverse()) stack.push({ id, depth: item.depth + 1 });
      }
    }
    doc = { ...doc, nodes, edges: tree.nodes.filter(node => node.parent_id && node.parent_id !== node.id && records.has(node.parent_id))
      .map(node => ({ id: `scene-edge:${node.id}`, from: `scene:${node.parent_id}`, to: `scene:${node.id}` })) };
    current = doc.nodes.find(node => node.id === `scene:${tree.current_id}`);
  } else if (!current && currentScene) {
    const dynamic: PlotGraphNodeDTO = { id: `scene:${currentScene.id}`, type: currentScene.kind || "beat",
      title: currentScene.title || "当前场景", content: currentScene.summary,
      x: Math.max(40, ...doc.nodes.map(node => node.x + NODE_W + LAYOUT_H_GAP)), y: 200 };
    doc = { ...doc, nodes: [...doc.nodes, dynamic] }; current = dynamic;
  }
  const runtimeById = new Map(tree?.nodes.map(node => [`scene:${node.id}`, node]) ?? []);
  for (const node of doc.nodes) {
    let progress: GraphNodeDisplay["progress"] = "locked";
    if (node.id.startsWith("scene:")) {
      if (runtimeById.get(node.id)?.has_state) progress = "done";
    } else if (node.type === "plot") {
      if (currentScene || arrived.size || current) progress = "done";
    } else if (node.type === "beat") {
      if (arrived.has(`${node.ref?.chapter_idx}:${node.ref?.beat_id}`)) progress = "done";
    } else if (node.type === "chapter") {
      if ([...arrived].some(key => key.startsWith(`${node.ref?.chapter_idx}:`)) || current?.ref?.chapter_idx === node.ref?.chapter_idx) progress = "done";
    } else if (node.type === "combat") {
      if (tree?.nodes.some(item => item.kind === "combat" && item.combat_node_id === node.ref?.node_id && item.has_state)) progress = "done";
    }
    if (node.id === current?.id) progress = "current";
    displays.set(node.id, { title: node.title, body: node.content, progress });
  }
  return { doc, displays, currentId: current?.id };
}
