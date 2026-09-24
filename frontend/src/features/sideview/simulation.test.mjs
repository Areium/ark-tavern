import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
test('exit requires every guard cleared and simulation stops after victory', () => {
  const s = createSimulation(level, DEMO_OPERATOR); Object.assign(s.player, { x: 3250, y: 470 }); tick(s, 1); assert.equal(s.outcome, null);
  s.enemies.forEach(e => { e.hp = 0; }); tick(s, 1); assert.equal(s.outcome, 'victory'); const elapsed = s.elapsed; tick(s, 60); assert.equal(s.elapsed, elapsed); assert.equal(snapshotSimulation(s).exitReached, true);
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
