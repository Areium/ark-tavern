/**
 * ResizeHandle —— 侧栏宽度拖拽把手（配合 useResizableWidth）。
 *
 * 渲染为一条覆盖在面板边缘的窄热区（视觉居中、不挤占布局），
 * 悬停 / 聚焦 / 拖动时亮起；支持键盘 ←/→ 微调、Home/End 到极限、双击复位。
 */
import type { ResizableWidth } from "../../hooks/useResizableWidth";

export default function ResizeHandle({
  resize,
  label,
  className = "",
}: {
  resize: ResizableWidth;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={resize.width}
      aria-valuemin={resize.min}
      aria-valuemax={resize.max}
      tabIndex={0}
      title={`${label}（拖拽调整，双击恢复默认）`}
      className={`resize-handle ${className}`}
      {...resize.handleProps}
    />
  );
}
