import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Crosshair, Pause, Play, Shield, Sparkles, Swords, LogOut } from 'lucide-react';
import { DEMO_LEVEL, DEMO_OPERATOR, normalizeLevel } from './level';
import { createRenderer } from './renderer';
import { createSimulation, emptyInput, FIXED_STEP, snapshotSimulation, stepSimulation } from './simulation';
import type { Action, SideviewLevel, SideviewOperator, SideviewResult, SideviewSnapshot, Simulation } from './types';
import './sideview.css';

export interface SideviewBattleProps {
  runId: string; level?: SideviewLevel; operator?: SideviewOperator; supportName?: string;
  initialSnapshot?: SideviewSnapshot | null;
  onSnapshot?: (snapshot: SideviewSnapshot) => void;
  onComplete: (result: SideviewResult) => void;
  /** Suspend and save this run; this is not abandonment or defeat. */
  onExit?: (snapshot: SideviewSnapshot) => void;
  onAbandon?: () => void | Promise<void>;
}
type Phase = 'ready' | 'playing' | 'paused' | 'finished';
const keyActions: Record<string, Action> = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'jump', KeyW: 'jump', ArrowUp: 'jump', ShiftLeft: 'dash', ShiftRight: 'dash', KeyJ: 'attack', KeyK: 'skill', KeyL: 'support' };

export default function SideviewBattle({ runId, level = DEMO_LEVEL, operator = DEMO_OPERATOR, supportName = '后方援护', initialSnapshot, onSnapshot, onComplete, onExit, onAbandon }: SideviewBattleProps) {
  const supportLabel = supportName || '后方援护';
  const root = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null);
  const sim = useRef<Simulation | null>(null), input = useRef(emptyInput());
  const pending = useRef(emptyInput());
  const callbacks = useRef({ onSnapshot, onComplete, onExit }); callbacks.current = { onSnapshot, onComplete, onExit };
  const phaseRef = useRef<Phase>('ready');
  const [phase, setPhase] = useState<Phase>('ready');
  const [hud, setHud] = useState({ hp: initialSnapshot?.player.hp ?? operator.maxHp, kills: 0, seconds: 0, skill: 0, dash: 0, support: 0, progress: 0 });
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const abandoningRef = useRef(false);
  const [abandonError, setAbandonError] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const changePhase = (next: Phase) => { phaseRef.current = next; setPhase(next); input.current = emptyInput(); pending.current = emptyInput(); };
  const begin = () => { if (abandoningRef.current) return; changePhase('playing'); root.current?.focus(); };
  const pause = () => { if (phaseRef.current !== 'playing') return; changePhase('paused'); if (sim.current) callbacks.current.onSnapshot?.(snapshotSimulation(sim.current)); };

  useEffect(() => {
    if (!host.current) return;
    changePhase('ready'); setError('');
    const normalized = normalizeLevel(level);
    const state = createSimulation(normalized, operator, initialSnapshot ?? undefined); sim.current = state;
    let renderer: ReturnType<typeof createRenderer>;
    try { renderer = createRenderer(host.current, normalized, matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { setError(`无法启动场景渲染：${e instanceof Error ? e.message : '浏览器图形上下文不可用'}`); return; }
    let frame = 0, last = performance.now(), accumulator = 0, nextHud = 0, nextSave = state.elapsed + 5, completed = false;
    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000); last = now;
      if (phaseRef.current === 'playing') {
        accumulator += delta;
        while (accumulator >= FIXED_STEP) {
          const sampled = { ...input.current };
          for (const action of Object.keys(sampled) as Action[]) sampled[action] ||= pending.current[action];
          stepSimulation(state, sampled, normalized, operator); pending.current = emptyInput(); accumulator -= FIXED_STEP;
        }
        if (state.elapsed >= nextSave) { nextSave = state.elapsed + 5; callbacks.current.onSnapshot?.(snapshotSimulation(state)); }
        if (state.outcome && !completed) {
          completed = true; changePhase('finished');
          callbacks.current.onComplete({ runId, levelId: level.id, outcome: state.outcome, durationMs: Math.round(state.elapsed * 1000), kills: state.kills, damageTaken: state.damageTaken, hpRemaining: state.player.hp, snapshot: snapshotSimulation(state) });
        }
      } else accumulator = 0;
      if (now >= nextHud) {
        nextHud = now + 100;
        setHud({ hp: state.player.hp, kills: state.kills, seconds: Math.floor(state.elapsed), skill: state.player.skillCooldown, dash: state.player.dashCooldown, support: state.player.supportCooldown, progress: Math.max(0, Math.min(100, state.player.x / Math.max(1, level.width - 120) * 100)) });
      }
      renderer.render(state); frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const release = () => { input.current = emptyInput(); pause(); };
    const visibility = () => { if (document.hidden) release(); };
    const down = (event: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement)) return;
      if ((event.code === 'Space' || event.code === 'Enter') && (event.target as HTMLElement).tagName === 'BUTTON') return;
      if (event.code === 'Escape' && !event.repeat) { event.preventDefault(); if (phaseRef.current === 'playing') pause(); else if (phaseRef.current === 'paused') begin(); return; }
      const action = keyActions[event.code];
      if (action && phaseRef.current === 'playing') { event.preventDefault(); input.current[action] = true; if (!event.repeat) pending.current[action] = true; }
    };
    const up = (event: KeyboardEvent) => { const action = keyActions[event.code]; if (action) input.current[action] = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(frame); renderer.destroy(); input.current = emptyInput(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
    // A run owns immutable level/operator data. Autosave callback changes must not restart its simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const exit = () => { if (!sim.current) return; changePhase('paused'); callbacks.current.onExit?.(snapshotSimulation(sim.current)); };
  const abandon = async () => {
    if (!onAbandon) return;
    changePhase('paused'); abandoningRef.current = true; setAbandoning(true); setAbandonError('');
    try { await onAbandon(); } catch (e) { setAbandonError(e instanceof Error ? e.message : '放弃失败，请重试。'); }
    finally { abandoningRef.current = false; setAbandoning(false); }
  };
  const touch = (action: Action) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => { if (phaseRef.current !== 'playing') return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); input.current[action] = true; pending.current[action] = true; },
    onPointerUp: () => { input.current[action] = false; }, onPointerCancel: () => { input.current[action] = false; }, onLostPointerCapture: () => { input.current[action] = false; },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { if ((event.key === 'Enter' || event.key === ' ') && phaseRef.current === 'playing') { event.preventDefault(); input.current[action] = true; if (!event.repeat) pending.current[action] = true; } },
    onKeyUp: () => { input.current[action] = false; }, onBlur: () => { input.current[action] = false; },
  });
  const cooldown = (value: number) => value > 0 ? `${value.toFixed(1)}s` : '就绪';
  return <section className="sideview-battle" ref={root} tabIndex={-1} aria-label={`${level.name}实时动作关卡`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pause(); }}>
    <header className="sv-header">
      <div className="sv-mission"><h2>{level.name}</h2><p>清除守卫，穿过废城，抵达撤离点。</p></div>
      <div className="sv-header-actions"><span className="sv-time" aria-label="行动时间">{Math.floor(hud.seconds / 60).toString().padStart(2, '0')}:{(hud.seconds % 60).toString().padStart(2, '0')}</span><button type="button" onClick={() => phase === 'playing' ? pause() : begin()} disabled={phase === 'finished' || !!error || abandoning} aria-label={phase === 'playing' ? '暂停行动' : '继续行动'}>{phase === 'playing' ? <Pause size={18} /> : <Play size={18} />}</button>{onExit && <button type="button" onClick={exit} disabled={abandoning} aria-label="保存并离开"><LogOut size={18} /></button>}</div>
    </header>
    <div className="sv-stage">
      <div className="sv-canvas" ref={host} />
      <div className="sv-status">
        <div className="sv-health"><div><strong>{operator.name}</strong><span>{Math.ceil(hud.hp)} / {operator.maxHp}</span></div><div className="sv-health-track" role="progressbar" aria-label="生命值" aria-valuemin={0} aria-valuemax={operator.maxHp} aria-valuenow={Math.ceil(hud.hp)}><i style={{ transform: `scaleX(${Math.max(0, hud.hp / operator.maxHp)})` }} /></div></div>
        <div className="sv-objective"><Crosshair size={15}/><span>守卫 {hud.kills}/{level.enemies.length}</span></div>
      </div>
      <div className="sv-route" aria-label={`关卡进度 ${Math.round(hud.progress)}%`}><i style={{ transform: `scaleX(${hud.progress / 100})` }} /></div>
      {(phase !== 'playing' || error) && <div className="sv-curtain">
        <div className="sv-brief" role={error ? 'alert' : undefined}>
          <h3>{error ? '场景未能启动' : phase === 'finished' ? (sim.current?.outcome === 'victory' ? '撤离成功' : '行动中止') : phase === 'paused' ? '行动已暂停' : '进入雨幕'}</h3>
          <p>{error || (phase === 'finished' ? '行动结果已交给结算系统。' : phase === 'paused' ? '准备好后继续。离开页面或切换窗口会自动暂停。' : '留意敌人的橙色攻击预警。跳过危险地带，用闪避穿过攻击，再寻找近身反击的机会。')}</p>
          {(phase === 'ready' || phase === 'paused') && !error && <><div className="sv-brief-keys"><span><kbd>A</kbd><kbd>D</kbd> 移动</span><span><kbd>Space</kbd> 跳跃</span><span><kbd>Shift</kbd> 闪避</span><span><kbd>J</kbd> 近战</span><span><kbd>K</kbd> 技能</span><span><kbd>L</kbd> 援护</span></div><button type="button" className="sv-primary" onClick={begin} disabled={abandoning}><Play size={17}/>{phase === 'paused' || initialSnapshot ? '继续行动' : '开始行动'}</button></>}
          {onExit && <button type="button" className="sv-exit" onClick={exit} disabled={abandoning}>保存并离开</button>}
          {phase === 'paused' && onAbandon && (confirmAbandon ? <div className="sv-abandon-confirm"><p>结束本次关卡？放弃后不发放通关奖励。</p><button type="button" onClick={abandon} disabled={abandoning}>{abandoning ? '正在结束行动…' : '确认放弃'}</button><button type="button" className="sv-exit" onClick={() => setConfirmAbandon(false)} disabled={abandoning}>保留行动</button></div> : <button type="button" className="sv-abandon" onClick={() => setConfirmAbandon(true)} disabled={abandoning}>放弃本次行动</button>)}
          {abandonError && <p role="alert">{abandonError}</p>}
        </div>
      </div>}
    </div>
    <footer className="sv-controls">
      <div className="sv-movement"><button type="button" {...touch('left')} disabled={phase !== 'playing'} aria-label="向左移动"><ArrowLeft size={22}/><kbd>A</kbd></button><button type="button" {...touch('right')} disabled={phase !== 'playing'} aria-label="向右移动"><ArrowRight size={22}/><kbd>D</kbd></button><button type="button" {...touch('jump')} disabled={phase !== 'playing'} aria-label="跳跃"><ArrowUp size={22}/><span>跳跃</span><kbd>Space</kbd></button></div>
      <div className="sv-abilities">
        <button type="button" {...touch('dash')} disabled={phase !== 'playing' || hud.dash > 0} aria-label={`闪避 ${cooldown(hud.dash)}`}><Shield size={20}/><span>闪避</span><small>{cooldown(hud.dash)}</small><kbd>Shift</kbd></button>
        <button type="button" {...touch('attack')} disabled={phase !== 'playing'} aria-label="近战攻击"><Swords size={20}/><span>近战</span><small>按住连击</small><kbd>J</kbd></button>
        <button type="button" className="sv-skill" {...touch('skill')} disabled={phase !== 'playing' || hud.skill > 0} aria-label={`范围技能 ${cooldown(hud.skill)}`}><Sparkles size={20}/><span>裂光</span><small>{cooldown(hud.skill)}</small><kbd>K</kbd></button>
        <button type="button" {...touch('support')} disabled={phase !== 'playing' || hud.support > 0} aria-label={`${supportLabel} ${cooldown(hud.support)}`}><Crosshair size={20}/><span>援护</span><small>{cooldown(hud.support)}</small><kbd>L</kbd></button>
      </div>
      <button type="button" className="sv-help-toggle" onClick={() => { pause(); setHelp(v => !v); }} aria-expanded={help}>操作说明</button>
    </footer>
    {help && <div className="sv-help"><p><strong>移动与战斗</strong>：A / D 或方向键移动，Space / W / ↑ 跳跃；短按小跳，长按高跳。Shift 闪避，J 近战连击，K 范围技能（6 秒），L 呼叫{supportLabel}（14 秒，恢复 30 生命并打击附近敌人）。Esc 暂停。</p><p>移动设备可同时按住方向与动作按钮。清除全部守卫后，最右侧撤离门会亮起。进度每 5 秒保存；“保存并离开”会挂起当前行动。</p></div>}
    <span className="sv-sr-only" aria-live="polite">{phase === 'finished' ? (sim.current?.outcome === 'victory' ? '撤离成功' : '行动失败') : hud.kills === level.enemies.length ? '全部守卫已清除，前往最右侧撤离点。' : ''}</span>
  </section>;
}
