// Native window controller contract tests; run with node scripts/test_window_controls.cjs.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('../frontend/node_modules/esbuild');

const handlers = new Map();
const display = new EventEmitter();
display.area = { width: 3840, height: 2160 };
display.getDisplayMatching = () => ({ workAreaSize: display.area, workArea: { x: 0, y: 0, ...display.area } });
const ipcMain = {
  handle: (name, handler) => handlers.set(name, handler),
  removeHandler: name => handlers.delete(name),
};
const compiled = buildSync({ entryPoints: [path.join(__dirname, '../frontend/electron/windowControls.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text;
const moduleScope = { exports: {} };
vm.runInNewContext(compiled, { module: moduleScope, exports: moduleScope.exports,
  require: name => name === 'electron' ? { ipcMain, screen: display } : require(name), setTimeout, clearTimeout });

class TestWindow extends EventEmitter {
  constructor() {
    super(); this.size = [1400, 900]; this.normal = [...this.size]; this.mode = 'windowed'; this.destroyed = false;
    this.minimum = [1000, 600];
    this.messages = [];
    this.webContents = { mainFrame: {}, isDestroyed: () => this.destroyed,
      send: (channel, state) => this.messages.push({ channel, state }) };
  }
  getSize() { return [this.size[0] + 16, this.size[1] + 39]; }
  getContentSize() { return [...this.size]; }
  getMinimumSize() { return [...this.minimum]; }
  setMinimumSize(width, height) { this.minimum = [width, height]; }
  getBounds() { return { x: 0, y: 0, width: this.size[0] + 16, height: this.size[1] + 39 }; }
  isDestroyed() { return this.destroyed; }
  isFullScreen() { return this.mode === 'fullscreen'; }
  isMaximized() { return this.mode === 'maximized'; }
  setContentSize(width, height) {
    this.size = [Math.max(width, this.minimum[0] - 16), Math.max(height, this.minimum[1] - 39)];
    this.normal = [...this.size]; this.emit('resize');
  }
  // Model the Windows DPI rounding observed when moving a sized window.
  setPosition() { this.size = [this.size[0] + 2, this.size[1] + 1]; this.emit('move'); }
  setFullScreen(on) {
    this.mode = on ? 'fullscreen' : 'windowed';
    this.size = on ? [3840, 2160] : [...this.normal];
    setTimeout(() => this.emit(on ? 'enter-full-screen' : 'leave-full-screen'), 5);
  }
  maximize() { this.mode = 'maximized'; this.size = [3824, 2121]; setTimeout(() => this.emit('maximize'), 5); }
  unmaximize() { this.mode = 'windowed'; this.size = [...this.normal]; setTimeout(() => this.emit('unmaximize'), 5); }
}

(async () => {
  const win = new TestWindow();
  moduleScope.exports.registerWindowControls(win);
  const sender = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const call = (name, arg, event = sender) => Promise.resolve().then(() => handlers.get(name)(event, arg));
  const get = () => call('get-window-state');
  assert.equal((await get()).presetId, '1400x900');
  for (const id of ['1280x720', '1400x900', '1600x900', '1920x1080', '2560x1440']) {
    const result = await call('set-window-preset', id);
    assert.equal(`${result.width}x${result.height}`, id);
    assert.equal(result.presetId, id);
    assert.equal(result.mode, 'windowed');
  }
  for (const mode of ['maximized', 'fullscreen', 'windowed']) {
    assert.equal((await call('set-window-mode', mode)).mode, mode);
  }
  const operations = await Promise.all([call('set-window-mode', 'fullscreen'), call('set-window-preset', '1280x720')]);
  assert.equal(operations[0].mode, 'fullscreen');
  assert.equal(operations[1].mode, 'windowed');
  assert.deepEqual(win.getContentSize(), [1280, 720]);
  await assert.rejects(call('set-window-preset', { width: 99999 }), /不支持/);
  await assert.rejects(call('set-window-mode', 'invalid'), /不支持/);
  await assert.rejects(call('get-window-state', undefined, { sender: {}, senderFrame: {} }), /来源/);
  await assert.rejects(call('set-window-preset', '1400x900', { sender: win.webContents, senderFrame: {} }), /来源/);
  display.area = { width: 1366, height: 768 };
  display.emit('display-metrics-changed');
  const fitted = await call('set-window-preset', '2560x1440');
  assert.equal(fitted.presetId, '2560x1440');
  assert.ok(fitted.width + 16 <= display.area.width && fitted.height + 39 <= display.area.height);
  win.setContentSize(1300, 700); // User resize stays custom, no preset snap.
  assert.equal((await get()).width, 1300);
  assert.equal((await get()).presetId, null);
  assert.equal(win.messages.at(-1).state.width, 1300);
  display.area = { width: 3840, height: 2160 };
  await call('set-window-mode', 'maximized');
  const originalRestore = win.unmaximize.bind(win);
  win.unmaximize = () => { originalRestore(); display.area = { width: 1366, height: 768 }; };
  const restoredFit = await call('set-window-preset', '2560x1440');
  assert.equal(restoredFit.presetId, '2560x1440');
  assert.ok(restoredFit.width + 16 <= 1366 && restoredFit.height + 39 <= 768);
  display.area = { width: 1024, height: 536 };
  const tinyFit = await call('set-window-preset', '2560x1440');
  assert.equal(tinyFit.presetId, '2560x1440');
  assert.ok(tinyFit.width + 16 <= 1024 && tinyFit.height + 39 <= 536);
  win.destroyed = true; win.emit('closed');
  assert.equal(handlers.size, 0);
  assert.equal(display.listenerCount('display-metrics-changed'), 0);
  console.log('Window controls: 5 presets, 3 modes, queued transitions, IPC validation, screen fitting, resize and cleanup passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
