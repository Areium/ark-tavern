import type { CSSProperties } from "react";
import { useAppStore } from "../../stores/appStore";
import AvatarPlaceholder from "./AvatarPlaceholder";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

interface DialogueBubbleProps {
  text: string;
  speaker?: string;
  color?: string;
  /** 会话 ID：传入时头像走会话覆盖（会话优先，回退全局） */
  sessionId?: string;
}

const FALLBACK_ROLE_COLOR = "#a78bfa";
const FALLBACK_BG = "rgba(88, 28, 135, 0.25)";
const FALLBACK_BORDER = "rgba(147, 51, 234, 0.3)";

export default function DialogueBubble({ text, speaker, color, sessionId }: DialogueBubbleProps) {
  const isUnknown = !speaker;
  // 点击台词 → 高亮说话人（场景角色列表 / 舞台立绘同步）；再点一次取消
  const highlighted = useAppStore((s) => s.highlightedSpeaker);
  const setHighlightedSpeaker = useAppStore((s) => s.setHighlightedSpeaker);
  const isHighlighted = !!speaker && highlighted === speaker;

  const rgb = color ? hexToRgb(color) : null;
  // 姓名保留角色原色色相，由主题 CSS 根据背景明度自动提亮或压深。
  const nameStyle = {
    "--role-color": rgb ? `rgb(${rgb.join(", ")})` : FALLBACK_ROLE_COLOR,
  } as CSSProperties;
  const bubbleBg = rgb
    ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)`
    : FALLBACK_BG;
  const bubbleBorder = rgb
    ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.35)`
    : FALLBACK_BORDER;

  return (
    <div className="flex items-start gap-3 my-2">
      {isUnknown ? (
        <div className="w-8 h-8 rounded-full flex-shrink-0 border border-dashed border-gray-600/50" />
      ) : (
        <AvatarPlaceholder name={speaker!} size="sm" sessionId={sessionId} />
      )}

      <div className="flex flex-col max-w-[75%]">
        {speaker && (
          <span className="dlg-name text-sm font-bold mb-0.5 ml-1" style={nameStyle}>
            {speaker}
          </span>
        )}

        <div
          className={`dlg-bubble border rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed text-gray-100 ${isHighlighted ? "is-highlighted" : ""}`}
          style={{
            ...nameStyle,
            backgroundColor: isUnknown ? "rgba(55, 65, 81, 0.4)" : bubbleBg,
            borderColor: isUnknown ? "rgba(75, 85, 99, 0.3)" : bubbleBorder,
          }}
          onClick={() => { if (speaker) setHighlightedSpeaker(isHighlighted ? null : speaker); }}
          title={speaker ? `点击高亮「${speaker}」` : undefined}
        >
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    </div>
  );
}
