/**
 * 对话页（沉浸式）—— 全屏无 sidebar。
 *
 * 顶栏：左侧「返回大厅 / 主菜单」+ 场景面板开合；中间会话名与模式；右侧布局切换（记录 / 舞台）。
 * 主体：左侧场景面板（图标栏 + 当前页，页签由插件注册表提供）+ 右侧对话区。
 * 原「会话资源」右侧面板已并入场景面板的「资源」页，原顶栏的「收起面板」改到左侧，
 * 收起的正是它旁边那块面板。
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { audioManager } from "../audio/audioManager";
import ChatPanel from "./ChatPanel";
import ScenePanel from "./scene/ScenePanel";
import AppIcon from "./AppIcon";
import "../plugins";
import "../styles/chat.css";
import "../styles/session-story-graph.css";

export default function ChatView() {
  const {
    setCurrentView, chatMode, setChatMode, activeSessionId, sessions,
    scenePanelOpen, setScenePanelOpen, chatLayout, setChatLayout, currentView,
  } = useAppStore();

  const [stageOnly, setStageOnly] = useState(false);
  const [musicMuted, setMusicMuted] = useState(() => audioManager.getSettings().muted);
  // ChatView 常驻挂载。返回同一会话时补拉在后台完成的角色、环境、数值与回忆。
  useEffect(() => {
    if (currentView !== "chat") return;
    const store = useAppStore.getState();
    if (!store.activeSessionId) return;
    store.triggerCharacterRefresh();
    store.triggerEnvRefresh();
    store.triggerStatsRefresh();
    store.triggerMemoryRefresh();
  }, [currentView]);
  useEffect(() => {
    if (chatLayout !== "stage" || currentView !== "chat") setStageOnly(false);
    if (currentView === "chat") setMusicMuted(audioManager.getSettings().muted);
  }, [chatLayout, currentView]);

  const toggleMusic = () => {
    const next = !audioManager.getSettings().muted;
    audioManager.setMuted(next);
    setMusicMuted(next);
    if (!next && currentView === "chat") audioManager.startDialogueBgm();
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const graphAvailable = chatMode === "story" && activeSession?.mode === "story";
  useEffect(() => {
    if (chatLayout === "graph" && (chatMode !== "story" || (activeSession && activeSession.mode !== "story"))) setChatLayout("log");
  }, [chatMode, activeSession, chatLayout, setChatLayout]);

  return (
    <div className={`chat-view flex flex-col h-full ${stageOnly && chatLayout === "stage" ? "is-stage-only" : ""}`}>
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

        <div className="chat-session-heading flex-1 min-w-0 flex items-center justify-center gap-2 px-2">
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
          <button type="button" aria-label="记录" aria-pressed={chatLayout === "log"} onClick={() => setChatLayout("log")} title="消息流：完整的对话记录">
            <AppIcon name="docs" size={13} /><span>记录</span>
          </button>
          <button type="button" aria-label="舞台" aria-pressed={chatLayout === "stage"} onClick={() => setChatLayout("stage")} title="舞台：背景 + 立绘 + 对话框，逐句推进">
            <AppIcon name="characters" size={13} /><span>舞台</span>
          </button>
          {graphAvailable && (
            <button type="button" aria-label="节点图" aria-pressed={chatLayout === "graph"} onClick={() => setChatLayout("graph")} title="节点图：查看会话实时剧情轨迹">
              <AppIcon name="workflow" size={13} /><span>节点图</span>
            </button>
          )}
        </div>
        {chatLayout === "stage" && (
          <button type="button" className="chat-topbar-btn" onClick={() => setStageOnly(true)} title="只显示舞台" aria-label="进入纯舞台模式">
            <AppIcon name="maximize" size={14} /><span>纯舞台</span>
          </button>
        )}
        <button type="button" className="chat-topbar-btn is-icon" onClick={toggleMusic}
          title={musicMuted ? "开启背景音乐" : "静音背景音乐"} aria-label={musicMuted ? "开启背景音乐" : "静音背景音乐"}
          aria-pressed={!musicMuted}>
          <AppIcon name={musicMuted ? "volumeOff" : "volume"} size={15} />
        </button>
      </div>

      {/* ═══ 主体 ═══ */}
      <div className="flex flex-1 min-h-0">
        <ScenePanel />
        <div className="flex-1 flex flex-col min-w-0">
          <ChatPanel stageOnly={stageOnly && chatLayout === "stage"} onExitStageOnly={() => setStageOnly(false)}
            musicMuted={musicMuted} onToggleMusic={toggleMusic} />
        </div>
      </div>
    </div>
  );
}
