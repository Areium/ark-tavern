import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/utils/gridCombatResources.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { gridSpineActor, gridSpineResource, gridSpineFileUrl, gridUnitResourceKey, createGridResourceLoadGuard } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const player = (overrides = {}) => ({ team: 'player', name: '同一个显示名', character_id: 'original_id',
  worldbook_id: 'book_a', avatar_url: '/avatar?worldbook_id=book_a', ...overrides });

test('players sharing a display name resolve their original character directories', () => {
  const registries = new Map([['book_a', { original_id: 'first/skin_1', other_id: 'second/skin_2', 同一个显示名: 'wrong_model' }]]);
  const first = gridSpineResource(player(), registries);
  const second = gridSpineResource(player({ character_id: 'other_id' }), registries);
  assert.equal(first.characterId, 'original_id');
  assert.equal(first.variant, 'first/skin_1');
  assert.equal(second.characterId, 'other_id');
  assert.equal(second.variant, 'second/skin_2');
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.notEqual(gridUnitResourceKey(player()), gridUnitResourceKey(player({ character_id: 'other_id' })));
  assert.deepEqual(gridSpineResource(player({ name: '改过的显示名' }), registries), first);
  assert.equal(gridUnitResourceKey(player({ name: '改过的显示名' })), gridUnitResourceKey(player()));
});

test('ownerless actors and built-in trainers never search a display-name registry', () => {
  const registries = new Map([['book_a', { 同一个显示名: 'must_not_load' }], ['', { 同一个显示名: 'also_wrong' }]]);
  for (const unit of [player({ character_id: '' }), player({ worldbook_id: '' }),
    player({ team: 'enemy', worldbook_id: '' })]) {
    assert.equal(gridSpineActor(unit), null);
    assert.equal(gridSpineResource(unit, registries), null);
  }
});

test('same character ID is isolated by owner in lookup, positive and negative cache keys', () => {
  const registries = new Map([['book_a', { original_id: 'shared_skin' }], ['book_b', { original_id: 'shared_skin' }]]);
  const a = gridSpineResource(player(), registries);
  const b = gridSpineResource(player({ worldbook_id: 'book_b' }), registries);
  assert.notEqual(a.cacheKey, b.cacheKey);
  const failed = new Set([a.cacheKey]);
  assert.equal(failed.has(b.cacheKey), false);
  assert.equal(gridSpineResource(player({ worldbook_id: 'missing_book' }), registries), null);
  assert.equal(gridSpineResource(player({ worldbook_id: 'book_b' }), new Map([['book_a', { original_id: 'skin' }]])), null);
});

test('enemies resolve only their owners name mapping and use Back assets', () => {
  const unit = player({ team: 'enemy', character_id: '', name: '敌兵', worldbook_id: 'enemy_book' });
  const registries = new Map([['book_a', { 敌兵: 'wrong' }], ['enemy_book', { 敌兵: 'enemy/soldier' }]]);
  const resource = gridSpineResource(unit, registries);
  assert.equal(resource.characterId, '敌兵');
  assert.equal(resource.variant, 'enemy/soldier');
  assert.equal(resource.dir, 'Back');
  assert.equal(resource.bookId, 'enemy_book');
});

test('atlas, skel and nested texture URLs append an encoded owner after the entire filename', () => {
  const unit = player({ character_id: '角色 & 1', worldbook_id: '书 & 2' });
  const resource = gridSpineResource(unit, new Map([['书 & 2', { '角色 & 1': 'character/outfit_3' }]]));
  assert.equal(resource.fileName, 'outfit_3');
  for (const file of ['outfit_3.atlas', 'outfit_3.skel', 'textures/贴图 1.png']) {
    const raw = gridSpineFileUrl(resource, file);
    const url = new URL(raw, 'http://localhost');
    assert.equal(decodeURIComponent(url.pathname), `/api/assets/characters/角色 & 1/spine/character/outfit_3/Front/${file}`);
    assert.equal(url.searchParams.get('worldbook_id'), '书 & 2');
    assert.deepEqual([...url.searchParams.keys()], ['worldbook_id']);
    assert.equal(url.hash, '');
    assert.equal(raw.split('?').length, 2);
  }
});

test('atlas texture paths cannot traverse or inject a different owner', () => {
  const resource = gridSpineResource(player(), new Map([['book_a', { original_id: 'skin' }]]));
  for (const file of ['../other.png', '/root.png', 'tex/../../other.png', 'image.png?worldbook_id=evil',
    'image.png#fragment', 'tex\\image.png', 'tex//image.png']) {
    assert.throws(() => gridSpineFileUrl(resource, file), /无效的模型文件路径/);
  }
  for (const character_id of ['..', '.', '../other', 'one/two', 'one\\two']) {
    assert.equal(gridSpineActor(player({ character_id })), null);
  }
});

test('unit resource identity changes for owner, avatar, actor and team, not ordinary HP updates', () => {
  const base = gridUnitResourceKey(player());
  for (const change of [{ worldbook_id: 'book_b' }, { character_id: 'new_actor' }, { avatar_url: '/new.png' }, { team: 'enemy' }]) {
    assert.notEqual(gridUnitResourceKey(player(change)), base);
  }
  assert.equal(gridUnitResourceKey(player({ hp: 1, pos: [4, 5] })), base);
});

test('late old loads cannot replace or clear a new A -> B -> A request for the same unit ID', async () => {
  const guard = createGridResourceLoadGuard();
  const a = gridUnitResourceKey(player());
  const b = gridUnitResourceKey(player({ character_id: 'replacement' }));
  const old = guard.begin('player_1', a);
  let resolveOld;
  const late = new Promise(resolve => { resolveOld = resolve; }).then(() => {
    const mayMount = guard.isCurrent(old);
    guard.finish(old);
    return mayMount;
  });
  guard.cancel('player_1');
  const middle = guard.begin('player_1', b);
  guard.cancel('player_1');
  const current = guard.begin('player_1', a);
  resolveOld();
  assert.equal(await late, false);
  assert.equal(guard.isCurrent(middle), false);
  assert.equal(guard.get('player_1'), current);
  guard.finish(current);
  assert.equal(guard.get('player_1'), undefined);
});

test('scene disposal invalidates all pending loads even if the next scene reuses unit identities', () => {
  const guard = createGridResourceLoadGuard();
  const first = guard.begin('same_id', gridUnitResourceKey(player()));
  const other = guard.begin('other_id', gridUnitResourceKey(player()));
  guard.clear();
  const next = guard.begin('same_id', first.resourceKey);
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(other), false);
  guard.finish(first);
  assert.equal(guard.isCurrent(next), true);
});
