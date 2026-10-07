import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

async function moduleAt(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { paginatePreview, graphemes, canonicalOffset, isJsonPreview, resolveReading, readingKey, rememberReading, cachedReading } = await moduleAt('./stageReading.ts');
const { buildStageScript, stepsForMessage } = await moduleAt('./stageScript.ts');
const names = ['临光', '瑕光'];
const make = (content, extra = {}) => buildStageScript([{ role: 'narrator', content, generationId: 'g1', ...extra }], names, '博士');

test('preview has fixed 140-grapheme boundaries and lossless UTF-16 offsets', () => {
  const input = '甲'.repeat(139) + '👨‍👩‍👧‍👦' + 'e\u0301' + '🇨🇳' + '乙'.repeat(142);
  const pages = paginatePreview(input);
  assert.equal(pages[0].text, '甲'.repeat(139) + '👨‍👩‍👧‍👦');
  assert.equal(pages.map(p => p.text).join(''), input);
  for (const page of pages) {
    assert.ok(graphemes(page.text).length <= 140);
    assert.equal(input.slice(page.sourceStart, page.sourceEnd), page.text);
  }
  for (let count = 141; count <= graphemes(input).length; count++) {
    const prefix = graphemes(input).slice(0, count).map(x => x.segment).join('');
    const received = paginatePreview(prefix);
    assert.deepEqual(received.slice(0, -1), pages.slice(0, received.length - 1));
  }
  assert.deepEqual(paginatePreview(''), []);
  assert.equal(paginatePreview('字'.repeat(140)).length, 1);
  assert.equal(paginatePreview('字'.repeat(141)).length, 2);
  assert.throws(() => paginatePreview('x', 0), RangeError);
});

test('growing last page never moves current page; received End is not success', () => {
  const first = make('甲'.repeat(141), { generationPhase: 'receiving', streaming: true });
  const key = readingKey('s1', first.key);
  const initial = resolveReading(first, key);
  const later = make('甲'.repeat(421), { generationPhase: 'receiving', streaming: true });
  assert.equal(resolveReading(later, key, initial.cursor).cursor.step, 0);
  assert.equal(later.preview, true);
  assert.equal(later.phase, 'receiving');
  assert.equal(later.steps.length, 4);
});

test('repeated sentences get sequential anchors, and split pages retain exact offsets', () => {
  const content = '临光：「等等。」瑕光：「等等。」' + '雨'.repeat(300);
  const steps = stepsForMessage({ role: 'narrator', content }, names, '博士');
  assert.equal(steps[0].sourceStart, content.indexOf('等等。'));
  assert.equal(steps[1].sourceStart, content.lastIndexOf('等等。'));
  assert.ok(steps[1].sourceStart > steps[0].sourceEnd);
  for (const step of steps) assert.equal(content.slice(step.sourceStart, step.sourceEnd), step.text);
  assert.equal(steps.slice(2).map(step => step.text).join(''), '雨'.repeat(300));
});

test('only adjacent known same-speaker lines merge within capacity', () => {
  const same = stepsForMessage({ role: 'narrator', content: '临光：「一。」「二。」' }, names, '博士');
  assert.equal(same.length, 1);
  assert.equal(same[0].text, '一。\n二。');
  for (const content of ['临光：「一。」瑕光：「二。」', '「一。」「二。」', '临光：「一。」门开了。「二。」']) {
    assert.ok(stepsForMessage({ role: 'narrator', content }, names, '博士').length >= 2);
  }
  const long = stepsForMessage({ role: 'narrator', content: `临光：「${'甲'.repeat(100)}」「${'乙'.repeat(100)}」` }, names, '博士');
  assert.equal(long.length, 2);
});

test('completion uses exact prefix offset and lands fully revealed without jumping to end', () => {
  const raw = '甲'.repeat(300) + '尾声';
  const preview = make(raw, { generationPhase: 'processing', streaming: true, previewContent: raw });
  const key = readingKey('s1', preview.key);
  const old = { ...resolveReading(preview, key).cursor, step: 1, sourceStart: 140, readRanges: [{ start: 0, end: 280 }] };
  const canonical = '新增前缀。' + raw;
  const final = make(canonical, { generationPhase: 'complete', previewContent: raw });
  const result = resolveReading(final, key, old);
  assert.equal(result.cursor.mode, 'formal');
  assert.equal(result.cursor.step, 1);
  assert.equal(result.cursor.revealed, true);
  assert.ok(result.cursor.step < result.steps.length - 1);
  assert.equal(canonicalOffset(raw, canonical, 140), 145);
  assert.equal(canonicalOffset(canonical, raw, 145), 140);
  assert.equal(canonicalOffset(canonical, raw, 2), 0, 'removed prefix maps to first remaining prose');
  assert.equal(canonicalOffset(raw, '改写' + raw.slice(20), 140), null);
});

test('preview read ranges reveal subsequent formal lines but do not mark End-skipped pages read', () => {
  const raw = '临光：「第一句。」瑕光：「第二句。」' + '甲'.repeat(500);
  const preview = make(raw, { generationPhase: 'receiving', streaming: true });
  const key = readingKey('ranges', preview.key);
  const first = resolveReading(preview, key);
  const end = resolveReading(preview, key, { ...first.cursor, step: 3, sourceStart: 420 });
  assert.deepEqual(end.cursor.readRanges, [{ start: 0, end: 140 }, { start: 420, end: raw.length }]);
  const final = make(raw, { generationPhase: 'complete', previewContent: raw });
  const landed = resolveReading(final, key, first.cursor);
  const second = resolveReading(final, key, { ...landed.cursor, step: 1, revealed: false });
  assert.equal(second.cursor.revealed, true, 'second line was visible in first preview page');
  const fromEnd = resolveReading(final, key, end.cursor);
  const unseenStep = final.steps.findIndex(step => step.sourceStart >= 140 && step.sourceEnd <= 420);
  assert.ok(unseenStep >= 0);
  const unseen = resolveReading(final, key, { ...fromEnd.cursor, step: unseenStep, revealed: false });
  assert.equal(unseen.cursor.revealed, false, 'unseen middle region still uses normal reading');
});

test('completion while unmounted uses final accumulated raw, not an earlier partial snapshot', () => {
  const partial = '甲'.repeat(160);
  const raw = partial + '乙'.repeat(160);
  const oldScript = make(partial, { generationPhase: 'receiving', streaming: true });
  const key = readingKey('s1', oldScript.key);
  rememberReading({ ...resolveReading(oldScript, key).cursor, step: 1, sourceStart: 140 });
  const final = make('前缀' + raw, { generationPhase: 'complete', previewContent: raw });
  const result = resolveReading(final, key, cachedReading(key));
  assert.equal(result.cursor.mode, 'formal');
  assert.equal(result.cursor.step, 1);
  assert.equal(result.cursor.revealed, true);
  assert.equal(resolveReading(final, readingKey('s2', final.key), cachedReading(key)).cursor.step, 0);
  assert.equal(resolveReading({ ...final, key: 'retry' }, readingKey('s1', 'retry'), cachedReading(key)).cursor.step, 0);
});

test('unreliable canonical or segment anchors retain complete plain preview for the generation', () => {
  const raw = '甲'.repeat(300);
  const preview = make(raw, { generationPhase: 'receiving' });
  const key = readingKey('s1', preview.key);
  const cursor = { ...resolveReading(preview, key).cursor, step: 1, sourceStart: 140 };
  for (const final of [
    make('无法对应的正文', { generationPhase: 'complete', previewContent: raw }),
    make(raw, { generationPhase: 'complete', previewContent: raw, dialogueSegments: [{ type: 'narration', text: '不存在的片段' }] }),
  ]) {
    const result = resolveReading(final, key, cursor);
    assert.equal(result.cursor.mode, 'plain');
    assert.equal(result.cursor.step, 1);
    assert.equal(result.steps.map(x => x.text).join(''), raw);
    assert.equal(resolveReading(final, key, result.cursor).cursor.mode, 'plain');
  }
});

test('JSON is withheld, processing canonical prose appears, request errors do not replace it', () => {
  for (const raw of ['  {"text":', '\n[', '```json\n{']) assert.equal(isJsonPreview(raw), true);
  assert.equal(make('{"text":', { generationPhase: 'receiving' }).steps.length, 0);
  const processing = make('权威正文', { generationPhase: 'processing', previewContent: '{"text":"权威正文"}' });
  assert.equal(processing.steps[0].text, '权威正文');
  assert.equal(make('无 token 的权威正文', {generationPhase:'processing',previewContent:''}).steps[0].text, '无 token 的权威正文');
  assert.equal(isJsonPreview('[窗边的灯光]'), false);
  const failed = buildStageScript([
    { role: 'narrator', content: '保留正文', generationId: 'g1', generationPhase: 'error' },
    { role: 'system', content: '错误信息', requestError: true, generationId: 'g1' },
  ], names, '博士');
  assert.equal(failed.steps[0].text, '保留正文');
  assert.equal(failed.phase, 'error');
});

test('variant and explicit rollback reset cursors while keeping generation event association', () => {
  const message={role:'narrator',content:'妮可说：「完整发言。」',generationId:'variants',generationPhase:'complete'};
  const roll={role:'system',content:'检定成功',generationId:'variants',rollData:{}};
  const original=buildStageScript([message,roll],['妮可'],'博士');
  const variant=buildStageScript([{...message,content:'妮可说：「新变体正文。」',variantIndex:1,previewContent:undefined,generationPhase:undefined},roll],['妮可'],'博士');
  assert.equal(variant.messageIndex,0);
  assert.equal(variant.steps[0].text,'新变体正文。');
  assert.notEqual(original.key,variant.key);
  const rollback=buildStageScript([{...message,playbackRevision:1},roll],['妮可'],'博士');
  assert.notEqual(original.key,rollback.key);
});

test('beforeText attribute roll remains status throughout tokens and completion without crossing later messages', () => {
  const roll = { role: 'system', content: '检定成功', rollData: { result: 'success' }, generationId: 'g1' };
  for (const phase of ['receiving', 'processing', 'complete']) {
    const message = { role: 'narrator', content: phase === 'receiving' ? '' : '权威正文', previewContent: phase === 'receiving' ? '即时正文' : '权威正文', generationId: 'g1', generationPhase: phase };
    const script = buildStageScript([message, roll], names, '博士');
    assert.equal(script.messageIndex, 0);
    assert.equal(script.steps[0].text, phase === 'receiving' ? '即时正文' : '权威正文');
    const laterUser = buildStageScript([message, roll, { role: 'user', content: '下一轮' }], names, '博士');
    assert.equal(laterUser.messageIndex, 2);
    const unrelated = buildStageScript([message, { role: 'system', content: '独立事件', generationId: 'other' }], names, '博士');
    assert.equal(unrelated.messageIndex, 1);
  }
});
