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
const moved = {id:'b', type:'beat', title:'旧标题', ref:{chapter_idx:99, beat_id:'choose'}, x:44, y:55, scene_media:{background:{kind:'image',asset:'plots/p/art/cg.png',role:'cg',fit:'contain',position:[50,50],portraits:'hide'}}};
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

const { sceneCGPreviews, sceneAssetUrl } = require('../frontend/src/utils/sceneMedia.ts');
const { cgNodeBounds } = require('../frontend/src/components/combat/graphCG.ts');
const { fitView } = require('../frontend/src/components/combat/graphModel.ts');
const cg = moved.scene_media.background;
const media = {background: cg, events: [{id:'event', title:'Event', trigger:{kind:'enter'}, actions:[
  {kind:'set_visual',visual:cg},
  {kind:'set_visual',visual:{...cg,asset:'plots/p/art/second.png'}},
  {kind:'set_visual',visual:{...cg,role:'background',asset:'plots/p/art/bg.png'}},
  {kind:'set_visual',visual:{...cg,asset:'plots/../secret.png'}},
]}]};
assert.deepEqual(sceneCGPreviews(media).map(image => image.asset), [cg.asset, 'plots/p/art/second.png']);
assert.equal(sceneAssetUrl('plots/../secret.png', 'b'), '');
assert.ok(sceneAssetUrl(cg.asset, 'other book').startsWith('/api/worldbooks/other%20book/'));
const card = {x:100,y:200,w:192,h:80};
assert.deepEqual(cgNodeBounds(card,0),card);
const bounds = cgNodeBounds(card,2);
assert.ok(bounds.x < card.x && bounds.y < card.y && bounds.x + bounds.w > card.x + card.w);
const view = fitView([{...moved,x:card.x,y:card.y}],new Map([['b',card]]),800,600,(node,rect)=>cgNodeBounds(rect,2));
assert.ok(bounds.x*view.zoom+view.x >= 0 && bounds.y*view.zoom+view.y >= 0);
assert.ok((bounds.x+bounds.w)*view.zoom+view.x <= 800 && (bounds.y+bounds.h)*view.zoom+view.y <= 600);
console.log('CG asset deduplication, unsafe paths, book scoping and full preview fit bounds: passed.');
