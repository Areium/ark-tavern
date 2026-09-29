import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/utils/spineVariants.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { loadSpineVariants, hasSpineVariant, createSpineVariantCache } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('empty content directory has no built-in actor mappings', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ variants: {} }) });
  try {
    const result = await loadSpineVariants();
    assert.equal(Object.keys(result).length, 0);
    assert.equal(hasSpineVariant('临光', result), false);
    assert.equal(hasSpineVariant('toString', result), false);
  } finally { globalThis.fetch = original; }
});

test('a later battle reads newly installed mappings without a stale registry cache', async () => {
  const original = globalThis.fetch;
  let installed = false, requests = 0;
  globalThis.fetch = async url => {
    assert.equal(url, '/api/assets/spine-variants'); requests++;
    return { ok: true, json: async () => ({ variants: installed ? { '旅者': 'traveler/outfit_1' } : {} }) };
  };
  try {
    assert.equal(hasSpineVariant('旅者', await loadSpineVariants()), false);
    installed = true;
    const result = await loadSpineVariants();
    assert.equal(hasSpineVariant('旅者', result), true);
    assert.equal(result['旅者'], 'traveler/outfit_1');
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

test('untrusted paths cannot escape the character asset directory', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ variants: { good: 'model/skin-1', traversal: '../private', url: 'https://host/model', invalid: 12 } }) });
  try { assert.deepEqual(Object.keys(await loadSpineVariants()), ['good']); }
  finally { globalThis.fetch = original; }
});

test('registry errors are surfaced to renderers for an explicit fallback', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try { await assert.rejects(loadSpineVariants(), /503/); }
  finally { globalThis.fetch = original; }
});

test('scoped requests encode the owner and explicit empty owner does not broaden scope', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ variants: {} }) };
  };
  try {
    await loadSpineVariants('book & 书');
    await loadSpineVariants('');
    assert.deepEqual(urls, ['/api/assets/spine-variants?worldbook_id=book%20%26%20%E4%B9%A6',
      '/api/assets/spine-variants?worldbook_id=']);
  } finally { globalThis.fetch = original; }
});

test('scene cache coalesces concurrent reads by owner without merging same-name variants', async () => {
  const original = globalThis.fetch;
  const requests = [];
  const release = new Map();
  globalThis.fetch = url => {
    const book = new URL(url, 'http://localhost').searchParams.get('worldbook_id');
    requests.push(book);
    return new Promise(resolve => release.set(book, () => resolve({
      ok: true, json: async () => ({ variants: { same_id: `${book}/skin` } }),
    })));
  };
  try {
    const load = createSpineVariantCache();
    const a = load('book_a');
    assert.equal(load('book_a'), a);
    const b = load('book_b');
    await Promise.resolve(); // getBaseUrl settles before fetch
    assert.deepEqual(requests, ['book_a', 'book_b']); // both started before either completed
    release.get('book_b')();
    release.get('book_a')();
    assert.equal((await a).same_id, 'book_a/skin');
    assert.equal((await b).same_id, 'book_b/skin');
    assert.equal(load('book_a'), a);
    assert.deepEqual(Object.keys(await load('')), []);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});

test('registry cache lifetime is one battle and one failed owner does not poison another', async () => {
  const original = globalThis.fetch;
  let unavailable = true;
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    if (url.endsWith('book_a') && unavailable) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ variants: { actor: 'skin_1' } }) };
  };
  try {
    const load = createSpineVariantCache();
    await assert.rejects(load('book_a'), /503/);
    assert.equal((await load('book_b')).actor, 'skin_1');
    await assert.rejects(load('book_a'), /503/);
    assert.equal(requests, 2);
    unavailable = false;
    assert.equal((await createSpineVariantCache()('book_a')).actor, 'skin_1');
    assert.equal(requests, 3);
  } finally { globalThis.fetch = original; }
});
