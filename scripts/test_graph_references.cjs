const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../frontend/node_modules/typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const { resolveGraphReference: resolve, repairGraphReferences: repair, graphEdgeDescription: describe } = require('../frontend/src/components/combat/graphReferences.ts');
const { importLayoutFromFlow, GraphHistory } = require('../frontend/src/components/combat/graphModel.ts');
const plot = { plot_id: 'p', name: '故事', worldbook_id: 'b', source: 'outline', combat_nodes: [], chapters: [
  { idx: 1, id: 'c1', title: '入口', label: '入口', kind: 'main', combat_nodes: [], beats: [
    { id: 'choose', title: '抉择', summary: '摘要', combat_nodes: [], branches: [{label: '用钥匙开门', intent: '保留证据', target_beat_id: 'door'}] },
  ]},
  { idx: 2, id: 'c2', title: '终点', label: '终点', kind: 'branch', combat_nodes: [], beats: [{id:'door', title:'门后', combat_nodes: []}] },
]};
const moved = {id:'b', type:'beat', title:'旧标题', ref:{chapter_idx:99, beat_id:'choose'}, x:44, y:55, scene_media:{cg_url:'/api/assets/plots/p/art/cg.png'}};
assert.equal(resolve(moved, plot).beat.id, 'choose');
assert.equal(resolve(moved, plot).moved, true);
const doc = {schema_version:1, plot_id:'p', nodes:[moved], edges:[]};
const result = repair(doc, plot);
assert.equal(result.repaired, 1);
assert.equal(result.doc.nodes[0].ref.chapter_idx, 1);
assert.equal(moved.ref.chapter_idx, 99, 'repair is immutable');
assert.deepEqual(result.doc.nodes[0].scene_media, moved.scene_media);
assert.equal(result.doc.nodes[0].x, 44);
const history = new GraphHistory(); history.commit(doc, result.doc);
assert.equal(history.undo(result.doc).nodes[0].ref.chapter_idx, 99);
assert.equal(resolve({...moved, ref:{beat_id:'deleted'}}, plot).missing, true);
assert.equal(resolve(moved, {...plot, chapters:[...plot.chapters, {...plot.chapters[0],idx:3}]}).missing, true, 'ambiguous references never guessed');
const layout = importLayoutFromFlow(plot, new Map());
const from = layout.nodes.find(n => n.ref?.beat_id === 'choose');
const to = layout.nodes.find(n => n.type === 'chapter' && n.ref?.chapter_idx === 2);
assert.ok(layout.edges.some(e => e.from === from.id && e.to === to.id));
assert.equal(describe(layout, plot, from.id, to.id), '用钥匙开门 · 保留证据');
assert.equal(describe(layout, plot, to.id, from.id), '');
assert.equal(new Set(layout.edges.map(e => e.id)).size, layout.edges.length);
console.log('Graph references, undo, preserved CG and authored edges: passed.');
