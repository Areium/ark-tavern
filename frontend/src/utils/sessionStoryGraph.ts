import type { StageDTO, StoryStateDTO, StoryTreeDTO } from "../types";

export const STORY_GRAPH_NODE_WIDTH = 224;
export const STORY_GRAPH_NODE_HEIGHT = 128;
export const STORY_GRAPH_MAX_ZOOM = 2;
export type SessionGraphNodeState = "current" | "path" | "visited" | "locked";
export interface SessionGraphNode {
  id: string;
  title: string;
  summary: string;
  type: "plot" | "chapter" | "beat" | "combat";
  subtitle: string;
  x: number;
  y: number;
  state: SessionGraphNodeState;
}
export interface SessionGraphEdge { source: string; target: string; onPath: boolean; label?: string }
export interface SessionGraphLayout {
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
  width: number;
  height: number;
}
const EMPTY: SessionGraphLayout = { nodes: [], edges: [], width: 0, height: 0 };
export const SESSION_GRAPH_STATE_LABEL = { current: "当前位置", path: "已抵达", visited: "已探索分支", locked: "未抵达" };
export const SESSION_GRAPH_KIND_LABEL = { plot: "剧情入口", chapter: "章节", beat: "剧情节拍", combat: "战斗节点" };

export function sessionGraphFitZoom(layout: Pick<SessionGraphLayout, "width" | "height">,
  viewport: { width: number; height: number }): number {
  if (!layout.width || !layout.height || !viewport.width || !viewport.height) return 1;
  return Math.min(1, Math.max(1, viewport.width - 24) / layout.width, Math.max(1, viewport.height - 24) / layout.height);
}

/** All authored chapters/beats and every generated scene.
 * A narration may advance the roadmap before it is committed: the round-bound
 * stage cue identifies the beat the player just saw. It must never mark a second
 * node current. The runtime tree owns the avatar; cues only color authored beats.
 * Chapter progress is derived from its beats, not array order (branches can be skipped).
 */
export function layoutSessionStoryGraph(state?: StoryStateDTO | null, cue?: StageDTO["scene_media"] | null): SessionGraphLayout {
  if (!state?.has_plot) return EMPTY;
  const tree = state.tree;
  const hasTree = !!tree?.has_tree;
  const roads = state.roads ?? [];
  const currentBeat = cue?.round && cue.beat_id ? cue.beat_id : hasTree ? undefined : state.beat?.id;
  const currentChapter = cue?.round && cue.beat_id ? roads.find(road => road.chapter_idx + 1 === cue.chapter_idx)?.id
    : hasTree ? undefined : state.chapter?.id;
  const nodes: SessionGraphNode[] = [];
  const edges: SessionGraphEdge[] = [];
  const completed = new Set(state.completed_beats ?? []);
  const beatNodes = new Map<string, SessionGraphNode>();
  const chapterNodes = new Map<string, SessionGraphNode>();
  const ids = new Set<string>();
  const addEdge = (source: string, target: string, label?: string) => {
    if (source === target || !ids.has(source) || !ids.has(target) || edges.some(e => e.source === source && e.target === target)) return;
    const a = nodes.find(node => node.id === source)!;
    const b = nodes.find(node => node.id === target)!;
    edges.push({ source, target, onPath: a.state !== "locked" && b.state !== "locked" && b.state !== "visited", label });
  };
  for (const [row, road] of roads.entries()) {
    const y = 76 + row * 224;
    const chapter: SessionGraphNode = { id: `chapter:${road.chapter_idx}:${road.id}`, title: road.title || `章节 ${road.chapter_idx + 1}`,
      summary: road.summary || "", type: "chapter", subtitle: road.kind === "branch" ? "分支路线" : `第 ${road.chapter_idx + 1} 章`,
      x: 48, y, state: "locked" };
    nodes.push(chapter); ids.add(chapter.id); chapterNodes.set(road.id, chapter);
    for (const [col, beat] of road.beats.entries()) {
      const arrived = beat.id === currentBeat && (!currentChapter || road.id === currentChapter);
      const progress = arrived ? hasTree ? "path" : "current" : beat.state === "done" || completed.has(beat.id) || beat.round_start != null ? "path" : "locked";
      const entry: SessionGraphNode = { id: `beat:${road.chapter_idx}:${beat.id}`, title: beat.title || beat.summary || beat.id,
        summary: beat.summary, type: beat.has_combat ? "combat" : "beat", subtitle: `节拍 ${col + 1} · ${beat.id}`,
        x: 360 + col * 312, y, state: progress };
      nodes.push(entry); ids.add(entry.id); beatNodes.set(beat.id, entry);
    }
    // Chapter cards group beats; the runtime tree owns the avatar when present.
    if (road.beats.some(beat => beatNodes.get(beat.id)?.state === "current" || beatNodes.get(beat.id)?.state === "path")) chapter.state = "path";
    else if (road.beats.some(beat => beatNodes.get(beat.id)?.state === "visited")) chapter.state = "visited";
  }
  let previousMain: SessionGraphNode | undefined;
  let previousRequiresChoice = false;
  for (const road of roads) {
    const chapter = chapterNodes.get(road.id)!;
    const first = beatNodes.get(road.beats[0]?.id);
    if (first) addEdge(chapter.id, first.id);
    if (road.kind === "branch") {
      const origin = beatNodes.get(road.origin?.beat_id || "") || chapterNodes.get(road.origin?.chapter_id || "");
      if (origin) addEdge(origin.id, chapter.id);
    } else {
      if (previousMain && !previousRequiresChoice) addEdge(previousMain.id, chapter.id);
      previousMain = beatNodes.get(road.beats[road.beats.length - 1]?.id) || chapter;
      previousRequiresChoice = !!road.beats[road.beats.length - 1]?.choice_required;
    }
    road.beats.forEach((beat, index) => {
      const from = beatNodes.get(beat.id)!;
      const branches = beat.authored_branches ?? [];
      const targets = branches.map(branch => ({ target: beatNodes.get(branch.target_beat_id || ""), label: branch.label }));
      for (const { target, label } of targets) if (target) addEdge(from.id, target.id, label);
      // Optional choices preserve normal progression; mandatory choices do not.
      if (!beat.choice_required) {
        const next = beatNodes.get(road.beats[index + 1]?.id);
        if (next) addEdge(from.id, next.id);
      }
    });
  }
  // Keep every generated scene and its real parent edges. Multiple scenes can
  // share or change a beat ref: collapsing them would erase genuine forks.
  // The tree current ID is the sole avatar position when a tree exists, even
  // when the historical stage cue fails or progress has advanced ahead.
  const journey = layoutRuntimeTree(tree, 76 + roads.length * 224);
  nodes.push(...journey.nodes);
  edges.push(...journey.edges);
  if (!nodes.length) return EMPTY;
  return { nodes, edges, width: nodes.reduce((max, node) => Math.max(max, node.x), 0) + STORY_GRAPH_NODE_WIDTH + 48,
    height: nodes.reduce((max, node) => Math.max(max, node.y), 0) + STORY_GRAPH_NODE_HEIGHT + 64 };
}

/** Iterative forest layout: deep scenes, orphan roots and malformed cycles stay
 * visible without recursion. parent_id is authoritative; no guessed choice edges.
 */
function layoutRuntimeTree(tree: StoryTreeDTO | undefined, top: number) {
  if (!tree?.has_tree) return { nodes: [], edges: [] };
  const records = new Map<string, StoryTreeDTO["nodes"][number]>();
  for (const node of tree.nodes) if (node.id && !records.has(node.id)) records.set(node.id, node);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of records.values()) {
    if (!node.parent_id || node.parent_id === node.id || !records.has(node.parent_id)) roots.push(node.id);
    else {
      const siblings = children.get(node.parent_id) ?? [];
      siblings.push(node.id);
      children.set(node.parent_id, siblings);
    }
  }
  const path = new Set(tree.path ?? []);
  const placed = new Map<string, SessionGraphNode>();
  const edges: SessionGraphEdge[] = [];
  let lane = 0;
  for (const root of [...roots, ...records.keys()]) {
    if (placed.has(root)) continue;
    const stack = [{ id: root, depth: 0, exit: false, descendants: [] as string[] }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) {
        placed.get(frame.id)!.y = frame.descendants.length
          ? (placed.get(frame.descendants[0])!.y + placed.get(frame.descendants[frame.descendants.length - 1])!.y) / 2
          : top + lane++ * 184;
        continue;
      }
      if (placed.has(frame.id)) continue;
      const node = records.get(frame.id)!;
      const entry: SessionGraphNode = { id: `scene:${node.id}`, title: node.title || node.id, summary: node.summary,
        type: node.kind || "beat", subtitle: "会话剧情", x: 48 + frame.depth * 312, y: 0,
        state: node.id === tree.current_id ? "current" : path.has(node.id) ? "path" : node.has_state ? "visited" : "locked" };
      placed.set(node.id, entry);
      const descendants = (children.get(node.id) ?? []).filter(id => !placed.has(id));
      stack.push({ ...frame, exit: true, descendants });
      for (let i = descendants.length - 1; i >= 0; i--) {
        const id = descendants[i];
        edges.push({ source: entry.id, target: `scene:${id}`, onPath: path.has(node.id) && (path.has(id) || id === tree.current_id) });
        stack.push({ id, depth: frame.depth + 1, exit: false, descendants: [] });
      }
    }
  }
  return { nodes: [...placed.values()], edges };
}
