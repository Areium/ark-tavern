// Run: node scripts/test_session_graph_ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const fromFrontend = createRequire(path.join(root, 'frontend/package.json'));
const ts = fromFrontend('typescript');
require.extensions['.css'] = () => {};
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const { layoutSessionStoryGraph: layout, sessionGraphFitZoom: fitZoom,
  STORY_GRAPH_NODE_WIDTH: W, STORY_GRAPH_NODE_HEIGHT: H } = require(path.join(root, 'frontend/src/utils/sessionStoryGraph.ts'));
const beat = (id, state = 'locked') => ({ id, title: id, summary: '节拍摘要', state, round_start: null, round_end: null });
const scene = (id, ref_beat_id, extras = {}) => ({ id, ref_beat_id, ref_chapter_id: 'main', parent_id: null,
  title: id, summary: '', children: [], branches: [], has_state: true, state: 'current', ...extras });
const road = (id, chapter_idx, beats, extras = {}) => ({ id, chapter_idx, title: id, kind: 'main', origin: {}, state: 'locked', beats, ...extras });
const state = { has_plot: true, plot_name: '测试路线', roads: [road('main', 0, [beat('start', 'done'), beat('next', 'current'), beat('end')]),
  road('skipped', 1, [beat('skipped-beat')], { state: 'done', kind: 'branch' }), road('last', 2, [beat('final')])],
  tree: { has_tree: true, current_id: 'live', path: ['live'], nodes: [scene('live', 'next')] } };
const cue = { round: 1, beat_id: 'start', chapter_idx: 1 };
const before = JSON.stringify(state);
const graph = layout(state, cue);
assert.equal(JSON.stringify(state), before, 'never mutate the session response');
assert.equal(graph.nodes.length, 9, 'all chapters and beats, including future branches, appear');
assert.equal(graph.nodes.filter(n => n.state === 'current').length, 1);
assert.equal(graph.nodes.find(n => n.state === 'current').title, 'live', 'tree current owns the avatar');
assert.equal(graph.nodes.find(n => n.title === 'start').state, 'path', 'round-bound cue colors the beat just narrated');
assert.equal(graph.nodes.find(n => n.title === 'next').state, 'locked', 'advance alone is not evidence of arrival');
assert.equal(graph.nodes.find(n => n.title === 'skipped').state, 'locked', 'chapter done by index cannot prove a skipped branch was visited');
assert.equal(graph.nodes.find(n => n.title === 'final').state, 'locked');
for (const n of graph.nodes) assert.ok(n.x >= 0 && n.y >= 30 && n.x + W <= graph.width && n.y + H <= graph.height);
const invalid = layout({ ...state, tree: { ...state.tree, current_id: 'missing' } }, cue);
assert.equal(invalid.nodes.filter(n => n.state === 'current').length, 0, 'do not invent a current node when current_id is missing');
const noTree = layout({ ...state, tree: undefined, beat: { id: 'next' }, chapter: { id: 'main' } });
assert.equal(noTree.nodes.find(n => n.state === 'current').title, 'next');
assert.equal(layout({ has_plot: false, roads: state.roads }).nodes.length, 0);
assert.equal(layout().nodes.length, 0);
const fresh = layout({ has_plot: true, roads: [road('main', 0, [beat('opening', 'current'), beat('later')])],
  tree: { has_tree: true, current_id: 'root', path: ['root'], nodes: [scene('root', 'opening')] } });
assert.equal(fresh.nodes.length, 4, 'complete roadmap exists before later scenes are generated');
const combatState = { ...state, tree: { ...state.tree, nodes: [scene('live', 'next', { kind: 'combat', combat_node_id: 'battle' })] } };
const combat = layout(combatState, cue);
assert.equal(combat.nodes.find(n => n.state === 'current').type, 'combat', 'actual combat is not collapsed into its parent beat');
assert.equal(combat.nodes.filter(n => n.state === 'current').length, 1);
const dynamic = layout({ has_plot: true, roads: [], tree: { has_tree: true, current_id: 'second', path: ['root', 'second'],
  nodes: [scene('root', ''), scene('second', '', { parent_id: 'root' }), scene('pending', '', { has_state: false })] } });
assert.equal(dynamic.nodes.length, 3);
assert.equal(dynamic.edges.length, 1);
assert.equal(dynamic.nodes.find(n => n.title === 'pending').state, 'locked');
assert.equal(dynamic.nodes.find(n => n.title === 'second').state, 'current');
const branching = layout({ has_plot: true, roads: [road('main', 0, [
  { ...beat('fork'), authored_branches: [{ label: '走岔路', target_beat_id: 'side' }] }, beat('bypass'), beat('side'),
])] });
assert.ok(branching.edges.some(e => e.source.endsWith(':fork') && e.target.endsWith(':side')));
assert.ok(branching.edges.some(e => e.source.endsWith(':fork') && e.target.endsWith(':bypass')), 'optional author branch keeps normal continuation');
const mandatory = layout({ has_plot: true, roads: [road('main', 0, [{ ...beat('fork'), choice_required: true, authored_branches: [{ label: '走岔路', target_beat_id: 'side' }] }, beat('bypass'), beat('side')])] });
assert.ok(!mandatory.edges.some(e => e.source.endsWith(':fork') && e.target.endsWith(':bypass')), 'required choice blocks default continuation');
const rolled = layout({ ...state, tree: { ...state.tree, current_id: 'old', nodes: [scene('old', 'start'), scene('live', 'next')], path: ['old'] } }, cue);
assert.equal(rolled.nodes.find(n => n.state === 'current').title, 'old', 'rollback relocates the marker');
assert.equal(rolled.nodes.find(n => n.title === 'next').state, 'locked', 'retained next-beat refs are not arrival evidence');
const noCue = layout(state);
assert.equal(noCue.nodes.find(n => n.state === 'current').title, 'live', 'stage failure does not move the avatar to an advanced beat');
assert.equal(noCue.nodes.find(n => n.title === 'next').state, 'locked');
const sameBeat = layout({ ...state, tree: { ...state.tree, nodes: [scene('live', 'start'), scene('other-fork', 'start', {parent_id:'live'})] } }, cue);
assert.ok(sameBeat.nodes.some(n => n.title === 'other-fork') && sameBeat.edges.some(e => e.target === 'scene:other-fork'), 'same-beat dynamic forks remain inspectable');
for (const size of [{ width: 1280, height: 720 }, { width: 900, height: 500 }]) {
  const scale = fitZoom(graph, size);
  assert.ok(scale > 0 && scale <= 1 && graph.width * scale <= size.width - 24 && graph.height * scale <= size.height - 24);
}

const deepNodes = Array.from({length:12000}, (_, i) => scene('deep-'+i, '', {parent_id:i ? 'deep-'+(i-1) : null}));
assert.equal(layout({has_plot:true, roads:[], tree:{has_tree:true, nodes:deepNodes, path:[], current_id:'deep-11999'}}).nodes.length, 12000, 'deep histories remain iterative');

// Render the actual graph with a loaded snapshot. SSR verifies markup only;
// browser checks cover effects, pan, zoom and desktop styling.
const React = fromFrontend('react');
const { renderToStaticMarkup } = fromFrontend('react-dom/server');
const storeModule = require(path.join(root, 'frontend/src/stores/appStore.ts'));
const actualStore = storeModule.useAppStore;
const actualState = React.useState;
const Component = require(path.join(root, 'frontend/src/components/story/SessionStoryGraph.tsx')).default;
try {
  const session = { id: 'fixture', player_identity: '主角', characters: ['同伴'] };
  const store = { sessions: [session], sessionNarrationCount: { fixture: 1 }, sessionStreaming: {}, sessionSending: {} };
  storeModule.useAppStore = selector => selector ? selector(store) : store;
  const states = [{ sessionId: 'fixture', state, stage: { scene_media: cue, player: { name: '主角' }, characters: [{ name: '同伴' }] }, round: 1 },
    false, '', 0, 1, true, { width: 1280, height: 720 }];
  let index = 0;
  React.useState = initial => [index < states.length ? states[index++] : typeof initial === 'function' ? initial() : initial, () => {}];
  const markup = renderToStaticMarkup(React.createElement(Component, { sessionId: 'fixture', onOpenLog() {}, onExit() {} }));
  assert.equal((markup.match(/aria-current="step"/g) || []).length, 1);
  assert.ok(markup.includes('当前节点角色：主角、同伴'));
  assert.ok(markup.includes('未抵达') && markup.includes('final') && markup.includes('skipped-beat'));
  assert.ok(!markup.includes('节点详情') && !markup.includes('<textarea'), 'graph stays focused on the canvas');
  assert.ok(markup.includes('适应全图') && markup.includes('定位当前节点') && markup.includes('返回舞台'));
} finally { React.useState = actualState; storeModule.useAppStore = actualStore; }
console.log('Session roadmap: future nodes, author branches, round position, rollback, combat, fit and graph SSR passed.');
