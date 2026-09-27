import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/utils/spineVariants.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { loadSpineVariants, hasSpineVariant } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

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
