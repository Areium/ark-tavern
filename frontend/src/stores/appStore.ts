/**
 * 应用全局状态
 */
import { create } from "zustand";
import type { BackendStatus, Session, LLMStatus, CombatStateDTO, ChatMessage, CombatBriefingDTO } from "../types";

type Theme = "dark" | "light";

/** UI 皮肤：default = 现有主题（受明暗切换控制）；prts/tavern = 独立色板皮肤（接管明暗） */
export type SkinId = "default" | "prts" | "tavern";

export interface CombatContext {
  practiceMode: "tactical" | "sideview" | null;
  state: CombatStateDTO | null;
  uiMode: "VIEWING" | "TARGETING";
  selectedCardIndex: number | null;
  testId: string | null;
  sessionId: string | null;
  selectedUnitId: string | null;
}

type ViewName = "home" | "chat" | "sessions" | "settings" | "combat" | "worldbook" | "docs" | "characters";

/** 对话页布局：消息流 / 视觉小说舞台 */
export type ChatLayout = "log" | "stage" | "graph";

/** 读 localStorage 的小工具：SSR / 隐私模式下拿不到就用默认值 */
function readLocal<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (raw == null) return fallback;
    if (allowed && !allowed.includes(raw as T)) return fallback;
    return raw as T;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
}

/**
 * 角色页模块页签（原「内容中心」的资产 / 卡牌并入「角色」）。
 *
 * `characters` / `identities` 是角色自身的两个模块（角色库即角色资料内容），
 * `images` / `cards` 是迁入的资产与卡牌。内容中心一级入口已删除。
 */
export type CharacterTab = "characters" | "identities" | "images" | "cards";

/** 世界书工作台页签：`graph` = 迁入的剧情节点图（旧「节点视图」已整页删除）。 */
export type WorldBookTab = "entries" | "prompt" | "graph" | "index";

/** 最小化对话框的恢复入口信息（key = 对话框 id） */
export interface MinimizedDialogEntry {
  title: string;
  restore: () => void;
}

interface AppState {
  // 视图
  currentView: ViewName;
  setCurrentView: (view: ViewName) => void;

  // 角色页模块页签（跨组件跳转：角色卡编辑 → 卡牌；会话向导 → 玩家身份）
  characterTab: CharacterTab;
  setCharacterTab: (tab: CharacterTab) => void;

  // 世界书工作台页签（A-1）：所有跨组件跳转的唯一入口（R-4 会与资料库口径一起归一）
  worldbookTab: WorldBookTab;
  setWorldbookTab: (tab: WorldBookTab) => void;

  // 跨组件跳转 → 工作台：选中该书 / 跳对应页签
  /** 检索命中等入口：跳到工作台 `entries` 页签并选中该书 + 条目 */
  worldbookJumpId: string | null;
  setWorldbookJumpId: (id: string | null) => void;
  /** 旧依赖入口：统一跳到工作台 `entries` 页签。 */
  worldbookScopeJumpId: string | null;
  setWorldbookScopeJumpId: (id: string | null) => void;
  /** 节点图专用入口（战斗页「编辑此节点」）：选中该书 + 直接打开 `graph` 页签 */
  worldbookGraphJumpId: string | null;
  setWorldbookGraphJumpId: (id: string | null) => void;
  worldbookEntryJump: { bookId: string; entryUid: string } | null;
  setWorldbookEntryJump: (target: { bookId: string; entryUid: string } | null) => void;

  // 战斗节点编辑器跳转：战前卡片等入口指定要打开的节点
  combatNodeJumpId: string | null;
  setCombatNodeJumpId: (id: string | null) => void;

  // 主题
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  // 皮肤（独立色板主题；非 default 时接管明暗切换）
  skin: SkinId;
  setSkin: (skin: SkinId) => void;

  // 后端连接
  backend: BackendStatus;
  llmStatus: LLMStatus | null;
  setBackendStatus: (status: BackendStatus) => void;
  setLLMStatus: (status: LLMStatus) => void;

  // 当前对话模式
  chatMode: "free" | "story";
  setChatMode: (mode: "free" | "story") => void;

  // 会话
  sessions: Session[];
  activeSessionId: string | null;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;

  // 环境刷新触发器（SSE scene_event / 手动切换后 +1）
  envRefreshKey: number;
  triggerEnvRefresh: () => void;

  // 回忆刷新触发器（SSE memory_event / 手动切换后 +1）
  memoryRefreshKey: number;
  triggerMemoryRefresh: () => void;

  // 聊天刷新触发器（回退后 +1，通知 ChatPanel 重新加载）
  chatRefreshKey: number;
  triggerChatRefresh: () => void;

  // 发送前编辑模式：点击选项后填入输入框而非直接发送
  editBeforeSend: boolean;
  setEditBeforeSend: (v: boolean) => void;

  // 对话气泡模式：将角色对话以聊天气泡形式显示
  dialogueBubbleMode: boolean;
  setDialogueBubbleMode: (v: boolean) => void;

  // 聊天字体大小（px）
  chatFontSize: number;
  setChatFontSize: (size: number) => void;

  // 角色变更触发器（加载/卸载角色后 +1）
  characterRefreshKey: number;
  triggerCharacterRefresh: () => void;

  // 场景切换触发器（剧情模式切换场景后 +1，通知 ChatPanel 触发叙述）
  sceneSwitchKey: number;
  triggerSceneSwitch: () => void;

  // 索引管理跳转（从会话列表跳转到索引管理器并选中指定会话）
  indexSessionId: string | null;
  setIndexSessionId: (id: string | null) => void;

  // 场景面板（对话页左侧，可折叠；页签由插件注册表提供，见 plugins/scenePanels.tsx）
  scenePanelOpen: boolean;
  setScenePanelOpen: (open: boolean) => void;
  scenePanelTab: string;
  setScenePanelTab: (tab: string) => void;
  // 对话页布局：log = 消息流；stage = 视觉小说舞台（背景 + 立绘 + 对话框）
  chatLayout: ChatLayout;
  setChatLayout: (layout: ChatLayout) => void;
  // 点击对话时高亮的说话人（舞台立绘 / 场景角色列表同步高亮）
  highlightedSpeaker: string | null;
  setHighlightedSpeaker: (name: string | null) => void;
  // 角色数值刷新触发器（面板 / 插件写入数值后 +1）
  statsRefreshKey: number;
  triggerStatsRefresh: () => void;
  // 会话覆盖图缓存爆破（上传/删除覆盖后 +1，通知头像等刷新）
  resourceVersion: number;
  bumpResourceVersion: () => void;

  // 战斗
  combatContext: CombatContext;
  setCombatContext: (partial: Partial<CombatContext> | null) => void;

  // 战斗后自动叙述
  pendingAutoNarrate: { action: string; settlement?: { winner: string; survivors: string[]; rounds: number; encounter_id: string; engine?: "sideview"; durationMs?: number } } | null;
  setPendingAutoNarrate: (data: { action: string; settlement?: { winner: string; survivors: string[]; rounds: number; encounter_id: string; engine?: "sideview"; durationMs?: number } } | null) => void;

  // 战前简报（SSE combat_briefing 事件）
  pendingBriefing: CombatBriefingDTO | null;
  setPendingBriefing: (data: CombatBriefingDTO | null) => void;

  // 对话框最小化：key = 对话框 id，多个对话框各自独立、互不干扰
  minimizedDialogs: Record<string, MinimizedDialogEntry>;
  setMinimizedDialog: (id: string, entry: MinimizedDialogEntry | null) => void;

  // 按会话存储的消息/流式状态（跨会话切换保留）
  sessionMessages: Record<string, ChatMessage[]>;
  sessionStreaming: Record<string, boolean>;
  sessionSending: Record<string, boolean>;
  sessionNarrationCount: Record<string, number>;
  sessionAbortFns: Record<string, (() => void) | null>;

  setSessionMessages: (sessionId: string, updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setSessionStreaming: (sessionId: string, streaming: boolean) => void;
  setSessionSending: (sessionId: string, sending: boolean) => void;
  setSessionNarrationCount: (sessionId: string, count: number) => void;
  setSessionAbortFn: (sessionId: string, fn: (() => void) | null) => void;
  clearSessionStream: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // 视图（默认进入游戏主页主菜单）
  currentView: "home",
  setCurrentView: (view) => set({ currentView: view }),

  // 角色页模块页签（默认角色库）
  characterTab: "characters",
  setCharacterTab: (tab) => set({ characterTab: tab }),

  // 世界书工作台页签（默认条目页）
  worldbookTab: "entries",
  setWorldbookTab: (tab) => set({ worldbookTab: tab }),

  // 跨组件跳转 → 工作台（选中书 / 页签）
  worldbookJumpId: null,
  setWorldbookJumpId: (id) => set({ worldbookJumpId: id }),
  worldbookScopeJumpId: null,
  setWorldbookScopeJumpId: (id) => set({ worldbookScopeJumpId: id }),
  worldbookGraphJumpId: null,
  setWorldbookGraphJumpId: (id) => set({ worldbookGraphJumpId: id }),
  worldbookEntryJump: null,
  setWorldbookEntryJump: (target) => set({ worldbookEntryJump: target }),

  // 战斗节点编辑器跳转
  combatNodeJumpId: null,
  setCombatNodeJumpId: (id) => set({ combatNodeJumpId: id }),

  // 主题
  theme: "dark",
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),

  // 皮肤
  skin: "default",
  setSkin: (skin) => set({ skin }),

  // 后端
  backend: { status: "connecting", url: "" },
  llmStatus: null,
  setBackendStatus: (status) => set((state) => {
    if (state.backend.status === status.status && state.backend.url === status.url) return {};
    return { backend: status };
  }),
  setLLMStatus: (status) => set({ llmStatus: status }),

  // 对话模式
  chatMode: "story",
  setChatMode: (mode) => set({ chatMode: mode }),

  // 会话
  sessions: [],
  activeSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  // 环境刷新触发器
  envRefreshKey: 0,
  triggerEnvRefresh: () => set((state) => ({ envRefreshKey: state.envRefreshKey + 1 })),

  // 回忆刷新触发器
  memoryRefreshKey: 0,
  triggerMemoryRefresh: () => set((state) => ({ memoryRefreshKey: state.memoryRefreshKey + 1 })),

  // 聊天刷新触发器
  chatRefreshKey: 0,
  triggerChatRefresh: () => set((state) => ({ chatRefreshKey: state.chatRefreshKey + 1 })),

  // 发送前编辑模式
  editBeforeSend: false,
  setEditBeforeSend: (v) => set({ editBeforeSend: v }),

  // 对话气泡模式
  dialogueBubbleMode: false,
  setDialogueBubbleMode: (v) => set({ dialogueBubbleMode: v }),

  // 聊天字体大小（默认 15px，持久化到 localStorage）
  chatFontSize: (() => {
    if (typeof localStorage === "undefined") return 15;
    const saved = Number(localStorage.getItem("ark_chat_font_size"));
    return saved >= 12 && saved <= 24 ? saved : 15;
  })(),
  setChatFontSize: (size) => {
    const clamped = Math.max(12, Math.min(24, size));
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ark_chat_font_size", String(clamped));
    }
    set({ chatFontSize: clamped });
  },

  // 角色变更触发器
  characterRefreshKey: 0,
  triggerCharacterRefresh: () => set((state) => ({ characterRefreshKey: state.characterRefreshKey + 1 })),

  // 场景切换触发器
  sceneSwitchKey: 0,
  triggerSceneSwitch: () => set((state) => ({ sceneSwitchKey: state.sceneSwitchKey + 1 })),

  // 索引管理跳转
  indexSessionId: null,
  setIndexSessionId: (id) => set({ indexSessionId: id }),

  // 场景面板：开合与页签都记住（localStorage），下次进对话页保持上次的样子
  scenePanelOpen: readLocal("ark_scene_panel_open", "1", ["1", "0"] as const) === "1",
  setScenePanelOpen: (open) => { writeLocal("ark_scene_panel_open", open ? "1" : "0"); set({ scenePanelOpen: open }); },
  scenePanelTab: readLocal("ark_scene_panel_tab", "characters"),
  setScenePanelTab: (tab) => { writeLocal("ark_scene_panel_tab", tab); set({ scenePanelTab: tab }); },
  // 对话页布局（默认消息流；舞台模式记住选择）
  chatLayout: readLocal<ChatLayout>("ark_chat_layout", "log", ["log", "stage", "graph"] as const),
  setChatLayout: (layout) => { writeLocal("ark_chat_layout", layout); set({ chatLayout: layout }); },
  highlightedSpeaker: null,
  setHighlightedSpeaker: (name) => set({ highlightedSpeaker: name }),
  statsRefreshKey: 0,
  triggerStatsRefresh: () => set((state) => ({ statsRefreshKey: state.statsRefreshKey + 1 })),
  resourceVersion: 0,
  bumpResourceVersion: () => set((state) => ({ resourceVersion: state.resourceVersion + 1 })),

  // 战斗
  combatContext: {
    practiceMode: null,
    state: null,
    uiMode: "VIEWING" as const,
    selectedCardIndex: null,
    testId: null,
    sessionId: null,
    selectedUnitId: null,
  },
  setCombatContext: (partial) => set((s) => {
    if (partial === null) {
      return {
        combatContext: {
          practiceMode: null,
          state: null,
          uiMode: "VIEWING",
          selectedCardIndex: null,
          testId: null,
          sessionId: null,
          selectedUnitId: null,
        },
      };
    }
    return { combatContext: { ...s.combatContext, ...partial } };
  }),

  // 战斗后自动叙述
  pendingAutoNarrate: null,
  setPendingAutoNarrate: (action) => set({ pendingAutoNarrate: action }),

  // 战前简报
  pendingBriefing: null,
  setPendingBriefing: (data) => set({ pendingBriefing: data }),

  // 对话框最小化
  minimizedDialogs: {},
  setMinimizedDialog: (id, entry) => set((state) => {
    const next = { ...state.minimizedDialogs };
    if (entry) next[id] = entry; else delete next[id];
    return { minimizedDialogs: next };
  }),

  // ── 按会话存储的消息/流式状态 ──
  sessionMessages: {},
  sessionStreaming: {},
  sessionSending: {},
  sessionNarrationCount: {},
  sessionAbortFns: {},

  setSessionMessages: (sessionId, updater) => set((state) => ({
    sessionMessages: {
      ...state.sessionMessages,
      [sessionId]: typeof updater === "function"
        ? (updater as (prev: ChatMessage[]) => ChatMessage[])(state.sessionMessages[sessionId] || [])
        : updater,
    },
  })),
  setSessionStreaming: (sessionId, streaming) => set((state) => ({
    sessionStreaming: { ...state.sessionStreaming, [sessionId]: streaming },
  })),
  setSessionSending: (sessionId, sending) => set((state) => ({
    sessionSending: { ...state.sessionSending, [sessionId]: sending },
  })),
  setSessionNarrationCount: (sessionId, count) => set((state) => ({
    sessionNarrationCount: { ...state.sessionNarrationCount, [sessionId]: count },
  })),
  setSessionAbortFn: (sessionId, fn) => set((state) => ({
    sessionAbortFns: { ...state.sessionAbortFns, [sessionId]: fn },
  })),
  clearSessionStream: (sessionId) => {
    get().sessionAbortFns[sessionId]?.();
    set(({ sessionMessages, sessionStreaming, sessionSending, sessionNarrationCount, sessionAbortFns }) => {
      const { [sessionId]: _, ...restMessages } = sessionMessages;
      const { [sessionId]: __, ...restStreaming } = sessionStreaming;
      const { [sessionId]: ___, ...restSending } = sessionSending;
      const { [sessionId]: ____, ...restNarration } = sessionNarrationCount;
      const { [sessionId]: _____, ...restAbort } = sessionAbortFns;
      return {
        sessionMessages: restMessages,
        sessionStreaming: restStreaming,
        sessionSending: restSending,
        sessionNarrationCount: restNarration,
        sessionAbortFns: restAbort,
      };
    });
  },
}));
