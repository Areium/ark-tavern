// Isolated Electron window with production preload/window controls and fixture APIs.
// PLAYWRIGHT_MODULE points at an existing Playwright package; no new dependencies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const out = path.join(root, ".tmp/stage-window-qa");
fs.mkdirSync(out, { recursive: true });
fromFrontend("esbuild").buildSync({entryPoints:[path.join(root,"frontend/electron/windowControls.ts")],
  outfile:path.join(out,"windowControls.cjs"),bundle:true,platform:"node",format:"cjs",external:["electron"]});
const entry = path.join(out, "main.cjs");
fs.writeFileSync(entry, `const {app,BrowserWindow,ipcMain,Menu}=require('electron');
const {registerWindowControls}=require('./windowControls.cjs');
app.setPath('userData',${JSON.stringify(path.join(out,"profile"))});
app.whenReady().then(()=>{
 Menu.setApplicationMenu(null);
 ipcMain.handle('get-backend-url',()=> '');
 const win=new BrowserWindow({width:1400,height:900,useContentSize:true,autoHideMenuBar:true,title:'Stage Reading QA - isolated',
 webPreferences:{preload:${JSON.stringify(path.join(root,"frontend/dist-electron/preload.js"))},contextIsolation:true,nodeIntegration:false}});
 registerWindowControls(win); win.on('page-title-updated',event=>event.preventDefault());
 win.loadURL('data:text/html,<title>Stage QA loading</title>');
}); app.on('window-all-closed',()=>app.quit());`);

(async () => {
  const electron = await _electron.launch({executablePath:fromFrontend("electron"),args:[entry]});
  try {
    const page = await electron.firstWindow({timeout:10000});
    const errors=[]; page.on("pageerror", error=>errors.push(String(error)));
    const session={id:"native-stage-qa",name:"舞台窗口验收",mode:"story",characters:[],player_identity:"玩家",narration_count:1,combat_mode:"narrative",worldbook_ids:[]};
    await page.route("**/api/**", async route=>{
      const pathname=new URL(route.request().url()).pathname;
      let body={};
      if (pathname.endsWith('/config')) body={theme:"dark",skin:"default"};
      else if (pathname==='/api/sessions') body=[session];
      else if (pathname==='/api/sessions/native-stage-qa') body=session;
      else if (pathname.endsWith('/memories')) body={memories:[],narration_count:1};
      else if (pathname.endsWith('/characters')) body={characters:[],character_colors:{}};
      else if (pathname.endsWith('/stage')) body={session_id:session.id,location:"房间",weather:"晴",time:"夜晚",atmosphere:[],
        background:{url:null,source:"none",bg_id:""},characters:[],player:{name:"玩家",skin_url:null,avatar_url:null,color:null}};
      await route.fulfill({json:body});
    });
    await page.goto(process.env.STAGE_STREAM_URL || "http://127.0.0.1:5197");
    const raw="灯光落在窗边，她抱着猫玩偶。".repeat(36);
    await page.evaluate(async ({session,raw})=>{
      const {useAppStore}=await import('/src/stores/appStore.ts'); window.qaStore=useAppStore;
      useAppStore.setState({currentView:'chat',chatMode:'story',activeSessionId:session.id,sessions:[session],
        chatLayout:'stage',scenePanelOpen:false,theme:'dark',skin:'default',
        sessionStreaming:{[session.id]:true},sessionMessages:{[session.id]:[{role:'narrator',content:raw,
          previewContent:raw,generationId:'native-generation',generationPhase:'processing',streaming:true,round:2}]}});
    },{session,raw});
    const dialog=page.locator('.stage-dialog');
    await dialog.waitFor(); await dialog.press('End');
    const anchorText=await page.locator('.stage-dialog-text').innerText();
    const states=[];
    async function inspect(label,state) {
      await page.waitForFunction(async()=>{const s=await electronAPI.getWindowState(); return Math.abs(innerWidth-s.width)<=1 && Math.abs(innerHeight-s.height)<=1;},undefined,{timeout:10000});
      state=await page.evaluate(()=>electronAPI.getWindowState());
      const box=await dialog.boundingBox();
      assert.ok(box.y>=0 && box.y+box.height<=state.height+1,`${label}: dialogue cropped`);
      assert.equal(await page.locator('.stage-dialog-text').innerText(),anchorText,`${label}: reading reset`);
      assert.ok((await page.locator('.stage-progress').innerText()).includes('整理中'));
      await page.screenshot({path:path.join(out,`${label}.png`)});
      states.push({label,...state});
    }
    for (const id of ["1280x720","1400x900","1600x900","1920x1080","2560x1440"]) {
      const state=await page.evaluate(id=>electronAPI.setWindowPreset(id),id);
      assert.equal(state.mode,"windowed");
      assert.equal(state.presetId,id);
      await inspect(id,state);
    }
    for (const mode of ["maximized","fullscreen","windowed"]) {
      const state=await page.evaluate(mode=>electronAPI.setWindowMode(mode),mode);
      assert.equal(state.mode,mode); await inspect(mode,state);
    }
    await page.evaluate(()=>qaStore.setState(state=>({sessionStreaming:{},sessionMessages:{'native-stage-qa':
      state.sessionMessages['native-stage-qa'].map(m=>({...m,streaming:false,generationPhase:'complete'}))}})));
    await page.waitForFunction(()=>!document.querySelector('.stage-progress').textContent.includes('整理中'));
    assert.equal(await page.locator('.stage-dialog-text').innerText(),anchorText);
    assert.deepEqual(errors,[]);
    const report={states,page_errors:errors,boundary:"isolated native Electron with production preload and windowControls; fixture narrative/API, no real saves"};
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    if (process.env.STAGE_QA_HOLD==='1') await new Promise(resolve=>setTimeout(resolve,45000));
  } finally { await electron.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
