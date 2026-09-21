// Real Chromium + production React components. API responses are deterministic stubs.
// Run with a Vite web server on WB_UI_URL and PLAYWRIGHT_MODULE pointing to playwright.
//
// 本脚本覆盖：统一草稿的冲突保留、跨页签草稿一致、分类结构不调用旧写入接口、
// 切书的未保存确认对话框，以及「已删除的接口不再被调用」。
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.WB_UI_URL || 'http://127.0.0.1:5185';
const categories = [{id:'worldview',name:'世界观',scope_type:'worldview',parent_id:null},
  {id:'characters',name:'角色',scope_type:'character',parent_id:null},
  {id:'unclassified',name:'未分类',scope_type:'other',parent_id:null}];
const entry = (uid,name,content) => ({uid,name,content,category_id:'unclassified',enabled:true,trigger_keys:[]});
const detail = {id:'review',name:'返修验收书',enabled:true,book_type:'story',schema_version:3,scope_mode:'selective',
  updated_at:1,categories,import_config:{revision:1,fixed_entry_uids:[],dependency_sources:[]},
  dependency_rules:{roots:[{entry_uid:'a',activation:'roster_any',expansion:'requires_closure',character_ids:['A']}],
    rejected:[],edge_meta:{'a|b':{origin:'manual',locked:true}}},
  dependency_edges:[],related_edges:[{from_uid:'a',to_uid:'b'}],
  entries:[entry('a','角色甲设定','角色甲使用术式。'),entry('b','术式定义','术式的基础规则。')]};
const secondBook = {...detail,id:'second',name:'第二本书',updated_at:2,
  dependency_rules:{roots:[],rejected:[],edge_meta:{}},related_edges:[]};
(async()=>{
  const browser = await chromium.launch({headless:true,channel:process.env.WB_BROWSER || 'chrome'});
  const page = await browser.newPage({viewport:{width:1400,height:1000}});
  const errors = []; page.on('pageerror',e=>{errors.push(e.message); console.error('PAGE',e.message)});
  let previews=0, writes=[], oldWrites=0, removedEndpointHits=0;
  await page.route('**/api/**',async route=>{
    const req=route.request(), url=new URL(req.url()), p=url.pathname;
    let data={}; let status=200;
    if(p==='/api/worldbook') data={books:[detail,secondBook]};
    else if(p==='/api/worldbook/review') data=detail;
    else if(p==='/api/worldbook/second') data=secondBook;
    else if(p==='/api/characters') data=[{id:'A',name:'角色甲'}];
    else if(p.endsWith('/auto-classify')) {
      if(req.postDataJSON().apply) oldWrites++;
      data={matched:1,total:2,unmatched:[],unmatched_count:0,character_links:0,conflicts:[],signals:{},categories,
        draft_patch:{categories,entry_moves:{b:'worldview'},entry_updates:{}}};
    }
    // D-4 已删除的接口：任何一次命中都是回归
    else if(p.includes('/dependency-proposals')||p.includes('/worldbook-dependency-jobs')) {
      removedEndpointHits++; status=404; data={error:'接口已删除'};
    }
    else if(/\/entries\/|\/taxonomy$/.test(p)) {oldWrites++;}
    else if(p.endsWith('/avatar')) {await route.fulfill({status:404,body:''});return;}
    else if(p.endsWith('/scope-preview')) {previews++;data={entry_count:1,full_entry_count:2,scope:{resolved_entry_uids:['a']},
      full_estimated_tokens:20,resolved_estimated_tokens:10,saved_estimated_tokens:10,saved_percent:50,
      active_roots:[],resolved_edges:[],selection_reasons:{},display_tree:[],issues:[],warnings:[],breakdown:{}};}
    else if(p.endsWith('/configuration')) {writes.push(req.postDataJSON());status=409;data={error:'配置已变更，请重新加载后再保存'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.route('**/review-harness',route=>route.fulfill({contentType:'text/html',body:`
    <html><head><link rel="stylesheet" href="/src/style.css"></head><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
    window.__vite_plugin_react_preamble_installed__=true;
    const React=await import('/node_modules/.vite/deps/react.js');
    const DOM=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {default:Page}=await import('/src/components/WorldBookManager.tsx');
    DOM.default.createRoot(document.getElementById('root')).render(React.default.createElement(Page));</script></body></html>`}));
  await page.goto(base+'/review-harness');

  // ── 选中书 → 工作台页签可用 ──
  const bookCard = page.getByText('返修验收书',{exact:true});
  await bookCard.waitFor({timeout:10000});
  await bookCard.click();
  const loadTab = page.getByRole('button',{name:'分类与载入',exact:true});
  await loadTab.waitFor({timeout:10000});
  assert.equal(await page.getByRole('button',{name:'条目',exact:true}).getAttribute('aria-pressed'),'true',
    '默认落在「条目」页签');

  // ── 空转预览必须停下来（语义键防抖 + 过时响应保护） ──
  await page.waitForTimeout(700); const idle=previews;
  await page.waitForTimeout(1200); assert.equal(previews,idle,'idle preview must stop');
  assert.equal(await page.getByText('计算中…',{exact:true}).count(),0);

  // ── 分类与载入 → 分类结构：改动只进统一草稿，不调用旧写入接口 ──
  await loadTab.click();
  await page.getByRole('button',{name:'分类结构',exact:true}).click();
  await page.getByRole('button',{name:'自动分类',exact:true}).click();
  await page.getByRole('button',{name:/应用分类/}).click();
  await page.getByTitle('角色甲设定 · a',{exact:true}).click();
  await page.getByLabel('归属分类').selectOption('characters');
  await page.getByPlaceholder('角色目录名',{exact:true}).fill('A');
  await page.getByRole('button',{name:'保存归属',exact:true}).click();
  assert.equal(oldWrites,0,'分类结构里的改动不得调用旧写盘接口');

  // ── 保存 → 409 冲突：草稿必须完整保留 ──
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText(/保存被拒绝/).waitFor();
  assert.equal(writes.length,1);
  assert.equal(writes[0].entry_updates.a.character_id,'A');
  assert.equal(writes[0].entry_moves.b,'worldview');
  assert.equal('proposal' in writes[0],false,'AI 构建字段（proposal）不再随保存下发');
  assert.deepEqual(writes[0].related_edges,[{from_uid:'a',to_uid:'b'}]);

  // ── 跨页签切回：冲突提示与草稿都还在 ──
  await page.getByRole('button',{name:'条目',exact:true}).click();
  await loadTab.click();
  assert.ok(await page.getByText(/保存被拒绝/).isVisible(),'conflict preserves draft across tabs');
  await page.getByRole('button',{name:'分类结构',exact:true}).click();
  assert.ok(await page.getByText(/保存被拒绝/).isVisible(),'conflict preserves draft across sub-views');

  // ── 切书：有未保存改动 → 三选一对话框 ──
  await page.getByText('第二本书',{exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'切换世界书'});
  await dialog.waitFor();
  for(const name of ['保存并切换','放弃并切换','取消']) assert.ok(await dialog.getByRole('button',{name,exact:true}).isVisible());
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await dialog.count(),0);
  assert.ok(await page.getByRole('button',{name:'撤销',exact:true}).isVisible(),'取消后草稿仍在');

  // ── 撤销 → 回到已保存版本；此时切书不再需要确认 ──
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),false);
  await page.getByText('第二本书',{exact:true}).click();
  assert.equal(await dialog.count(),0,'干净草稿切书不弹确认');
  await page.getByDisplayValue('第二本书').waitFor();
  assert.equal(removedEndpointHits,0,'D-4 删除的接口不得再被调用');
  assert.deepEqual(errors,[]);

  if(process.env.WB_UI_SCREENSHOT) await page.screenshot({path:process.env.WB_UI_SCREENSHOT,fullPage:true});
  console.log(JSON.stringify({idlePreviews:idle,configurationWrites:writes.length,oldWrites,
    draftOnlyTaxonomy:true,conflictDraftPreserved:true,threeWayBookSwitch:true,removedEndpointHits,errors}));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
