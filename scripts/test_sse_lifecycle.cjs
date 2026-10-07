// Run: node scripts/test_sse_lifecycle.cjs
// Same dependency-free TypeScript require hook as test_stage_ui.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const ts = fromFrontend("typescript");
const baseUrlFile = path.join(root, "frontend/src/utils/baseUrl.ts");
let getBaseUrl;
require.extensions[".ts"] = (module, filename) => {
  if (filename === baseUrlFile) {
    module.exports = { getBaseUrl: () => getBaseUrl() };
    return;
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
const { createSSE } = require(path.join(root, "frontend/src/hooks/useApi.ts"));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const event = (type, data = {}) => `data: ${JSON.stringify({ type, data })}\n\n`;
const chunk = (text) => ({ done: false, value: encoder.encode(text) });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const base = deferred();
  const fetched = deferred();
  const text = deferred();
  const fetchCalls = [];
  const reads = [];
  const events = [];
  const counts = { reader: 0, cancel: 0, release: 0, bodyCancel: 0, text: 0 };
  let locked = false;
  const reader = {
    read() {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    // Deliberately do not settle queued reads on cancel. Late resolutions must
    // be suppressed by lifecycle state, not by a cooperative fetch mock.
    cancel() {
      counts.cancel++;
      return options.cancel ? options.cancel() : Promise.resolve();
    },
    releaseLock() { counts.release++; locked = false; },
  };
  const body = {
    get locked() { return locked; },
    getReader() { counts.reader++; locked = true; return reader; },
    cancel() { counts.bodyCancel++; return Promise.resolve(); },
  };
  const response = {
    ok: options.ok ?? true,
    status: options.ok === false ? 500 : 200,
    body: options.noBody ? null : body,
    text() {
      counts.text++;
      locked = true;
      return text.promise.finally(() => { locked = false; });
    },
  };
  const originalFetch = global.fetch;
  getBaseUrl = () => base.promise;
  global.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return fetched.promise;
  };
  const handlers = {};
  for (const name of ["Meta", "TextComplete", "Text", "Reasoning", "SceneEvent", "MemoryEvent", "Choice",
    "DialogueSegments", "TokenUsage", "CombatTrigger", "CombatBriefing", "AttributeRoll", "Error", "Done"]) {
    handlers[`on${name}`] = (...args) => {
      events.push([name, ...args]);
      options.onEvent?.(name, ...args);
    };
  }
  const connection = createSSE("/api/sessions/test/stream", handlers);
  t.after(() => { connection.close(); global.fetch = originalFetch; });
  return {
    base, fetched, text, fetchCalls, reads, events, counts, response, connection,
    async startFetch() {
      base.resolve("http://backend.test");
      await tick();
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "http://backend.test/api/sessions/test/stream");
      assert.equal(fetchCalls[0].init.method, "GET");
      assert.equal(fetchCalls[0].init.headers.Accept, "text/event-stream");
    },
    async startReader() {
      await this.startFetch();
      fetched.resolve(response);
      await tick();
      assert.equal(reads.length, 1);
    },
    assertReleased() {
      assert.equal(fetchCalls[0].init.signal.aborted, true, "network aborted");
      assert.equal(counts.cancel, 1, "reader cancelled once");
      assert.equal(counts.release, 1, "reader lock released once");
      assert.equal(counts.bodyCancel, 0, "locked body not cancelled separately");
    },
  };
}

// Pending = close before settlement; queued = settlement before close but before
// the awaiting continuation runs. Each await must defend against both races.
for (const timing of ["pending", "queued"]) {
  async function closeAround(h, settle) {
    if (timing === "queued") settle();
    h.connection.close();
    h.connection.close();
    if (timing === "pending") settle();
    await tick();
  }

  for (const reject of [false, true]) {
    test(`close at getBaseUrl: ${timing}, ${reject ? "reject" : "resolve"}`, async (t) => {
      const h = harness(t);
      await closeAround(h, () => reject ? h.base.reject(new Error("base failed")) : h.base.resolve(""));
      assert.deepEqual(h.events, []);
      assert.equal(h.fetchCalls.length, 0, "no fetch after closing during base URL lookup");
    });
  }

  for (const ok of [true, false]) {
    test(`close at fetch: ${timing}, HTTP ${ok ? "200" : "500"}`, async (t) => {
      const h = harness(t, { ok });
      await h.startFetch();
      await closeAround(h, () => h.fetched.resolve(h.response));
      assert.deepEqual(h.events, []);
      assert.equal(h.counts.text, 0, "closed HTTP response must not be consumed");
      assert.equal(h.counts.reader, 0);
      assert.equal(h.counts.bodyCancel, 1, "late response body released");
      assert.equal(h.fetchCalls[0].init.signal.aborted, true);
    });
  }

  test(`close at rejected fetch: ${timing}`, async (t) => {
    const h = harness(t);
    await h.startFetch();
    await closeAround(h, () => h.fetched.reject(new Error("fetch failed")));
    assert.deepEqual(h.events, []);
    assert.equal(h.fetchCalls[0].init.signal.aborted, true);
  });

  for (const reject of [false, true]) {
    test(`close at response.text: ${timing}, ${reject ? "reject" : "resolve"}`, async (t) => {
      const h = harness(t, { ok: false });
      await h.startFetch();
      h.fetched.resolve(h.response);
      await tick();
      assert.equal(h.counts.text, 1);
      await closeAround(h, () => reject ? h.text.reject(new Error("body failed")) : h.text.resolve('{"error":"late HTTP error"}'));
      assert.deepEqual(h.events, []);
      assert.equal(h.fetchCalls[0].init.signal.aborted, true);
    });
  }

  for (const result of ["data", "eof", "reject"]) {
    test(`close at reader.read: ${timing}, ${result}`, async (t) => {
      const h = harness(t);
      await h.startReader();
      await closeAround(h, () => result === "reject"
        ? h.reads[0].reject(new Error("read failed"))
        : h.reads[0].resolve(result === "eof" ? { done: true } : chunk(event("text", { token: "late" }) + event("done"))));
      assert.deepEqual(h.events, []);
      assert.equal(h.reads.length, 1);
      h.assertReleased();
    });
  }
}

test("close in a callback suppresses remaining events already in the same chunk", async (t) => {
  const h = harness(t, { onEvent: (name) => { if (name === "Text") h.connection.close(); } });
  await h.startReader();
  h.reads[0].resolve(chunk(event("text", { token: "first" }) + event("choice", { options: ["late"] }) + event("done")));
  await tick();
  assert.deepEqual(h.events, [["Text", "first"]]);
  assert.equal(h.reads.length, 1);
  h.assertReleased();
});

for (const terminal of [event("done"), "data: [DONE]\n\n", event("error", { message: "failed" })]) {
  test(`terminal ${terminal.trim()} stops same-chunk and future events`, async (t) => {
    const h = harness(t);
    await h.startReader();
    h.reads[0].resolve(chunk(event("text", { token: "first" }) + terminal
      + event("text", { token: "late" }) + event("choice", { options: ["late"] })
      + event("combat_briefing", { name: "late" }) + event("done") + "data: [DONE]\n\n"));
    await tick();
    assert.deepEqual(h.events, [["Text", "first"], terminal.includes('"error"') ? ["Error", "failed"] : terminal.includes('[DONE]') ? ["Done"] : ["Done", {}]]);
    assert.equal(h.reads.length, 1, "terminal event must not request another chunk");
    h.connection.close();
    h.assertReleased();
  });
}

for (const hasText of [false, true]) {
  test(`natural EOF is an interruption, ${hasText ? "after text" : "empty stream"}`, async (t) => {
    const h = harness(t);
    await h.startReader();
    if (hasText) {
      h.reads[0].resolve(chunk(event("text", { token: "first" })));
      await tick();
      assert.deepEqual(h.events, [["Text", "first"]]);
      assert.equal(h.fetchCalls[0].init.signal.aborted, false);
    }
    h.reads.at(-1).resolve({ done: true });
    await tick();
    h.connection.close();
    await tick();
    assert.deepEqual(h.events, [...(hasText ? [["Text", "first"]] : []), ["Error", "连接中断，内容尚未完成"]]);
    h.assertReleased();
  });
}

test("normal fragmented UTF-8 stream preserves event payloads and ordering", async (t) => {
  const h = harness(t);
  const branches = [{ id: "branch", label: "前进" }];
  const briefing = { encounter_id: "e1", session_id: "test", name: "遭遇", approaches: [{ id: "fight", label: "战斗", hint: "准备", kind: "combat" }] };
  const segments = [{ type: "dialogue", text: "走吧", speaker: "临光" }];
  const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
  const trigger = { encounter_id: "e1", session_id: "test" };
  const roll = { attribute: "strength", character: "玩家", roll: 12, modifier: 1, total: 13, dc: 10, success: true, text: "成功", source: "story", stream_id: "s1" };
  await h.startReader();
  const stream = ": heartbeat\n\ndata: malformed\n\n" + event("text", { token: "你好" })
    + event("choice", { options: ["前进"], branches }) + event("combat_briefing", briefing)
    + event("text", { token: "！" }) + event("reasoning", { token: "思考" })
    + event("scene_event", { location: "street" }) + event("memory_event", { id: "m1" })
    + event("dialogue_segments", { segments }) + event("token_usage", { usage })
    + event("combat_trigger", trigger) + event("attribute_roll", roll);
  // Byte-sized fragments exercise both partial SSE lines and partial UTF-8 code points.
  for (const byte of encoder.encode(stream)) {
    h.reads.at(-1).resolve({ done: false, value: Uint8Array.of(byte) });
    await tick();
    assert.equal(h.fetchCalls[0].init.signal.aborted, false, "nonterminal/background stream remains open");
    assert.equal(h.counts.cancel, 0);
  }
  assert.deepEqual(h.events, [
    ["Text", "你好"], ["Choice", ["前进"], branches], ["CombatBriefing", briefing], ["Text", "！"],
    ["Reasoning", "思考"], ["SceneEvent", { location: "street" }], ["MemoryEvent", { id: "m1" }],
    ["DialogueSegments", segments], ["TokenUsage", usage], ["CombatTrigger", trigger], ["AttributeRoll", roll],
  ]);
  h.reads.at(-1).resolve(chunk(event("done")));
  await tick();
  assert.deepEqual(h.events.at(-1), ["Done", {}]);
  h.assertReleased();
});

test("正文完成事件保留权威文本，最终事件携带实际回合", async (t) => {
  const h = harness(t);
  await h.startReader();
  const meta = { stream_id: "narr-1" };
  const complete = { stream_id: "narr-1", narrative: "检定成功。\n妮可说：「它在等。」" };
  const done = { stream_id: "narr-1", round: 7, phase2_status: "degraded" };
  h.reads[0].resolve(chunk(event("meta", meta) + event("text", {token:"它在等。"}) + event("text_complete", complete)));
  await tick();
  assert.deepEqual(h.events, [["Meta", meta], ["Text", "它在等。"], ["TextComplete", complete]]);
  assert.equal(h.counts.cancel, 0, "text_complete does not close phase two");
  h.reads.at(-1).resolve(chunk(event("done", done)));
  await tick();
  assert.deepEqual(h.events.at(-1), ["Done", done]);
  h.assertReleased();
});

for (const stage of ["base", "fetch", "text", "read", "missing-body"]) {
  test(`active ${stage} failure notifies error once without done`, async (t) => {
    const h = harness(t, { ok: stage !== "text", noBody: stage === "missing-body" });
    if (stage === "base") h.base.reject(new Error("failed"));
    else {
      await h.startFetch();
      if (stage === "fetch") h.fetched.reject(new Error("failed"));
      else {
        h.fetched.resolve(h.response);
        await tick();
        if (stage === "text") h.text.resolve('{"error":"failed"}');
        if (stage === "read") h.reads[0].reject(new Error("failed"));
      }
    }
    await tick();
    assert.deepEqual(h.events, [["Error", stage === "missing-body" ? "No reader" : "failed"]]);
    if (stage !== "base") assert.equal(h.fetchCalls[0].init.signal.aborted, true);
    if (stage === "read") h.assertReleased();
  });
}

test("reader cancellation rejection does not leak an unhandled rejection or repeat completion", async (t) => {
  const h = harness(t, { cancel: () => Promise.reject(new Error("cancel failed")) });
  await h.startReader();
  h.reads[0].resolve(chunk(event("done") + event("done")));
  await tick();
  assert.deepEqual(h.events, [["Done", {}]]);
  h.assertReleased();
});

test("native stream cancellation releases its lock and settles a pending read silently", async (t) => {
  const h = harness(t);
  let cancelled = 0;
  h.response.body = new ReadableStream({ cancel() { cancelled++; } });
  await h.startFetch();
  h.fetched.resolve(h.response);
  await tick();
  assert.equal(h.response.body.locked, true);
  h.connection.close();
  await tick();
  assert.deepEqual(h.events, []);
  assert.equal(cancelled, 1);
  assert.equal(h.response.body.locked, false);
  assert.equal(h.fetchCalls[0].init.signal.aborted, true);
});
