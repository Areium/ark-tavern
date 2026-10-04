import { useState } from "react";
import { useAppStore } from "../../stores/appStore";

const COLORS = [
  "#c44b3c", "#3c8c4a", "#8b5ca8", "#4a6b8a",
  "#c4a83c", "#d4a574", "#5c9a8b", "#6b5c8a",
];

function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash += name.charCodeAt(i);
  }
  return COLORS[hash % COLORS.length];
}

function avatarUrl(name: string, sessionId?: string, version = 0): string {
  const base = `/api/characters/${encodeURIComponent(name)}/avatar`;
  const query = new URLSearchParams({ v: String(version) });
  if (sessionId) query.set("session_id", sessionId);
  return `${base}?${query}`;
}

interface AvatarPlaceholderProps {
  name: string;
  size?: "sm" | "md";
  /** 会话覆盖与绑定世界书由后端统一解析；失败不得跨书回退。 */
  sessionId?: string;
}

export default function AvatarPlaceholder({ name, size = "sm", sessionId }: AvatarPlaceholderProps) {
  const bg = nameToColor(name);
  const initial = name.charAt(0);
  const sizeClass = size === "sm" ? "w-8 h-8 text-xs" : "w-10 h-10 text-sm";
  const resourceVersion = useAppStore((s) => s.resourceVersion);
  // 失败只属于这个 URL；切会话或刷新资源立即重试，旧图片事件不污染新地址。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = avatarUrl(name, sessionId, resourceVersion);

  if (failedSrc !== src) {
    return (
      <img
        key={src}
        src={src}
        alt={name}
        className={`dlg-ava ${sizeClass} rounded-full object-cover flex-shrink-0`}
        onError={() => setFailedSrc(src)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={name}
      className={`${sizeClass} rounded-full flex items-center justify-center font-bold text-white/90 flex-shrink-0`}
      style={{ backgroundColor: bg }}
      title={name}
    >
      {initial}
    </div>
  );
}
