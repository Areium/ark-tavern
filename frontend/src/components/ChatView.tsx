/**
 * 对话页（沉浸式）—— 全屏无 sidebar。
 *
 * 顶栏：左侧「返回大厅 / 主菜单」+ 场景面板开合；中间会话名与模式；右侧布局切换（记录 / 舞台）。
 * 主体：左侧场景面板（图标栏 + 当前页，页签由插件注册表提供）+ 右侧对话区。
 * 原「会话资源」右侧面板已并入场景面板的「资源」页，原顶栏的「收起面板」改到左侧，
 * 收起的正是它旁边那块面板。
 */
import { useAppStore } from "../stores/appStore";
import ChatPanel from "./ChatPanel";
import ScenePanel from "./scene/ScenePanel";
import AppIcon from "./AppIcon";
import "../plugins";
import "../styles/chat.css";

export default function ChatView() {
  const {
    setCurrentView, chatMode, setChatMode, activeSessionId, sessions,
    scenePanelOpen, setScenePanelOpen, chatLayout, setChatLayout,
  } = useAppStore();

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="chat-view flex flex-col h-full">
      {/* ═══ 沉浸式顶栏 ═══ */}
      <div className="chat-topbar">
        <button
          type="button"
          onClick={() => setCurrentView("sessions")}
          className="chat-topbar-btn is-back"
          title="退出会话，返回会话大厅（调节世界书 / 阵容 / 设置）"
        >
          <AppIcon name="back" size={15} />
          <span>返回大厅</span>
        </button>
        <button
          type="button"
          onClick={() => setCurrentView("home")}
          className="chat-topbar-btn is-icon"
          title="返回主菜单"
          aria-label="返回主菜单"
        >
          <AppIcon name="home" size={15} />
        </button>

        <span className="chat-topbar-sep" />

        {/* 场景面板开合：按钮在左，收起的正是左侧面板 */}
        <button
          type="button"
          onClick={() => setScenePanelOpen(!scenePanelOpen)}
          className={`chat-topbar-btn ${scenePanelOpen ? "" : "is-on"}`}
          title={scenePanelOpen ? "收起场景面板，全屏沉浸" : "展开场景面板"}
          aria-pressed={scenePanelOpen}
        >
          <AppIcon name={scenePanelOpen ? "collapseAll" : "expandAll"} size={14} className="rotate-90" />
          <span>{scenePanelOpen ? "收起面板" : "场景面板"}</span>
        </button>

        <div className="flex-1 min-w-0 flex items-center justify-center gap-2 px-2">
          {activeSession && (
            <span className="chat-topbar-title" title={activeSession.name || "未命名会话"}>
              {activeSession.name || "未命名会话"}
            </span>
          )}
          <div className="chat-mode-switch" role="group" aria-label="对话模式">
            <button type="button" aria-pressed={chatMode === "story"} className="is-story" onClick={() => setChatMode("story")}>剧情</button>
            <button type="button" aria-pressed={chatMode === "free"} className="is-free" onClick={() => setChatMode("free")}>自由</button>
          </div>
        </div>

        {/* 布局：消息流 / 舞台 */}
        <div className="chat-layout-switch" role="group" aria-label="对话布局">
          <button type="button" aria-pressed={chatLayout === "log"} onClick={() => setChatLayout("log")} title="消息流：完整的对话记录">
            <AppIcon name="docs" size={13} /><span>记录</span>
          </button>
          <button type="button" aria-pressed={chatLayout === "stage"} onClick={() => setChatLayout("stage")} title="舞台：背景 + 立绘 + 对话框，逐句推进">
            <AppIcon name="characters" size={13} /><span>舞台</span>
          </button>
        </div>
      </div>

      {/* ═══ 主体 ═══ */}
      <div className="flex flex-1 min-h-0">
        <ScenePanel />
        <div className="flex-1 flex flex-col min-w-0">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
