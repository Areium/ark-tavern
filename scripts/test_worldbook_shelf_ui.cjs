// Deterministic lifecycle tests: node scripts/test_worldbook_shelf_ui.cjs
// Real component / mock API browser fixture: append --serve (127.0.0.1:5192).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');
const fromFrontend = createRequire(path.join(frontend, 'package.json'));
const ts = fromFrontend('typescript');
require.extensions['.css'] = () => {};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText, filename);
};
const { startWorldbookShelfSync } = require(path.join(frontend, 'src/utils/worldbookShelfSync.ts'));
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function environment() {
  const host = new EventTarget(), page = new EventTarget(), timers = new Map();
  let serial = 0;
  page.visibilityState = 'visible';
  host.setTimeout = (callback, delay) => { timers.set(++serial, { callback, delay }); return serial; };
  host.clearTimeout = id => timers.delete(id);
  return { host, page, timers, fire: async delay => {
    const pending = [...timers].find(([, t]) => t.delay === delay);
    assert.ok(pending, `expected timer ${delay}`);
    timers.delete(pending[0]); pending[1].callback(); await settle();
  } };
}
async function tests() {
  let env = environment(), calls = 0;
  let stop = startWorldbookShelfSync(async () => { calls++; return true; }, env.host, env.page);
  await settle(); assert.equal(calls, 1, 'load immediately without clicking refresh');
  assert.equal(env.timers.size, 0, 'healthy shelves must not poll');
  env.host.dispatchEvent(new Event('focus')); env.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.timers.size, 1, 'coalesce return events');
  await env.fire(150); assert.equal(calls, 2);
  env.page.visibilityState = 'hidden'; env.page.dispatchEvent(new Event('visibilitychange'));
  env.host.dispatchEvent(new Event('focus')); assert.equal(env.timers.size, 0);
  env.page.visibilityState = 'visible'; env.page.dispatchEvent(new Event('visibilitychange'));
  await env.fire(150); assert.equal(calls, 3, 'return from file manager reloads');
  env.host.dispatchEvent(new Event('online')); await env.fire(150); assert.equal(calls, 4);
  stop(); env.host.dispatchEvent(new Event('focus')); env.host.dispatchEvent(new Event('online'));
  env.page.dispatchEvent(new Event('visibilitychange')); assert.equal(env.timers.size, 0, 'remove all listeners');

  env = environment(); calls = 0;
  stop = startWorldbookShelfSync(async () => ++calls > 1, env.host, env.page);
  await settle(); await env.fire(2000);
  assert.equal(calls, 2, 'initial failure recovers automatically');
  assert.equal(env.timers.size, 0); stop();

  env = environment(); calls = 0;
  stop = startWorldbookShelfSync(async () => { calls++; throw new Error('offline'); }, env.host, env.page);
  await settle(); for (const delay of [2000, 5000, 10000]) await env.fire(delay);
  assert.equal(calls, 4); assert.equal(env.timers.size, 0, 'retry budget is bounded');
  env.host.dispatchEvent(new Event('online')); await env.fire(150);
  assert.equal(calls, 5, 'recovery event starts a new attempt'); stop(); assert.equal(env.timers.size, 0);

  env = environment(); calls = 0; let resolve;
  stop = startWorldbookShelfSync(() => { calls++; return new Promise(r => { resolve = r; }); }, env.host, env.page);
  env.host.dispatchEvent(new Event('focus')); assert.equal(env.timers.size, 0, 'do not overlap slow automatic requests');
  stop(); resolve(false); await settle(); assert.equal(env.timers.size, 0, 'unmounted failure cannot retry');
  stop = startWorldbookShelfSync(async () => { calls++; return true; }, env.host, env.page);
  await settle(); assert.equal(calls, 2, 'remount loads again'); stop();

  env = environment(); calls = 0; env.page.visibilityState = 'hidden';
  stop = startWorldbookShelfSync(async () => { calls++; return true; }, env.host, env.page);
  assert.equal(calls, 0); env.page.visibilityState = 'visible'; env.page.dispatchEvent(new Event('visibilitychange'));
  await env.fire(150); assert.equal(calls, 1); stop();

  const React = fromFrontend('react');
  const { renderToStaticMarkup } = fromFrontend('react-dom/server');
  const Manager = require(path.join(frontend, 'src/components/WorldBookManager.tsx')).default;
  const html = renderToStaticMarkup(React.createElement(Manager));
  assert.ok(html.includes('正在载入世界书…'));
  assert.ok(!html.includes('书架还是空的'), 'pending request must not look empty');
  assert.ok(!html.includes('用文件夹安装与分享'));
  assert.match(html, /aria-label="打开书架文件"[^>]*><svg/);
  assert.ok(html.includes('role="tooltip">打开书架文件'));
  assert.ok(html.includes('aria-busy="true"'));
  const css = fs.readFileSync(path.join(frontend, 'src/styles/worldbook-entry-refresh.css'), 'utf8');
  assert.ok(!css.includes('wber-folder-guide'), 'remove unused guide styles');
  assert.ok(css.includes('.wber-folder-action:focus-within'));
  const managerSource = fs.readFileSync(path.join(frontend, 'src/components/WorldBookManager.tsx'), 'utf8');
  assert.ok(!managerSource.includes('useScopePreview'), 'entry page must not request an unused scope preview');
  console.log('PASS: shelf entry, retry/recovery, visibility/focus, deduplication, cleanup/remount, loading SSR and accessible SVG.');
}
async function serve() {
  process.chdir(frontend);
  const { createServer } = await import(pathToFileURL(path.join(path.dirname(fromFrontend.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import WorldBookManager from '/src/components/WorldBookManager.tsx';
import '/src/style.css';
const book=(id,name)=>({id,name,description:'隔离验收数据，不连接本地书或在线服务。',book_type:'story',schema_version:3,enabled:true,edit_revision:1,entries:[],categories:[],entry_groups:[],entry_group_map:{},entry_layout:[],entry_order:[],stat_fields:[],import_config:{revision:1},dependency_rules:{roots:[]},dependency_edges:[],related_edges:[]});
const initial=[book('first','自动载入的世界书'),book('second','第二本世界书')];
const largeBook=()=>{const value=book('large','254 条目加载验收');value.entries=Array.from({length:254},(_,i)=>({uid:'entry-'+i,name:'测试条目 '+i,content:'隔离测试正文 '+i,enabled:true,always_active:true,position:0,trigger_keys:[],secondary_keys:[],category_id:'unclassified',probability:100}));value.entry_count=254;return value;};
let books=[...initial], calls=0, failures=0, delay=400, notify=()=>{};
const api={listWorldbooks:async()=>{calls++;notify();await new Promise(r=>setTimeout(r,delay));if(failures-->0)throw Error('测试：服务暂未就绪');return {books:[...books]};},getWorldbook:async id=>structuredClone(books.find(b=>b.id===id)),getWorldbookDir:async()=>({path:'D:/fixture/worldbooks/books'})};
api.updateWorldbookEntry=async(id,uid,payload)=>{const b=books.find(b=>b.id===id);if(payload.expected_revision!==b.edit_revision)throw Error('revision conflict');const e=b.entries.find(e=>e.uid===uid);Object.assign(e,payload);b.edit_revision++;return {entry:structuredClone(e),edit_revision:b.edit_revision};};
function Fixture(){
 const [mounted,setMounted]=useState(true),[version,setVersion]=useState(0),[,render]=useState(0);
 notify=()=>render(n=>n+1);
 const scenario=(kind)=>{calls=0;failures=kind==='retry'?1:0;delay=kind==='slow'?8000:400;books=kind==='empty'?[]:kind==='large'?[largeBook(),...initial]:[...initial];setMounted(true);setVersion(n=>n+1);};
 return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
 <header style={{padding:8,display:'flex',flexWrap:'wrap',gap:8,fontSize:14}}>
 <strong>隔离 API mock</strong><output>列表请求 {calls}</output>
 <button onClick={()=>scenario('normal')}>正常载入</button><button onClick={()=>scenario('retry')}>首请求失败</button><button onClick={()=>scenario('slow')}>慢速载入</button><button onClick={()=>scenario('empty')}>空书架</button>
 <button onClick={()=>scenario('large')}>254 条目</button>
 <button onClick={()=>{books=[...initial,book('copied','文件夹新加入的书')];}}>模拟复制书</button>
 <button onClick={()=>window.dispatchEvent(new Event('focus'))}>模拟返回窗口</button>
 <button onClick={()=>setMounted(v=>!v)}>{mounted?'离开书架':'返回书架'}</button>
 <button onClick={()=>document.documentElement.classList.toggle('light')}>切换明暗</button>
 </header><section style={{flex:1,minHeight:0}}>{mounted&&<WorldBookManager key={version} __api={api}/>}</section></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const server = await createServer({ root: frontend, configFile: false, cacheDir: path.join(root, '.tmp-shelf-vite'),
    esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 5192, strictPort: true },
    plugins: [{ name: 'isolated-shelf-fixture',
      resolveId(id) { if (id === '/__shelf-fixture.tsx') return '\0shelf-fixture.tsx'; },
      load(id) { if (id === '\0shelf-fixture.tsx') return ts.transpileModule(fixture, {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: 'fixture.tsx',
      }).outputText; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>书架自动载入 · 隔离验收</title></head><body><div id="root"></div><script type="module" src="/__shelf-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(); console.log('Shelf fixture: http://127.0.0.1:5192 (mock API, no live writes)');
}
(process.argv.includes('--serve') ? serve() : tests()).catch(error => { console.error(error); process.exitCode = 1; });
