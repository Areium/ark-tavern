// Focused SSR + request wiring: node scripts/test_story_rules_ui.cjs
// Isolated browser fixture (no live backend/LLM/data): append --serve, port 5191.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');
const fromFrontend = createRequire(path.join(frontend, 'package.json'));
const ts = fromFrontend('typescript');
const src = file => path.join(frontend, 'src', file);
require.extensions['.css'] = () => {};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: filename,
  });
  module._compile(outputText, filename);
};
const React = fromFrontend('react');
const ReactDOM = fromFrontend('react-dom');
const { renderToStaticMarkup: render } = fromFrontend('react-dom/server');
const { default: Choices, resolveChoiceBranch, latestStoryBranches } = require(src('components/story/StoryChoices.tsx'));
const branches = [
  { id: 'blocked', label: '出示通行证', source: 'author', available: false,
    blocked_reasons: ['缺少物品：雨夜通行证'],
    condition_summary: ['持有雨夜通行证', '信任 ≥ 3'], effect_summary: ['消耗雨夜通行证', '信任 + 1'] },
  { id: 'open /补给', label: '打开补给盒', available: true, condition_summary: ['补给盒尚未开启'], effect_summary: ['获得绷带'] },
  { id: 'stale', label: '尝试已变化的条件', available: true, condition_summary: ['服务端将重新确认条件'], effect_summary: ['通过后进入下一节点'] },
];
const choiceMessage = { role: 'system', content: '— 请选择 —', round: 1, choices: branches.map(b => b.label), branches };
const props = { message: choiceMessage, disabled: false, onChoice() {} };
const playerStats = { name: '玩家', is_player: true, worldbook_id: 'fixture', worldbook_name: '测试世界书',
  fields: [{ key: 'permit', label: '已获许可', type: 'bool', default: false }, { key: 'trust', label: '信任', type: 'number', default: 0 }],
  values: { permit: false, trust: 0 }, sources: { permit: 'default', trust: 'default' }, session_values: {} };

async function tests() {
  for (const variant of ['chat', 'stage']) {
    const html = render(React.createElement(Choices, { ...props, variant }));
    assert.equal((html.match(/disabled=""/g) || []).length, 1);
    for (const line of [...branches[0].blocked_reasons, ...branches[0].condition_summary, ...branches[0].effect_summary]) {
      assert.ok(html.includes(line), `visible text, not just tooltip: ${line}`);
    }
    assert.ok(!html.includes('title='), 'rules are inline');
    assert.ok(html.includes('type="button"') && html.includes('focus-visible:outline'));
    assert.equal((render(React.createElement(Choices, { ...props, variant, disabled: true })).match(/disabled=""/g) || []).length, 3);
  }
  assert.equal(render(React.createElement(Choices, { ...props, message: {} })), '');
  const duplicate = render(React.createElement(Choices, { ...props, knownBranches: branches, message: { choices: ['出示通行证'] } }));
  assert.ok(duplicate.includes('disabled=""') && duplicate.includes('缺少物品'));
  assert.equal(resolveChoiceBranch(' 出示通行证 ', [ { ...branches[0], available: true }, branches[0] ]), branches[0]);
  assert.equal(resolveChoiceBranch('自由探索', branches), undefined);
  assert.equal(latestStoryBranches([choiceMessage, { role: 'system', choices: ['出示通行证'] }]), branches);
  const unspecified = { id: 'x', label: '<script>alert(1)</script>', effect_summary: ['<img src=x>'] };
  const safeHtml = render(React.createElement(Choices, { ...props, message: { branches: [unspecified] } }));
  assert.ok(!safeHtml.includes('disabled=""'), 'absent availability does not imply blocked');
  assert.ok(safeHtml.includes('&lt;script&gt;') && safeHtml.includes('&lt;img'));
  assert.ok(render(React.createElement(Choices, { ...props, message: { branches: [{ ...unspecified, available: false }] } })).includes('当前条件未满足'));

  const { BranchRuleSummary } = require(src('components/story/StoryChoices.tsx'));
  const html = render(React.createElement(BranchRuleSummary, { branch: branches[0], historical: true }));
  assert.ok(html.includes('记录时不可选') && html.includes('效果：') && !html.includes('<button'));

  // Render the real card with controlled loaded hook snapshots; never claim SSR ran effects.
  const storeModule = require(src('stores/appStore.ts'));
  const actualStore = storeModule.useAppStore;
  const originalState = React.useState;
  const originalPortal = ReactDOM.createPortal;
  const oldWindow = global.window;
  const oldDocument = global.document;
  const Card = require(src('components/CharacterDetailCard.tsx')).default;
  global.window = { innerWidth: 1280, innerHeight: 800 };
  global.document = { body: {} };
  ReactDOM.createPortal = element => element;
  try {
    for (const mode of ['narrative', 'tactical', 'sideview']) for (const populated of [false, true]) {
      const state = { activeSessionId: 'fixture', statsRefreshKey: 0, sessions: [{ id: 'fixture', combat_mode: mode }], triggerStatsRefresh() {} };
      storeModule.useAppStore = selector => selector ? selector(state) : state;
      const values = [{ metadata: { name: '测试角色', attributes: { strength: 8 } }, content: '' }, false, '',
        populated ? { level: 4, xp: 15 } : null, populated ? { hp: 120 } : null, false, '', { width: 1280, height: 800 },
        playerStats, {}, false, false, '', false, 0];
      let index = 0;
      React.useState = initial => [index < values.length ? values[index++] : typeof initial === 'function' ? initial() : initial, () => {}];
      const cardProps = { characterId: '玩家', anchorRect: { right: 20, left: 0, top: 10 }, pinned: true, onClose() {}, onTogglePin() {} };
      const markup = render(React.createElement(Card, cardProps));
      assert.equal(markup.includes('Lv.'), mode !== 'narrative' && populated);
      assert.equal(markup.includes('>战斗数值<'), mode !== 'narrative' && populated);
      assert.equal(markup.includes('>力量<'), mode !== 'narrative');
      assert.ok(!markup.includes('Lv.1') && !markup.includes('XP 0'), 'never invent progression');
      assert.ok(markup.includes('已获许可') && markup.includes('信任') && markup.includes('value="0"'), 'worldbook fields remain visible with null combat');
      assert.match(markup, /type="checkbox"[^>]*\/>/);
      assert.ok(!markup.includes('checked=""') && markup.includes('否'), 'false default is not dropped');
      if (mode === 'narrative' && !populated) {
        values[0] = null; values[2] = '角色档案不存在'; index = 0;
        const withoutProfile = render(React.createElement(Card, cardProps));
        assert.ok(withoutProfile.includes('已获许可') && withoutProfile.includes('value="0"'), 'main-control stats do not depend on a character-library profile');
        state.activeSessionId = null; index = 0;
        assert.ok(!render(React.createElement(Card, cardProps)).includes('character-session-stats'), 'no session means no session editor');
      }
    }
  } finally {
    React.useState = originalState;
    ReactDOM.createPortal = originalPortal;
    storeModule.useAppStore = actualStore;
    global.window = oldWindow;
    global.document = oldDocument;
  }

  const cardSource = fs.readFileSync(src('components/CharacterDetailCard.tsx'), 'utf8');
  assert.ok(cardSource.includes('key={`${activeSessionId}:${characterId}`}'), 'remount isolates pending edits for both identity dimensions');
  await testStatsLifecycle();

  // Exercise the actual fetch/SSE parser and store callbacks, including HTTP 409.
  const { triggerNarrate } = require(src('components/ChatPanel.tsx'));
  const originalFetch = global.fetch;
  try {
    for (const reject of [true, false]) {
      actualStore.setState({ activeSessionId: 'fixture', currentView: 'chat', sessions: [{ id: 'fixture', player_identity: '玩家', characters: [] }],
        sessionMessages: { fixture: [choiceMessage] }, sessionNarrationCount: { fixture: 1 }, statsRefreshKey: 0, envRefreshKey: 0 });
      let requestUrl;
      global.fetch = async url => {
        requestUrl = url;
        return reject ? new Response(JSON.stringify({ error: '缺少物品：雨夜通行证，状态已变化' }), { status: 409 })
          : new Response('data: {"type":"text","data":{"token":"模拟叙述成功"}}\n\ndata: {"type":"done"}\n\n');
      };
      triggerNarrate('fixture', '打开补给盒', 'open /补给');
      for (let i = 0; i < 100 && actualStore.getState().sessionStreaming.fixture; i++) await new Promise(setImmediate);
      const state = actualStore.getState();
      assert.ok(!state.sessionStreaming.fixture, 'request finished');
      assert.equal(new URL(requestUrl, 'http://fixture').searchParams.get('branch_id'), 'open /补给');
      assert.equal(state.sessionNarrationCount.fixture, reject ? 1 : 2);
      assert.ok(state.statsRefreshKey > 0 && state.envRefreshKey > 0, 'stats and inventory refresh keys');
      assert.equal(state.sessionMessages.fixture.some(message => message.requestError), reject);
      assert.equal(state.sessionMessages.fixture.some(message => message.content === '模拟叙述成功'), !reject);
      if (reject) assert.match(state.sessionMessages.fixture.at(-1).content, /缺少物品：雨夜通行证，状态已变化/);
    }
  } finally { global.fetch = originalFetch; }
  console.log('story rules UI: choice/card/graph SSR + real SSE success/409 + branch ID + refresh assertions passed');
}

// Focused hook/effect harness: exercises the actual component's load/save closures,
// with a controlled API. Browser layout and React reconciliation are checked separately.
async function testStatsLifecycle() {
  const Stats = require(src('components/scene/CharacterSessionStats.tsx')).default;
  const Form = require(src('components/roles/StatValuesForm.tsx')).default;
  const apiModule = require(src('hooks/useApi.ts'));
  const storeModule = require(src('stores/appStore.ts'));
  const originals = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    api: apiModule.useApi, store: storeModule.useAppStore };
  let serverRow = structuredClone(playerStats), loadError = '', saveError = '';
  const api = {
    async getSessionCharacterStats() { if (loadError) throw new Error(loadError); return { characters: [structuredClone(serverRow)] }; },
    async saveSessionCharacterStats(session, name, pending) {
      assert.equal(session, 'fixture'); assert.equal(name, '玩家');
      if (saveError) throw new Error(saveError);
      serverRow = { ...serverRow, values: { ...serverRow.values, ...pending }, session_values: { ...pending } };
      return structuredClone(serverRow);
    },
  };
  const slots = [];
  let cursor = 0, dirty = true, tree, effects = [];
  const store = { statsRefreshKey: 0, triggerStatsRefresh() { store.statsRefreshKey++; dirty = true; } };
  function run() {
    cursor = 0; dirty = false; effects = [];
    React.useState = initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; dirty = true; }];
    };
    React.useRef = initial => { const index = cursor++; return slots[index] ??= { current: initial }; };
    React.useEffect = (effect, deps) => {
      const index = cursor++, prior = slots[index];
      if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
        prior?.cleanup?.(); slots[index] = { deps };
        effects.push(() => { slots[index].cleanup = effect(); });
      }
    };
    apiModule.useApi = () => api;
    storeModule.useAppStore = selector => selector(store);
    try { tree = Stats({ sessionId: 'fixture', name: '玩家' }); }
    finally {
      React.useState = originals.useState; React.useRef = originals.useRef; React.useEffect = originals.useEffect;
      apiModule.useApi = originals.api; storeModule.useAppStore = originals.store;
    }
    effects.forEach(effect => effect());
  }
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props?.children)) { const found = find(child, predicate); if (found) return found; }
  }
  const form = () => find(tree, node => node.type === Form);
  const button = text => find(tree, node => node.type === 'button' && node.props.children === text);
  async function settle() { for (let i = 0; i < 10; i++) { if (dirty) run(); await new Promise(setImmediate); } assert.equal(dirty, false); }
  try {
    run(); assert.ok(render(tree).includes('加载数值中')); await settle();
    assert.deepEqual(form().props.values, { permit: false, trust: 0 });
    assert.ok(button('保存数值').props.disabled);
    serverRow.values.trust = 5; store.triggerStatsRefresh(); await settle();
    assert.equal(form().props.values.trust, 5, 'background refresh updates visible numeric value');
    form().props.onChange('trust', 9); await settle();
    serverRow.values = { permit: true, trust: 6 }; store.triggerStatsRefresh(); await settle();
    assert.deepEqual(form().props.values, { permit: true, trust: 9 }, 'refresh updates untouched fields without losing draft');
    saveError = '409：剧情正在结算'; button('保存数值').props.onClick(); await settle();
    assert.ok(render(tree).includes(saveError)); assert.equal(form().props.values.trust, 9);
    saveError = ''; button('保存数值').props.onClick(); await settle();
    assert.ok(button('保存数值').props.disabled); assert.equal(serverRow.values.trust, 9);
    serverRow = { ...playerStats, fields: [], values: {}, sources: {}, session_values: {} };
    store.triggerStatsRefresh(); await settle();
    assert.ok(render(tree).includes('尚未定义叙事数值')); assert.equal(form(), undefined);
    assert.ok(!render(tree).includes('<input') && !render(tree).includes('保存数值'));
    serverRow.values = { custom_false: false, custom_zero: 0 }; store.triggerStatsRefresh(); await settle();
    assert.ok(render(tree).includes('value="false"') && render(tree).includes('value="0"'), 'schema-less actual values remain visible');
    loadError = '数值读取失败'; store.triggerStatsRefresh(); await settle();
    assert.ok(render(tree).includes(loadError));
  } finally { for (const slot of slots) slot?.cleanup?.(); }
  console.log('session stats: null-combat/player SSR, false/zero, empty, refresh, draft retention, failed save and successful save passed');
}

async function serve() {
  // Tailwind's existing content globs are relative to the frontend working directory.
  process.chdir(frontend);
  const { createServer } = await import(pathToFileURL(path.join(path.dirname(fromFrontend.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const fixtureStats = ['玩家', 'narrative', 'tactical', 'sideview', '空白'].map(name => ({ ...structuredClone(playerStats), name, is_player: name === '玩家',
    ...(name === '空白' ? { fields: [], values: {}, sources: {} } : {}) }));
  let graphMode = 'normal';
  const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatPanel from '/src/components/ChatPanel.tsx';
import CharacterDetailCard from '/src/components/CharacterDetailCard.tsx';
import {useAppStore} from '/src/stores/appStore.ts';
import '/src/style.css';
import '/src/styles/chat.css';
import '/src/styles/session-story-graph.css';
const choices = ${JSON.stringify(choiceMessage)};
const session = {id:'fixture', name:'前端测试', mode:'story', combat_mode:'narrative', player_identity:'玩家', characters:['同伴'], narration_count:1};
useAppStore.setState({activeSessionId:'fixture', chatMode:'story', sessions:[session], chatLayout:'graph', currentView:'chat', sessionMessages:{fixture:[choices]}, sessionNarrationCount:{fixture:1}});
function Fixture(){
 const state=useAppStore(); const [card,setCard]=useState(false); const [cardName,setCardName]=useState('');
 const reset=()=>{state.setSessionMessages('fixture',[choices]);state.setSessionNarrationCount('fixture',1);};
 return <div style={{height:'100vh',display:'flex',flexDirection:'column'}} className="chat-view">
 <header style={{padding:8,display:'flex',flexWrap:'wrap',gap:8,fontSize:14}}>
 <strong>API mock · 非真实 LLM</strong>
 <select aria-label="模拟剧情状态" defaultValue="normal" onChange={e=>fetch('/api/__fixture/graph-mode?mode='+e.target.value,{method:'POST'}).then(()=>state.triggerEnvRefresh())}>
 <option value="normal">正常节点</option><option value="rollback">模拟回档</option><option value="error">模拟加载失败</option><option value="empty">模拟空状态</option><option value="stage-error">模拟角色失败</option></select>
 <button onClick={()=>state.setSessionStreaming('fixture',!state.sessionStreaming.fixture)}>模拟生成状态</button>
 <select aria-label="测试布局" value={state.chatLayout} onChange={e=>state.setChatLayout(e.target.value)}><option value="chat">记录</option><option value="stage">舞台</option><option value="graph">节点图</option></select>
 <select aria-label="测试模式" value={state.sessions[0].combat_mode} onChange={e=>state.setSessions([{...session,combat_mode:e.target.value}])}><option>narrative</option><option>tactical</option><option>sideview</option></select>
 <button onClick={()=>{setCardName('');setCard(!card);}}>角色详情</button><button onClick={reset}>重置测试</button>
 <button onClick={()=>{setCardName('玩家');setCard(true);}}>主控详情</button>
 <button onClick={()=>{setCardName('空白');setCard(true);}}>空状态详情</button>
 <button onClick={()=>fetch('/api/__fixture/stats-refresh',{method:'POST'}).then(()=>state.triggerStatsRefresh())}>模拟数值刷新</button>
 <button onClick={()=>state.setSessionMessages('fixture',[choices,{role:'system',content:'同名纯文本选项',round:1,choices:['出示通行证']}])}>同名旁路测试</button>
 <label><input type="checkbox" checked={state.editBeforeSend} onChange={e=>state.setEditBeforeSend(e.target.checked)}/>编辑后发送</label>
 <output>数值刷新 {state.statsRefreshKey} / 物品刷新 {state.envRefreshKey} / 轮次 {state.sessionNarrationCount.fixture}</output>
 </header>
 <main style={{flex:1,minHeight:0}}><ChatPanel stageOnly={false} onExitStageOnly={()=>{}} musicMuted={true} onToggleMusic={()=>{}}/></main>
 {card&&<CharacterDetailCard characterId={cardName||state.sessions[0].combat_mode} anchorRect={{right:8,left:8,top:80}} pinned={true} onTogglePin={()=>{}} onClose={()=>setCard(false)}/>}
 </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const server = await createServer({ root: frontend, configFile: false, cacheDir: path.join(root, '.tmp', 'story-rules-vite'),
    esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 5191, strictPort: true },
    plugins: [{ name: 'isolated-story-fixture',
      resolveId(id) { if (id === '/__story-rules-fixture.tsx') return '\0story-rules-fixture.tsx'; },
      load(id) { if (id === '\0story-rules-fixture.tsx') return ts.transpileModule(fixture, {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: 'fixture.tsx',
      }).outputText; },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><head><title>Story rules API mock</title></head><body><div id="root"></div><script type="module" src="/__story-rules-fixture.tsx"></script></body></html>'); return; }
        if (!url.pathname.startsWith('/api/')) return next();
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/__fixture/graph-mode') { graphMode = url.searchParams.get('mode'); res.end('{}'); return; }
        if (url.pathname.endsWith('/story-state') && graphMode === 'error') { res.statusCode = 503; res.end(JSON.stringify({error:'模拟：剧情节点加载失败'})); return; }
        if (url.pathname.endsWith('/stage') && graphMode === 'stage-error') { res.statusCode = 503; res.end(JSON.stringify({error:'模拟：场景角色加载失败'})); return; }
        if (url.pathname === '/api/__fixture/stats-refresh') {
          fixtureStats.filter(row => row.fields.length).forEach(row => { row.values.trust += 5; });
          res.end('{}'); return;
        }
        if (url.pathname.endsWith('/character-stats')) { res.end(JSON.stringify({ session_id: 'fixture', characters: fixtureStats })); return; }
        if (url.pathname.includes('/character-stats/')) {
          const name = decodeURIComponent(url.pathname.split('/character-stats/')[1]);
          const row = fixtureStats.find(row => row.name === name);
          if (!row) { res.statusCode = 404; res.end(JSON.stringify({error:'测试角色不存在'})); return; }
          if (req.method === 'PUT') {
            let body = ''; for await (const chunk of req) body += chunk;
            const values = JSON.parse(body).values;
            row.values = { ...row.values, ...values }; row.session_values = { ...row.session_values, ...values };
          } else if (req.method === 'DELETE') { row.values = { ...playerStats.values }; row.session_values = {}; }
          res.end(JSON.stringify(row)); return;
        }
        if (url.pathname.endsWith('/narrate')) {
          console.log('mock narrate', url.searchParams.get('branch_id'));
          if (url.searchParams.get('branch_id') === 'stale') { res.statusCode = 409; res.end(JSON.stringify({ error: '状态已变化：雨夜通行证已被消耗，请重新确认条件' })); return; }
          res.setHeader('Content-Type', 'text/event-stream');
          setTimeout(() => res.end('data: {"type":"text","data":{"token":"模拟结果：获得绷带。"}}\n\ndata: {"type":"done"}\n\n'), 1200); return;
        }
        let data = {};
        if (url.pathname.endsWith('/avatar')) { res.setHeader('Content-Type','image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#627c90"/><circle cx="32" cy="24" r="12" fill="#e5ded0"/><ellipse cx="32" cy="62" rx="25" ry="25" fill="#e5ded0"/></svg>'); return; }
        if (url.pathname.startsWith('/api/characters/')) data = { metadata: { name: '测试角色', attributes: { strength: 8 } }, content: '这是一份前端 API mock，不是真实剧情或用户数据。' };
        if (url.pathname.includes('/overrides/characters/')) data = /\/(tactical|sideview)$/.test(url.pathname) ? { progress: { level: 4, xp: 15 }, combat_stats: { hp: 120, patk: 30, matk: 20, heal: 0, def: 10, res: 5, spd: 7, hit: 95, eva: 3, max_ap: 6 } } : { progress: null, combat_stats: null };
        if (url.pathname.endsWith('/stage')) data = { session_id:'fixture', location:'雨夜入口', weather:'小雨', time:'夜晚', atmosphere:[],
          background:{url:null,source:'none',bg_id:''}, player:{name:'玩家',skin_url:null,avatar_url:null,color:null}, characters:[{name:'同伴',skin_url:null,avatar_url:null,color:null,active:true}], scene_media:null };
        if (url.pathname.endsWith('/story-state')) data = { has_plot:true, plot_name:'长夜归途', roads:[
          {chapter_idx:0,id:'rain',kind:'main',title:'雨中的约定',state:'current',beats:[
            {id:'gate',title:'抵达旧城',summary:'长夜开始，灯火渐次亮起。',state:'done',choice_required:false},
            {id:'bridge',title:'桥头的约定',summary:'与同伴会合，寻找雨中的线索。',state:'current',choice_required:false},
            {id:'market',title:'旧城集市',summary:'继续前往旧城区。',state:'locked',choice_required:false}]},
          {chapter_idx:1,id:'dawn',kind:'main',title:'黎明之前',state:'locked',beats:[
            {id:'tower',title:'钟楼回声',summary:'前往钟楼寻找线索。',state:'locked',choice_required:false},
            {id:'return',title:'归途',summary:'重逢的约定。',state:'locked',choice_required:false}]}
          ], tree:{has_tree:true,current_id:'bridge-scene',root_id:'root',path:['root','bridge-scene'],nodes:[
            {id:'root',parent_id:null,title:'抵达雨中的旧城',kind:'plot',summary:'沿着灯光寻找同伴。',children:['bridge-scene','side'],branches,has_state:true},
            {id:'bridge-scene',parent_id:'root',title:'桥头的约定',kind:'beat',summary:'同伴终于在桥头会合。',children:[],branches:[],has_state:true},
            {id:'side',parent_id:'root',title:'独自走进暗巷',kind:'beat',summary:'尚未走过的岔路。',children:[],branches:[],has_state:false}
          ]} };
        if (url.pathname.endsWith('/stage')) data.scene_media = { round:1, beat_id:graphMode === 'rollback' ? 'gate' : 'bridge', chapter_idx:1 };
        if (url.pathname.endsWith('/story-state') && graphMode === 'rollback') { data.tree.current_id = 'root'; data.tree.path=['root']; }
        if (url.pathname.endsWith('/story-state') && graphMode === 'empty') data={has_plot:false,roads:[]};
        res.end(JSON.stringify(data));
      }); },
    }],
  });
  await server.listen();
  console.log('API mock only (no live backend/LLM): http://127.0.0.1:5191');
}
(process.argv.includes('--serve') ? serve() : tests()).catch(error => { console.error(error); process.exitCode = 1; });
