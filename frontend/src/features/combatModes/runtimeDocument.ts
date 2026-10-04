export const ABI = 'ark-combat/1' as const
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_INIT_BYTES = 48 * 1024 * 1024
export const MAX_ERROR_LENGTH = 512

/** Self-contained: the same validator is embedded in the opaque-origin document. */
export function encodeJson(value: unknown, maxBytes = 1024 * 1024): string {
  let budget = maxBytes
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64 || --budget < 0) throw new Error('JSON exceeds runtime limits')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item === 'string') {
      budget -= item.length
      if (budget < 0) throw new Error('JSON exceeds runtime limits')
      return
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error('Invalid JSON value')
    const proto = Object.getPrototypeOf(item)
    if (Array.isArray(item) && proto !== Array.prototype) throw new Error('Expected plain JSON array')
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('Expected plain JSON')
    ancestors.add(item)
    const keys = Reflect.ownKeys(item)
    if (Array.isArray(item) && keys.length !== item.length + 1) throw new Error('Invalid JSON array')
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string') throw new Error('Invalid JSON key')
      if (Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new Error('Invalid JSON array key')
      budget -= key.length
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid JSON property')
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error('JSON exceeds byte limit')
  return encoded
}

export function requireSnapshot(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Snapshot must be a JSON object')
  encodeJson(value)
}

export function runtimeDocument(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid runtime token')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>战斗脚本</title><style>html,body{margin:0;min-height:100%;background:#10151d;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif}*{box-sizing:border-box}#root{min-height:100vh;padding:16px}button,input,select{font:inherit}:focus-visible{outline:2px solid #7dd3fc;outline-offset:3px}</style></head>
<body><main id="root" tabindex="-1" aria-label="战斗内容"></main><script>
(() => {
  'use strict';
  const token = '${token}', abi = 'ark-combat/1';
  const encodeJson = ${encodeJson.toString()};
  const requireSnapshot = value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Snapshot must be a JSON object');
    encodeJson(value);
  };
  let initialized = false, stopped = false, sequence = 0, queue = Promise.resolve(), pending = null;
  let heartbeat;
  const send = (type, fields = {}) => {
    const message = { abi, token, type, ...fields };
    encodeJson(message);
    parent.postMessage(message, '*');
  };
  const fail = (error) => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    const message = String(error instanceof Error ? error.message : error).slice(0, 512);
    if (pending) { pending.reject(new Error(message)); pending = null; }
    send('error', { message });
  };
  const rpc = (type, snapshot, outcome) => {
    let frozen;
    try { requireSnapshot(snapshot); frozen = JSON.parse(encodeJson(snapshot)); }
    catch (error) { fail(error); return Promise.reject(error); }
    const operation = queue.then(() => {
      if (stopped) throw new Error('Runtime stopped');
      return new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        pending = { requestId, resolve, reject, type };
        try { send(type, { requestId, snapshot: frozen, ...(type === 'complete' ? { outcome } : {}) }); }
        catch (error) { fail(error); }
      });
    });
    queue = operation.catch(error => { fail(error); });
    return operation;
  };
  addEventListener('error', event => fail(event.message));
  addEventListener('unhandledrejection', event => fail(event.reason));
  addEventListener('message', async event => {
    if (event.source !== parent || stopped) return;
    const message = event.data;
    if (!message || message.abi !== abi || message.token !== token) return;
    try {
      encodeJson(message, message.type === 'init' && !initialized ? 48 * 1024 * 1024 : 1024 * 1024);
      if (message.type === 'init' && !initialized) {
        initialized = true;
        requireSnapshot(message.input);
        if (message.snapshot !== null) requireSnapshot(message.snapshot);
        heartbeat = setInterval(() => send('heartbeat'), 1000);
        const module = await import('data:text/javascript;base64,' + message.entry);
        if (stopped) return;
        if (typeof module.default !== 'function') throw new Error('Script must export a default function');
        send('started');
        await module.default(Object.freeze({
          root: document.getElementById('root'), input: message.input, snapshot: message.snapshot,
          resources: Object.freeze(message.resources),
          save: snapshot => rpc('save', snapshot),
          complete: (outcome, snapshot) => {
            if (!['victory', 'defeat', 'retreat'].includes(outcome)) {
              const error = new Error('Invalid outcome'); fail(error); return Promise.reject(error);
            }
            return rpc('complete', snapshot, outcome);
          }
        }));
      } else if (message.type === 'ack' && initialized && pending && message.requestId === pending.requestId) {
        const request = pending;
        pending = null;
        if (message.ok === true) {
          if (request.type === 'complete') { stopped = true; clearInterval(heartbeat); }
          request.resolve();
        } else if (message.ok === false && typeof message.error === 'string' && message.error.length <= 512) {
          request.reject(new Error(message.error)); fail(message.error);
        } else throw new Error('Invalid acknowledgement');
      } else throw new Error('Unexpected parent message');
    } catch (error) { fail(error); }
  });
  send('ready');
})();
</script></body></html>`
}
