import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import type { EventEmitter } from "node:events";
import { WINDOW_PRESETS, type WindowPresetId, type WindowState } from "../src/shared/windowSettings";

export function registerWindowControls(win: BrowserWindow) {
  const emitter: EventEmitter = win;
  const [outerWidth, outerHeight] = win.getSize();
  const [contentWidth, contentHeight] = win.getContentSize();
  const frameWidth = outerWidth - contentWidth;
  const frameHeight = outerHeight - contentHeight;
  const [minimumWidth, minimumHeight] = win.getMinimumSize();
  let queue: Promise<unknown> = Promise.resolve();
  let appliedPreset: { id: WindowPresetId; width: number; height: number } | null = null;

  const getState = (): WindowState => {
    const [width, height] = win.getContentSize();
    const mode = win.isFullScreen() ? "fullscreen" : win.isMaximized() ? "maximized" : "windowed";
    return {
      width, height, mode,
      presetId: mode !== "windowed" ? null : appliedPreset?.width === width && appliedPreset.height === height
        ? appliedPreset.id : WINDOW_PRESETS.find(p => p.width === width && p.height === height)?.id ?? null,
    };
  };

  const authorize = (event: IpcMainInvokeEvent) => {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("窗口请求来源无效");
    }
  };

  const transition = (eventName: "leave-full-screen" | "unmaximize" | "maximize" | "enter-full-screen", action: () => void) =>
    new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        emitter.removeListener(eventName, done);
        reject(new Error("窗口模式切换超时，请重试"));
      }, 2500);
      emitter.once(eventName, done);
      try { action(); }
      catch (error) { clearTimeout(timer); emitter.removeListener(eventName, done); reject(error); }
    });

  const restore = async () => {
    if (win.isFullScreen()) await transition("leave-full-screen", () => win.setFullScreen(false));
    if (win.isMaximized()) await transition("unmaximize", () => win.unmaximize());
  };

  const enqueue = (action: () => Promise<WindowState>) => {
    const pending = queue.then(action);
    queue = pending.catch(() => undefined);
    return pending;
  };

  ipcMain.handle("get-window-state", (event) => { authorize(event); return getState(); });
  ipcMain.handle("set-window-preset", (event, id: unknown) => {
    authorize(event);
    const preset = WINDOW_PRESETS.find(p => p.id === id);
    if (!preset) throw new Error("不支持的窗口尺寸");
    return enqueue(async () => {
      await restore();
      // 显示缩放和窗口装饰会减少逻辑工作区；预设始终可选，较大尺寸适配屏幕。
      // 恢复可能回到另一显示器，使用恢复后的目标工作区。
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      const ratio = Math.min(1, (area.width - frameWidth - 2) / preset.width, (area.height - frameHeight - 2) / preset.height);
      const width = Math.floor(preset.width * ratio);
      const height = Math.floor(preset.height * ratio);
      appliedPreset = { id: preset.id, width, height };
      // 高 DPI 小工作区可能小于常规最小窗口；避免最小尺寸将适配结果重新撑大。
      win.setMinimumSize(Math.min(minimumWidth, width + frameWidth), Math.min(minimumHeight, height + frameHeight));
      // 先定位再调整内容区，避免 Windows 缩放下 setPosition 再次舍入尺寸。
      win.setPosition(Math.round(area.x + (area.width - width - frameWidth) / 2), Math.round(area.y + (area.height - height - frameHeight) / 2));
      win.setContentSize(width, height);
      // 部分缩放比例会将适配尺寸舍入到相邻逻辑像素，记录系统实际采用的尺寸。
      const [actualWidth, actualHeight] = win.getContentSize();
      appliedPreset = { id: preset.id, width: actualWidth, height: actualHeight };
      return getState();
    });
  });
  ipcMain.handle("set-window-mode", (event, mode: unknown) => {
    authorize(event);
    if (!["windowed", "maximized", "fullscreen"].includes(mode as string)) throw new Error("不支持的窗口模式");
    return enqueue(async () => {
      if (getState().mode !== mode) {
        await restore();
        if (mode === "maximized") await transition("maximize", () => win.maximize());
        if (mode === "fullscreen") await transition("enter-full-screen", () => win.setFullScreen(true));
      }
      return getState();
    });
  });

  const broadcast = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("window-state-changed", getState());
  };
  const events = ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "move"] as const;
  for (const event of events) emitter.on(event, broadcast);
  screen.on("display-metrics-changed", broadcast);
  win.once("closed", () => {
    screen.removeListener("display-metrics-changed", broadcast);
    for (const channel of ["get-window-state", "set-window-preset", "set-window-mode"]) ipcMain.removeHandler(channel);
  });
}
