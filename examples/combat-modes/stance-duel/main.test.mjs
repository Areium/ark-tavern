import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const code = await readFile(new URL("./main.js", import.meta.url));
const { initial, restore, step, intent } = await import(`data:text/javascript;base64,${code.toString("base64")}`);
const input = JSON.parse(await readFile(new URL("./practice.json", import.meta.url), "utf8"));

test("defend the heavy hit then burst for a deterministic victory", () => {
  let state = initial(input);
  for (const action of ["strike", "focus", "guard", "burst", "focus", "burst"]) state = step(input, state, action);
  assert.equal(state.outcome, "victory");
  assert.equal(state.enemyHp, 0);
  assert.equal(state.hp, 40);
  assert.ok(state.log.length <= 8);
});
test("invalid actions and unearned burst cannot advance", () => {
  const state = initial(input);
  assert.throws(() => step(input, state, "burst"));
  assert.throws(() => step(input, state, "cheat"));
  assert.equal(state.turn, 1);
});
test("serialized save resumes identically", () => {
  let state = step(input, initial(input), "focus");
  const resumed = restore(input, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(step(input, resumed, "strike"), step(input, state, "strike"));
});
test("defeat and retreat terminate further moves", () => {
  const fragile = { ...input, player: { name: "Test", hp: 1 } };
  const lost = step(fragile, initial(fragile), "strike");
  assert.equal(lost.outcome, "defeat");
  assert.throws(() => step(fragile, lost, "guard"));
  assert.equal(step(input, initial(input), "retreat").outcome, "retreat");
});
test("reject corrupt input and snapshot", () => {
  assert.throws(() => initial({ player: {}, enemy: {} }));
  assert.throws(() => restore(input, { ...initial(input), hp: Infinity }));
  assert.throws(() => restore(input, { ...initial(input), outcome: "victory" }));
  assert.equal(intent({ turn: 3 }).damage, 24);
});
