/**
 * Preload 脚本 — 桥接主进程和渲染进程
 */

import { contextBridge, ipcRenderer } from "electron";
import type { WindowMode, WindowPresetId, WindowState } from "../src/shared/windowSettings";

contextBridge.exposeInMainWorld("electronAPI", {
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke("get-backend-url"),
  openDirectory: (dirPath: string): Promise<{ success: boolean; error: string }> =>
    ipcRenderer.invoke("open-directory", dirPath),
  getWindowState: (): Promise<WindowState> => ipcRenderer.invoke("get-window-state"),
  setWindowPreset: (id: WindowPresetId): Promise<WindowState> => ipcRenderer.invoke("set-window-preset", id),
  setWindowMode: (mode: WindowMode): Promise<WindowState> => ipcRenderer.invoke("set-window-mode", mode),
  onWindowStateChange: (callback: (state: WindowState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WindowState) => callback(state);
    ipcRenderer.on("window-state-changed", listener);
    return () => { ipcRenderer.removeListener("window-state-changed", listener); };
  },
});
