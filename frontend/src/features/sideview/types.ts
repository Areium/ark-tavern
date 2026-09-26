export interface Rect { x: number; y: number; width: number; height: number }
/** Thin ledges are one-way: pass through from below and the sides, land only when falling onto them. */
export interface Platform extends Rect { oneWay?: boolean }
export type SideviewVictoryCondition = 'clear_and_exit' | 'reach_exit';
export type SideviewEnemyKind = 'guard' | 'ranger' | 'elite';
export interface SideviewEnemySpec { id: string; name?: string; kind: SideviewEnemyKind; x: number; y: number; patrolMin: number; patrolMax: number; hp: number; damage?: number; speed?: number; range?: number }
export interface SimulationLevel {
  id: string; name: string; worldWidth: number; worldHeight: number;
  platforms: Platform[]; obstacles: Rect[]; hazards: (Rect & { damage?: number })[];
  spawn: { x: number; y: number }; enemies: SideviewEnemySpec[]; goal: Rect; victoryCondition: SideviewVictoryCondition;
}
export interface SideviewOperator { name: string; maxHp: number; attack: number; skillPower: number }
export type SideviewOutcome = 'victory' | 'defeat';
export interface Body extends Rect { vx: number; vy: number; grounded: boolean; facing: -1 | 1 }
/** Cosmetic street fixtures: no collision, damage, drops, or settlement state. */
export interface SceneProp extends Rect { id: string; kind: 'canister' | 'lamp'; broken: boolean }
export interface PlayerState extends Body {
  hp: number; invulnerable: number; attackCooldown: number; skillCooldown: number;
  dashCooldown: number; supportCooldown: number; dashTime: number; attackTime: number;
  coyote: number; jumpBuffer: number;
  /** A melee press slightly before recovery ends still lands. */
  attackBuffer: number;
  /** Last melee stage (1–3) and the window in which the next press continues the chain. */
  combo: number; comboTime: number;
  /** One perfect-dodge reward per dash. */
  dashPerfect: boolean;
  /** Last solid footing; pits return the player here instead of the level start. */
  safeX: number; safeY: number;
  /** Distance travelled on foot since the last footfall; transient presentation only. */
  stepDistance: number;
}
export interface EnemyState extends Body {
  id: string; hp: number; cooldown: number; windup: number; hurt: number;
  /** Stagger locks AI; knock is decaying horizontal velocity from hits. */
  stagger: number; knock: number;
  /** Elite charge: remaining lunge time after the windup releases. */
  lunge: number;
}
export interface SimulationSnapshot {
  version: 1; levelId: string; elapsed: number; player: PlayerState; enemies: EnemyState[];
  kills: number; damageTaken: number; outcome: SideviewOutcome | null;
}
export interface SideviewResult {
  runId: string; levelId: string; outcome: SideviewOutcome; durationMs: number;
  kills: number; damageTaken: number; hpRemaining: number; snapshot: SideviewSnapshot;
  /** Presentation only: longest hit chain. The server ignores it. */
  bestChain?: number;
}
export type Action = 'left' | 'right' | 'jump' | 'dash' | 'attack' | 'skill' | 'support';
export type SideviewInput = Record<Action, boolean>;
export type EffectKind = 'hit' | 'slash' | 'finisher' | 'skill' | 'support' | 'dash' | 'perfect' | 'damage' | 'lunge' | 'step' | 'land' | 'jump' | 'debris' | 'spark';
export interface Effect {
  x: number; y: number; kind: EffectKind; life: number; facing: number;
  /** Floating numbers: amount and who received it. */
  value?: number; tone?: 'enemy' | 'player' | 'heal';
}
export interface Projectile extends Rect { vx: number; vy: number; life: number; damage: number }
export interface Simulation extends SimulationSnapshot {
  props: SceneProp[];
  effects: Effect[]; projectiles: Projectile[]; previous: SideviewInput;
  /** Rising edges pressed during hitstop, applied on the next live step. */
  queued: Partial<SideviewInput>;
  /** Presentation cues owned by the deterministic step. */
  hitstop: number; shake: number; hurtFlash: number;
  /** Consecutive hits without taking damage. */
  chain: number; chainTime: number; bestChain: number;
}

export interface SideviewLevel {
  schemaVersion: 1; id: string; name: string; width: number; height: number;
  platforms: Platform[]; obstacles: Rect[]; hazards: (Rect & { damage: number })[];
  spawn: { x: number; y: number };
  enemies: { id: string; name: string; x: number; y: number; hp: number; damage: number; speed: number; range: number; kind?: SideviewEnemyKind; patrolMin?: number; patrolMax?: number }[];
  exit: Rect; victoryCondition?: SideviewVictoryCondition; rewards: { xp: number; items: string[] };
}
export interface SideviewSnapshot {
  version: 1; player: { x: number; y: number; hp: number; facing: number };
  enemies: { id: string; x: number; y: number; hp: number }[];
  elapsedMs: number; exitReached: boolean;
  cooldowns?: { skill: number; dash: number; support: number }; damageTaken?: number;
}
