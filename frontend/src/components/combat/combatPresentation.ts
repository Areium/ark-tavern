import type { CombatEventDTO, CombatStateDTO } from "../../types";

export interface CombatPresentationResponse {
  state: CombatStateDTO;
  events: CombatEventDTO[];
}

export interface CombatCue {
  event: CombatEventDTO;
  attack: boolean;
  before: number;
  after: number;
}

/** Engine events describe results; only the first result of a card starts its animation. */
export function combatCues(events: CombatEventDTO[], reducedMotion = false, cursor = { attackKey: "" }): CombatCue[] {
  let attackKey = cursor.attackKey;
  return events.map((event) => {
    const d = event.data;
    const type = event.type as string;
    const isCardEffect = ["damage", "heal", "status"].includes(type)
      && !!d.card_id && d.source_type !== "terrain" && d.source_type !== "burn";
    const key = `${d.unit_id}:${d.card_id}`;
    const attack = isCardEffect && key !== attackKey;
    if (attack) attackKey = key;
    if (type === "card_played" || type === "move" || type === "turn_end") attackKey = "";
    cursor.attackKey = attackKey;
    const before = attack ? (reducedMotion ? 50 : 180) : 0;
    const after = type === "move" ? (reducedMotion ? 80 : 300)
      : type === "death" ? (reducedMotion ? 120 : 650)
      : ["damage", "heal"].includes(type) ? (reducedMotion ? 60 : 180)
      : type === "round_start" ? 160 : 0;
    return { event, attack, before, after };
  });
}

/** Visual projection only. Every action ends by replacing it with the authoritative snapshot. */
export function projectCombatEvent(state: CombatStateDTO, event: CombatEventDTO): CombatStateDTO {
  const d = event.data;
  const type = event.type as string;
  if (type === "round_start") return { ...state, round_num: d.round ?? state.round_num, phase: "PLAYER_TURN" };
  const target = type === "move" || type === "death" ? d.unit_id : d.target_id;
  if (!target) return state;
  return { ...state, units: state.units.map((unit) => {
    if (unit.unit_id !== target) return unit;
    if (type === "damage") return {
      ...unit, hp: Math.max(0, unit.hp - Math.max(0, Number(d.damage) || 0)),
      // Keep lethal targets on stage until the separate death cue has started.
      status: { ...unit.status, shield: Math.max(0, (unit.status?.shield ?? 0) - (Number(d.shielded) || 0)) },
    };
    if (type === "heal") return { ...unit, hp: Math.min(unit.max_hp, unit.hp + Math.max(0, Number(d.amount) || 0)) };
    if (type === "death") return { ...unit, hp: 0, is_alive: false };
    if (type === "move" && Array.isArray(d.to_pos)) return { ...unit, pos: [...d.to_pos] as [number, number] };
    if (type === "status") {
      const previous = Number(unit.status?.[d.type]) || 0;
      const value = Math.max(0, Number(d.value) || 0);
      if (d.type === "burn") return { ...unit, status: { ...unit.status,
        burn: Math.max(previous, Number(d.duration) || 2),
        burn_damage: Math.max(Number(unit.status?.burn_damage) || 0, value),
      } };
      return { ...unit, status: { ...unit.status,
        [d.type]: d.type === "shield" ? previous + value : Math.max(previous, value),
      } };
    }
    if (type === "cleanse") {
      const status = { ...unit.status };
      for (const kind of ["slow", "bind", "weaken", "silence", "burn", "blind", "burn_damage"]) status[kind] = 0;
      return { ...unit, status };
    }
    return unit;
  }) };
}

/** Bounded deduplication for the same event delivered through HTTP and SSE. */
export class CombatEventLedger {
  private ids = new Set<string>();
  has(event: CombatEventDTO): boolean {
    return !!event.data.presentation_id && this.ids.has(event.data.presentation_id);
  }
  remember(event: CombatEventDTO): void {
    const id = event.data.presentation_id;
    if (!id) return;
    this.ids.add(id);
    if (this.ids.size > 2048) this.ids.delete(this.ids.values().next().value!);
  }
  clear(): void { this.ids.clear(); }
}

export function presentationDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ok);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
