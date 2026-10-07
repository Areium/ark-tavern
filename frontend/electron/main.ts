/**
 * Electron 主进程
 *
 * 职责:
 * - 窗口管理
 * - Python 后端子进程生命周期管理
 * - IPC 通信桥接
 */

import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { PythonProcessManager } from "./processManager";
import path from "path";
import { DEFAULT_WINDOW_PRESET } from "../src/shared/windowSettings";
import { registerWindowControls } from "./windowControls";

let mainWindow: BrowserWindow | null = null;
let processManager: PythonProcessManager | null = null;

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const BACKEND_PORT = 5000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
// 窗口/任务栏图标：开发时读 public/，打包后读 dist/
const LOGO_PATH = path.join(
  __dirname,
  isDev ? "../public/logo.png" : "../dist/logo.png"
);

/** 只放行 http(s) 外链，交给系统浏览器打开；其他协议一律拒绝 */
async function openExternal(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 供原生测试直接调用/断言，不参与运行时逻辑：
 * `scripts/test_external_links_electron.cjs` 在 stub 过的 Electron 环境里加载本模块。
 */
export const __mainTestExports = { openExternal };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_PRESET.width,
    height: DEFAULT_WINDOW_PRESET.height,
    useContentSize: true,
    minWidth: 1000,
    minHeight: 600,
    title: "Ark Tavern",
    icon: LOGO_PATH,
    backgroundColor: "#0f1117",
    // 不显示系统菜单栏（默认菜单 File/Edit/View/Window/Help 与本项目无关）
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  // 外链一律交给系统浏览器，不在应用内开新窗口。
  // 教程、许可全文、源码地址等都是 http(s) 链接，默认行为会创建一个
  // 带默认 webPreferences 的 Electron 窗口，既危险也不是预期的「打开网页」。
  // 先于窗口控制注册，保证外链处理不依赖窗口尺寸模块的初始化结果。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  registerWindowControls(mainWindow);

  // 窗口准备好后再显示（避免白屏闪烁）
  mainWindow.once("ready-to-show", () => {
    // Windows 显示缩放可能舍入首次创建的内容区，在显示前归一到设计基准。
    mainWindow?.setContentSize(DEFAULT_WINDOW_PRESET.width, DEFAULT_WINDOW_PRESET.height);
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Python 后端管理 ──

function getPythonProjectRoot(): string {
  // Electron app 在 frontend/ 下，Python 项目在上级目录
  return path.resolve(app.getAppPath(), "..");
}

function startBackend() {
  const projectRoot = getPythonProjectRoot();
  processManager = new PythonProcessManager({
    projectRoot,
    port: BACKEND_PORT,
  });

  processManager.start();
}

// ── IPC 处理 ──

ipcMain.handle("get-backend-url", () => {
  // 开发模式使用 Vite 代理（同源请求），生产模式直连 Flask
  return isDev ? "" : BACKEND_URL;
});

ipcMain.handle("open-directory", async (_event, dirPath: string) => {
  const result = await shell.openPath(dirPath);
  return { success: !result, error: result || "" };
});

ipcMain.handle("open-external", (_event, url: string) => openExternal(url));

// ── 应用生命周期 ──

app.whenReady().then(() => {
  // 全局清空应用菜单（必须在创建窗口前）：避免默认的 File/Edit/View/Window/Help
  Menu.setApplicationMenu(null);
  createWindow();
  startBackend();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  processManager?.stop();
});
