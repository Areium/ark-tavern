import type { Action, EnemyState, Rect, SideviewEnemyKind, SideviewEnemySpec, SideviewInput, SimulationLevel, SideviewOperator, SideviewSnapshot, Simulation } from './types';
import { createSceneProps } from './environment';

export const FIXED_STEP = 1 / 60;
/** Ability cooldowns in seconds; the HUD reads these to fill cooldown meters. */
export const COOLDOWNS = { dash: 1.1, skill: 6, support: 14 } as const;
/** Enemy attack telegraph lengths; the renderer draws the warning against these. */
export const ENEMY_WINDUP: Record<SideviewEnemyKind, number> = { guard: 0.48, ranger: 0.55, elite: 0.7 };
/** Melee hitbox that lands when a guard's windup releases, relative to its body.
 *  It reaches 40 px above the head so a player standing on a crate beside the guard is not out of reach. */
export const guardStrikeBox = (e: Rect): Rect => ({ x: e.x - 42, y: e.y - 40, width: e.width + 84, height: e.height + 45 });
/** Elite charge: body-relative hitbox carried along the lunge path. */
export const ELITE_LUNGE = { time: 0.24, speed: 520 } as const;
export const eliteLungeBox = (e: Rect): Rect => ({ x: e.x - 20, y: e.y - 20, width: e.width + 40, height: e.height + 20 });

/** Three-stage melee chain. The finisher staggers ordinary enemies and interrupts their windup. */
const COMBO = [
  { mult: 1, cooldown: 0.3, active: 0.2, reach: 92, knock: 140, step: 90, hitstop: 0.045 },
  { mult: 1.1, cooldown: 0.3, active: 0.2, reach: 96, knock: 160, step: 90, hitstop: 0.045 },
  { mult: 1.6, cooldown: 0.5, active: 0.28, reach: 118, knock: 380, step: 200, hitstop: 0.09 },
] as const;
const COMBO_WINDOW = 0.35;
const PERFECT_DODGE_REFUND = 1.5;
const DEFAULT_DAMAGE: Record<SideviewEnemyKind, number> = { guard: 15, ranger: 12, elite: 24 };
const DEFAULT_RANGE: Record<SideviewEnemyKind, number> = { guard: 82, ranger: 500, elite: 130 };
const ACTIONS: Action[] = ['left', 'right', 'jump', 'dash', 'attack', 'skill', 'support'];
const MAX_EFFECTS = 90;

export const emptyInput = (): SideviewInput => ({ left: false, right: false, jump: false, dash: false, attack: false, skill: false, support: false });
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const solidAt = (solids: Rect[], x: number, y: number) => solids.some(r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
export const exitBarrierX = (level: SimulationLevel) => level.goal.x - 24;
export const exitLocked = (s: Simulation, level: SimulationLevel) => level.victoryCondition === 'clear_and_exit' && s.enemies.some(e => e.hp > 0);
export const enemyDamage = (spec: SideviewEnemySpec) => spec.damage ?? DEFAULT_DAMAGE[spec.kind];
export const snapshotSimulation = (s: Simulation): SideviewSnapshot => ({ version: 1, elapsedMs: Math.round(s.elapsed * 1000), player: { x: s.player.x, y: s.player.y, hp: s.player.hp, facing: s.player.facing }, enemies: s.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp })), damageTaken: s.damageTaken, exitReached: s.outcome === 'victory', cooldowns: { skill: s.player.skillCooldown, dash: s.player.dashCooldown, support: s.player.supportCooldown } });

// Level geometry is immutable for a run; derive lookup tables once instead of every 60 Hz step.
const prepared = new WeakMap<SimulationLevel, { solids: Rect[]; oneWay: Set<Rect>; specs: Map<string, SideviewEnemySpec> }>();
export function levelTables(level: SimulationLevel) {
  let tables = prepared.get(level);
  if (!tables) { tables = { solids: [...level.platforms, ...level.obstacles], oneWay: new Set(level.platforms.filter(p => p.oneWay)), specs: new Map(level.enemies.map(e => [e.id, e])) }; prepared.set(level, tables); }
  return tables;
}

export function createSimulation(level: SimulationLevel, operator: SideviewOperator, saved?: SideviewSnapshot): Simulation {
  const s: Simulation = {
    version: 1, levelId: level.id, elapsed: 0, kills: 0, damageTaken: 0, outcome: null,
    player: { ...level.spawn, width: 32, height: 58, vx: 0, vy: 0, grounded: false, facing: 1, hp: operator.maxHp, invulnerable: 0, attackCooldown: 0, skillCooldown: 0, dashCooldown: 0, supportCooldown: 0, dashTime: 0, attackTime: 0, attackBuffer: 0, coyote: 0, jumpBuffer: 0, combo: 0, comboTime: 0, dashPerfect: false, safeX: level.spawn.x, safeY: level.spawn.y, stepDistance: 0 },
    enemies: level.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, width: e.kind === 'elite' ? 48 : 34, height: e.kind === 'elite' ? 72 : 58, vx: 0, vy: 0, grounded: false, facing: -1, hp: e.hp, cooldown: 1, windup: 0, hurt: 0, stagger: 0, knock: 0, lunge: 0 })),
    props: createSceneProps(level), effects: [], projectiles: [], previous: emptyInput(), queued: {},
    hitstop: 0, shake: 0, hurtFlash: 0, chain: 0, chainTime: 0, bestChain: 0,
  };
  if (saved?.version === 1) {
    s.elapsed = saved.elapsedMs / 1000; s.damageTaken = saved.damageTaken ?? 0;
    s.player = { ...s.player, ...saved.player, facing: saved.player.facing < 0 ? -1 : 1, hp: Math.min(operator.maxHp, saved.player.hp), skillCooldown: saved.cooldowns?.skill ?? 0, dashCooldown: saved.cooldowns?.dash ?? 0, supportCooldown: saved.cooldowns?.support ?? 0 };
    s.enemies = s.enemies.map(e => ({ ...e, ...saved.enemies.find(v => v.id === e.id) }));
    s.kills = s.enemies.filter(e => e.hp <= 0).length;
  }
  if (exitLocked(s, level)) s.player.x = Math.min(s.player.x, exitBarrierX(level) - s.player.width);
  // Server spawns are points, not actor-size-aware rectangles. Resolve a foot
  // intersecting a floor before horizontal movement can treat it as a wall.
  for (const body of [s.player, ...s.enemies]) for (const floor of levelTables(level).solids) {
    if (overlaps(body, floor) && body.y < floor.y) { body.y = floor.y - body.height; body.grounded = true; body.vy = 0; }
  }
  if (s.player.grounded) { s.player.safeX = s.player.x; s.player.safeY = s.player.y; }
  return s;
}

function move(body: EnemyState | Simulation['player'], solids: Rect[], oneWay: Set<Rect>, dt: number, worldWidth: number) {
  body.x += body.vx * dt;
  for (const r of solids) if (!oneWay.has(r) && overlaps(body, r)) {
    if (body.vx > 0) body.x = r.x - body.width;
    else if (body.vx < 0) body.x = r.x + r.width;
    body.vx = 0;
  }
  body.x = Math.max(0, Math.min(worldWidth - body.width, body.x));
  body.vy = Math.min(950, body.vy + 1750 * dt);
  const bottom = body.y + body.height;
  body.y += body.vy * dt; body.grounded = false;
  for (const r of solids) if (overlaps(body, r)) {
    if (oneWay.has(r)) {
      if (body.vy >= 0 && bottom <= r.y + 0.01) { body.y = r.y - body.height; body.grounded = true; body.vy = 0; }
      continue;
    }
    if (body.vy >= 0) { body.y = r.y - body.height; body.grounded = true; }
    else body.y = r.y + r.height;
    body.vy = 0;
  }
}

function pushEffect(s: Simulation, effect: Simulation['effects'][number]) {
  s.effects.push(effect);
  if (s.effects.length > MAX_EFFECTS) s.effects.splice(0, s.effects.length - MAX_EFFECTS);
}

/** Street fixtures are visual interactions only, so old version-1 saves remain valid. */
function breakProps(s: Simulation, area: Rect) {
  for (const prop of s.props) {
    if (prop.broken || !overlaps(area, prop)) continue;
    prop.broken = true;
    const x = prop.x + prop.width / 2, y = prop.y + prop.height / 2;
    pushEffect(s, { x, y, kind: 'debris', life: 0.65, facing: s.player.facing, value: Number(prop.kind === 'lamp') });
    if (prop.kind === 'lamp') pushEffect(s, { x, y: prop.y + 10, kind: 'spark', life: 0.5, facing: s.player.facing });
  }
}

/** A dodge that passes through an enemy attack refunds skill time once per dash. */
function perfectDodge(s: Simulation) {
  const p = s.player;
  p.dashPerfect = true; p.skillCooldown = Math.max(0, p.skillCooldown - PERFECT_DODGE_REFUND);
  p.invulnerable = Math.max(p.invulnerable, 0.4); s.hitstop = Math.max(s.hitstop, 0.08);
  pushEffect(s, { x: p.x + p.width / 2, y: p.y + 26, kind: 'perfect', life: 0.6, facing: p.facing });
}

/** Returns true only when damage landed; dodged projectiles keep flying. */
function damagePlayer(s: Simulation, amount: number, fromX: number, attack = false) {
  const p = s.player;
  if (p.hp <= 0) return false;
  if (p.dashTime > 0) { if (attack && !p.dashPerfect) perfectDodge(s); return false; }
  if (p.invulnerable > 0) return false;
  const actual = Math.min(p.hp, Math.round(amount)); p.hp -= actual; s.damageTaken += actual;
  p.invulnerable = 0.9; p.vy = -260; p.vx = p.x < fromX ? -220 : 220;
  s.hitstop = Math.max(s.hitstop, 0.06); s.shake = Math.max(s.shake, 0.3); s.hurtFlash = 0.45;
  s.chain = 0; s.chainTime = 0;
  pushEffect(s, { x: p.x + 16, y: p.y + 25, kind: 'hit', life: 0.3, facing: 1 });
  pushEffect(s, { x: p.x + 16, y: p.y - 8, kind: 'damage', life: 0.8, facing: 1, value: actual, tone: 'player' });
  return true;
}

interface Blow { knock: number; stagger: number; hitstop: number; heavy?: boolean }
function damageEnemy(s: Simulation, e: EnemyState, spec: SideviewEnemySpec, amount: number, blow: Blow) {
  if (e.hp <= 0) return;
  // At least 1 so fractional HP from older saves still reaches zero.
  const actual = Math.min(e.hp, Math.max(1, Math.round(amount)));
  e.hp -= actual; e.hurt = 0.22;
  // Elites keep super armor against the melee chain; only area skills break their stance.
  const armored = spec.kind === 'elite';
  e.knock = blow.knock * (armored ? 0.3 : 1);
  if (blow.stagger > 0 && (!armored || blow.stagger >= 0.5)) {
    e.stagger = Math.max(e.stagger, blow.stagger); e.windup = 0; e.lunge = 0; e.cooldown = Math.max(e.cooldown, 0.5);
  }
  s.hitstop = Math.max(s.hitstop, blow.hitstop); s.shake = Math.max(s.shake, blow.heavy ? 0.28 : 0.1);
  s.chain++; s.chainTime = 2.5; s.bestChain = Math.max(s.bestChain, s.chain);
  pushEffect(s, { x: e.x + e.width / 2, y: e.y + 26, kind: 'hit', life: 0.3, facing: 1 });
  pushEffect(s, { x: e.x + e.width / 2, y: e.y - 10, kind: 'damage', life: 0.75, facing: 1, value: actual, tone: 'enemy' });
  if (!e.hp) { s.kills++; e.windup = 0; e.lunge = 0; e.stagger = 0; }
}

/** One deterministic 60 Hz step. Inputs are held states; jump/dash/skills use rising edges. */
export function stepSimulation(s: Simulation, input: SideviewInput, level: SimulationLevel, operator: SideviewOperator, dt = FIXED_STEP) {
  if (s.outcome) return;
  s.elapsed += dt;
  s.shake = Math.max(0, s.shake - dt); s.hurtFlash = Math.max(0, s.hurtFlash - dt);
  for (const key of ACTIONS) if (input[key] && !s.previous[key]) s.queued[key] = true;
  s.previous = { ...input };
  // Hitstop freezes the world for a few frames; presses made meanwhile stay queued.
  if (s.hitstop > 0) { s.hitstop = Math.max(0, s.hitstop - dt); s.effects = s.effects.filter(e => (e.life -= dt) > 0); return; }
  const p = s.player;
  const { solids, oneWay, specs } = levelTables(level);
  const wasGrounded = p.grounded, beforeX = p.x, beforeY = p.y;
  const pressed = (key: Action) => !!s.queued[key];
  for (const key of ['invulnerable', 'attackCooldown', 'skillCooldown', 'dashCooldown', 'supportCooldown', 'dashTime', 'attackTime', 'attackBuffer', 'jumpBuffer', 'comboTime'] as const) p[key] = Math.max(0, p[key] - dt);
  if (!p.comboTime) p.combo = 0;
  s.chainTime = Math.max(0, s.chainTime - dt); if (!s.chainTime) s.chain = 0;
  p.coyote = p.grounded ? 0.12 : Math.max(0, p.coyote - dt);
  if (pressed('jump')) p.jumpBuffer = 0.14;
  if (pressed('attack')) p.attackBuffer = 0.18;
  if (p.jumpBuffer > 0 && p.coyote > 0) {
    if (p.grounded) pushEffect(s, { x: p.x + p.width / 2, y: p.y + p.height, kind: 'jump', life: 0.3, facing: p.facing });
    p.vy = -650; p.jumpBuffer = 0; p.coyote = 0; p.grounded = false; p.stepDistance = 0;
  }
  if (!input.jump && p.vy < -260) p.vy += 2000 * dt;
  const dir = Number(input.right) - Number(input.left);
  if (dir) p.facing = dir > 0 ? 1 : -1;
  if (pressed('dash') && p.dashCooldown <= 0) { p.dashTime = 0.19; p.dashCooldown = COOLDOWNS.dash; p.dashPerfect = false; p.invulnerable = Math.max(p.invulnerable, 0.24); }
  if (p.dashTime > 0) {
    p.vx = p.facing * 760; p.vy = -1750 * dt;
    if (Math.floor(s.elapsed * 60) % 3 === 0) pushEffect(s, { x: p.x, y: p.y, kind: 'dash', life: 0.22, facing: p.facing });
  } else p.vx += (dir * 285 - p.vx) * Math.min(1, dt * (p.grounded ? 18 : 9));
  const landingSpeed = p.vy;
  move(p, solids, oneWay, dt, level.worldWidth);
  if (exitLocked(s, level) && p.x + p.width > exitBarrierX(level)) {
    p.x = exitBarrierX(level) - p.width; p.vx = 0;
  }
  if (!wasGrounded && p.grounded && landingSpeed > 180) {
    pushEffect(s, { x: p.x + p.width / 2, y: p.y + p.height, kind: 'land', life: 0.4, facing: p.facing, value: Math.min(1, landingSpeed / 850) });
    p.stepDistance = 0;
  } else if (wasGrounded && p.grounded && p.dashTime <= 0) {
    p.stepDistance += Math.abs(p.x - beforeX);
    if (p.stepDistance >= 44) {
      p.stepDistance %= 44;
      pushEffect(s, { x: p.x + p.width / 2 - p.facing * 7, y: p.y + p.height, kind: 'step', life: 0.28, facing: p.facing });
    }
  } else p.stepDistance = 0;
  if (p.dashTime > 0) breakProps(s, { x: Math.min(beforeX, p.x), y: Math.min(beforeY, p.y), width: p.width + Math.abs(p.x - beforeX), height: p.height + Math.abs(p.y - beforeY) });
  if (p.grounded && p.hp > 0) {
    const foot = p.y + p.height + 2;
    const clearOfHazards = !level.hazards.some(h => overlaps({ x: p.x - 48, y: p.y, width: p.width + 96, height: p.height + 4 }, h));
    if (clearOfHazards && solidAt(solids, p.x + 2, foot) && solidAt(solids, p.x + p.width - 2, foot)) { p.safeX = p.x; p.safeY = p.y; }
  }
  if ((input.attack || p.attackBuffer > 0) && p.attackCooldown <= 0) {
    const stage = p.comboTime > 0 && p.combo < 3 ? p.combo + 1 : 1;
    const c = COMBO[stage - 1];
    p.combo = stage; p.attackCooldown = c.cooldown; p.attackTime = c.active; p.comboTime = c.cooldown + COMBO_WINDOW; p.attackBuffer = 0;
    if (p.grounded && p.dashTime <= 0) p.vx = p.facing * c.step;
    const attack = { x: p.facing > 0 ? p.x + p.width - 8 : p.x + 8 - c.reach, y: p.y - 12, width: c.reach, height: 85 };
    breakProps(s, attack);
    for (const e of s.enemies) if (overlaps(attack, e)) damageEnemy(s, e, specs.get(e.id)!, operator.attack * c.mult, { knock: p.facing * c.knock, stagger: stage === 3 ? 0.45 : 0, hitstop: c.hitstop, heavy: stage === 3 });
    pushEffect(s, { x: p.x + p.width / 2, y: p.y + 22, kind: stage === 3 ? 'finisher' : 'slash', life: stage === 3 ? 0.3 : 0.22, facing: p.facing, value: stage });
  }
  if (pressed('skill') && p.skillCooldown <= 0) {
    p.skillCooldown = COOLDOWNS.skill; p.invulnerable = Math.max(p.invulnerable, 0.35);
    const area = { x: p.x - 210, y: p.y - 155, width: 452, height: 290 };
    breakProps(s, area);
    for (const e of s.enemies) if (overlaps(area, e)) damageEnemy(s, e, specs.get(e.id)!, operator.skillPower, { knock: (e.x >= p.x ? 1 : -1) * 320, stagger: 0.6, hitstop: 0.1, heavy: true });
    s.shake = Math.max(s.shake, 0.4);
    pushEffect(s, { x: p.x + 16, y: p.y + 30, kind: 'skill', life: 0.65, facing: p.facing });
  }
  if (pressed('support') && p.supportCooldown <= 0) {
    p.supportCooldown = COOLDOWNS.support;
    const healed = Math.min(30, operator.maxHp - p.hp); p.hp += healed;
    for (const e of s.enemies) if (Math.abs(e.x - p.x) < 400) damageEnemy(s, e, specs.get(e.id)!, operator.skillPower * 0.65, { knock: (e.x >= p.x ? 1 : -1) * 220, stagger: 0.5, hitstop: 0.06 });
    pushEffect(s, { x: p.x + 16, y: p.y + 25, kind: 'support', life: 1, facing: 1 });
    if (healed > 0) pushEffect(s, { x: p.x + 16, y: p.y - 8, kind: 'damage', life: 0.9, facing: 1, value: healed, tone: 'heal' });
  }
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const spec = specs.get(e.id)!;
    e.cooldown = Math.max(0, e.cooldown - dt); e.hurt = Math.max(0, e.hurt - dt);
    const dx = p.x - e.x; const nearby = p.hp > 0 && Math.abs(dx) < (spec.kind === 'ranger' ? 500 : 330) && Math.abs(p.y - e.y) < 140;
    const speed = spec.speed ?? 105;
    let vx = 0;
    if (e.stagger > 0) e.stagger = Math.max(0, e.stagger - dt);
    else if (e.lunge > 0) {
      e.lunge = Math.max(0, e.lunge - dt); vx = e.facing * ELITE_LUNGE.speed;
      if (overlaps(p, eliteLungeBox(e))) damagePlayer(s, enemyDamage(spec), e.x + e.width / 2, true);
      if (!e.lunge) e.cooldown = 1.3;
    } else if (e.windup > 0) {
      // Elites commit to the telegraphed direction; guards and rangers keep tracking.
      if (nearby && spec.kind !== 'elite') e.facing = dx > 0 ? 1 : -1;
      e.windup = Math.max(0, e.windup - dt);
      if (!e.windup) {
        if (spec.kind === 'ranger') {
          const bx = e.x + e.width / 2 + e.facing * 10, by = e.y + 24;
          const aim = (p.y + p.height * 0.45 - by) / Math.max(60, Math.abs(p.x + p.width / 2 - bx));
          s.projectiles.push({ x: bx - 7, y: by, width: 14, height: 7, vx: e.facing * 320, vy: Math.max(-160, Math.min(160, aim * 320)), life: 2.5, damage: enemyDamage(spec) });
          e.cooldown = 1.6;
        } else if (spec.kind === 'elite') {
          e.lunge = ELITE_LUNGE.time;
          pushEffect(s, { x: e.x + e.width / 2, y: e.y + e.height / 2, kind: 'lunge', life: 0.35, facing: e.facing });
        } else {
          if (overlaps(p, guardStrikeBox(e))) damagePlayer(s, enemyDamage(spec), e.x, true);
          pushEffect(s, { x: e.x + e.width / 2, y: e.y + 22, kind: 'slash', life: 0.2, facing: e.facing, tone: 'enemy' });
          e.cooldown = 1.6;
        }
      }
    } else {
      if (nearby) e.facing = dx > 0 ? 1 : -1;
      if (nearby && Math.abs(dx) < (spec.range ?? DEFAULT_RANGE[spec.kind]) && e.cooldown <= 0) e.windup = ENEMY_WINDUP[spec.kind];
      else if (spec.kind === 'ranger') { if (nearby && Math.abs(dx) < 170) vx = -e.facing * speed * 0.7; }
      else {
        if (!nearby && e.x <= spec.patrolMin) e.facing = 1;
        if (!nearby && e.x >= spec.patrolMax) e.facing = -1;
        vx = e.facing * (nearby ? speed : 40);
      }
      // The patrol interval bounds idle wandering only; a chase follows the player until a ledge or wall stops it.
      if (!nearby && ((e.x <= spec.patrolMin && vx < 0) || (e.x >= spec.patrolMax && vx > 0))) vx = 0;
    }
    // AI locomotion never walks off a ledge; knockback still can.
    if (vx && e.grounded && !solidAt(solids, vx > 0 ? e.x + e.width + 2 : e.x - 2, e.y + e.height + 4)) {
      vx = 0;
      if (e.lunge) { e.lunge = 0; e.cooldown = 1.3; } else if (!nearby) e.facing = e.facing > 0 ? -1 : 1;
    }
    const before = e.x;
    e.vx = vx + e.knock;
    e.knock = Math.abs(e.knock) < 5 ? 0 : e.knock - e.knock * Math.min(1, dt * 10);
    move(e, solids, oneWay, dt, level.worldWidth);
    if (!nearby && vx && !e.stagger && Math.abs(e.x - before) < 0.01) e.facing = e.facing > 0 ? -1 : 1;
    if (e.y > level.worldHeight) damageEnemy(s, e, spec, e.hp, { knock: 0, stagger: 0, hitstop: 0 });
  }
  for (const b of s.projectiles) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (overlaps(p, b) && damagePlayer(s, b.damage, b.x, true)) b.life = 0;
    if (solids.some(r => !oneWay.has(r) && overlaps(b, r))) b.life = 0;
  }
  s.projectiles = s.projectiles.filter(b => b.life > 0);
  for (const h of level.hazards) if (overlaps(p, h)) damagePlayer(s, h.damage ?? 20, h.x + h.width / 2);
  if (p.y > level.worldHeight + 80) {
    // Falling must always incur damage, even if the fall started during a dodge.
    p.invulnerable = 0; p.dashTime = 0; damagePlayer(s, 25, p.x);
    p.x = p.safeX; p.y = p.safeY; p.vx = 0; p.vy = 0;
    if (p.hp > 0) p.invulnerable = Math.max(p.invulnerable, 1.2);
  }
  s.effects = s.effects.filter(e => (e.life -= dt) > 0);
  if (p.hp <= 0) s.outcome = 'defeat';
  else if (!exitLocked(s, level) && overlaps(p, level.goal)) s.outcome = 'victory';
  s.queued = {};
}
