import type { Body, EnemyState, Rect, SideviewInput, SimulationLevel, SideviewOperator, SideviewSnapshot, Simulation } from './types';

export const FIXED_STEP = 1 / 60;
export const emptyInput = (): SideviewInput => ({ left: false, right: false, jump: false, dash: false, attack: false, skill: false, support: false });
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export const exitBarrierX = (level: SimulationLevel) => level.goal.x - 24;
export const exitLocked = (s: Simulation, level: SimulationLevel) => level.victoryCondition === 'clear_and_exit' && s.enemies.some(e => e.hp > 0);
export const snapshotSimulation = (s: Simulation): SideviewSnapshot => ({ version: 1, elapsedMs: Math.round(s.elapsed * 1000), player: { x: s.player.x, y: s.player.y, hp: s.player.hp, facing: s.player.facing }, enemies: s.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp })), damageTaken: s.damageTaken, exitReached: s.outcome === 'victory', cooldowns: { skill: s.player.skillCooldown, dash: s.player.dashCooldown, support: s.player.supportCooldown } });

export function createSimulation(level: SimulationLevel, operator: SideviewOperator, saved?: SideviewSnapshot): Simulation {
  const s: Simulation = {
    version: 1, levelId: level.id, elapsed: 0, kills: 0, damageTaken: 0, outcome: null,
    player: { ...level.spawn, width: 32, height: 58, vx: 0, vy: 0, grounded: false, facing: 1, hp: operator.maxHp, invulnerable: 0, attackCooldown: 0, skillCooldown: 0, dashCooldown: 0, supportCooldown: 0, dashTime: 0, attackTime: 0, coyote: 0, jumpBuffer: 0 },
    enemies: level.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, width: e.kind === 'elite' ? 48 : 34, height: e.kind === 'elite' ? 72 : 58, vx: 0, vy: 0, grounded: false, facing: -1, hp: e.hp, cooldown: 1, windup: 0, hurt: 0 })),
    effects: [], projectiles: [], previous: emptyInput(),
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
  for (const body of [s.player, ...s.enemies]) for (const floor of [...level.platforms, ...level.obstacles]) {
    if (overlaps(body, floor) && body.y < floor.y) { body.y = floor.y - body.height; body.grounded = true; body.vy = 0; }
  }
  return s;
}

function move(body: Body, solids: Rect[], dt: number, worldWidth: number) {
  body.x += body.vx * dt;
  for (const r of solids) if (overlaps(body, r)) {
    if (body.vx > 0) body.x = r.x - body.width;
    else if (body.vx < 0) body.x = r.x + r.width;
    body.vx = 0;
  }
  body.x = Math.max(0, Math.min(worldWidth - body.width, body.x));
  body.vy = Math.min(950, body.vy + 1750 * dt);
  body.y += body.vy * dt; body.grounded = false;
  for (const r of solids) if (overlaps(body, r)) {
    if (body.vy >= 0) { body.y = r.y - body.height; body.grounded = true; }
    else body.y = r.y + r.height;
    body.vy = 0;
  }
}

function damagePlayer(s: Simulation, amount: number, fromX: number) {
  const p = s.player;
  if (p.invulnerable > 0 || p.dashTime > 0 || p.hp <= 0) return;
  const actual = Math.min(p.hp, amount); p.hp -= actual; s.damageTaken += actual;
  p.invulnerable = 0.9; p.vy = -260; p.vx = p.x < fromX ? -220 : 220;
  s.effects.push({ x: p.x + 16, y: p.y + 25, kind: 'hit', life: 0.3, facing: 1 });
}

function damageEnemy(s: Simulation, e: EnemyState, amount: number) {
  if (e.hp <= 0) return;
  e.hp = Math.max(0, e.hp - amount); e.hurt = 0.22;
  s.effects.push({ x: e.x + e.width / 2, y: e.y + 26, kind: 'hit', life: 0.3, facing: 1 });
  if (!e.hp) { s.kills++; e.windup = 0; }
}

/** One deterministic 60 Hz step. Inputs are held states; jump/dash/skills use rising edges. */
export function stepSimulation(s: Simulation, input: SideviewInput, level: SimulationLevel, operator: SideviewOperator, dt = FIXED_STEP) {
  if (s.outcome) return;
  s.elapsed += dt;
  const p = s.player;
  const pressed = (key: keyof SideviewInput) => input[key] && !s.previous[key];
  const solids = [...level.platforms, ...level.obstacles];
  for (const key of ['invulnerable', 'attackCooldown', 'skillCooldown', 'dashCooldown', 'supportCooldown', 'dashTime', 'attackTime', 'jumpBuffer'] as const) p[key] = Math.max(0, p[key] - dt);
  p.coyote = p.grounded ? 0.12 : Math.max(0, p.coyote - dt);
  if (pressed('jump')) p.jumpBuffer = 0.14;
  if (p.jumpBuffer > 0 && p.coyote > 0) { p.vy = -650; p.jumpBuffer = 0; p.coyote = 0; p.grounded = false; }
  if (!input.jump && p.vy < -260) p.vy += 2000 * dt;
  const dir = Number(input.right) - Number(input.left);
  if (dir) p.facing = dir > 0 ? 1 : -1;
  if (pressed('dash') && p.dashCooldown <= 0) { p.dashTime = 0.19; p.dashCooldown = 1.1; p.invulnerable = Math.max(p.invulnerable, 0.24); }
  if (p.dashTime > 0) {
    p.vx = p.facing * 760; p.vy = -1750 * dt;
    if (Math.floor(s.elapsed * 60) % 3 === 0) s.effects.push({ x: p.x, y: p.y, kind: 'dash', life: 0.22, facing: p.facing });
  } else p.vx += (dir * 285 - p.vx) * Math.min(1, dt * (p.grounded ? 18 : 9));
  move(p, solids, dt, level.worldWidth);
  if (exitLocked(s, level) && p.x + p.width > exitBarrierX(level)) {
    p.x = exitBarrierX(level) - p.width; p.vx = 0;
  }
  if (input.attack && p.attackCooldown <= 0) {
    p.attackCooldown = 0.36; p.attackTime = 0.22;
    const attack = { x: p.facing > 0 ? p.x + p.width - 8 : p.x - 84, y: p.y - 12, width: 92, height: 85 };
    for (const e of s.enemies) if (overlaps(attack, e)) damageEnemy(s, e, operator.attack);
    s.effects.push({ x: p.x + p.width / 2, y: p.y + 22, kind: 'slash', life: 0.22, facing: p.facing });
  }
  if (pressed('skill') && p.skillCooldown <= 0) {
    p.skillCooldown = 6; p.invulnerable = Math.max(p.invulnerable, 0.35);
    const area = { x: p.x - 210, y: p.y - 155, width: 452, height: 290 };
    for (const e of s.enemies) if (overlaps(area, e)) damageEnemy(s, e, operator.skillPower);
    s.effects.push({ x: p.x + 16, y: p.y + 30, kind: 'skill', life: 0.65, facing: p.facing });
  }
  if (pressed('support') && p.supportCooldown <= 0) {
    p.supportCooldown = 14; p.hp = Math.min(operator.maxHp, p.hp + 30);
    for (const e of s.enemies) if (Math.abs(e.x - p.x) < 400) damageEnemy(s, e, operator.skillPower * 0.65);
    s.effects.push({ x: p.x + 16, y: p.y + 25, kind: 'support', life: 1, facing: 1 });
  }
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const spec = level.enemies.find(v => v.id === e.id)!;
    e.cooldown = Math.max(0, e.cooldown - dt); e.hurt = Math.max(0, e.hurt - dt);
    const dx = p.x - e.x; const nearby = Math.abs(dx) < (spec.kind === 'ranger' ? 500 : 330) && Math.abs(p.y - e.y) < 140;
    if (nearby) e.facing = dx > 0 ? 1 : -1;
    if (e.windup > 0) {
      e.windup = Math.max(0, e.windup - dt); e.vx = 0;
      if (!e.windup) {
        if (spec.kind === 'ranger') s.projectiles.push({ x: e.x + 17, y: e.y + 24, width: 14, height: 7, vx: e.facing * 300, life: 2.5, damage: spec.damage ?? 12 });
        else if (overlaps(p, { x: e.x - 42, y: e.y - 5, width: e.width + 84, height: e.height + 10 })) damagePlayer(s, spec.damage ?? (spec.kind === 'elite' ? 24 : 15), e.x);
        e.cooldown = spec.kind === 'elite' ? 1.25 : 1.6;
      }
    } else if (nearby && Math.abs(dx) < (spec.range ?? (spec.kind === 'ranger' ? 500 : 82)) && e.cooldown <= 0) { e.windup = spec.kind === 'elite' ? 0.65 : 0.48; e.vx = 0; }
    else {
      if (e.x <= spec.patrolMin) e.facing = 1;
      if (e.x >= spec.patrolMax) e.facing = -1;
      e.vx = spec.kind === 'ranger' ? 0 : e.facing * (nearby ? (spec.speed ?? 105) : 40);
      if ((e.x <= spec.patrolMin && e.vx < 0) || (e.x >= spec.patrolMax && e.vx > 0)) e.vx = 0;
    }
    move(e, solids, dt, level.worldWidth);
    if (e.y > level.worldHeight) damageEnemy(s, e, e.hp);
  }
  for (const b of s.projectiles) {
    b.x += b.vx * dt; b.life -= dt;
    if (overlaps(p, b)) { damagePlayer(s, b.damage, b.x); b.life = 0; }
    if (solids.some(r => overlaps(b, r))) b.life = 0;
  }
  s.projectiles = s.projectiles.filter(b => b.life > 0);
  for (const h of level.hazards) if (overlaps(p, h)) damagePlayer(s, h.damage ?? 20, p.x + 10);
  if (p.y > level.worldHeight + 80) {
    // Falling must always incur damage, even if the fall started during a dodge.
    p.invulnerable = 0; p.dashTime = 0; damagePlayer(s, 25, p.x);
    p.x = level.spawn.x; p.y = level.spawn.y; p.vx = 0; p.vy = 0;
  }
  s.effects = s.effects.filter(e => (e.life -= dt) > 0);
  if (p.hp <= 0) s.outcome = 'defeat';
  else if (!exitLocked(s, level) && overlaps(p, level.goal)) s.outcome = 'victory';
  s.previous = { ...input };
}
