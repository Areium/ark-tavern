import type { StoryTreeDTO, StoryTreeNode } from "../types";

export const STORY_GRAPH_NODE_WIDTH = 244;
export const STORY_GRAPH_NODE_HEIGHT = 140;
export type SessionGraphNodeState = "current" | "path" | "branch";
export interface SessionGraphNode {
  id: string;
  node: StoryTreeNode;
  x: number;
  y: number;
  state: SessionGraphNodeState;
}
export interface SessionGraphEdge { source: string; target: string; onPath: boolean }
export interface SessionGraphLayout {
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
  width: number;
  height: number;
}

/** Linear-time, iterative forest layout. parent_id is authoritative, not depth/children.
 * Duplicate IDs keep the first node; orphan roots and cycles remain inspectable.
 * A cycle's closing edge is omitted so every rendered edge points forwards.
 * Never mutates the response or guesses a current node when current_id is absent.
 */
export function layoutSessionStoryGraph(tree?: StoryTreeDTO | null): SessionGraphLayout {
  const empty = { nodes: [], edges: [], width: 0, height: 0 };
  if (!tree?.has_tree || !tree.nodes?.length) return empty;
  const byId = new Map<string, StoryTreeNode>();
  for (const node of tree.nodes) if (node.id && !byId.has(node.id)) byId.set(node.id, node);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of byId.values()) {
    if (!node.parent_id || !byId.has(node.parent_id) || node.parent_id === node.id) roots.push(node.id);
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
  let maxX = 0;
  // Include non-root components after the normal roots, covering malformed cycles.
  for (const root of [...roots, ...byId.keys()]) {
    if (placed.has(root)) continue;
    const stack: { id: string; depth: number; exit: boolean; children: string[] }[] = [
      { id: root, depth: 0, exit: false, children: [] },
    ];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) {
        const entry = placed.get(frame.id)!;
        entry.y = frame.children.length
          ? (placed.get(frame.children[0])!.y + placed.get(frame.children[frame.children.length - 1])!.y) / 2
          : 32 + lane++ * 180;
        continue;
      }
      if (placed.has(frame.id)) continue;
      const node = byId.get(frame.id)!;
      const x = 32 + frame.depth * 312;
      maxX = Math.max(maxX, x);
      placed.set(node.id, { id: node.id, node, x, y: 0,
        state: node.id === tree.current_id ? "current" : path.has(node.id) ? "path" : "branch" });
      const descendants = (children.get(node.id) ?? []).filter(id => !placed.has(id));
      stack.push({ ...frame, exit: true, children: descendants });
      for (let i = descendants.length - 1; i >= 0; i--) {
        const id = descendants[i];
        edges.push({ source: node.id, target: id,
          onPath: path.has(node.id) && (path.has(id) || id === tree.current_id) });
        stack.push({ id, depth: frame.depth + 1, exit: false, children: [] });
      }
    }
  }
  return { nodes: [...placed.values()], edges,
    width: maxX + STORY_GRAPH_NODE_WIDTH + 32,
    height: Math.max(1, lane) * 180 + 24 };
}
