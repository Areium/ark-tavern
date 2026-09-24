export interface Rect { x: number; y: number; width: number; height: number }
export type SideviewVictoryCondition = 'clear_and_exit' | 'reach_exit';
export interface SideviewEnemySpec { id: string; kind: 'guard' | 'ranger' | 'elite'; x: number; y: number; patrolMin: number; patrolMax: number; hp: number; damage?: number; speed?: number; range?: number }
export interface SimulationLevel {
  id: string; name: string; worldWidth: number; worldHeight: number;
  platforms: Rect[]; obstacles: Rect[]; hazards: (Rect & { damage?: number })[];
  spawn: { x: number; y: number }; enemies: SideviewEnemySpec[]; goal: Rect; victoryCondition: SideviewVictoryCondition;
}
export interface SideviewOperator { name: string; maxHp: number; attack: number; skillPower: number }
export type SideviewOutcome = 'victory' | 'defeat';
export interface Body extends Rect { vx: number; vy: number; grounded: boolean; facing: -1 | 1 }
export interface PlayerState extends Body {
  hp: number; invulnerable: number; attackCooldown: number; skillCooldown: number;
  dashCooldown: number; supportCooldown: number; dashTime: number; attackTime: number;
  coyote: number; jumpBuffer: number;
}
export interface EnemyState extends Body { id: string; hp: number; cooldown: number; windup: number; hurt: number }
export interface SimulationSnapshot {
  version: 1; levelId: string; elapsed: number; player: PlayerState; enemies: EnemyState[];
  kills: number; damageTaken: number; outcome: SideviewOutcome | null;
}
export interface SideviewResult {
  runId: string; levelId: string; outcome: SideviewOutcome; durationMs: number;
  kills: number; damageTaken: number; hpRemaining: number; snapshot: SideviewSnapshot;
}
export type Action = 'left' | 'right' | 'jump' | 'dash' | 'attack' | 'skill' | 'support';
export type SideviewInput = Record<Action, boolean>;
export interface Effect { x: number; y: number; kind: 'hit' | 'slash' | 'skill' | 'support' | 'dash'; life: number; facing: number }
export interface Projectile extends Rect { vx: number; life: number; damage: number }
export interface Simulation extends SimulationSnapshot { effects: Effect[]; projectiles: Projectile[]; previous: SideviewInput }

export interface SideviewLevel {
  schemaVersion: 1; id: string; name: string; width: number; height: number;
  platforms: Rect[]; obstacles: Rect[]; hazards: (Rect & { damage: number })[];
  spawn: { x: number; y: number };
  enemies: { id: string; name: string; x: number; y: number; hp: number; damage: number; speed: number; range: number; kind?: 'guard' | 'ranger' | 'elite'; patrolMin?: number; patrolMax?: number }[];
  exit: Rect; victoryCondition?: SideviewVictoryCondition; rewards: { xp: number; items: string[] };
}
export interface SideviewSnapshot {
  version: 1; player: { x: number; y: number; hp: number; facing: number };
  enemies: { id: string; x: number; y: number; hp: number }[];
  elapsedMs: number; exitReached: boolean;
  cooldowns?: { skill: number; dash: number; support: number }; damageTaken?: number;
}
