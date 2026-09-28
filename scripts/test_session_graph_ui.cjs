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
const {layoutSessionStoryGraph: layout, STORY_GRAPH_NODE_HEIGHT: H, STORY_GRAPH_NODE_WIDTH: W} =
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
