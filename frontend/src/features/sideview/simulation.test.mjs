import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundled = await build({ entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', external: ['react', 'react/jsx-runtime', 'pixi.js', 'lucide-react'], loader: { '.css': 'empty' } });
// Import only simulation entry to keep this test independent of browser/React.
const pure = await build({ stdin: { contents: "export * from './simulation'; export * from './level';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
assert.ok(bundled.outputFiles.length);
const { createSimulation, stepSimulation, snapshotSimulation, normalizeLevel, DEMO_LEVEL, DEMO_OPERATOR, emptyInput } = await import(`data:text/javascript;base64,${Buffer.from(pure.outputFiles[0].text).toString('base64')}`);
const level = normalizeLevel(DEMO_LEVEL);
const tick = (s, n, input = {}, map = level) => { for (let i = 0; i < n; i++) stepSimulation(s, { ...emptyInput(), ...input }, map, DEMO_OPERATOR); };

test('falls onto ground; wall blocks continuous motion and jump clears it', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  assert.equal(s.player.y, 492); assert.equal(s.player.grounded, true);
  tick(s, 120, { right: true }); assert.equal(s.player.x, 358);
  tick(s, 25, { right: true, jump: true }); assert.ok(s.player.y < 425);
  tick(s, 30, { right: true }); assert.ok(s.player.x > 460);
});
test('size-independent server spawn does not teleport actors to the map edge', () => {
  const map = { ...level, spawn: { x: 80, y: 530 }, enemies: [{ ...level.enemies[0], x: 200, y: 530 }] };
  const s = createSimulation(map, DEMO_OPERATOR); tick(s, 1, { right: true }, map);
  assert.ok(s.player.x < 90); assert.ok(s.enemies[0].x < 210); assert.equal(s.player.y, 492);
});
test('held jump does not retrigger; releasing and pressing jumps again', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30); tick(s, 120, { jump: true });
  assert.equal(s.player.grounded, true); tick(s, 1); tick(s, 1, { jump: true }); assert.ok(s.player.vy < 0);
});
test('melee kills once and respects cooldown', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  Object.assign(s.enemies[0], { x: s.player.x + 50, y: s.player.y, hp: 30 });
  tick(s, 1, { attack: true }); assert.equal(s.enemies[0].hp, 4);
  tick(s, 1, { attack: true }); assert.equal(s.enemies[0].hp, 4);
  tick(s, 30, { attack: true }); assert.equal(s.enemies[0].hp, 0); assert.equal(s.kills, 1);
});
test('dash protects against hazard damage; hazard damages after invulnerability', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  const map = { ...level, hazards: [{ x: 0, y: 0, width: 1000, height: 600, damage: 20 }] };
  tick(s, 1, { dash: true }, map); assert.equal(s.player.hp, DEMO_OPERATOR.maxHp);
  tick(s, 30, {}, map); assert.ok(s.player.hp < DEMO_OPERATOR.maxHp); assert.equal(s.damageTaken, 20);
});
test('skill and support cooldowns persist, and support heals', () => {
  const s = createSimulation(level, DEMO_OPERATOR); s.player.hp = 60; tick(s, 1, { support: true, skill: true });
  assert.equal(s.player.hp, 90); const saved = snapshotSimulation(s); const restored = createSimulation(level, DEMO_OPERATOR, saved);
  assert.equal(restored.player.supportCooldown, 14); assert.equal(restored.player.skillCooldown, 6); assert.equal(restored.elapsed * 1000, Math.round(s.elapsed * 1000));
  tick(restored, 1, { support: true }); assert.equal(restored.player.hp, 90);
});
test('clear-and-exit wall blocks dash, clamps old saves, and opens after the last guard', () => {
  const map = { ...level, worldWidth: 700, platforms: [{ x: 0, y: 550, width: 700, height: 130 }], obstacles: [], hazards: [], goal: { x: 500, y: 426, width: 100, height: 124 }, enemies: [{ ...level.enemies[0], x: 100, y: 492, patrolMin: 50, patrolMax: 150 }] };
  const s = createSimulation(map, DEMO_OPERATOR); Object.assign(s.player, { x: 440, y: 492, grounded: true });
  tick(s, 10, { right: true, dash: true }, map);
  assert.equal(s.player.x, 444); assert.equal(s.outcome, null);
  const saved = snapshotSimulation(s); saved.player.x = 520;
  const restored = createSimulation(map, DEMO_OPERATOR, saved);
  assert.equal(restored.player.x, 444);
  s.enemies[0].hp = 0; tick(s, 10, { right: true }, map);
  assert.ok(s.player.x > 444); assert.equal(s.outcome, 'victory');
  const elapsed = s.elapsed; tick(s, 60, {}, map);
  assert.equal(s.elapsed, elapsed); assert.equal(snapshotSimulation(s).exitReached, true);
});
test('reach-exit level wins with guards still alive', () => {
  const map = { ...level, victoryCondition: 'reach_exit' };
  const s = createSimulation(map, DEMO_OPERATOR); Object.assign(s.player, { x: 3250, y: 470 });
  tick(s, 1, {}, map);
  assert.equal(s.outcome, 'victory'); assert.ok(s.enemies.some(e => e.hp > 0));
});
test('fatal fall records defeat even when falling during a dodge', () => {
  const s = createSimulation(level, DEMO_OPERATOR); Object.assign(s.player, { x: 1250, y: 900, hp: 10, invulnerable: 2 }); tick(s, 1);
  assert.equal(s.outcome, 'defeat'); assert.equal(s.damageTaken, 10);
});
test('same inputs produce deterministic snapshots', () => {
  const a = createSimulation(level, DEMO_OPERATOR), b = createSimulation(level, DEMO_OPERATOR);
  for (let i = 0; i < 500; i++) { const input = { right: true, jump: i % 70 < 25, attack: true, skill: i % 150 === 0 }; tick(a, 1, input); tick(b, 1, input); }
  assert.deepEqual(snapshotSimulation(a), snapshotSimulation(b));
});
test('three-stage chain: finisher hits harder and cancels an ordinary windup', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  const e = s.enemies[0]; Object.assign(e, { x: s.player.x + 50, y: s.player.y, hp: 500 });
  const hits = [];
  for (let i = 0; i < 90 && hits.length < 3; i++) { const before = e.hp; tick(s, 1, { attack: true }); if (e.hp < before) hits.push(before - e.hp); }
  assert.deepEqual(hits, [26, 29, 42]);
  const t = createSimulation(level, DEMO_OPERATOR); tick(t, 30);
  const g = t.enemies[0]; Object.assign(g, { x: t.player.x + 50, y: t.player.y, hp: 500, windup: 0.3 });
  tick(t, 1, { attack: true }); assert.ok(g.windup > 0, 'opening hit only flinches');
  tick(t, 20); Object.assign(t.player, { combo: 2, comboTime: 0.3, attackCooldown: 0 }); g.windup = 0.3;
  tick(t, 1, { attack: true }); assert.equal(g.windup, 0); assert.ok(g.stagger > 0);
});
test('elite keeps super armor against the chain; the skill breaks it', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  const elite = s.enemies.find(e => e.id === 'g5'); Object.assign(elite, { x: s.player.x + 50, y: s.player.y - 14, windup: 0.3 });
  Object.assign(s.player, { combo: 2, comboTime: 0.3 });
  tick(s, 1, { attack: true }); assert.ok(elite.windup > 0); assert.equal(elite.stagger, 0);
  tick(s, 12); elite.windup = 0.3;
  tick(s, 1, { skill: true }); assert.equal(elite.windup, 0); assert.ok(elite.stagger > 0);
});
test('dodging through a landing strike takes no damage and refunds skill time once', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  Object.assign(s.enemies[0], { x: s.player.x + 40, y: s.player.y, windup: 2 / 60, cooldown: 0 });
  s.player.skillCooldown = 4;
  tick(s, 1, { dash: true }); tick(s, 3);
  assert.equal(s.player.hp, DEMO_OPERATOR.maxHp); assert.equal(s.damageTaken, 0);
  assert.ok(s.player.skillCooldown < 2.6 && s.player.skillCooldown > 2.3, String(s.player.skillCooldown));
  assert.equal(s.player.dashPerfect, true);
});
test('a pit fall returns the player to the last safe footing, not the level start', () => {
  const s = createSimulation(level, DEMO_OPERATOR);
  Object.assign(s.player, { x: 1100, y: 492 }); tick(s, 5);
  assert.equal(s.player.safeX, 1100);
  Object.assign(s.player, { x: 1230, y: 492 }); tick(s, 60);
  assert.equal(s.player.x > 1000 && s.player.x <= 1100, true, String(s.player.x));
  assert.ok(s.damageTaken >= 25); assert.equal(s.outcome, null);
});
test('presses made during hitstop are applied when the world resumes', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  s.hitstop = 0.05; const x = s.player.x;
  tick(s, 1, { dash: true }); assert.equal(s.player.dashTime, 0); assert.equal(s.player.x, x);
  tick(s, 4); assert.ok(s.player.dashCooldown > 0); assert.ok(s.player.x > x + 10);
});
test('chasing guards stop at a ledge instead of walking into the pit', () => {
  const map = { ...level, worldWidth: 1000, platforms: [{ x: 0, y: 550, width: 400, height: 130 }, { x: 600, y: 550, width: 400, height: 130 }], obstacles: [], hazards: [], goal: { x: 900, y: 426, width: 90, height: 124 }, enemies: [{ ...level.enemies[0], x: 300, y: 492, patrolMin: 0, patrolMax: 1000 }] };
  const s = createSimulation(map, DEMO_OPERATOR); Object.assign(s.player, { x: 610, y: 492 });
  tick(s, 120, {}, map);
  const e = s.enemies[0]; assert.ok(e.hp > 0); assert.equal(e.grounded, true); assert.ok(e.x + e.width <= 402, String(e.x));
});
test('rangers back away at close range and aim shots at a raised target', () => {
  const floor = { x: 0, y: 550, width: 1200, height: 130 };
  const map = { ...level, worldWidth: 1200, platforms: [floor, { x: 200, y: 430, width: 150, height: 20 }], obstacles: [], hazards: [], goal: { x: 1100, y: 426, width: 90, height: 124 }, enemies: [{ ...level.enemies[1], x: 500, y: 492, patrolMin: 300, patrolMax: 800 }] };
  const near = createSimulation(map, DEMO_OPERATOR); Object.assign(near.player, { x: 420, y: 492 });
  tick(near, 30, {}, map); assert.ok(near.enemies[0].x > 505, String(near.enemies[0].x));
  const far = createSimulation(map, DEMO_OPERATOR); Object.assign(far.player, { x: 250, y: 372 });
  for (let i = 0; i < 200 && !far.projectiles.length; i++) tick(far, 1, {}, map);
  assert.equal(far.projectiles.length, 1); assert.ok(far.projectiles[0].vy < 0);
});
test('the server default stage settles every actor on solid ground', () => {
  const authored = JSON.parse(readFileSync(new URL('../../../../data/sideview_levels/default.json', import.meta.url), 'utf8'));
  const map = normalizeLevel(authored); const s = createSimulation(map, DEMO_OPERATOR);
  tick(s, 45, {}, map);
  assert.equal(s.player.grounded, true);
  for (const e of s.enemies) { assert.ok(e.hp > 0, e.id); assert.equal(e.grounded, true, e.id); }
  assert.deepEqual(new Set(map.enemies.map(e => e.kind)), new Set(['guard', 'ranger', 'elite']));
});
test('thin ledges are one-way: jump up through them, land on top; thick blocks stay solid', () => {
  const ledge = { x: 100, y: 470, width: 200, height: 20 }, wall = { x: 400, y: 380, width: 40, height: 170 };
  const map = normalizeLevel({ ...DEMO_LEVEL, width: 800, platforms: [{ x: 0, y: 550, width: 800, height: 130 }, ledge, wall], obstacles: [], hazards: [], enemies: [], exit: { x: 700, y: 426, width: 90, height: 124 } });
  assert.equal(map.platforms[1].oneWay, true); assert.equal(map.platforms[2].oneWay, false);
  const s = createSimulation(map, DEMO_OPERATOR); Object.assign(s.player, { x: 150, y: 492 }); tick(s, 5, {}, map);
  tick(s, 60, { jump: true }, map); tick(s, 30, {}, map);
  assert.equal(s.player.grounded, true); assert.equal(s.player.y, ledge.y - s.player.height);
  Object.assign(s.player, { x: 330, y: 492, vy: 0 }); tick(s, 60, { right: true }, map);
  assert.equal(s.player.x, wall.x - s.player.width);
});
test('a simple seek-and-strike policy clears the server default stage', () => {
  const authored = JSON.parse(readFileSync(new URL('../../../../data/sideview_levels/default.json', import.meta.url), 'utf8'));
  const map = normalizeLevel(authored), op = { name: 'test', maxHp: 140, attack: 22, skillPower: 35 };
  const s = createSimulation(map, op); const solids = [...map.platforms, ...map.obstacles];
  for (let i = 0; i < 60 * 90 && !s.outcome; i++) {
    const p = s.player, input = emptyInput();
    const target = s.enemies.filter(e => e.hp > 0).sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    const dx = target ? target.x - p.x : Infinity;
    if (target && Math.abs(dx) < 105 && Math.abs(target.y - p.y) < 60) { input.attack = true; input.skill = p.skillCooldown <= 0; }
    else if (target && dx < -20) input.left = true; else input.right = true;
    if (target && Math.abs(dx) < 200 && target.y < p.y - 40) input.jump = i % 40 < 30;
    if (s.enemies.some(e => e.hp > 0 && (e.windup > 0 && e.windup < 0.15 || e.lunge > 0) && Math.abs(e.x - p.x) < 150)) input.dash = i % 2 === 0;
    if (p.hp < op.maxHp * 0.5) input.support = true;
    const ahead = p.x + (input.left ? -14 : p.width + 14), foot = p.y + p.height + 4;
    const ground = solids.some(r => ahead >= r.x && ahead <= r.x + r.width && foot >= r.y && foot <= r.y + r.height + 40);
    const hazard = map.hazards.some(h => ahead + 50 > h.x && ahead - 20 < h.x + h.width && h.y < foot + 10 && h.y > p.y);
    const blocked = map.obstacles.some(o => ahead >= o.x && ahead <= o.x + o.width && foot - 4 > o.y);
    if (p.grounded && (!ground || hazard || blocked)) input.jump = true;
    if (!p.grounded && p.vy < 0) input.jump = true;
    stepSimulation(s, input, map, op);
  }
  assert.equal(s.outcome, 'victory', `kills ${s.kills}, hp ${s.player.hp}, x ${Math.round(s.player.x)}`);
  assert.equal(s.kills, map.enemies.length);
});
const serverStage = () => normalizeLevel(JSON.parse(readFileSync(new URL('../../../../data/sideview_levels/default.json', import.meta.url), 'utf8')));
test('a guard beside a crate still reaches a player standing on top of it', () => {
  const map = serverStage(), op = { name: 'test', maxHp: 140, attack: 22, skillPower: 35 };
  const s = createSimulation(map, op); const crate = map.obstacles[0];
  Object.assign(s.player, { x: crate.x + 20, y: crate.y - 58, grounded: true });
  Object.assign(s.enemies[0], { x: crate.x + crate.width + 2, y: 492, cooldown: 0 });
  tick(s, 180, {}, map); assert.ok(s.damageTaken > 0, 'the crate top is not a safe spot');
});
test('a chasing guard leaves its patrol interval instead of standing still out of reach', () => {
  const map = { ...level, worldWidth: 1400, platforms: [{ x: 0, y: 550, width: 1400, height: 130 }], obstacles: [], hazards: [], goal: { x: 1300, y: 426, width: 90, height: 124 }, enemies: [{ ...level.enemies[0], x: 490, y: 492, patrolMin: 300, patrolMax: 500 }] };
  const s = createSimulation(map, DEMO_OPERATOR); Object.assign(s.player, { x: 620, y: 492 });
  tick(s, 240, {}, map);
  assert.ok(s.enemies[0].x > 500, String(s.enemies[0].x)); assert.ok(s.damageTaken > 0);
});
test('one dash earns the perfect-dodge refund only once', () => {
  const s = createSimulation(level, DEMO_OPERATOR); tick(s, 30);
  Object.assign(s.enemies[0], { x: s.player.x + 40, y: s.player.y, windup: 2 / 60, cooldown: 0 });
  Object.assign(s.enemies[2], { x: s.player.x + 60, y: s.player.y, windup: 4 / 60, cooldown: 0 });
  s.player.skillCooldown = 5;
  tick(s, 1, { dash: true }); tick(s, 8);
  assert.equal(s.effects.filter(e => e.kind === 'perfect').length, 1);
  assert.ok(s.player.skillCooldown > 3.2, String(s.player.skillCooldown)); assert.equal(s.damageTaken, 0);
});
test('an enemy with fractional HP from an old save still dies in a pit', () => {
  const s = createSimulation(level, DEMO_OPERATOR);
  Object.assign(s.enemies[1], { hp: 17.25, x: 1250, y: 700 });
  tick(s, 5);
  assert.equal(s.enemies[1].hp, 0); assert.equal(s.kills, 1); assert.ok(s.enemies[1].y <= level.worldHeight + 80);
});

test('street props are bounded, repeatable and clear of hazards, blockers and the exit', () => {
  const s = createSimulation(level, DEMO_OPERATOR), again = createSimulation(level, DEMO_OPERATOR);
  assert.deepEqual(s.props, again.props); assert.ok(s.props.length >= 4 && s.props.length <= 32);
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  for (const prop of s.props) {
    assert.ok(prop.x >= 0 && prop.x + prop.width <= level.worldWidth);
    assert.ok(prop.y >= 0 && prop.y + prop.height <= level.worldHeight);
    assert.ok(![...level.hazards, ...level.obstacles, level.goal].some(r => overlaps(prop, r)));
    assert.ok(level.platforms.some(f => prop.y + prop.height === f.y && prop.x >= f.x && prop.x + prop.width <= f.x + f.width));
  }
});
const emptyStreet = () => ({ ...level, enemies: [], obstacles: [], hazards: [], platforms: [{ x: 0, y: 550, width: 3400, height: 130 }] });
test('footsteps need actual ground travel; jumping and landing each emit one cue', () => {
  const map = emptyStreet(), s = createSimulation(map, DEMO_OPERATOR); tick(s, 30, {}, map);
  assert.equal(s.effects.length, 0);
  tick(s, 25, { right: true }, map); assert.ok(s.effects.some(e => e.kind === 'step'));
  tick(s, 60, {}, map); assert.equal(s.effects.length, 0);
  tick(s, 1, { jump: true }, map); assert.equal(s.effects.filter(e => e.kind === 'jump').length, 1);
  let landed = false;
  for (let i = 0; i < 100; i++) {
    tick(s, 1, { jump: true }, map);
    assert.equal(s.effects.some(e => e.kind === 'step'), false);
    if (s.player.grounded) { landed = true; break; }
  }
  assert.ok(landed); assert.equal(s.effects.filter(e => e.kind === 'land').length, 1);
  tick(s, 60, {}, map); assert.equal(s.effects.length, 0);
});
test('walking through scenery neither blocks movement nor breaks a prop; dashing does', () => {
  const map = emptyStreet(), s = createSimulation(map, DEMO_OPERATOR); tick(s, 10, {}, map);
  const prop = s.props[0]; tick(s, 35, { right: true }, map);
  assert.ok(s.player.x > prop.x + prop.width); assert.equal(prop.broken, false);
  s.player.x = prop.x - 50; tick(s, 8, { right: true, dash: true }, map);
  assert.equal(prop.broken, true); assert.equal(s.kills, 0); assert.equal(s.damageTaken, 0);
  assert.equal(s.effects.filter(e => e.kind === 'debris').length, 1);
});
test('melee only breaks street props in the strike direction and cannot repeatedly shatter them', () => {
  const map = emptyStreet(), s = createSimulation(map, DEMO_OPERATOR); tick(s, 10, {}, map);
  const prop = s.props[0]; s.player.x = prop.x + prop.width + 10;
  tick(s, 1, { attack: true }, map); assert.equal(prop.broken, false);
  tick(s, 35, {}, map); s.player.facing = -1;
  tick(s, 1, { attack: true }, map); assert.equal(prop.broken, true);
  const hp = s.player.hp; tick(s, 120, { attack: true }, map);
  assert.equal(s.player.hp, hp); assert.equal(s.kills, 0); assert.equal(s.effects.some(e => e.kind === 'debris'), false);
});
test('skills break nearby fixtures once, including lamp sparks, without changing combat or save contracts', () => {
  const map = emptyStreet(), s = createSimulation(map, DEMO_OPERATOR); tick(s, 10, {}, map);
  const lamp = s.props.find(p => p.kind === 'lamp'); s.player.x = lamp.x - 40;
  tick(s, 1, { skill: true }, map);
  assert.equal(lamp.broken, true); assert.equal(s.effects.filter(e => e.kind === 'spark').length, 1);
  assert.equal(s.player.hp, DEMO_OPERATOR.maxHp); assert.equal(s.kills, 0);
  const saved = snapshotSimulation(s); assert.equal(saved.version, 1); assert.ok(!('props' in saved));
  const restored = createSimulation(map, DEMO_OPERATOR, saved);
  assert.ok(restored.props.every(p => !p.broken)); assert.equal(restored.effects.length, 0);
  assert.equal(restored.player.skillCooldown, s.player.skillCooldown);
});
test('presentation effects stay bounded across sustained movement and attacks', () => {
  const map = emptyStreet(), a = createSimulation(map, DEMO_OPERATOR), b = createSimulation(map, DEMO_OPERATOR);
  for (let i = 0; i < 3600; i++) {
    const input = { right: i % 600 < 300, left: i % 600 >= 300, jump: i % 90 < 35, attack: true, dash: i % 100 === 0, skill: i % 400 === 0 };
    tick(a, 1, input, map); tick(b, 1, input, map); assert.ok(a.effects.length <= 90);
  }
  assert.deepEqual(a.props, b.props); assert.deepEqual(a.effects, b.effects);
  assert.deepEqual(snapshotSimulation(a), snapshotSimulation(b));
});
