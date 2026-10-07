// Real Electron check for external-link handling in the main process.
// Run with: node scripts/test_external_links_electron.cjs
//
// Covers the plumbing behind the in-app AGPL license entry:
//   - a renderer <a target="_blank"> is denied as a window and handed to the OS browser
//   - non-http(s) protocols are refused
//   - the "open-external" IPC channel behaves the same way
// The Python backend is stubbed and shell.openExternal is recorded instead of executed,
// so no browser window and no server process is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('../frontend/node_modules/electron'), [__filename], {
    env: environment, timeout: 60000, encoding: 'utf8', windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
} else {
  const { app } = require('electron');

  // Keep the run out of the user's profile/window state.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ark-external-links-')));

  const setupPath = path.join(__dirname, '..', '.tmp', 'main-external-links.cjs');
  const reportPath = path.join(__dirname, '..', '.tmp', 'external-links-report.json');
  const setup = require(setupPath);
  const { openExternal, ipcHandlers, opened } = setup;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  (async () => {
    await setup.waitForReady();
    const windowOpenHandler = setup.windowOpenHandler;
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? null });

    check('window open handler is registered on the main window', typeof windowOpenHandler === 'function');
    check('no Python backend was started by this test', setup.backendStarts === 0, `starts=${setup.backendStarts}`);

    // 1. renderer <a target="_blank"> → denied window + OS browser
    opened.length = 0;
    const decision = typeof windowOpenHandler === 'function'
      ? windowOpenHandler({ url: 'https://github.com/Areium/ark-tavern/blob/main/LICENSE' })
      : null;
    check('target=_blank is denied as an Electron window', decision?.action === 'deny', JSON.stringify(decision));
    await settle();
    check('license URL reached shell.openExternal',
      opened.length === 1 && opened[0] === 'https://github.com/Areium/ark-tavern/blob/main/LICENSE',
      JSON.stringify(opened));

    // 2. non-http(s) protocols refused, both through the helper and the handler
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'not a url']) {
      opened.length = 0;
      const ok = await openExternal(url);
      await settle();
      check(`helper refuses ${url}`, ok === false && opened.length === 0, `ok=${ok} opened=${JSON.stringify(opened)}`);
    }
    opened.length = 0;
    if (typeof windowOpenHandler === 'function') windowOpenHandler({ url: 'file:///C:/Windows/System32/calc.exe' });
    await settle();
    check('handler refuses file:// links', opened.length === 0, JSON.stringify(opened));

    // 3. http(s) allowed through the shared helper
    opened.length = 0;
    const httpsOk = await openExternal('https://www.gnu.org/licenses/agpl-3.0.html');
    await settle();
    check('allows https through the helper',
      httpsOk === true && opened.length === 1 && opened[0] === 'https://www.gnu.org/licenses/agpl-3.0.html',
      JSON.stringify(opened));

    // 4. the IPC channel used by the renderer behaves the same
    const channel = ipcHandlers.get('open-external');
    check('open-external IPC handler is registered', typeof channel === 'function');
    if (typeof channel === 'function') {
      opened.length = 0;
      const viaIpc = await channel({ sender: null }, 'https://github.com/Areium/ark-tavern');
      const refused = await channel({ sender: null }, 'ftp://example.com/x');
      await settle();
      check('IPC opens https and refuses ftp',
        viaIpc === true && refused === false && opened.length === 1 && opened[0] === 'https://github.com/Areium/ark-tavern',
        `viaIpc=${viaIpc} refused=${refused} opened=${JSON.stringify(opened)}`);
    }

    const failures = checks.filter((entry) => !entry.ok);
    fs.writeFileSync(reportPath, JSON.stringify({ electron: process.versions.electron, checks, failures: failures.length }, null, 2));
    for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : ' :: ' + entry.detail}`);
    console.log(failures.length === 0 ? 'external-link checks passed' : `${failures.length} external-link check(s) failed`);
    app.exit(failures.length === 0 ? 0 : 1);
  })().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
