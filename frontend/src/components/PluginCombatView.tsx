import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useApi } from '../hooks/useApi';
import type { Session } from '../types';
import RuntimeFrame from '../features/combatModes/RuntimeFrame';
import { pluginSessionApi, type PluginCompletion, type PluginOutcome, type PluginSessionState } from '../features/combatModes/sessionApi';
import ConfirmDialog from './common/ConfirmDialog';

const outcomeLabels = { victory: '胜利', defeat: '失利', retreat: '撤退' };
const buttonClass = 'btn btn-ghost px-4 py-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300';

function SessionCombat({ sessionId, epoch, navigation }: { sessionId: string; epoch: number; navigation: number }) {
  const api = useApi();
  const [data, setData] = useState<PluginSessionState | null>(null);
  const dataRef = useRef<PluginSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [encounterId, setEncounterId] = useState('');
  const [confirmation, setConfirmation] = useState<'accept' | 'retreat' | null>(null);
  const [receipt, setReceipt] = useState<PluginCompletion | null>(null);
  const alive = useRef(false);
  const sequence = useRef(0);
  const current = useCallback(() => {
    const store = useAppStore.getState();
    return alive.current && store.currentView === 'combat' && store.combatContext.sessionId === sessionId
      && store.navigationRevision === navigation && (store.sessionEpochs[sessionId] || 0) === epoch;
  }, [sessionId, epoch, navigation]);
  const publish = (next: PluginSessionState) => { dataRef.current = next; setData(next); };
  const markBusy = (value: boolean) => { busyRef.current = value; setBusy(value); };

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setTrusted(false);
    try {
      const next = await pluginSessionApi.get(sessionId, signal);
      if (!current() || request !== sequence.current) return;
      dataRef.current = next;
      setData(next);
      setEncounterId(next.run?.encounter_id || next.binding.encounters[0]?.id || '');
    } catch (cause) {
      if (current() && request === sequence.current && !signal?.aborted) {
        setError(cause instanceof Error ? cause.message : '读取插件会话失败');
      }
    } finally {
      if (current() && request === sequence.current) setLoading(false);
    }
  }, [sessionId, current]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { alive.current = false; sequence.current++; controller.abort(); };
  }, [load]);

  const start = async () => {
    if (busyRef.current || !current() || !encounterId) return;
    markBusy(true);
    setError('');
    setTrusted(false);
    try {
      const next = await pluginSessionApi.start(sessionId, encounterId);
      if (!current()) return;
      publish(next);
      const store = useAppStore.getState();
      store.setSessions(store.sessions.map(session => session.id === sessionId
        ? { ...session, in_combat: true, combat_resumable: true } : session));
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '启动遭遇失败');
    } finally { if (current()) markBusy(false); }
  };

  // RuntimeFrame serializes callbacks. Update the ref before resolving each CAS save,
  // so the next queued snapshot uses the new revision even before React renders.
  const save = async (snapshot: Record<string, unknown>, outcome?: PluginOutcome) => {
    const previous = dataRef.current;
    if (!current() || busyRef.current || !previous?.run || previous.run.status !== 'active') {
      throw new Error('运行上下文已变化，请重新读取战斗状态');
    }
    markBusy(true);
    try {
      const run = await pluginSessionApi.save(sessionId, previous.run, snapshot, outcome);
      if (!current()) throw new Error('会话已切换，忽略旧存档响应');
      publish({ ...previous, run: { ...previous.run, ...run, input: previous.run.input, name: previous.run.name } });
      if (run.status !== 'active') setTrusted(false);
    } catch (cause) {
      if (current()) {
        setTrusted(false);
        setError(`存档未确认，请重新读取状态：${cause instanceof Error ? cause.message : '未知错误'}`);
      }
      throw cause;
    } finally { if (current()) markBusy(false); }
  };

  const finish = async (completion: PluginCompletion) => {
    const session: Session = await api.getSession(sessionId);
    if (!current()) return;
    const store = useAppStore.getState();
    store.setSessions(store.sessions.map(item => item.id === sessionId ? session : item));
    store.setPendingBriefing(sessionId, null);
    store.setPendingAutoNarrate(sessionId, { action: completion.auto_narrate_action });
    store.setActiveSession(sessionId);
    store.setChatMode(session.mode);
    store.setCombatContext(null);
    store.setCurrentView('chat');
  };

  const confirm = async () => {
    const run = dataRef.current?.run;
    if (!current() || busyRef.current || !run || (!confirmation && !receipt)) return;
    markBusy(true);
    setError('');
    try {
      const completion = receipt || await pluginSessionApi.confirm(sessionId, run, confirmation!);
      if (!current()) return;
      setReceipt(completion);
      setConfirmation(null);
      await finish(completion);
    } catch (cause) {
      if (current()) setError(`确认或刷新未完成，可重试：${cause instanceof Error ? cause.message : '未知错误'}`);
    } finally { if (current()) markBusy(false); }
  };

  const continueConfirmed = async () => {
    const savedRun = dataRef.current?.run;
    if (!current() || busyRef.current || savedRun?.status !== 'completed' || !savedRun.completion) return;
    markBusy(true);
    setError('');
    setReceipt(savedRun.completion);
    try {
      // The persisted receipt survives a reload after confirmation. Reuse it only
      // on this explicit click; never accept again or auto-narrate on GET.
      await finish(savedRun.completion);
    } catch (cause) {
      if (current()) setError(`刷新会话未完成，可重试：${cause instanceof Error ? cause.message : '未知错误'}`);
    } finally { if (current()) markBusy(false); }
  };

  const run = data?.run;
  const active = run?.status === 'active';
  const settling = run?.status === 'settling';
  const leave = () => {
    if (busyRef.current || !current()) return;
    const store = useAppStore.getState();
    store.setActiveSession(sessionId);
    store.setCombatContext(null);
    store.setCurrentView('chat');
  };
  const ask = (choice: 'accept' | 'retreat') => {
    if (busyRef.current) return;
    setTrusted(false); // Stop the iframe before asking; cancel never ends the run.
    setConfirmation(choice);
  };

  return <div className="bg-combat-bg h-full overflow-auto bg-gray-950 text-gray-200 p-6 space-y-5">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-amber-300">会话战斗 · {data?.bundle?.name || data?.binding.mode_id || '插件'}</h1>
        {data && <p className="text-xs text-gray-400 mt-2">冻结版本 {data.binding.version} · {data.binding.encounters.length} 个遭遇 · 不受已安装包更新影响</p>}
      </div>
      <button type="button" className={buttonClass} disabled={busy || !!receipt} onClick={leave}>返回对话（不结束战斗）</button>
    </header>
    <p className="text-xs text-gray-400">返回仅保留最近成功保存的快照，不代表撤退或接受结果。插件结果未经引擎验证，不自动发放经验或物品。</p>
    {loading && <p role="status">正在读取冻结内容与战斗存档…</p>}
    {receipt && <p role="status" className="text-amber-200">战斗结果已确认。{busy ? '正在刷新会话并返回对话…' : '请重试刷新会话以继续剧情，不会重复写入战斗结果。'}</p>}
    {error && <div role="alert" className="border border-red-400/30 rounded-lg p-4 text-red-300 space-y-3">
      <p className="break-words">{error}</p>
      <button type="button" className={buttonClass} disabled={busy || loading}
        onClick={() => { if (receipt) void confirm(); else { setConfirmation(null); void load(); } }}>
        {receipt ? '重试刷新并返回对话' : '重新读取战斗状态'}
      </button>
    </div>}
    {!loading && data && !receipt && <>
      {run?.status === 'completed' && run.completion && <section className="detail-section p-4 space-y-3">
        <h2 className="font-medium text-amber-200">{run.name} · 结果已确认</h2>
        <p className="text-sm text-gray-400">如果确认后尚未续写，可以使用已保存结果继续剧情。此操作不会再次确认战斗；已续写过则无需重复点击，也可直接选择新遭遇。</p>
        <button type="button" className={buttonClass} disabled={busy || !!error} onClick={() => void continueConfirmed()}>
          使用已确认结果继续剧情
        </button>
      </section>}
      {!active && !settling && <section className="detail-section p-4 space-y-3">
        <h2 className="font-medium">选择冻结遭遇</h2>
        {data.binding.encounters.length === 0 ? <p className="text-gray-400">本会话没有可用遭遇，请返回对话。</p> : <>
          <label className="block text-sm">战斗遭遇
            <select className="input mt-2" value={encounterId} disabled={busy}
              onChange={event => setEncounterId(event.target.value)}>
              {data.binding.encounters.map(encounter => <option key={encounter.id} value={encounter.id}>
                {encounter.name} · {encounter.worldbook_id}
              </option>)}
            </select>
          </label>
          <button type="button" className={buttonClass} disabled={busy || !encounterId || !!error} onClick={() => void start()}>开始遭遇</button>
        </>}
      </section>}
      {(active || settling) && <section className="detail-section p-4 space-y-3">
        <h2 className="font-medium text-cyan-300">{run?.name} · {settling ? '等待用户确认' : '战斗进行中'}</h2>
        <p role="status" className="text-xs text-gray-400">{busy ? '正在保存或确认，请稍候…' : `存档修订 ${run?.revision}`}</p>
        {settling && <p className="text-amber-200">插件报告：{run?.outcome ? outcomeLabels[run.outcome] : '未知'}。脚本已停止；确认后才会写入战斗历史并续写剧情。</p>}
        {active && !trusted && <div className="space-y-3">
          <p className="text-sm text-amber-200">此内容包含第三方浏览器脚本。仅在信任来源时运行；本次离开或重载后需要重新授权。</p>
          <button type="button" className={buttonClass} disabled={busy || !!error || !data.bundle || !!confirmation}
            onClick={() => setTrusted(true)}>我信任此脚本，开始本次运行</button>
        </div>}
        <div className="flex gap-3">
          {settling && <button type="button" className={buttonClass} disabled={busy || !!error} onClick={() => ask('accept')}>接受结果并继续剧情</button>}
          <button type="button" className={buttonClass} disabled={busy || !!error} onClick={() => ask('retreat')}>撤退并结束遭遇</button>
        </div>
      </section>}
      {active && trusted && !error && data.bundle && run && <RuntimeFrame
        bundle={data.bundle} runId={run.runId} input={run.input} snapshot={run.snapshot}
        onSnapshot={snapshot => save(snapshot)} onComplete={(outcome, snapshot) => save(snapshot, outcome)}
        onError={message => { if (current()) { setError(message); setTrusted(false); } }} />}
      {data.history.length > 0 && <details className="detail-section p-4">
        <summary className="cursor-pointer">已确认战斗记录（{data.history.length}）</summary>
        <ul className="mt-3 space-y-2 text-sm">{data.history.map(entry => <li key={entry.runId}>
          {entry.name} · {outcomeLabels[entry.outcome]} · 玩家确认，未验证
        </li>)}</ul>
      </details>}
    </>}
    {confirmation && <ConfirmDialog title={confirmation === 'retreat' ? '确认撤退？' : '接受插件战斗结果？'} tone="neutral"
      confirmLabel={busy ? '正在确认…' : confirmation === 'retreat' ? '确认撤退' : '接受并继续剧情'}
      onCancel={() => { if (!busyRef.current) setConfirmation(null); }} onConfirm={() => void confirm()}>
      <p>这会结束当前遭遇、记录{confirmation === 'retreat' ? '撤退' : '插件报告的结果'}并继续剧情，不会自动发放奖励。取消只关闭此确认，不结束战斗。</p>
      {error && <p role="alert" className="text-red-300 mt-3">{error}</p>}
    </ConfirmDialog>}
  </div>;
}

export default function PluginCombatView() {
  const { combatContext, sessionEpochs, navigationRevision, setCurrentView } = useAppStore();
  const sessionId = combatContext.sessionId;
  if (!sessionId) return <div className="p-6"><p role="alert">缺少会话上下文。</p>
    <button type="button" className={buttonClass} onClick={() => setCurrentView('sessions')}>返回会话大厅</button></div>;
  const epoch = sessionEpochs[sessionId] || 0;
  return <SessionCombat key={`${sessionId}:${epoch}:${navigationRevision}`} sessionId={sessionId} epoch={epoch} navigation={navigationRevision} />;
}
