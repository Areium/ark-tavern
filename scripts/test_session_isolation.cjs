// Actual store/narration callbacks with deferred transports; no browser, server or LLM.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const ts = fromFrontend("typescript");
global.localStorage = { getItem: () => null, setItem: () => {} };
require.extensions[".css"] = () => {};
for (const ext of [".ts", ".tsx"]) {
  require.extensions[ext] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const src = relative => path.join(root, "frontend/src", relative);
const streams = [];
require.cache[src("hooks/useApi.ts")] = { exports: {
  useApi: () => ({}),
  createSSE: (url, handlers) => {
    const stream = { url, handlers, closed: false, close() { this.closed = true; } };
    streams.push(stream);
    return stream;
  },
} };
const { useAppStore } = require(src("stores/appStore.ts"));
const { triggerNarrate } = require(src("components/ChatPanel.tsx"));
const briefing = id => ({ session_id: id, encounter_id: "gate", name: `${id} gate`, approaches: [] });
const get = () => useAppStore.getState();
get().setSessions(["a", "b"].map(id => ({ id, mode: "story", combat_mode: "tactical", characters: [], player_identity: "玩家" })));
get().setActiveSession("b");
get().setCurrentView("chat");
get().setPendingBriefing("b", briefing("b"));
get().setPendingAutoNarrate("b", { action: "B continuation" });
triggerNarrate("a");
let callbacks = streams.at(-1).handlers;
callbacks.onText("A narration");
callbacks.onChoice(["A choice"]);
callbacks.onCombatBriefing(briefing("a"));
assert.equal(get().sessionBriefings.b.session_id, "b");
assert.equal(get().sessionBriefings.a.session_id, "a");
assert.equal(get().activeSessionId, "b");
assert.equal(get().currentView, "chat");
assert.equal(get().sessionMessages.b, undefined);
callbacks.onCombatTrigger({ session_id: "a", encounter_id: "gate" });
assert.equal(get().currentView, "chat");
assert.equal(get().combatContext.sessionId, null);
assert.equal(get().sessions.find(s => s.id === "a").in_combat, true);
callbacks.onCombatBriefing(briefing("b"));
assert.equal(get().sessionBriefings.a.session_id, "a", "payload cannot change stream owner");

get().setPendingAutoNarrate("a", { action: "A continuation" });
get().setPendingAutoNarrate("a", null);
assert.equal(get().sessionAutoNarrate.b.action, "B continuation");
get().setPendingBriefing("a", null);
assert.equal(get().sessionBriefings.b.session_id, "b");

// Replacing/clearing a stream invalidates every captured callback, even if transport misbehaves.
triggerNarrate("a");
const current = streams.at(-1);
assert.equal(streams[0].closed, true);
const before = get().sessionMessages.a;
callbacks.onText("obsolete text");
callbacks.onCombatBriefing(briefing("a"));
callbacks.onDone();
assert.equal(get().sessionMessages.a, before);
assert.equal(get().sessionBriefings.a, null);
assert.equal(get().sessionStreaming.a, true);
callbacks = current.handlers;
get().clearSessionStream("a");
callbacks.onText("deleted text");
callbacks.onError("deleted error");
callbacks.onCombatBriefing(briefing("a"));
assert.equal(get().sessionMessages.a, undefined);
assert.equal(get().sessionBriefings.a, undefined);
assert.equal(get().sessionAutoNarrate.a, undefined);
assert.equal(get().sessionBriefings.b.session_id, "b");

// A valid foreground event can still enter combat, clearing unrelated practice context.
get().setActiveSession("a");
get().setCombatContext({ practiceMode: "tactical", testId: "old-practice" });
triggerNarrate("a");
callbacks = streams.at(-1).handlers;
callbacks.onCombatTrigger({ session_id: "a", encounter_id: "gate" });
assert.equal(get().currentView, "combat");
assert.equal(get().combatContext.sessionId, "a");
assert.equal(get().combatContext.testId, null);
assert.equal(get().combatContext.practiceMode, null);
callbacks.onDone();
const completed = get().sessionMessages.a;
callbacks.onText("after done");
assert.equal(get().sessionMessages.a, completed);
assert.equal(get().sessionAbortFns.a, null);
console.log("PASS: per-session briefings, continuations, navigation, replacement and deletion isolation");
