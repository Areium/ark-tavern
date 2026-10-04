// Run: node scripts/test_session_graph_ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const fromFrontend = createRequire(path.join(root, 'frontend/package.json'));
const ts = fromFrontend('typescript');
require.extensions['.css'] = () => {};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText, filename);
};
const src = file => path.join(root, 'frontend/src', file);
const { sessionPlotFlow, sessionGraphDocument, sessionGraphProgress, applySessionGraphPositions, sessionPositionKey } = require(src('utils/sessionStoryGraph.ts'));
const { importLayoutFromFlow, nodeIdentity } = require(src('components/combat/graphModel.ts'));
const beat = (id, state = 'locked') => ({ id, title: id, summary: '节拍摘要', state, round_start: null, round_end: null });
const scene = (id, extras = {}) => ({ id, parent_id: null, title: id, summary: '', children: [], branches: [], has_state: true, ...extras });
const road = (id, chapter_idx, beats, extras = {}) => ({ id, chapter_idx, title: id, kind: 'main', origin: {}, state: 'locked', beats, ...extras });
const state = { has_plot: true, plot_id:'plot', plot_name: '测试路线', roads: [road('main', 0, [beat('start', 'done'), beat('next', 'current'), beat('end')]),
  road('skipped', 1, [beat('skipped-beat')], { state: 'done', kind: 'branch' })],
  tree: { has_tree: true, current_id: 'live', path: ['live'], nodes: [scene('live', {ref_beat_id:'next'})] } };
const cue = { round: 1, beat_id: 'start', chapter_idx: 1 };
const before = JSON.stringify(state);
const doc = sessionGraphDocument(state);
const imported = importLayoutFromFlow(sessionPlotFlow(state), new Map());
assert.deepEqual(doc.nodes.map(n => [nodeIdentity(n),n.x,n.y]), imported.nodes.map(n => [nodeIdentity(n),n.x,n.y]), 'exact worldbook ordering and coordinates');
assert.equal(doc.nodes.length, 7, 'all author nodes, with no duplicate runtime section');
const graph = sessionGraphProgress(state, doc, cue);
const progress = id => graph.displays.get(doc.nodes.find(n => n.ref?.beat_id === id).id).progress;
assert.equal(progress('start'), 'current', 'avatar uses the beat actually narrated');
assert.equal(progress('next'), 'locked', 'advanced ref does not prove arrival');
assert.equal(progress('skipped-beat'), 'locked', 'chapter array index does not prove branch arrival');
assert.equal([...graph.displays.values()].filter(d=>d.progress==='current').length, 1);
assert.equal(JSON.stringify(state), before);
const invalid = sessionGraphProgress({...state,tree:{...state.tree,current_id:'missing'}},doc,cue);
assert.equal(invalid.currentId, undefined);
const noCue = sessionGraphProgress(state,doc);
assert.equal(noCue.currentId,'scene:live', 'missing stage never guesses next beat');
const rolled = sessionGraphProgress(state,doc,{...cue,beat_id:'next'});
assert.equal(rolled.doc.nodes.find(n=>n.id===rolled.currentId).ref.beat_id,'next');
const saved = {...doc,worldbook_id:'book',nodes:doc.nodes.map((n,i)=>({...n,id:'saved'+i,x:n.x+83,y:n.y+21})),edges:[],};
saved.edges=[{id:'custom',from:saved.nodes[0].id,to:saved.nodes[3].id}];
const restored = sessionGraphDocument(state,sessionPlotFlow(state),saved);
assert.deepEqual(restored,saved,'saved author positions and custom edges preserved');
const partial = {...saved,nodes:saved.nodes.slice(0,3),edges:[]};
const completed = sessionGraphDocument(state,sessionPlotFlow(state),partial);
assert.equal(completed.nodes.length,doc.nodes.length,'saved partial map still shows all author nodes');
assert.deepEqual(completed.nodes.slice(0,3),partial.nodes);
const key=nodeIdentity(doc.nodes[2]);
const moved=applySessionGraphPositions(restored,{[key]:{x:45,y:96},[nodeIdentity(doc.nodes[3])]:{x:NaN,y:12}});
assert.equal(moved.nodes[2].x,45);assert.equal(moved.nodes[3].x,restored.nodes[3].x);
assert.deepEqual(moved.edges,restored.edges);
assert.equal(sessionPositionKey({id:'scene:a',type:'beat'}),'scene:a');
const dynamic = sessionGraphProgress({has_plot:true,roads:[],tree:{has_tree:true,current_id:'b',nodes:[scene('a'),scene('b',{parent_id:'a'}),scene('c',{has_state:false})]}},sessionGraphDocument({has_plot:true,roads:[]}));
assert.equal(dynamic.doc.nodes.length,3);assert.equal(dynamic.doc.edges.length,1);assert.equal(dynamic.currentId,'scene:b');
assert.equal(dynamic.displays.get('scene:c').progress,'locked');
const deep=Array.from({length:12000},(_,i)=>scene('deep'+i,{parent_id:i?'deep'+(i-1):null}));
assert.equal(sessionGraphProgress({has_plot:true,roads:[],tree:{has_tree:true,current_id:'deep11999',nodes:deep}},sessionGraphDocument({has_plot:true,roads:[]})).doc.nodes.length,12000);
const combatDoc={...doc,nodes:[...doc.nodes,{id:'combat',type:'combat',title:'战斗',x:42,y:360,ref:{node_id:'battle'}}]};
assert.equal(sessionGraphProgress({...state,tree:{...state.tree,nodes:[scene('live',{kind:'combat',combat_node_id:'battle'})]}},combatDoc,cue).currentId,'combat');
const combatOnlyFlow={...sessionPlotFlow(state),chapters:[],combat_nodes:['future']};
const combatOnly=sessionGraphDocument(state,combatOnlyFlow);
const combatOnlyProgress=sessionGraphProgress({...state,roads:[]},combatOnly);
assert.ok(combatOnlyProgress.doc.nodes.some(n=>n.ref?.node_id==='future'),'combat-only author graph survives runtime fallback');
for(const required of [false,true]) {
 const branchState={has_plot:true,roads:[road('main',0,[{...beat('fork'),choice_required:required,authored_branches:[{label:'岔路',target_beat_id:'side'}]},beat('next'),beat('side')])]};
 const branchDoc=sessionGraphDocument(branchState);
 const source=branchDoc.nodes.find(n=>n.ref?.beat_id==='fork').id;
 const next=branchDoc.nodes.find(n=>n.ref?.beat_id==='next').id;
 assert.equal(branchDoc.edges.some(e=>e.from===source&&e.to===next),!required,'shared optional/required exits remain correct');
}

const React=fromFrontend('react');
const {renderToStaticMarkup:render}=fromFrontend('react-dom/server');
const GraphCanvas=require(src('components/combat/GraphCanvas.tsx')).default;
const noop=()=>{};
const props={doc,view:{x:0,y:0,zoom:.25},selected:null,onSelect:noop,onDocChange:noop,onViewChange:noop,
 displays:graph.displays,onOpenNode:noop,onRequestDeleteNode:noop,onCreateCombat:noop,onAddBeat:noop,onAddCombatNode:noop,
 availableBeats:[],availableCombats:[],onImportLayout:noop,onResetPositions:noop};
const sessionMarkup=render(React.createElement(GraphCanvas,{...props,mode:'session',renderNodeOverlay:n=>n.id===graph.currentId?React.createElement('span',{'aria-label':'当前节点角色：主角'}):null}));
assert.ok(sessionMarkup.includes('当前节点角色：主角'));
assert.equal((sessionMarkup.match(/aria-current="step"/g)||[]).length,1);
assert.ok(sessionMarkup.includes('data-ng-progress="locked"'));
assert.ok(!sessionMarkup.includes('ng-anchor')&&!sessionMarkup.includes('textarea'),'session cannot edit content/links');
assert.ok(sessionMarkup.includes('适应')&&sessionMarkup.includes('1:1'));
const editorMarkup=render(React.createElement(GraphCanvas,props));
assert.ok(editorMarkup.includes('ng-anchor'),'worldbook editor still exposes linking');
console.log('Shared worldbook layout, saved positions/edges, local overrides, arrival/rollback, combat, deep fallback and session/editor SSR passed.');
