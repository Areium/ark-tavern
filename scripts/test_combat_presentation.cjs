// Deterministic presentation contracts; no browser, model calls or battle rules are mocked here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const ts = createRequire(path.join(root, "frontend/package.json"))("typescript");
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  });
  module._compile(outputText, filename);
};
const { combatCues, projectCombatEvent, CombatEventLedger, presentationDelay } = require(
  path.join(root, "frontend/src/components/combat/combatPresentation.ts"));

const event = (type, data = {}) => ({ type, data });
const hit = (target, more = {}) => event("damage", {
  unit_id: "caster", card_id: "wave", source_type: "card", target_id: target, damage: 25, ...more,
});
const batch = [hit("one"), event("death", { unit_id: "one" }), hit("two"),
  event("card_played", { unit_id: "caster", card_id: "wave" }), hit("two"),
  event("battle_end", { winner: "player" })];
const cues = combatCues(batch);
assert.deepEqual(cues.map(c => c.attack), [true, false, false, false, true, false],
  "AOE including lethal hits starts one attack; the next cast of the same card starts another");
assert.equal(cues[1].after, 650, "death remains visible before following actions or settlement");
assert.deepEqual(cues.map(c => c.event), batch, "death and settlement order must not be rearranged");
assert.equal(combatCues([hit("one", { source_type: "terrain" })])[0].attack, false,
  "environment damage does not animate an unrelated attacker");
const cursor = { attackKey: "" };
assert.equal(combatCues([hit("one")], false, cursor)[0].attack, true);
assert.equal(combatCues([hit("two")], false, cursor)[0].attack, false, "late legacy SSE fragments retain the same attack group");
combatCues([event("card_played")], false, cursor);
assert.equal(combatCues([hit("two")], false, cursor)[0].attack, true);
const reduced = combatCues(batch, true);
assert.ok(reduced.reduce((n,c) => n+c.before+c.after,0) < cues.reduce((n,c) => n+c.before+c.after,0));
assert.equal(reduced[1].event.type, "death", "reduced motion preserves outcomes");

const original = { round_num: 1, phase: "PLAYER_TURN", units: [
  { unit_id: "one", hp: 20, max_hp: 30, is_alive: true, pos: [0,0], status: { shield: 8 } },
  { unit_id: "two", hp: 80, max_hp: 80, is_alive: true, pos: [1,0] },
] };
const damaged = projectCombatEvent(original, hit("one", { shielded: 6 }));
assert.equal(damaged.units[0].hp, 0);
assert.equal(damaged.units[0].is_alive, true, "a lethal damage cue must not remove its death-animation target");
assert.equal(damaged.units[0].status.shield, 2);
assert.equal(original.units[0].hp, 20, "visual projection never mutates the input snapshot");
assert.equal(projectCombatEvent(damaged, batch[1]).units[0].is_alive, false);
assert.equal(projectCombatEvent(original, event("heal", { target_id: "one", amount: 90 })).units[0].hp, 30);
assert.deepEqual(projectCombatEvent(original, event("move", { unit_id: "one", to_pos: [2,3] })).units[0].pos, [2,3]);
assert.equal(projectCombatEvent(original, event("round_start", { round: 2 })).round_num, 2);

assert.equal(projectCombatEvent(original, event("status", { target_id: "one", type: "shield", value: 5 })).units[0].status.shield, 13);
const burned = projectCombatEvent(original, event("status", { target_id: "one", type: "burn", value: 4, duration: 2 }));
assert.equal(burned.units[0].status.burn, 2, "burn value is damage, not duration");
assert.equal(burned.units[0].status.burn_damage, 4);
assert.equal(projectCombatEvent(burned, event("cleanse", { target_id: "one" })).units[0].status.burn, 0);

const ledger = new CombatEventLedger();
const http = hit("one", { presentation_id: "same-delivery" });
assert.equal(ledger.has(http), false);
ledger.remember(http);
assert.equal(ledger.has(JSON.parse(JSON.stringify(http))), true, "HTTP/SSE copies are one impact");
ledger.clear();
assert.equal(ledger.has(http), false, "a new battle resets delivery history");
for (let i=0; i<2100; i++) ledger.remember(hit("one", { presentation_id: String(i) }));
assert.equal(ledger.has(hit("one", { presentation_id: "0" })), false, "history remains bounded");
assert.equal(ledger.has(hit("one", { presentation_id: "2099" })), true);

(async () => {
  const controller = new AbortController();
  const pending = presentationDelay(10000, controller.signal);
  controller.abort();
  assert.equal(await pending, false, "leaving the battle cancels a pending animation wait immediately");
  assert.equal(await presentationDelay(0, controller.signal), false);
  assert.equal(await presentationDelay(1, new AbortController().signal), true);
  console.log("Combat presentation: checks passed (sequencing, projection, deduplication, cancellation).");
})().catch(error => { console.error(error); process.exitCode=1; });
