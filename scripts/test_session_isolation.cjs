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
const { triggerNarrate, restoreCachedMessages, messagesAfterRollback } = require(src("components/ChatPanel.tsx"));
const briefing = id => ({ session_id: id, encounter_id: "gate", name: `${id} gate`, approaches: [] });
const get = () => useAppStore.getState();
function finishNarration(handlers, text = "A narration", round = 1) {
  handlers.onTextComplete({stream_id:"test-stream", narrative:text});
  handlers.onDone({stream_id:"test-stream", round, phase2_status:"completed"});
}
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
assert.equal(get().sessionBriefings.a, undefined, "briefing waits for successful completion");
assert.equal(get().activeSessionId, "b");
assert.equal(get().currentView, "chat");
assert.equal(get().sessionMessages.b, undefined);
callbacks.onCombatTrigger({ session_id: "a", encounter_id: "gate" });
assert.equal(get().sessionStreaming.a, true, "combat must not complete the narration early");
callbacks.onCombatBriefing(briefing("b"));
finishNarration(callbacks);
assert.equal(get().currentView, "chat");
assert.equal(get().combatContext.sessionId, null);
assert.equal(get().sessions.find(s => s.id === "a").in_combat, true);
assert.equal(get().sessionBriefings.a.session_id, "a", "payload cannot change stream owner");

get().setPendingAutoNarrate("a", { action: "A continuation" });
get().setPendingAutoNarrate("a", null);
assert.equal(get().sessionAutoNarrate.b.action, "B continuation");
get().setPendingBriefing("a", null);
assert.equal(get().sessionBriefings.b.session_id, "b");

// Replacing/clearing a stream invalidates every captured callback, even if transport misbehaves.
triggerNarrate("a");
const current = streams.at(-1);
assert.equal(get().sessionMessages.a.at(-1).generationPhase, "receiving");
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
assert.equal(get().currentView, "chat");
finishNarration(callbacks);
assert.equal(get().currentView, "combat");
assert.equal(get().combatContext.sessionId, "a");
assert.equal(get().combatContext.testId, null);
assert.equal(get().combatContext.practiceMode, null);
const completed = get().sessionMessages.a;
callbacks.onText("after done");
assert.equal(get().sessionMessages.a, completed);
assert.equal(get().sessionAbortFns.a, null);

// Authority text, reasoning and request identity survive chunk/phase changes.
triggerNarrate("a");
callbacks = streams.at(-1).handlers;
const narrator = () => get().sessionMessages.a.findLast(m => m.role === "narrator");
const generation = narrator().generationId;
callbacks.onMeta({stream_id:"authority"});
callbacks.onReasoning("private reasoning");
callbacks.onText("妮可说：「它在等。」");
assert.equal(narrator().reasoning, "private reasoning");
assert.equal(narrator().generationPhase, "receiving");
callbacks.onTextComplete({stream_id:"wrong-stream", narrative:"wrong"});
assert.equal(narrator().generationPhase, "receiving");
const authority = "检定成功。\n妮可说：「它在等。」";
callbacks.onTextComplete({stream_id:"authority", narrative:authority});
callbacks.onText("late token");
assert.equal(narrator().content, authority);
assert.equal(narrator().previewContent, "妮可说：「它在等。」");
assert.equal(narrator().generationPhase, "processing");
assert.equal(get().sessionStreaming.a, true);
callbacks.onChoice(["继续"]);
callbacks.onDone({stream_id:"authority",round:9,phase2_status:"degraded"});
assert.equal(narrator().generationId, generation);
assert.equal(narrator().generationPhase, "complete");
assert.equal(narrator().phase2Status, "degraded");
assert.equal(narrator().round, 9);
assert.equal(get().sessionMessages.a.at(-1).round, 9);
assert.equal(get().sessionNarrationCount.a, 9);

triggerNarrate("a");
callbacks = streams.at(-1).handlers;
callbacks.onText("还没传完");
callbacks.onError("断线");
assert.equal(narrator().content, "还没传完");
assert.equal(narrator().generationPhase, "error");
assert.equal(narrator().round, undefined, "failed drafts cannot shadow the next completed round");
assert.equal(get().sessionMessages.a.at(-1).requestError, true);
const failedMessages = get().sessionMessages.a;
callbacks.onDone({stream_id:"authority",round:10});
assert.equal(get().sessionMessages.a, failedMessages);

triggerNarrate("a");
callbacks = streams.at(-1).handlers;
callbacks.onText("取消仍保留正文");
const cancelledId = narrator().generationId;
get().sessionAbortFns.a();
assert.equal(narrator().generationPhase, "cancelled");
assert.equal(narrator().round, undefined);
assert.equal(get().sessionStreaming.a, false);
callbacks.onText("obsolete");
assert.equal(narrator().content, "取消仍保留正文");
triggerNarrate("a");
assert.notEqual(narrator().generationId, cancelledId);
callbacks = streams.at(-1).handlers;
callbacks.onDone({stream_id:"missing-text-complete",round:11});
assert.equal(narrator().generationPhase, "error", "done alone cannot promote an incomplete narration");
const restored = restoreCachedMessages([{role:"narrator",content:"保留正文",previewContent:"保留正文",generationId:"reload",generationPhase:"processing",streaming:true,round:11}, {role:"system",content:"choose",choices:["继续"],generationId:"reload",round:11}]);
assert.equal(restored[0].content, "保留正文");
assert.equal(restored[0].generationPhase, "error");
assert.equal(restored[0].round, undefined);
assert.ok(!restored.some(m => m.choices), "uncommitted choices cannot survive an interrupted restore");
assert.equal(restored.at(-1).requestError, true);
const originalHistory = [{role:"narrator",content:"正式正文",round:1,generationId:"old",generationPhase:"complete"}, {role:"narrator",content:"取消稿",generationId:"draft",generationPhase:"cancelled"}, {role:"system",content:"draft error",requestError:true,generationId:"draft"}, {role:"narrator",content:"未来正文",round:2}];
const rollback = messagesAfterRollback(originalHistory, 1);
assert.deepEqual(rollback.map(m=>m.content), ["正式正文"]);
assert.equal(rollback[0].generationId, "old", "rollback retains status association");
assert.equal(rollback[0].playbackRevision, 1, "rollback replays from a fresh stage cursor");
get().setSessionNarrationCount("a",4);
triggerNarrate("a");
assert.equal(get().sessionNarrationCount.a,5);
const replaced=streams.at(-1);
triggerNarrate("a");
assert.equal(replaced.closed,true);
assert.equal(get().sessionNarrationCount.a,5,"replacement uses the last acknowledged count after cancelling the previous request");
streams.at(-1).handlers.onError("replacement failed");
assert.equal(get().sessionNarrationCount.a,4);
console.log("PASS: per-session briefings, continuations, navigation, replacement and deletion isolation");
