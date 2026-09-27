/**
 * useResizableWidth —— 侧栏 / 面板宽度拖拽调整。
 *
 * 用法：
 *   const panel = useResizableWidth({ storageKey: "ark.scenePanel.width", defaultWidth: 288 });
 *   <aside style={{ width: panel.width }}>…</aside>
 *   <ResizeHandle resize={panel} label="调整面板宽度" />
 *
 * - 拖拽把手上的 Pointer Capture 保证移出把手后仍能继续拖动；
 * - 宽度持久化到 localStorage（按 storageKey 各自独立）；
 * - 双击把手恢复默认宽度；键盘 ←/→ 也可微调（无障碍 separator 语义）。
 */
import { useCallback, useState } from "react";

export interface ResizableWidthOptions {
  /** localStorage 持久化键（各面板取不同值） */
  storageKey: string;
  /** 默认宽度（px） */
  defaultWidth: number;
  /** 最小宽度（px），默认 200 */
  min?: number;
  /** 最大宽度（px），默认 560 */
  max?: number;
  /** 把手在面板的哪一侧：right = 面板在左（往右拉变宽）；left = 面板在右 */
  edge?: "right" | "left";
  /** 键盘方向键步进（px），默认 16 */
  step?: number;
}

export interface ResizableWidth {
  width: number;
  min: number;
  max: number;
  /** 恢复到默认宽度 */
  reset: () => void;
  /** 拖拽把手的完整 props（ResizeHandle 内部使用，也可自行展开） */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  };
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min = 200,
  max = 560,
  edge = "right",
  step = 16,
}: ResizableWidthOptions): ResizableWidth {
  const clamp = useCallback(
    (w: number) => Math.min(max, Math.max(min, Math.round(w))),
    [min, max],
  );

  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) return clamp(saved);
    } catch {
      /* localStorage 不可用时用默认值 */
    }
    return clamp(defaultWidth);
  });

  const persist = useCallback(
    (w: number) => {
      try {
        window.localStorage.setItem(storageKey, String(w));
      } catch {
        /* 持久化失败不影响本次使用 */
      }
    },
    [storageKey],
  );

  const apply = useCallback(
    (w: number, save = false) => {
      const next = clamp(w);
      setWidth(next);
      if (save) persist(next);
      return next;
    },
    [clamp, persist],
  );

  const reset = useCallback(() => {
    apply(defaultWidth, true);
  }, [apply, defaultWidth]);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const el = e.currentTarget;
      if (el.dataset.dragging !== "1") return;
      delete el.dataset.dragging;
      document.body.classList.remove("is-col-resizing");
      // 松手时持久化最终宽度
      setWidth((w) => {
        persist(w);
        return w;
      });
    },
    [persist],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      el.dataset.dragging = "1";
      el.dataset.startX = String(e.clientX);
      el.dataset.startWidth = String(width);
      el.setPointerCapture(e.pointerId);
      document.body.classList.add("is-col-resizing");
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const el = e.currentTarget;
      if (el.dataset.dragging !== "1") return;
      const startX = Number(el.dataset.startX);
      const startWidth = Number(el.dataset.startWidth);
      const delta = e.clientX - startX;
      apply(startWidth + (edge === "right" ? delta : -delta));
    },
    [apply, edge],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      let delta = 0;
      if (e.key === "ArrowLeft") delta = edge === "right" ? -step : step;
      else if (e.key === "ArrowRight") delta = edge === "right" ? step : -step;
      else if (e.key === "Home") {
        e.preventDefault();
        apply(min, true);
        return;
      } else if (e.key === "End") {
        e.preventDefault();
        apply(max, true);
        return;
      } else return;
      e.preventDefault();
      apply(width + delta, true);
    },
    [apply, edge, step, width, min, max],
  );

  return {
    width,
    min,
    max,
    reset,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: reset,
      onKeyDown,
    },
  };
}
