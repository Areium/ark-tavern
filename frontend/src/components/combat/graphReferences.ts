import type { PlotFlowDTO, PlotGraphDocDTO, PlotGraphNodeDTO } from "../../types";

/** A beat's ID is authoritative. A moved, unique beat can be repaired; names are
 * never used to guess replacements. Ambiguous/deleted references stay explicit. */
export function resolveGraphReference(node: PlotGraphNodeDTO, plot: PlotFlowDTO | null) {
  const ref = node.ref;
  if (node.type === "beat") {
    const matches = plot?.chapters.flatMap(chapter => chapter.beats
      .filter(beat => beat.id === ref?.beat_id).map(beat => ({ chapter, beat }))) ?? [];
    const match = matches.length === 1 ? matches[0]
      : matches.find(({ chapter }) => chapter.idx === ref?.chapter_idx);
    return { chapter: match?.chapter, beat: match?.beat, missing: !match,
      moved: !!match && match.chapter.idx !== ref?.chapter_idx };
  }
  const chapter = plot?.chapters.find(ch => ch.idx === ref?.chapter_idx);
  return { chapter, beat: undefined, missing: node.type === "chapter" && !chapter, moved: false };
}

export function repairGraphReferences(doc: PlotGraphDocDTO, plot: PlotFlowDTO) {
  let repaired = 0;
  const nodes = doc.nodes.map(node => {
    const resolved = resolveGraphReference(node, plot);
    if (!resolved.moved || !resolved.chapter) return node;
    repaired++;
    return { ...node, ref: { ...node.ref, chapter_idx: resolved.chapter.idx } };
  });
  return { doc: { ...doc, nodes }, repaired };
}

/** Editorial edges do not execute choices. Only expose rules declared by the
 * source beat for the exact target; an unconfigured line is not a condition. */
export function graphEdgeDescription(doc: PlotGraphDocDTO, plot: PlotFlowDTO | null,
  fromId: string, toId: string): string {
  const from = doc.nodes.find(n => n.id === fromId);
  const to = doc.nodes.find(n => n.id === toId);
  if (!from || !to) return "";
  const source = resolveGraphReference(from, plot).beat;
  const target = resolveGraphReference(to, plot);
  const targetBeat = target.beat?.id ?? (to.type === "chapter" ? target.chapter?.beats[0]?.id : undefined);
  return source?.branches?.filter(b => b.target_beat_id === targetBeat && targetBeat)
    .map(b => b.intent ? `${b.label} · ${b.intent}` : b.label).join(" / ") || "";
}
