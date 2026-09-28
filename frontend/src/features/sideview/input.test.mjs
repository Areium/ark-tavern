import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const pure = await build({ entryPoints: [fileURLToPath(new URL('./input.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createInputController, cameraEase } = await import(`data:text/javascript;base64,${Buffer.from(pure.outputFiles[0].text).toString('base64')}`);

test('two physical keys for one action release independently', () => {
  const input = createInputController();
  input.press('key:KeyD', 'right'); input.press('key:ArrowRight', 'right');
  assert.equal(input.sample().right, true);
  input.release('key:KeyD'); assert.equal(input.sample().right, true);
  input.release('key:ArrowRight'); assert.equal(input.sample().right, false);
});
test('touch release never interrupts a keyboard hold, or another pointer', () => {
  const input = createInputController();
  input.press('key:KeyD', 'right'); input.press('pointer:1', 'right'); input.press('pointer:2', 'jump');
  input.sample(); input.release('pointer:1');
  assert.equal(input.sample().right, true); assert.equal(input.sample().jump, true);
  input.release('pointer:2'); assert.equal(input.sample().jump, false);
});
test('a tap between fixed steps is delivered once', () => {
  const input = createInputController();
  input.press('pointer:2', 'skill'); input.release('pointer:2');
  assert.equal(input.sample().skill, true); assert.equal(input.sample().skill, false);
});
test('held input does not generate a queued tap on repeated keydown', () => {
  const input = createInputController(); input.press('key:Space', 'jump'); input.sample();
  input.press('key:Space', 'jump'); input.release('key:Space');
  assert.equal(input.sample().jump, false);
});
test('button focus loss only releases that button keyboard source', () => {
  const input = createInputController();
  input.press('button:attack:Enter', 'attack'); input.press('pointer:3', 'attack'); input.sample();
  input.releasePrefix('button:attack:'); assert.equal(input.sample().attack, true);
  input.release('pointer:3'); assert.equal(input.sample().attack, false);
});
test('pause clears held and buffered actions', () => {
  const input = createInputController(); input.press('pointer:1', 'dash'); input.clear();
  assert.ok(Object.values(input.sample()).every(value => !value));
});
test('gamepad is merged without owning or releasing other input sources', () => {
  const input = createInputController(); input.press('key:KeyD', 'right');
  const pad = { left: true, right: false, jump: true, attack: false, skill: false, support: false, dash: false };
  assert.equal(input.sample(pad).jump, true);
  assert.equal(input.sample().jump, false); assert.equal(input.sample().right, true);
});
test('camera response is refresh-rate independent and still when paused', () => {
  const advance = (fps) => {
    let x = 0;
    for (let frame = 0; frame < fps; frame++) x += (100 - x) * cameraEase(0.035, 1 / fps);
    return x;
  };
  assert.ok(Math.abs(advance(30) - advance(60)) < 1e-10);
  assert.ok(Math.abs(advance(144) - advance(60)) < 1e-10);
  assert.equal(cameraEase(0.12, 0), 0);
});
