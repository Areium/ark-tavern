import type { NodeRect } from "./graphModel";

export const CG_W = 160;
export const CG_H = 90;
export const CG_GAP = 12;
export const CG_CONNECTOR = 22;

export function cgStripWidth(count: number): number {
  return count > 0 ? count * CG_W + (count - 1) * CG_GAP : 0;
}

/** Used by both fit-view and culling; the persisted node coordinates stay intact. */
export function cgNodeBounds(rect: NodeRect, count: number): NodeRect {
  if (!count) return rect;
  const width = Math.max(rect.w, cgStripWidth(count));
  return { x: rect.x + (rect.w - width) / 2, y: rect.y - CG_H - CG_CONNECTOR,
    w: width, h: rect.h + CG_H + CG_CONNECTOR };
}
