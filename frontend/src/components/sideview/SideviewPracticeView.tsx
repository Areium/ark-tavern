/** No-session sideview drill. Progress stays in this browser and never enters a story save. */
import { useCallback, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import SideviewBattle from "../../features/sideview/SideviewBattle";
import { DEMO_LEVEL, DEMO_OPERATOR } from "../../features/sideview/level";
import type { SideviewResult, SideviewSnapshot } from "../../features/sideview/types";

const SAVE_KEY = "ark_sideview_practice_v1";

interface PracticeRun {
  runId: string;
  levelId: string;
  snapshot: SideviewSnapshot | null;
}

function newRun(): PracticeRun {
  return { runId: `practice-${Date.now()}`, levelId: DEMO_LEVEL.id, snapshot: null };
}

function readRun(): PracticeRun {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null") as PracticeRun | null;
    const snapshot = saved?.snapshot;
    if (saved?.levelId === DEMO_LEVEL.id && typeof saved.runId === "string" &&
      snapshot?.version === 1 && !snapshot.exitReached &&
      Number.isFinite(snapshot.elapsedMs) && Number.isFinite(snapshot.player?.x) &&
      Number.isFinite(snapshot.player?.y) && Number.isFinite(snapshot.player?.hp) &&
      Array.isArray(snapshot.enemies)) return saved;
  } catch { /* Missing or invalid browser storage starts a fresh drill. */ }
  return newRun();
}

function writeRun(runId: string, snapshot: SideviewSnapshot): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ runId, levelId: DEMO_LEVEL.id, snapshot }));
    return true;
  } catch { return false; }
}

function clearRun() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* Storage may be unavailable. */ }
}

export default function SideviewPracticeView() {
  const { setCombatContext, setCurrentView } = useAppStore();
  const [run, setRun] = useState<PracticeRun>(readRun);
  const [result, setResult] = useState<SideviewResult | null>(null);
  const [saveError, setSaveError] = useState("");

  const returnToLobby = useCallback(() => {
    setCombatContext(null);
    setCurrentView("sessions");
  }, [setCombatContext, setCurrentView]);

  const saveSnapshot = useCallback((snapshot: SideviewSnapshot) => {
    setSaveError(writeRun(run.runId, snapshot) ? "" : "本机无法保存演练进度，请检查浏览器存储空间。");
  }, [run.runId]);

  const saveAndLeave = useCallback((snapshot: SideviewSnapshot) => {
    if (writeRun(run.runId, snapshot)) returnToLobby();
    else setSaveError("本机无法保存演练进度；请释放浏览器存储空间后重试，或放弃演练。");
  }, [returnToLobby, run.runId]);

  const restart = useCallback(() => {
    clearRun();
    setResult(null);
    setSaveError("");
    setRun(newRun());
  }, []);

  if (result) return (
    <div className="h-full bg-combat-bg text-gray-100 grid place-items-center px-4">
      <section className="w-full max-w-md rounded-xl border border-gray-600/70 bg-surface-card p-6 shadow-xl" aria-label="横版演练结果">
        <h1 className="text-xl font-display font-semibold text-cyan-100">{result.outcome === "victory" ? "演练完成" : "演练结束"}</h1>
        <p className="mt-2 text-sm text-gray-300">{DEMO_LEVEL.name} · {result.outcome === "victory" ? "成功撤离" : "行动失败"}</p>
        <dl className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3 border-y border-gray-700/70 py-4 text-center">
          <div><dt className="text-xs text-gray-400">用时</dt><dd className="mt-1 text-lg tabular-nums">{Math.ceil(result.durationMs / 1000)} 秒</dd></div>
          <div><dt className="text-xs text-gray-400">击败敌人</dt><dd className="mt-1 text-lg tabular-nums">{result.kills} / {DEMO_LEVEL.enemies.length}</dd></div>
          <div><dt className="text-xs text-gray-400">剩余生命</dt><dd className="mt-1 text-lg tabular-nums">{Math.max(0, Math.ceil(result.hpRemaining))}</dd></div>
          <div><dt className="text-xs text-gray-400">最高连击</dt><dd className="mt-1 text-lg tabular-nums">{result.bestChain ?? 0}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-gray-400">独立演练不会发放奖励，也不会改变会话进度。</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" onClick={restart} className="btn btn-primary px-4 py-2 text-sm">重新演练</button>
          <button type="button" onClick={returnToLobby} className="btn btn-ghost px-4 py-2 text-sm">返回会话大厅</button>
        </div>
      </section>
    </div>
  );

  return <div className="relative h-full bg-combat-bg text-white">
    <SideviewBattle key={run.runId} runId={run.runId} level={DEMO_LEVEL} operator={DEMO_OPERATOR}
      practice initialSnapshot={run.snapshot} onSnapshot={saveSnapshot}
      onComplete={(finished) => { clearRun(); setResult(finished); }}
      onExit={saveAndLeave}
      onAbandon={() => { clearRun(); returnToLobby(); }} />
    {saveError && <p className="absolute bottom-2 left-4 z-30 max-w-md rounded bg-red-950/95 px-3 py-2 text-sm text-red-100" role="alert">{saveError}</p>}
  </div>;
}
