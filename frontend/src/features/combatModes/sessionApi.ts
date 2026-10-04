import { getBaseUrl } from '../../utils/baseUrl';
import type { CombatPluginBindingDTO } from '../../types';
import type { RuntimeFrameProps } from './RuntimeFrame';

export const isPluginMode = (mode: unknown): mode is string =>
  typeof mode === 'string' && !['narrative', 'tactical', 'sideview'].includes(mode);

export type PluginOutcome = 'victory' | 'defeat' | 'retreat';
export interface PluginHistory {
  runId: string;
  encounter_id: string;
  name: string;
  outcome: PluginOutcome;
  verified: false;
  accepted_by_user: true;
  rewards: null;
  created_at: number;
}
export interface PluginCompletion {
  ok: boolean;
  history: PluginHistory;
  auto_narrate_action: string;
}
export interface PluginRun {
  runId: string;
  encounter_id: string;
  revision: number;
  status: 'active' | 'settling' | 'completed';
  snapshot: Record<string, unknown> | null;
  outcome: PluginOutcome | null;
  updatedAt: number;
  completion?: PluginCompletion;
}
export interface PluginSessionState {
  binding: CombatPluginBindingDTO;
  run: (PluginRun & { input: Record<string, unknown>; name: string }) | null;
  bundle: RuntimeFrameProps['bundle'] | null;
  history: PluginHistory[];
}

async function request<T>(sessionId: string, path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(cancel, 60000);
  try {
    const base = await getBaseUrl();
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/combat-plugin${path}`, {
      method, signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`插件服务返回无效响应（HTTP ${response.status}）`); }
    if (!response.ok) throw new Error(data.error || `插件请求失败（HTTP ${response.status}）`);
    return data as T;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('插件请求超时，请重新读取状态后重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export const pluginSessionApi = {
  get: (sessionId: string, signal?: AbortSignal) => request<PluginSessionState>(sessionId, '', 'GET', undefined, signal),
  start: (sessionId: string, encounterId: string) => request<PluginSessionState>(sessionId, '/start', 'POST', { encounter_id: encounterId }),
  save: (sessionId: string, run: PluginRun, snapshot: Record<string, unknown>, outcome?: PluginOutcome) =>
    request<PluginRun>(sessionId, '/state', 'PUT', { runId: run.runId, revision: run.revision, snapshot, ...(outcome ? { outcome } : {}) }),
  confirm: (sessionId: string, run: PluginRun, choice: 'accept' | 'retreat') =>
    request<PluginCompletion>(sessionId, '/confirm', 'POST', { runId: run.runId, revision: run.revision, [choice]: true }),
};
