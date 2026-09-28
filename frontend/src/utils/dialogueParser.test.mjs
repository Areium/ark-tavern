import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

async function moduleAt(file) {
  const result = await build({entryPoints:[fileURLToPath(new URL(file, import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const {parseDialogue, normalizeSegments} = await moduleAt('./dialogueParser.ts');
const {stepsForMessage} = await moduleAt('./stageScript.ts');
const names = ['临光', '瑕光', '博士', '阿米娅', '阿米', 'Ami', 'Amiya', 'Dr. Kal', 'W'];
const speakers = (text, known) => parseDialogue(text, known, names).filter(s => s.type === 'dialogue').map(s => s.speaker);

for (const [text, expected] of [
  ['临光说：「走吧。」', ['临光']],
  ['临光低声说：「走吧。」', ['临光']],
  ['临光对瑕光说：「跟上。」', ['临光']],
  ['临光低声对瑕光说：“跟上。”', ['临光']],
  ['临光对瑕光的态度让博士说：「跟上。」', [undefined]],
  ['临光没有对瑕光说：「跟上。」', [undefined]],
  ['临光看向瑕光。「跟上。」', [undefined]],
  ['博士提到了临光。风停了。「走吧。」', [undefined]],
  ['临光：「走吧。」「跟上。」', ['临光', '临光']],
  ['临光：「走吧。」门开了。「是谁？」', ['临光', undefined]],
  ['临光：「走吧。」\n\n「等等。」', ['临光', undefined]],
  ['临光：「走吧。」陌生人：「等等。」「还有我。」', ['临光', undefined, undefined]],
  ['临光：「走吧。」瑕光说：「等等。」', ['临光', '瑕光']],
  ['「走吧。」临光说道。', ['临光']],
  ['「走吧。」她看向临光。', [undefined]],
  ['「走吧。」\n瑕光说：「等等。」', [undefined, '瑕光']],
  ['阿米娅说：「走吧。」', ['阿米娅']],
  ['Amiya：「Go.」', ['Amiya']],
  ['Dr. Kal：「Go.」', ['Dr. Kal']],
  ['NEW：「Go.」', [undefined]],
]) test(text, () => assert.deepEqual(speakers(text), expected));

test('explicit local attribution overrides message default without leaving a label', () => {
  assert.deepEqual(parseDialogue('瑕光：「等等。」', '临光', names), [{type:'dialogue',text:'等等。',speaker:'瑕光'}]);
  assert.deepEqual(speakers('「走吧。」', '临光'), ['临光']);
});
test('unclosed quotes and narration are preserved', () => {
  for (const text of ['风停了。', '临光说：「走吧', '“未闭合', '']) {
    assert.equal(parseDialogue(text, undefined, names).map(s => s.text).join(''), text);
  }
});
test('structured null, empty and malformed speakers do not inherit; absent adjacent fields may', () => {
  for (const speaker of [null, '', ' ', 3, undefined]) {
    const result = normalizeSegments([{type:'dialogue',text:'一',speaker:'临光'}, {type:'dialogue',text:'二',speaker}, {type:'dialogue',text:'三'}]);
    assert.deepEqual(result.map(s => s.speaker), ['临光',undefined,undefined]);
    assert.deepEqual(normalizeSegments(result), result, 'normalization is idempotent');
  }
  assert.deepEqual(normalizeSegments([{type:'dialogue',text:'一',speaker:'临光'},{type:'dialogue',text:'二'}]).map(s => s.speaker), ['临光','临光']);
});
test('narration and invalid segments reset structured continuation', () => {
  for (const divider of [{type:'narration',text:'门开了。'}, {type:'narration',text:''}, {type:'other',text:'其他'}, null]) {
    const result = normalizeSegments([{type:'dialogue',text:'一',speaker:'临光'}, divider, {type:'dialogue',text:'二'}]);
    assert.equal(result.at(-1).speaker, undefined);
  }
});
test('stage never replaces explicit unknown with the message character', () => {
  assert.equal(stepsForMessage({role:'character',character:'临光',content:'「未知」',dialogueSegments:[{type:'dialogue',text:'未知',speaker:null}]},names,'博士')[0].speaker, undefined);
  assert.equal(stepsForMessage({role:'character',character:'临光',content:'「已知」'},names,'博士')[0].speaker, '临光');
});
