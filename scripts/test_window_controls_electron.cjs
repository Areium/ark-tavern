// Real Electron IPC/geometry check without starting a backend or using a user's profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { buildSync } = require('../frontend/node_modules/esbuild');
  const { spawnSync } = require('node:child_process');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-window-check-'));
  for (const [entry, output] of [['windowControls.ts', 'controls.cjs'], ['preload.ts', 'preload.cjs']]) {
    buildSync({ entryPoints: [path.join(__dirname, '../frontend/electron', entry)], bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(scratch, output) });
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('../frontend/node_modules/electron'), [__filename, scratch],
    { env: environment, timeout: 20000, encoding: 'utf8', windowsHide: true });
  const reportPath = path.join(scratch, 'report.json');
  if (fs.existsSync(reportPath)) console.log(fs.readFileSync(reportPath, 'utf8'));
  else console.error(result.stderr || result.error || 'No native window report');
  process.exitCode = result.status === 0 && fs.existsSync(reportPath) ? 0 : 1;
  if (!path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep + 'ark-window-check-')) throw new Error('Unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
} else {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const scratch = process.argv[2];
  app.setPath('userData', scratch);
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const reportingPreload = path.join(scratch, 'reporting-preload.cjs');
    fs.writeFileSync(reportingPreload, fs.readFileSync(path.join(scratch,'preload.cjs'),'utf8') +
      ";require('electron').contextBridge.exposeInMainWorld('testReport',r=>require('electron').ipcRenderer.invoke('native-test-report',r));require('electron').contextBridge.exposeInMainWorld('testReady',()=>require('electron').ipcRenderer.invoke('native-test-ready'));require('electron').contextBridge.exposeInMainWorld('testCustomSize',()=>require('electron').ipcRenderer.invoke('native-test-custom-size'));");
    const win = new BrowserWindow({width:1400,height:900,useContentSize:true,minWidth:1000,minHeight:600,show:false,
      webPreferences:{preload:reportingPreload,contextIsolation:true,nodeIntegration:false}});
    require(path.join(scratch, 'controls.cjs')).registerWindowControls(win);
    ipcMain.handle('native-test-ready', () => win.isVisible() ? true : new Promise(resolve => win.once('show', () => resolve(true))));
    ipcMain.handle('native-test-custom-size', () => {
      assert.equal(win.isResizable(), true);
      win.setContentSize(1300, 700);
      return win.getContentSize();
    });
    ipcMain.handle('native-test-report', (event, report) => {
      assert.equal(event.sender, win.webContents);
      fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));
      win.destroy(); app.exit(report.error ? 1 : 0);
    });
    const html = `<script>
      (async()=>{
        const report={presets:[],modes:[],adapted:[]};
        const assert=(ok,message)=>{if(!ok)throw new Error(message)};
        try{
          await window.testReady();
          const api=window.electronAPI;
          let updates=0;const unsubscribe=api.onWindowStateChange(()=>updates++);
          for(const id of ['1280x720','1400x900','1600x900','1920x1080','2560x1440']){
              const state=await api.setWindowPreset(id);
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              assert(state.presetId===id,'Selected preset was lost after fitting '+JSON.stringify(state));
              assert(innerWidth===state.width&&innerHeight===state.height,'Viewport '+innerWidth+'x'+innerHeight+' differs from content '+state.width+'x'+state.height);
              const adapted=state.width+'x'+state.height!==id;
              assert(state.fitted===adapted,'fitted flag disagrees with actual size '+JSON.stringify(state));
              report.presets.push(id);
              if(adapted)report.adapted.push({id,actual:[state.width,state.height]});
          }
          const actualCustom=await window.testCustomSize();
          const custom=await api.getWindowState();
          assert(custom.width===actualCustom[0]&&custom.height===actualCustom[1]&&custom.presetId===null&&custom.fitted===false,'Custom size snapped to preset');
          report.customSize=[custom.width,custom.height];
          for(const mode of ['maximized','fullscreen','windowed']){
            const state=await api.setWindowMode(mode);assert(state.mode===mode,'Incorrect native mode');report.modes.push(mode);
          }
          assert(updates>0,'No native state events');unsubscribe();
        }catch(error){report.error=error.message}
        // Test-only renderer report channel, absent from production preload.
        window.testReport(report);
      })();
    </script>`;
    win.once('ready-to-show',()=>{win.show();win.showInactive()});
    win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  }).catch(error=>{console.error(error);app.exit(1)});
}
