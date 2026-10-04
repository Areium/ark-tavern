import { useCallback, useEffect, useRef, useState } from "react";
import { getBaseUrl } from "../utils/baseUrl";
import CombatModeManager from "./CombatModeManager";
import ConfirmDialog from "./common/ConfirmDialog";
import RuntimeFrame from "../features/combatModes/RuntimeFrame";

interface Bundle {
  abi: "ark-combat/1"; id: string; name: string; version: string; digest: string;
  entry: string; resources: Record<string, string>;
}
type Snapshot = Record<string, unknown>;
type Outcome = "victory" | "defeat" | "retreat";
interface PracticeRun {
  runId: string; modeId: string; name: string; version: string; status: "active" | "completed";
  revision: number; updatedAt: number; input: Snapshot; snapshot: Snapshot | null;
  bundle: Bundle; result: { outcome: Outcome; verified: false; rewards: null } | null;
}
type RunSummary = Pick<PracticeRun, "runId" | "modeId" | "name" | "version" | "revision" | "updatedAt">;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = await getBaseUrl();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${base}/api/${path}`, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally { window.clearTimeout(timer); }
}
const message = (reason: unknown) => reason instanceof Error ? reason.message : "操作失败，请重试";
const outcomeName = { victory: "胜利", defeat: "失败", retreat: "撤退" };

export default function CombatModesView() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runErrors, setRunErrors] = useState<string[]>([]);
  const [active, setActive] = useState<PracticeRun | null>(null);
  const activeRef = useRef<PracticeRun | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "new" | "resume" | "retreat"; id: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ runs: RunSummary[]; errors: { runId: string; error: string }[] }>("combat-mode-runs");
      setRuns(data.runs); setRunErrors(data.errors.map(row => `${row.runId}: ${row.error}`));
    } catch (reason) { setError(message(reason)); }
  }, []);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);

  function select(run: PracticeRun | null) { activeRef.current = run; setActive(run); setError(""); }

  async function open(kind: "new" | "resume", id: string) {
    if (pending.current) return;
    const token = generation.current;
    pending.current = true; setBusy(true); setError("");
    try {
      const path = kind === "new" ? `combat-modes/${encodeURIComponent(id)}/practice`
        : `combat-mode-runs/${encodeURIComponent(id)}`;
      const result = await api<PracticeRun>(path, kind === "new" ? { method: "POST" } : {});
      if (generation.current === token) select(result);
    } catch (reason) { if (generation.current === token) setError(message(reason)); }
    finally { pending.current = false; if (generation.current === token) setBusy(false); }
  }

  const update = useCallback(async (snapshot: Snapshot, outcome?: Outcome) => {
    const run = activeRef.current;
    if (!run || run.status !== "active") throw new Error("演练已结束或未载入");
    if (pending.current) throw new Error("另一个保存操作尚未完成，请稍后重试");
    const token = generation.current;
    pending.current = true; setBusy(true);
    try {
      const state = await api<Omit<PracticeRun, "bundle">>(`combat-mode-runs/${run.runId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: run.revision, snapshot, ...(outcome ? { outcome } : {}) }),
      });
      if (generation.current === token && activeRef.current?.runId === run.runId) {
        const merged = { ...state, bundle: run.bundle };
        activeRef.current = merged; setActive(merged);
      }
    } finally { pending.current = false; if (generation.current === token) setBusy(false); }
  }, []);
  const save = useCallback((snapshot: Snapshot) => update(snapshot), [update]);
  const complete = useCallback((outcome: Outcome, snapshot: Snapshot) => update(snapshot, outcome), [update]);
  const runtimeError = useCallback((text: string) => setError(text), []);

  if (active) return <section className="h-full flex flex-col bg-gray-950 text-gray-100 p-4 gap-3">
    <header className="flex items-center gap-3 flex-wrap">
      <div className="flex-1"><h1 className="text-lg font-semibold">{active.name} · 演练</h1>
        <p className="text-xs text-gray-400">v{active.version} · 保存版本 {active.revision} · 不影响剧情会话或奖励</p></div>
      <button className="px-3 py-2 rounded border border-gray-600 disabled:opacity-40" disabled={busy}
        onClick={() => { select(null); void refresh(); }}>返回模式库（保留保存点）</button>
      {active.status === "active" && <button className="px-3 py-2 rounded border border-amber-500 disabled:opacity-40" disabled={busy}
        onClick={() => setConfirm({ kind: "retreat", id: active.runId })}>结束演练</button>}
    </header>
    {busy && <p role="status" className="text-sm text-amber-300">正在保存…</p>}
    {error && <div role="alert" className="p-3 bg-red-950 rounded border border-red-800">{error}
      <p className="text-sm mt-1">运行已停止。可返回模式库，从上次成功保存的位置恢复；不会把失败保存当作成功。</p></div>}
    {active.status === "completed" ? <div role="status" className="p-8 rounded border border-amber-700">
      <h2 className="text-xl">演练结束：{active.result ? outcomeName[active.result.outcome] : "已结束"}</h2>
      <p className="mt-3 text-gray-400">这是插件报告的演练结果，未经宿主验证，不发放剧情经验或物品。</p>
    </div> : !error && <RuntimeFrame key={active.runId} bundle={active.bundle} runId={active.runId}
      input={active.input} snapshot={active.snapshot} onSnapshot={save} onComplete={complete} onError={runtimeError} />}
    {confirm?.kind === "retreat" && <ConfirmDialog title="结束这次演练？" confirmLabel="撤退并结束"
      onCancel={() => setConfirm(null)} onConfirm={() => {
        setConfirm(null);
        void update(activeRef.current?.snapshot || {}, "retreat").catch(reason => setError(message(reason)));
      }}><p>将以上次成功保存的状态结束这次演练，不发放奖励。</p></ConfirmDialog>}
  </section>;

  return <div>
    <section className="max-w-6xl mx-auto p-6 pb-0" aria-label="可恢复演练">
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {busy && <p role="status">正在准备演练…</p>}
      {runs.length > 0 && <><h2 className="text-lg text-amber-200">继续演练</h2><p className="text-sm text-gray-400 my-2">
        保存点包含当时的模式版本；更新或卸载已安装模式不会修改它。</p>
        <div className="flex gap-2 flex-wrap">{runs.map(run => <button key={run.runId} disabled={busy}
          className="rounded border border-gray-600 px-3 py-2 text-sm disabled:opacity-40"
          onClick={() => setConfirm({ kind: "resume", id: run.runId })}>
          {run.name} · v{run.version} · 保存版本 {run.revision}</button>)}</div></>}
      {runErrors.length > 0 && <details className="mt-3 text-red-300"><summary>演练存档读取异常</summary>
        <ul>{runErrors.map(text => <li key={text}>{text}</li>)}</ul></details>}
    </section>
    <CombatModeManager onPractice={id => { if (!busy) setConfirm({ kind: "new", id }); }} />
    {confirm && confirm.kind !== "retreat" && <ConfirmDialog title="运行本地战斗插件？" confirmLabel="信任并运行"
      onCancel={() => setConfirm(null)} onConfirm={() => {
        const chosen = confirm; setConfirm(null);
        void open(chosen.kind as "new" | "resume", chosen.id);
      }}><p>这将执行模式作者提供的浏览器脚本。请只运行可信来源；iframe 隔离不等于可安全运行恶意代码。</p>
      <p>演练独立保存，不改动剧情会话。返回时保留上次成功保存的状态。</p></ConfirmDialog>}
  </div>;
}
