/**
 * 实体头像 — 角色库 / 玩家身份 / 卡牌三个列表共用。
 *
 * 有头像文件就显示图片；没有（新建的玩家身份、未配图的角色）时不再留一个隐形的空方块，
 * 而是显示按名称取色的首字色块，列表行与详情页头的版式因此始终稳定。
 * 取色与对话页 `chat/AvatarPlaceholder` 同一套色板，同名实体两处颜色一致。
 */
import { useEffect, useState } from "react";

const PALETTE = [
  "#c44b3c", "#3c8c4a", "#8b5ca8", "#4a6b8a",
  "#c4a83c", "#d4a574", "#5c9a8b", "#6b5c8a",
];

/** 与 `chat/AvatarPlaceholder` 相同的取色规则：按字符码求和取模 */
export function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i);
  return PALETTE[hash % PALETTE.length];
}

/** 角色 / 玩家身份的全局头像地址（两者都是角色目录） */
export const characterAvatarUrl = (id: string, bookId?: string) =>
  `/api/characters/${encodeURIComponent(id)}/avatar${bookId === "" ? "?local_only=1" : bookId ? `?worldbook_id=${encodeURIComponent(bookId)}` : ""}`;

interface EntityAvatarProps {
  /** 展示名：alt 文本与首字色块的取字来源 */
  name: string;
  /** 图片地址；空值直接显示首字色块 */
  src?: string | null;
  /** 边长（px） */
  size?: number;
  shape?: "rounded" | "circle";
  className?: string;
}

export default function EntityAvatar({ name, src, size = 32, shape = "rounded", className = "" }: EntityAvatarProps) {
  const [failed, setFailed] = useState(false);
  // 换了实体要重新尝试加载，否则上一个实体的失败态会粘到新实体上
  useEffect(() => { setFailed(false); }, [src]);

  const radius = shape === "circle" ? "9999px" : `${Math.max(4, Math.round(size * 0.22))}px`;
  const box = { width: size, height: size, borderRadius: radius };

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        loading="lazy"
        draggable={false}
        style={box}
        className={`roles-avatar ${className}`.trim()}
        onError={() => setFailed(true)}
      />
    );
  }
  const initial = Array.from(name.trim())[0] || "?";
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ ...box, background: nameToColor(name), fontSize: Math.round(size * 0.42) }}
      className={`roles-avatar-fallback ${className}`.trim()}
    >
      {initial}
    </span>
  );
}
