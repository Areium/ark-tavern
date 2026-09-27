import { useEffect, useRef, useState } from "react";

interface CombatEvent {
  type: string;
  data: Record<string, any>;
}

interface Props {
  events: CombatEvent[];
}

const ICON_MAP: Record<string, string> = {
  round_start: "◎",
  turn_start: "▸",
  damage: "⚔",
  heal: "✦",
  death: "☠",
  battle_end: "◈",
  move: "↗",
  error: "⚠",
  block_attempt: "🛡",
  block_success: "✓",
  block_fail: "✗",
  intercept_prompt: "⚡",
  battle_start: "▶",
  card_played: "◆",
  turn_end: "◁",
};

function formatEvent(ev: CombatEvent): { icon: string; text: string } {
  const icon = ICON_MAP[ev.type] || "·";
  switch (ev.type) {
    case "battle_start":
      return { icon, text: `战斗开始 — ${ev.data.encounter || ""}` };
    case "round_start":
      return { icon, text: `第 ${ev.data.round || "?"} 回合` };
    case "turn_start": {
      const team = ev.data.team === "player" ? "Player" : "Enemy";
      return { icon, text: `${ev.data.name || "?"}（${team}）行动` };
    }
    case "damage": {
      const card = ev.data.card ? `「${ev.data.card}」` : "";
      return { icon, text: `${ev.data.caster || "?"} ${card} → ${ev.data.target || "?"}  -${ev.data.damage || 0}${/crit/i.test(ev.data.hit_result || "") ? " · 暴击" : /miss|dodge/i.test(ev.data.hit_result || "") ? " · 未命中" : ""}` };
    }
    case "card_drawn":
      return { icon, text: `抽到「${ev.data.card || "卡牌"}」 · ${ev.data.owner || ev.data.unit_id || ""}` };
    case "cleanse":
      return { icon, text: `${ev.data.target || "目标"} 的负面状态已清除` };
    case "status": {
      const names: Record<string, string> = { shield: "护盾", burn: "燃烧", slow: "减速", bind: "束缚", weaken: "虚弱", strengthen: "增幅", silence: "沉默", taunt: "嘲讽", evade: "闪避", blind: "致盲" };
      return { icon, text: `${ev.data.target || "目标"} 获得${names[ev.data.type] || "状态效果"}` };
    }
    case "heal":
      return { icon, text: `${ev.data.caster || "?"} 治疗 ${ev.data.target || "?"} +${ev.data.amount || 0}` };
    case "death":
      return { icon, text: `${ev.data.name || "?"} 被击倒` };
    case "move":
      return { icon, text: `${ev.data.name || "?"} 移动到 (${(ev.data.to_pos ?? ev.data.to)?.[0] ?? "?"},${(ev.data.to_pos ?? ev.data.to)?.[1] ?? "?"})` };
    case "block_attempt":
      return { icon, text: `${ev.data.name || "?"} 尝试挡刀...` };
    case "block_success":
      return { icon, text: `${ev.data.name || "?"} 成功挡刀！伤害重定向` };
    case "block_fail":
      return { icon, text: `${ev.data.name || "?"} 挡刀失败` };
    case "battle_end":
      return { icon, text: ev.data.winner === "player" ? "战斗胜利！" : ev.data.winner === "escaped" ? "已撤退" : "战斗失败..." };
    case "card_played": {
      return { icon, text: `${ev.data.caster || "?"} 使用「${ev.data.card || "?"}」` };
    }
    case "turn_end":
      return { icon, text: `第 ${ev.data.round || "?"} 回合结束` };
    case "error":
      return { icon, text: `错误: ${ev.data.msg || "?"}` };
    default:
      return { icon, text: "战场状态已更新" };
  }
}

function eventStyle(type: string): string {
  switch (type) {
    case "damage":          return "text-dmg-physical";
    case "heal":            return "text-dmg-healing";
    case "death":           return "text-purple-400";
    case "turn_start":      return "text-gray-300";
    case "round_start":     return "text-combat-gold font-bold";
    case "battle_start":
    case "battle_end":      return "text-combat-gold font-bold";
    case "card_played":     return "text-combat-player";
    case "turn_end":        return "text-gray-500";
    case "block_success":   return "text-combat-player";
    case "block_fail":
    case "error":           return "text-combat-enemy";
    default:                return "text-gray-500";
  }
}

export default function CombatEventLog({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (!collapsed) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events.length, collapsed]);

  return (
    <div className="border border-combat-border rounded-lg bg-surface-dark/90 overflow-hidden">
      {/* Header — sticky, clickable toggle */}
      <button
        className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-dark hover:bg-surface-hover transition-colors sticky top-0 z-10"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="text-[11px] text-gray-600 uppercase tracking-widest font-display">
          Combat Log
        </span>
        <span className="text-[11px] text-gray-500">
          {collapsed ? `▶ ${events.length} events` : "▼"}
        </span>
      </button>

      {!collapsed && (
        <div className="h-32 overflow-y-auto p-2">
          {events.length === 0 && (
            <div className="text-[12px] text-gray-700 italic">等待战斗事件...</div>
          )}
          {events.slice(-80).map((ev, i) => {
            const { icon, text } = formatEvent(ev);
            return (
              <div key={i} className={`combat-log-entry text-[12px] font-mono leading-relaxed ${eventStyle(ev.type)}`}>
                <span className="log-icon text-[11px]">{icon}</span>
                <span>{text}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
