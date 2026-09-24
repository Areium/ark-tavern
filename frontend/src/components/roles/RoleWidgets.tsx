/**
 * 角色页四个模块（角色库 / 玩家身份 / 资产 / 卡牌）共用的小控件。
 *
 * 之前这些控件在三个文件里各写一份（来源徽章三处、折叠按钮四处、搜索框两处），字号与
 * 图标尺寸互不一致；集中到这里后三个界面用同一套尺寸档位：
 *  - 工具栏图标按钮 28×28、图标 14；
 *  - 徽章 11px（列表行内 10px）、图标 11 / 10；
 *  - 搜索框 12px、左侧内嵌 13 的放大镜；
 *  - 面板页头：Orbitron 眉标 + 衬线标题（与世界书工作台同一套字体语言）。
 */
import type { ReactNode } from "react";
import type { WorldBookSummary } from "../../types";
import AppIcon, { type AppIconName } from "../AppIcon";

/** 来源世界书徽章：有来源显示书名，否则显示「未分类」 */
export function SourceBookBadge({
  name,
  size = "sm",
  title,
}: {
  /** 书名；空串 = 未分类 */
  name: string;
  size?: "xs" | "sm";
  title?: string;
}) {
  const xs = size === "xs";
  const cls = xs
    ? "text-[11px] px-1 py-px gap-0.5 max-w-[8rem]"
    : "text-[12px] px-1.5 py-0.5 gap-1 max-w-[12rem]";
  if (!name) {
    return (
      <span
        className={`inline-flex items-center rounded text-gray-500 shrink-0 ${cls}`}
        title={title ?? "未关联来源世界书：手动创建，或角色卡未自带世界书"}
      >
        <AppIcon name="folder" size={xs ? 10 : 11} />
        未分类
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded bg-amber-600/20 text-amber-300 border border-amber-700/30 shrink-0 ${cls}`}
      title={title ?? `来源世界书：${name}`}
    >
      <AppIcon name="worldbook" size={xs ? 10 : 11} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** 工具栏图标按钮（28×28） */
export function ToolIconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: AppIconName;
  /** 同时作为 title 与 aria-label */
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={
        "inline-flex items-center justify-center w-7 h-7 rounded-md border shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
        (active
          ? "bg-amber-600/20 text-amber-300 border-amber-500/30"
          : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 border-transparent")
      }
    >
      <AppIcon name={icon} size={14} />
    </button>
  );
}

/**
 * 折叠 / 展开全部 — 作用于当前视图可折叠的那一级（角色库 = 世界书分组；资产 = 实体；
 * 卡牌 = 角色/职业组或世界书分组）。一个视图只放一个，不再为每一级各放一个「折叠」。
 */
export function FoldAllButton({
  collapsed,
  onToggle,
  what = "分组",
  disabled = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** 折叠对象的称呼，出现在提示里 */
  what?: string;
  disabled?: boolean;
}) {
  return (
    <ToolIconButton
      icon={collapsed ? "expandAll" : "collapseAll"}
      label={collapsed ? `展开全部${what}` : `折叠全部${what}`}
      onClick={onToggle}
      disabled={disabled}
    />
  );
}

/** 列表搜索框（左侧内嵌放大镜） */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative flex-1 min-w-0 ${className}`.trim()}>
      <AppIcon
        name="search"
        size={13}
        className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
      />
      <input
        type="text"
        className="w-full bg-gray-900 border border-gray-700 rounded-md pl-7 pr-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:border-amber-500/50"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

type ActionVariant = "solid" | "amber" | "blue" | "purple" | "green" | "danger" | "ghost";

const ACTION_STYLES: Record<ActionVariant, string> = {
  solid: "bg-amber-600 text-white border-transparent hover:bg-amber-500",
  amber: "bg-amber-600/20 text-amber-300 border-amber-600/30 hover:bg-amber-600/40",
  blue: "bg-blue-600/20 text-blue-300 border-blue-600/20 hover:bg-blue-600/40",
  purple: "bg-purple-600/20 text-purple-300 border-purple-700/30 hover:bg-purple-600/40",
  green: "bg-green-600/20 text-green-300 border-emerald-600/50 hover:bg-emerald-800/70",
  danger: "bg-red-500/10 text-red-300 border-red-800/60 hover:bg-red-500/20",
  ghost: "bg-gray-700 text-gray-300 border-transparent hover:bg-gray-600",
};

/** 带图标的小号文字按钮（面板页头操作 / 表单提交 / 设为默认图） */
export function ActionButton({
  icon,
  variant = "ghost",
  onClick,
  disabled = false,
  title,
  className = "",
  children,
}: {
  icon?: AppIconName;
  variant?: ActionVariant;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        `inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${ACTION_STYLES[variant]} ${className}`.trim()
      }
    >
      {icon && <AppIcon name={icon} size={14} />}
      {children}
    </button>
  );
}

/** 右侧面板通用页头：眉标 + 衬线标题（+ 可选头像、标题下方的标签行、右侧操作区） */
export function PanelHeader({
  eyebrow,
  icon,
  title,
  size = "md",
  leading,
  actions,
  children,
}: {
  eyebrow: string;
  icon: AppIconName;
  title: string;
  size?: "md" | "lg";
  /** 标题左侧的头像等 */
  leading?: ReactNode;
  actions?: ReactNode;
  /** 标题下方：标签 / 徽章行 */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-700 shrink-0">
      <div className="flex items-start gap-3 min-w-0">
        {leading}
        <div className="min-w-0">
          <div className="roles-eyebrow"><AppIcon name={icon} size={11} />{eyebrow}</div>
          <h2 className={`roles-title truncate ${size === "lg" ? "text-xl" : "text-base"}`} title={title}>{title}</h2>
          {children}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0 pt-0.5">{actions}</div>}
    </div>
  );
}

/** 空状态：图标 + 一句话（+ 补充说明） */
export function EmptyState({ icon, text, sub }: { icon: AppIconName; text: string; sub?: string }) {
  return (
    <div className="roles-empty">
      <AppIcon name={icon} size={28} />
      <span>{text}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/** 来源世界书下拉（资产 / 卡牌详情共用） */
export function WorldbookSelect({
  value, worldbooks, onChange,
}: {
  value: string;
  worldbooks: WorldBookSummary[];
  onChange: (bookId: string) => void;
}) {
  return (
    <select
      className="bg-gray-800/80 border border-gray-700 rounded-md px-1.5 py-1 text-[12px] text-gray-300 max-w-[12rem]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="标注来源世界书"
    >
      <option value="">（未标注）</option>
      {worldbooks.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
}
