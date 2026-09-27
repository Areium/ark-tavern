/**
 * 场景面板 —— 对话页左侧：竖向图标栏（页签）+ 当前面板内容。
 *
 * 页签来自插件注册表（`plugins/scenePanels.tsx`），内置面板与第三方面板同等对待；
 * 收起时只剩图标栏，点任一图标即展开到该页。面板内容包在 ErrorBoundary 里，
 * 第三方面板抛错不会拖垮整个对话页。
 */
import { useMemo, type CSSProperties } from "react";
import { useAppStore } from "../../stores/appStore";
import { useApi } from "../../hooks/useApi";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import {
  resolveScenePanelTab, useScenePanels, visibleScenePanels,
  type ScenePanelContext, type ScenePanelDefinition,
} from "../../plugins/scenePanels";
import AppIcon, { type AppIconName } from "../AppIcon";
import ErrorBoundary from "../ErrorBoundary";
import ResizeHandle from "../common/ResizeHandle";

function PanelIcon({ panel, size = 19 }: { panel: ScenePanelDefinition; size?: number }) {
  if (typeof panel.icon === "string") return <AppIcon name={panel.icon as AppIconName} size={size} />;
  const Custom = panel.icon;
  return <Custom size={size} />;
}

export default function ScenePanel() {
  const api = useApi();
  const panels = useScenePanels();
  const {
    activeSessionId, sessions, chatMode, scenePanelOpen, setScenePanelOpen, scenePanelTab, setScenePanelTab,
    envRefreshKey, memoryRefreshKey, chatRefreshKey, characterRefreshKey, statsRefreshKey, resourceVersion,
    triggerStatsRefresh, triggerEnvRefresh, triggerCharacterRefresh, triggerMemoryRefresh, bumpResourceVersion,
  } = useAppStore();

  const visible = useMemo(() => visibleScenePanels(panels, chatMode), [panels, chatMode]);
  const activeTab = resolveScenePanelTab(visible, ({ items: "characters", environment: "characters", stats: "characters", memory: "story" } as Record<string, string>)[scenePanelTab] || scenePanelTab);
  const active = visible.find((p) => p.id === activeTab) || null;
  const session = sessions.find((s) => s.id === activeSessionId) || null;

  const ctx = useMemo<ScenePanelContext | null>(() => {
    if (!activeSessionId) return null;
    const sid = activeSessionId;
    return {
      sessionId: sid,
      session,
      chatMode,
      api,
      refresh: {
        env: envRefreshKey, memory: memoryRefreshKey, chat: chatRefreshKey,
        character: characterRefreshKey, stats: statsRefreshKey, resource: resourceVersion,
      },
      stats: {
        list: () => api.getSessionCharacterStats(sid),
        set: async (name, values, replace = false) => {
          const saved = await api.saveSessionCharacterStats(sid, name, values, replace);
          triggerStatsRefresh();
          return saved;
        },
        reset: async (name) => {
          const saved = await api.resetSessionCharacterStats(sid, name);
          triggerStatsRefresh();
          return saved;
        },
      },
      data: {
        get: (namespace) => api.getPluginData(sid, namespace),
        set: (namespace, data, replace = false) => api.savePluginData(sid, namespace, data, replace),
        remove: async (namespace) => { await api.deletePluginData(sid, namespace); },
      },
      notify: (kind) => {
        if (kind === "stats") triggerStatsRefresh();
        else if (kind === "env") triggerEnvRefresh();
        else if (kind === "character") triggerCharacterRefresh();
        else if (kind === "memory") triggerMemoryRefresh();
        else if (kind === "resource") bumpResourceVersion();
      },
    };
  }, [activeSessionId, session, chatMode, api, envRefreshKey, memoryRefreshKey, chatRefreshKey,
    characterRefreshKey, statsRefreshKey, resourceVersion, triggerStatsRefresh, triggerEnvRefresh,
    triggerCharacterRefresh, triggerMemoryRefresh, bumpResourceVersion]);

  const pick = (id: string) => {
    setScenePanelTab(id);
    if (!scenePanelOpen) setScenePanelOpen(true);
  };

  // 面板内容区宽度可拖拽调整（CSS 变量 --scene-panel-w，移动端由媒体查询接管）
  const panelWidth = useResizableWidth({
    storageKey: "ark.scenePanel.width",
    defaultWidth: 288,
    min: 220,
    max: 560,
  });

  return (
    <aside
      className={`scene-panel ${scenePanelOpen ? "is-open" : "is-collapsed"}`}
      aria-label="场景面板"
      style={scenePanelOpen ? ({ "--scene-panel-w": `${panelWidth.width}px` } as CSSProperties) : undefined}
    >
      <nav className="scene-rail" aria-label="场景面板页签">
        {visible.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={`scene-rail-btn ${scenePanelOpen && panel.id === activeTab ? "is-active" : ""}`}
            title={panel.hint ? `${panel.title} — ${panel.hint}` : panel.title}
            aria-label={panel.title}
            aria-pressed={scenePanelOpen && panel.id === activeTab}
            onClick={() => pick(panel.id)}
          >
            <PanelIcon panel={panel} />
            <span className="scene-rail-label">{panel.title}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          className="scene-rail-btn is-toggle"
          title={scenePanelOpen ? "收起场景面板" : "展开场景面板"}
          aria-label={scenePanelOpen ? "收起场景面板" : "展开场景面板"}
          onClick={() => setScenePanelOpen(!scenePanelOpen)}
        >
          <AppIcon name={scenePanelOpen ? "back" : "forward"} size={15} />
        </button>
      </nav>

      {scenePanelOpen && (
        <div className="scene-panel-body">
          {active && (
            <header className="scene-panel-head">
              <h2 className="scene-panel-title">{active.title}</h2>
              {active.hint && <p className="scene-panel-hint">{active.hint}</p>}
            </header>
          )}
          <div className="scene-panel-content">
            {!ctx ? (
              <p className="text-gray-500 text-sm text-center py-6">请先选择或创建会话</p>
            ) : !active ? (
              <p className="text-gray-500 text-sm text-center py-6">没有可用的面板</p>
            ) : (
              <ErrorBoundary key={`${active.id}:${ctx.sessionId}`}>
                <active.component ctx={ctx} />
              </ErrorBoundary>
            )}
          </div>
        </div>
      )}

      {scenePanelOpen && (
        <ResizeHandle resize={panelWidth} label="调整场景面板宽度" />
      )}
    </aside>
  );
}
