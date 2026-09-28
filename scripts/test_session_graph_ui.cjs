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
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const {layoutSessionStoryGraph: layout, STORY_GRAPH_NODE_HEIGHT: H, STORY_GRAPH_NODE_WIDTH: W,
  STORY_GRAPH_MAX_ZOOM, sessionGraphFitZoom: fitZoom, sessionGraphKindLabel: kindLabel,
  sessionGraphIncoming: incoming} =
  require(path.join(root, 'frontend/src/utils/sessionStoryGraph.ts'));
const node = (id, parent_id = null) => ({id, parent_id, depth: 999, title: id,
  summary: '', children: [], branches: [], has_state: true, state: 'visited'});
const tree = (nodes, current_id = '', path = []) => ({has_tree: true, nodes, current_id, path, root_id: 'root'});
assert.deepEqual(layout(), {nodes: [], edges: [], width: 0, height: 0});
assert.equal(layout({has_tree: false, nodes: [node('x')]}).nodes.length, 0);
const input = tree([node('root'), node('a', 'root'), node('b', 'root'), node('c', 'a')], 'c', ['root', 'a', 'c']);
const before = JSON.stringify(input);
const graph = layout(input);
assert.equal(JSON.stringify(input), before, 'layout must not mutate backend state');
assert.equal(graph.nodes.length, 4);
assert.equal(graph.edges.length, 3);
assert.equal(graph.nodes.find(n => n.id === 'c').state, 'current');
assert.equal(graph.nodes.find(n => n.id === 'a').state, 'path');
assert.equal(graph.nodes.find(n => n.id === 'b').state, 'branch');
assert.deepEqual(graph.edges.filter(e => e.onPath).map(e => e.target).sort(), ['a', 'c']);
const positions = new Map(graph.nodes.map(n => [n.id, n]));
for (const edge of graph.edges) assert.ok(positions.get(edge.source).x < positions.get(edge.target).x);
for (const n of graph.nodes) {
  assert.ok(n.x >= 0 && n.y >= 0);
  assert.ok(n.x + W <= graph.width && n.y + H <= graph.height, 'all cards inside canvas');
}
for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
  const a = graph.nodes[i], b = graph.nodes[j];
  assert.ok(Math.abs(a.x - b.x) >= W || Math.abs(a.y - b.y) >= H, 'cards never overlap');
}
assert.equal(layout(tree(input.nodes, 'root', ['root'])).nodes.find(n => n.id === 'root').state, 'current', 'rollback marker');
assert.equal(layout(tree(input.nodes, 'missing')).nodes.filter(n => n.state === 'current').length, 0, 'never invent position');
assert.equal(layout(tree([node('dup'), node('dup'), node('orphan', 'absent')])).nodes.length, 2);
const cycle = layout(tree([node('a', 'c'), node('b', 'a'), node('c', 'b'), node('self', 'self')]));
assert.equal(cycle.nodes.length, 4);
assert.equal(cycle.edges.length, 2, 'cycle-closing edges omitted');
const deep = Array.from({length: 12000}, (_, i) => node(`n${i}`, i ? `n${i - 1}` : null));
assert.equal(layout(tree(deep)).nodes.length, 12000, 'deep chains do not recurse');
console.log('Session graph layout: all assertions passed (including 12,000-node chain).');

// Fitting has no fixed lower bound that clips very long or wide histories.
for (const size of [{width: 1280, height: 540}, {width: 360, height: 260}]) {
  for (const dimensions of [graph, layout(tree(deep)), {width: 800, height: 30000}]) {
    const scale = fitZoom(dimensions, size);
    assert.ok(scale > 0 && scale <= 1);
    assert.ok(dimensions.width * scale <= size.width - 24 + 1e-6);
    assert.ok(dimensions.height * scale <= size.height - 24 + 1e-6);
  }
}
assert.ok(fitZoom(layout(tree(deep)), {width: 360, height: 260}) < .01);
assert.equal(fitZoom({width: 0, height: 0}, {width: 360, height: 260}), 1);
assert.equal(fitZoom(graph, {width: 0, height: 0}), 1, 'unmeasured view does not produce Infinity');
assert.equal(fitZoom({width: 80, height: 60}, {width: 1280, height: 540}), 1, 'fit does not enlarge small graphs');
assert.equal(STORY_GRAPH_MAX_ZOOM, 2);
assert.deepEqual(['plot', 'beat', 'combat', undefined].map(kindLabel), ['剧情', '节拍', '战斗', '类型未记录']);

const choice = {id: 'choice-2', label: '沿北面的廊桥继续前进，穿过尚未熄灭的灯火',
  intent: '寻找灯塔的守望者', target_beat_id: 'beat_north_bridge', child_id: 'child', taken: true};
const parent = {...node('parent'), title: '岔路口', branches: [
  {...choice, id: 'choice-1', child_id: 'other', label: '沿北面的廊桥', intent: '错误的同名方向'}, choice,
]};
const child = {...node('child', 'parent'), kind: 'beat', title: '灯塔廊桥', branch_label: '沿北面的廊桥',
  intent: '节点保存的独立意图', summary: '长篇剧情第一行。\n第二行。'.repeat(50), round_start: 3, round_end: 5,
  branches: [
    {id: 'a', label: '继续调查', intent: '查看遗留记录', target_beat_id: 'beat_archive', taken: true},
    {id: 'b', label: '返回入口', intent: '等待同伴', target_beat_id: 'beat_gate', taken: false},
    {id: 'c', label: '保持观察', intent: null, target_beat_id: null},
  ]};
const recordsBefore = JSON.stringify([parent, child]);
assert.equal(incoming(child, parent).branch, choice, 'child_id wins over a matching truncated label');
assert.equal(incoming(child, parent).label, choice.label);
assert.equal(incoming(child, parent).intent, choice.intent);
const noMatchParent = {...parent, branches: [parent.branches[0]]};
assert.equal(incoming(child, noMatchParent).branch, undefined, 'taken or equal labels cannot prove an incoming edge');
assert.deepEqual(incoming(child, noMatchParent), {branch: undefined, label: child.branch_label, intent: child.intent});
assert.equal(incoming(child, {...parent, id: 'unrelated'}).branch, undefined, 'do not match another parent');
assert.deepEqual(incoming(child), {branch: undefined, label: child.branch_label, intent: child.intent}, 'orphan record survives');
assert.deepEqual(incoming(node('root')), {branch: undefined, label: '', intent: ''});

// Render the actual read-only detail component, not a duplicated HTML fixture.
const React = fromFrontend('react');
const {renderToStaticMarkup} = fromFrontend('react-dom/server');
const componentPath = path.join(root, 'frontend/src/components/story/SessionStoryGraph.tsx');
const {SessionStoryGraphDetails} = require(componentPath);
const renderDetails = (value, parentNode, state = 'current', castError = false) => renderToStaticMarkup(
  React.createElement(SessionStoryGraphDetails, {
    entry: {id: value.id, node: value, x: 0, y: 0, state}, parent: parentNode, castNames: ['玩家', '同行者'], castError,
  }),
);
const markup = renderDetails(child, parent);
for (const content of ['只读查看 · 不会回档', '灯塔廊桥', '节拍', '第 3–5 轮', choice.label, choice.intent,
  child.branch_label, child.intent, 'beat_north_bridge', '继续调查', '查看遗留记录', 'beat_archive',
  '返回入口', '等待同伴', 'beat_gate', '保持观察', '已走过', '未走过', '未记录', '未指定', '玩家、同行者']) {
  assert.ok(markup.includes(content), `detail includes actual record: ${content}`);
}
assert.ok(markup.includes(child.summary), 'full multiline summary is not truncated');
assert.ok(!/<button|<a\b|<input|<select|<textarea/.test(markup), 'details expose no write or navigation controls');
assert.ok(!markup.includes('错误的同名方向'), 'mismatched branch is not shown as the incoming choice');
assert.equal(JSON.stringify([parent, child]), recordsBefore, 'deriving and rendering details never mutate API records');
const orphanMarkup = renderDetails(child, undefined, 'branch');
assert.ok(orphanMarkup.includes('未找到 child_id 对应的父节点选项'));
assert.ok(orphanMarkup.includes(child.intent) && orphanMarkup.includes(child.branch_label));
assert.ok(!orphanMarkup.includes('同处当前节点'), 'cast is only displayed for the current node');
const emptyMarkup = renderDetails(node('root'));
for (const content of ['类型未记录', '无（起点）', '此节点暂无摘要', '未记录入边选项', '此节点尚无分支记录']) {
  assert.ok(emptyMarkup.includes(content), `missing data is explicit: ${content}`);
}
assert.ok(renderDetails(child, parent, 'current', true).includes('场景角色加载失败'));
assert.ok(renderDetails({...child, summary: '<script>alert(1)</script>'}, parent).includes('&lt;script&gt;'), 'records are escaped');

// Check native activation and read-only boundary in JSX. Browser focus/zoom and
// desktop/mobile visuals remain an integration check, not simulated by SSR.
const componentSource = fs.readFileSync(componentPath, 'utf8');
const sourceFile = ts.createSourceFile(componentPath, componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements = [];
const apiCalls = [];
function visit(astNode) {
  if (ts.isJsxOpeningElement(astNode) || ts.isJsxSelfClosingElement(astNode)) elements.push(astNode);
  if (ts.isCallExpression(astNode) && ts.isPropertyAccessExpression(astNode.expression)
    && astNode.expression.expression.getText(sourceFile) === 'api') apiCalls.push(astNode.expression.name.text);
  ts.forEachChild(astNode, visit);
}
visit(sourceFile);
function attr(element, name) {
  return element.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(sourceFile) === name)?.initializer;
}
const graphNode = elements.find(element => attr(element, 'className')?.getText(sourceFile).includes('session-graph-node is-'));
assert.equal(graphNode.tagName.getText(sourceFile), 'button', 'native Enter/Space activation');
assert.equal(attr(graphNode, 'type').text, 'button');
for (const name of ['onClick', 'onDoubleClick']) {
  assert.ok(attr(graphNode, name)?.getText(sourceFile).includes('setSelectedId(entry.id)'), `${name} opens the same detail`);
}
assert.ok(attr(graphNode, 'onClick').getText(sourceFile).includes('event.detail === 0'), 'keyboard activation moves focus into detail');
assert.ok(attr(graphNode, 'aria-controls'), 'node announces controlled details');
const aside = elements.find(element => element.tagName.getText(sourceFile) === 'aside');
assert.equal(attr(aside, 'tabIndex').getText(sourceFile), '{0}', 'long details are keyboard-scrollable');
assert.deepEqual([...new Set(apiCalls)].sort(), ['getStage', 'getStoryState'], 'graph only reads session APIs');
assert.ok(componentSource.includes('适应全图') && componentSource.includes('sessionGraphFitZoom(layout, viewportSize)'));
console.log('Session graph fit, incoming choices, detail SSR, native activation and read-only boundary: all assertions passed.');
