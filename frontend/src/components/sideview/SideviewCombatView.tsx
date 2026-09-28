/** Session handoff for the browser-owned side view simulation. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { CombatSettlementDTO } from "../../types";
import SideviewBattle from "../../features/sideview/SideviewBattle";
import type { SideviewLevel, SideviewOperator, SideviewResult, SideviewSnapshot } from "../../features/sideview/types";
import CombatSettlement from "../combat/CombatSettlement";

interface LaunchState {
  engine: "sideview";
  runId: string;
  level: SideviewLevel;
  operator: SideviewOperator;
  supportName?: string;
  snapshot: SideviewSnapshot;
  status: "active" | "suspended" | "settling" | "completed" | "abandoned";
  outcome?: "victory" | "defeat";
}

function resultFromSaved(state: LaunchState): SideviewResult {
  const snapshot = state.snapshot;
  return {
    runId: state.runId,
    levelId: state.level.id,
    outcome: state.outcome || (snapshot.player.hp > 0 ? "victory" : "defeat"),
    durationMs: snapshot.elapsedMs,
    kills: snapshot.enemies.filter((enemy) => enemy.hp === 0).length,
    damageTaken: snapshot.damageTaken || 0,
    hpRemaining: snapshot.player.hp,
    snapshot,
  };
}

export default function SideviewCombatView() {
  const { combatContext, sessions, setSessions, setCombatContext, setCurrentView, setPendingAutoNarrate } = useAppStore();
  const sessionId = combatContext.sessionId;
  const api = useApi();
  const [state, setState] = useState<LaunchState | null>(null);
  const [settlement, setSettlement] = useState<CombatSettlementDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveWarning, setSaveWarning] = useState("");
  const resultRef = useRef<SideviewResult | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const queueSave = useCallback((snapshot: SideviewSnapshot, suspended: boolean) => {
    if (!sessionId || !state) return Promise.reject(new Error("会话状态缺失"));
    const runId = state.runId;
    const next = saveQueue.current.catch(() => undefined).then(() =>
      api.sideviewSave(sessionId, runId, snapshot, suspended),
    );
    saveQueue.current = next;
    return next;
  }, [api, sessionId, state]);

  const complete = useCallback(async (result: SideviewResult) => {
    if (!sessionId || busy) return;
    resultRef.current = result;
    setBusy(true);
    setError("");
    try {
      await saveQueue.current;
      const response = await api.sideviewComplete(sessionId, result);
      setSettlement(response.settlement as CombatSettlementDTO);
    } catch (cause) {
      setError(`结算未写入，请重试：${cause instanceof Error ? cause.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  }, [api, busy, sessionId]);

  useEffect(() => {
    if (!sessionId) { setLoading(false); setError("缺少会话，请返回对话重新进入关卡。"); return; }
    let cancelled = false;
    setLoading(true);
    api.sideviewState(sessionId).then(async (response) => {
      if (cancelled) return;
      const launch = response.state as LaunchState;
      if (launch.engine !== "sideview") throw new Error("关卡存档类型不匹配");
      setState(launch);
      if (launch.status === "suspended") {
        await api.sideviewSave(sessionId, launch.runId, launch.snapshot, false);
        if (!cancelled) setState({ ...launch, status: "active" });
      } else if (launch.status === "settling") {
        const result = resultFromSaved(launch);
        resultRef.current = result;
        const finished = await api.sideviewComplete(sessionId, result);
        if (!cancelled) setSettlement(finished.settlement as CombatSettlementDTO);
      } else if (launch.status === "completed" || launch.status === "abandoned") {
        throw new Error("这场关卡已结束，请返回对话。");
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "读取关卡失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, sessionId]);

  const saveAndLeave = useCallback(async (snapshot: SideviewSnapshot) => {
    if (!sessionId || !state || busy) return;
    setBusy(true);
    setError("");
    try {
      await queueSave(snapshot, true);
      setSessions(sessions.map((session) => session.id === sessionId
        ? { ...session, in_combat: false, combat_resumable: true }
        : session));
      setCombatContext(null);
      setCurrentView("chat");
    } catch (cause) {
      setError(`关卡未能保存：${cause instanceof Error ? cause.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  }, [busy, queueSave, sessionId, sessions, setCombatContext, setCurrentView, setSessions, state]);

  const abandon = useCallback(async () => {
    if (!sessionId || !state || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.sideviewAbandon(sessionId, state.runId);
      setSessions(sessions.map((session) => session.id === sessionId
        ? { ...session, in_combat: false, combat_resumable: false, combat_resume: null }
        : session));
      setPendingAutoNarrate({ action: response.auto_narrate_action });
      setCombatContext(null);
      setCurrentView("chat");
    } catch (cause) {
      setError(`放弃关卡失败：${cause instanceof Error ? cause.message : "未知错误"}`);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [api, busy, sessionId, sessions, setCombatContext, setCurrentView, setPendingAutoNarrate, setSessions, state]);

  const confirmSettlement = useCallback(() => {
    if (!sessionId || !settlement) return;
    setSessions(sessions.map((session) => session.id === sessionId
      ? { ...session, in_combat: false, combat_resumable: false, combat_resume: null,
          sideview_status: {
            operatorName: state?.operator.name || "主控",
            hp: resultRef.current?.hpRemaining ?? 0,
            maxHp: state?.operator.maxHp || 0,
            outcome: settlement.victory ? "victory" : "defeat",
            runId: state?.runId || "",
          } }
      : session));
    setPendingAutoNarrate({
      action: settlement.victory
        ? "战斗结束，玩家获胜，描述战斗后的场景"
        : "战斗失利，描述战败后的场景与代价（fail-forward，剧情继续推进）",
      settlement: {
        winner: settlement.winner,
        survivors: resultRef.current && resultRef.current.hpRemaining > 0 ? [state?.operator.name || "主控"] : [],
        rounds: 0,
        encounter_id: settlement.encounter_id,
        engine: "sideview",
        durationMs: settlement.durationMs,
      },
    });
    setCombatContext(null);
    setCurrentView("chat");
  }, [sessionId, settlement, sessions, setCombatContext, setCurrentView, setPendingAutoNarrate, setSessions, state]);

  const onSnapshot = useCallback((snapshot: SideviewSnapshot) => {
    void queueSave(snapshot, false).then(() => setSaveWarning(""), (cause) =>
      setSaveWarning(`自动存档失败：${cause instanceof Error ? cause.message : "未知错误"}`));
  }, [queueSave]);

  return <div className="relative h-full bg-combat-bg text-white">
    {loading && <div className="grid h-full place-items-center" role="status">正在读取横版关卡…</div>}
    {!loading && state && state.status !== "settling" && !settlement &&
      <SideviewBattle key={state.runId} runId={state.runId} level={state.level}
        operator={state.operator} supportName={state.supportName}
        initialSnapshot={state.snapshot} onSnapshot={onSnapshot}
        onComplete={(result) => { void complete(result); }}
        onExit={saveAndLeave}
        onAbandon={abandon} />}
    {saveWarning && <p className="absolute bottom-2 left-4 z-30 rounded bg-red-950/90 px-3 py-1 text-sm text-red-100" role="status">{saveWarning}</p>}
    {error && <div className="absolute inset-x-4 top-4 z-50 mx-auto max-w-xl rounded-lg border border-red-500/60 bg-gray-950/95 p-4 text-red-100" role="alert">
      <p>{error}</p>
      <div className="mt-3 flex gap-3">
        {resultRef.current && !settlement && <button className="btn-primary px-3 py-1" disabled={busy} onClick={() => { void complete(resultRef.current!); }}>重试结算</button>}
        <button className="btn px-3 py-1" onClick={() => { setCombatContext(null); setCurrentView("chat"); }}>返回对话</button>
      </div>
    </div>}
    {settlement && <CombatSettlement settlement={settlement} busy={busy} onConfirm={confirmSettlement} />}
  </div>;
}
