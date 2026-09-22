/**
 * 场景面板插件注册表 —— 对话页左侧「场景面板」的每一个页签都是一个插件。
 *
 * 内置面板（角色 / 物品 / 环境 / 剧情 / 回忆 / 任务 / 数值 / 资源）与第三方面板走同一条
 * 注册路径：`registerScenePanel({...})`。第三方开发者把一个 `.tsx` 放进
 * `src/plugins/custom/`（由 `plugins/index.ts` 自动加载）即可出现在面板栏里。
 *
 * 面板拿到的 `ScenePanelContext` 是与系统数据交互的正式接口：
 *  - `stats`：读写角色数值（世界书统一字段 × 角色全局值 × 会话值），写入会话层；
 *  - `data`：按命名空间读写本会话的插件数据（JSON 对象，随剧情树节点快照回档）；
 *  - `refresh`：系统事件的刷新键（环境 / 回忆 / 角色 / 数值 / 资源），变化即该重新拉取；
 *  - `api`：完整的 REST 客户端，需要时可直接调用。
 *
 * 数据接口对应的后端端点见 `src/blueprints/stage.py`；开发说明见 `plugins/README.md`。
 */
import { useSyncExternalStore, type ComponentType } from "react";
import type { AppIconName } from "../components/AppIcon";
import type { useApi } from "../hooks/useApi";
import type {
  Session, SessionCharacterStatsDTO, SessionCharacterStatsListDTO, StatValue, PluginDataDTO,
} from "../types";

export type ApiClient = ReturnType<typeof useApi>;

/** 面板可见的对话模式；缺省两种模式都显示 */
export type ScenePanelMode = "story" | "free";

export interface ScenePanelRefreshKeys {
  env: number;
  memory: number;
  chat: number;
  character: number;
  stats: number;
  resource: number;
}

/** 角色数值接口（会话层）。写入后自动触发 `refresh.stats`。 */
export interface ScenePanelStatsApi {
  /** 阵容全部角色的合并数值（默认 → 全局 → 会话） */
  list: () => Promise<SessionCharacterStatsListDTO>;
  /** 写会话数值：默认合并，`null` 删键；replace=true 整份替换 */
  set: (name: string, values: Record<string, StatValue | null>, replace?: boolean) => Promise<SessionCharacterStatsDTO>;
  /** 清空会话值，回到角色全局值 */
  reset: (name: string) => Promise<SessionCharacterStatsDTO>;
}

/** 插件数据接口（会话层，按命名空间隔离） */
export interface ScenePanelDataApi {
  get: (namespace: string) => Promise<PluginDataDTO>;
  /** 默认顶层合并（`null` 删键）；replace=true 整份替换 */
  set: (namespace: string, data: Record<string, unknown>, replace?: boolean) => Promise<PluginDataDTO>;
  remove: (namespace: string) => Promise<void>;
}

export interface ScenePanelContext {
  sessionId: string;
  session: Session | null;
  chatMode: "story" | "free";
  api: ApiClient;
  refresh: ScenePanelRefreshKeys;
  stats: ScenePanelStatsApi;
  data: ScenePanelDataApi;
  /** 通知系统：数值 / 环境 / 角色有变化（内置面板会据此重新拉取） */
  notify: (kind: "stats" | "env" | "character" | "memory" | "resource") => void;
}

export interface ScenePanelProps {
  ctx: ScenePanelContext;
}

export interface ScenePanelDefinition {
  /** 唯一 id（小写字母 / 数字 / 连字符），也是页签持久化的键 */
  id: string;
  title: string;
  /** 内置图标名；第三方也可传一个自定义渲染函数 */
  icon: AppIconName | ComponentType<{ size?: number; className?: string }>;
  /** 排序：数字越小越靠前；内置面板占 10–80，第三方默认 100 */
  order?: number;
  /** 只在某些对话模式显示；缺省两种模式都显示 */
  modes?: ScenePanelMode[];
  /** 一句话说明（页签 title） */
  hint?: string;
  component: ComponentType<ScenePanelProps>;
}

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

let panels: ScenePanelDefinition[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** 注册一个面板；同 id 再次注册会覆盖（便于热重载）。返回注销函数。 */
export function registerScenePanel(definition: ScenePanelDefinition): () => void {
  if (!ID_RE.test(definition.id)) {
    throw new Error(`场景面板 id 非法：${definition.id}（小写字母开头，1–40 位 [a-z0-9-]）`);
  }
  if (typeof definition.component !== "function") {
    throw new Error(`场景面板 ${definition.id} 缺少 component`);
  }
  panels = [...panels.filter((p) => p.id !== definition.id), { order: 100, ...definition }]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  emit();
  return () => unregisterScenePanel(definition.id);
}

export function unregisterScenePanel(id: string) {
  const next = panels.filter((p) => p.id !== id);
  if (next.length !== panels.length) {
    panels = next;
    emit();
  }
}

export function listScenePanels(): ReadonlyArray<ScenePanelDefinition> {
  return panels;
}

/** 按对话模式过滤后的面板列表（纯函数，SSR 断言脚本也用它） */
export function visibleScenePanels(all: ReadonlyArray<ScenePanelDefinition>, mode: ScenePanelMode) {
  return all.filter((p) => !p.modes || p.modes.includes(mode));
}

/** 当前页签不在可见列表里时的兜底：取第一个可见面板 */
export function resolveScenePanelTab(visible: ReadonlyArray<ScenePanelDefinition>, wanted: string): string {
  if (visible.some((p) => p.id === wanted)) return wanted;
  return visible[0]?.id ?? "";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React 订阅：注册表变化即重渲染 */
export function useScenePanels(): ReadonlyArray<ScenePanelDefinition> {
  return useSyncExternalStore(subscribe, listScenePanels, listScenePanels);
}
