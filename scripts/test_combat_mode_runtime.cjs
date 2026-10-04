// Protocol/unit checks with an in-memory frame stub, NOT browser security QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, Module } = require('node:module');
const root = path.resolve(__dirname, '..');
const fromFrontend = createRequire(path.join(root, 'frontend/package.json'));
const ts = fromFrontend('typescript');
let hooks;
require.extensions['.css'] = () => {};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const original = module.require.bind(module);
  module.require = name => name === 'react' && filename.endsWith('RuntimeFrame.tsx')
    ? new Proxy(fromFrontend('react'), { get(target, key) { return hooks?.[key] || target[key]; } }) : original(name);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};
const { encodeJson, requireSnapshot, runtimeDocument } = require('../frontend/src/features/combatModes/runtimeDocument.ts');
const RuntimeFrame = require('../frontend/src/features/combatModes/RuntimeFrame.tsx').default;

async function main() {
  assert.equal(encodeJson({ hp: 1 }), '{"hp":1}');
  for (const value of [{ hp: Infinity }, { hp: undefined }, { x: new Date() }]) assert.throws(() => encodeJson(value));
  assert.throws(() => requireSnapshot([]));
  assert.throws(() => encodeJson({ text: 'x'.repeat(1024 * 1024) }));
  assert.doesNotThrow(() => encodeJson({ entry: 'x'.repeat(2 * 1024 * 1024) }, 48 * 1024 * 1024));
  const document = runtimeDocument('a'.repeat(64));
  assert.ok(document.includes("connect-src 'none'"));
  assert.ok(document.includes("frame-src 'none'"));
  assert.ok(document.includes("form-action 'none'"));
  assert.throws(() => runtimeDocument('</script>'));
  const boot = document.match(/<script>([\s\S]*)<\/script>/)[1];
  const bootMessages = [];
  const sandbox = { parent: { postMessage: data => bootMessages.push(data) },
    TextEncoder, setInterval: () => 1, clearInterval() {}, addEventListener() {} };
  new vm.Script(boot).runInNewContext(sandbox);
  assert.equal(bootMessages[0].type, 'ready', 'generated bootstrap executes without outer closures');
  const documentPath = path.join(root, 'frontend/src/features/combatModes/runtimeDocument.ts');
  const minified = fromFrontend('esbuild').transformSync(fs.readFileSync(documentPath, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022', minify: true,
  }).code;
  const compiled = new Module(documentPath, module);
  compiled._compile(minified, documentPath);
  const productionDocument = compiled.exports.runtimeDocument('b'.repeat(64));
  new vm.Script(productionDocument.match(/<script>([\s\S]*)<\/script>/)[1]).runInNewContext(sandbox);
  assert.equal(bootMessages[1].type, 'ready', 'minified bootstrap must remain self-contained');

  const originalGlobals = { window: global.window, document: global.document,
    setInterval: global.setInterval, clearInterval: global.clearInterval };
  const frames = [], listeners = new Map(), refs = [];
  let cursor = 0, mounted = false, effect, cleanup;
  const container = { appendChild(frame) { frames.push(frame); } };
  const errors = [], saves = [], completions = [];
  global.window = { addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  global.document = { createElement(tag) {
    assert.equal(tag, 'iframe');
    return { attributes: {}, messages: [], removed: false, contentWindow: {
      postMessage(data) { frames.at(-1).messages.push(data); },
    }, setAttribute(key, value) { this.attributes[key] = value; }, remove() { this.removed = true; } };
  } };
  global.setInterval = () => 1; global.clearInterval = () => {};
  hooks = {
    useRef(value) { const index = cursor++; return refs[index] ||= { current: value === null ? container : value }; },
    useId() { return 'runtime-test'; }, useState(value) { return [value, () => {}]; },
    useEffect(fn) { if (!mounted) effect = fn; },
  };
  const props = { bundle: { abi: 'ark-combat/1', id: 'test-mode', name: 'Test', version: '1.0.0',
      digest: 'a'.repeat(64), entry: Buffer.from('export default function(){}').toString('base64'), resources: {} },
    runId: 'run-one', input: {}, snapshot: null,
    onSnapshot: async value => saves.push(value), onComplete: async (...args) => completions.push(args),
    onError: text => errors.push(text) };
  function render(value) {
    cursor = 0;
    const element = RuntimeFrame(value); element.type(element.props);
    if (!mounted) { mounted = true; cleanup = effect(); }
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    render(props);
    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.equal(frame.attributes.sandbox, 'allow-scripts');
    assert.equal(frame.referrerPolicy, 'no-referrer');
    const token = frame.srcdoc.match(/const token = '([a-f0-9]+)'/)[1];
    const receive = (data, source = frame.contentWindow) => listeners.get('message')?.({ source,
      data: { abi: 'ark-combat/1', token, ...data } });
    receive({ type: 'ready' }, {});
    assert.equal(frame.messages.length, 0, 'spoofed source must not initialize the script');
    receive({ type: 'ready', token: 'bad' });
    assert.equal(frame.messages.length, 0);
    receive({ type: 'ready' });
    assert.equal(frame.messages[0].type, 'init');
    receive({ type: 'started' });
    receive({ type: 'save', requestId: '1', snapshot: { turn: 1 } });
    await flush();
    assert.deepEqual(saves, [{ turn: 1 }]);
    assert.equal(frame.messages.at(-1).ok, true);
    render({ ...props, snapshot: { turn: 1 }, onSnapshot: async value => saves.push({ updated: value }) });
    assert.equal(frames.length, 1, 'callback/snapshot rerender must not restart script');
    receive({ type: 'save', requestId: '2', snapshot: { turn: 2 } });
    await flush();
    assert.deepEqual(saves[1], { updated: { turn: 2 } });
    receive({ type: 'complete', requestId: '3', outcome: 'victory', snapshot: { turn: 3 } });
    await flush();
    assert.deepEqual(completions, [['victory', { turn: 3 }]]);
    assert.equal(frame.removed, true);
    assert.deepEqual(errors, []);
    cleanup(); refs.length = 0; mounted = false;
    render({ ...props, runId: 'run-two', onSnapshot: async () => { throw new Error('disk full'); } });
    const failedFrame = frames.at(-1);
    const failedToken = failedFrame.srcdoc.match(/const token = '([a-f0-9]+)'/)[1];
    const failedReceive = data => listeners.get('message')?.({ source: failedFrame.contentWindow,
      data: { abi: 'ark-combat/1', token: failedToken, ...data } });
    failedReceive({ type: 'ready' }); failedReceive({ type: 'started' });
    failedReceive({ type: 'save', requestId: '1', snapshot: { turn: 1 } });
    await flush();
    assert.equal(failedFrame.messages.at(-1).ok, false, 'save failure must not receive success acknowledgement');
    assert.equal(failedFrame.removed, true, 'save failure closes the runtime');
    assert.deepEqual(errors, ['disk full']);
    failedReceive({ type: 'complete', requestId: '2', outcome: 'victory', snapshot: {} });
    await flush();
    assert.equal(completions.length, 1, 'closed runtime cannot complete');
  } finally {
    cleanup?.();
    Object.assign(global, originalGlobals);
  }
  console.log('Combat runtime JSON, bootstrap and source/token/RPC lifecycle checks passed (not browser QA).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
