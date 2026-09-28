import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Crosshair, Gamepad2, Pause, Play, Shield, Sparkles, Swords, LogOut } from 'lucide-react';
import { DEMO_LEVEL, DEMO_OPERATOR, normalizeLevel } from './level';
import { createRenderer } from './renderer';
import { createInputController } from './input';
import { COOLDOWNS, createSimulation, emptyInput, FIXED_STEP, snapshotSimulation, stepSimulation } from './simulation';
import type { Action, SideviewInput, SideviewLevel, SideviewOperator, SideviewResult, SideviewSnapshot, Simulation } from './types';
import './sideview.css';

export interface SideviewBattleProps {
  runId: string; level?: SideviewLevel; operator?: SideviewOperator; supportName?: string;
  practice?: boolean;
  initialSnapshot?: SideviewSnapshot | null;
  onSnapshot?: (snapshot: SideviewSnapshot) => void;
  onComplete: (result: SideviewResult) => void;
  /** Suspend and save this run; this is not abandonment or defeat. */
  onExit?: (snapshot: SideviewSnapshot) => void | Promise<void>;
  onAbandon?: () => void | Promise<void>;
}
type Phase = 'ready' | 'playing' | 'paused' | 'finished';
interface Hud { prop: 'canister' | 'lamp' | null; hp: number; kills: number; seconds: number; skill: number; dash: number; support: number; progress: number; chain: number; combo: number; elite: { name: string; hp: number; max: number } | null }
const keyActions: Record<string, Action> = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'jump', KeyW: 'jump', ArrowUp: 'jump', ShiftLeft: 'dash', ShiftRight: 'dash', KeyJ: 'attack', KeyK: 'skill', KeyL: 'support' };
/** Nearby elites get a named bar in the HUD once they are this close. */
const ELITE_HUD_RANGE = 560;

/** Standard-mapping gamepad: stick/D-pad move, A jump, B/LB dodge, X/RT attack, Y skill, RB/LT support, Start pause. */
function readGamepad(): { input: SideviewInput; start: boolean } | null {
  let pads: (Gamepad | null)[] = [];
  // Embedded contexts without the gamepad permission throw; the loop must keep running.
  try { pads = navigator.getGamepads?.() ?? []; } catch { return null; }
  for (const pad of pads) {
    // Wheels and virtual joysticks use other layouts and can report a resting axis off zero.
    if (!pad?.connected || pad.mapping !== 'standard') continue;
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const x = pad.axes[0] ?? 0;
    return { input: { left: b(14) || x < -0.35, right: b(15) || x > 0.35, jump: b(0), dash: b(1) || b(4), attack: b(2) || b(7), skill: b(3), support: b(5) || b(6) }, start: b(9) };
  }
  return null;
}

export default function SideviewBattle({ runId, level = DEMO_LEVEL, operator = DEMO_OPERATOR, supportName = '后方援护', practice = false, initialSnapshot, onSnapshot, onComplete, onExit, onAbandon }: SideviewBattleProps) {
  const supportLabel = supportName || '后方援护';
  const clearRequired = (level.victoryCondition ?? 'clear_and_exit') === 'clear_and_exit';
  const root = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null);
  const sim = useRef<Simulation | null>(null), input = useRef(createInputController());
  const ready = useRef(false), padArmed = useRef(false);
  const callbacks = useRef({ onSnapshot, onComplete, onExit }); callbacks.current = { onSnapshot, onComplete, onExit };
  const phaseRef = useRef<Phase>('ready');
  const [phase, setPhase] = useState<Phase>('ready');
  const [hud, setHud] = useState<Hud>({ prop: null, hp: initialSnapshot?.player.hp ?? operator.maxHp, kills: 0, seconds: 0, skill: 0, dash: 0, support: 0, progress: 0, chain: 0, combo: 0, elite: null });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [assets, setAssets] = useState('');
  const [help, setHelp] = useState(false);
  const [gamepad, setGamepad] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const abandoningRef = useRef(false);
  const [abandonError, setAbandonError] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const abandonToggle = useRef<HTMLButtonElement>(null), keepAction = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const confirmAbandonRef = useRef(false); confirmAbandonRef.current = confirmAbandon;
  useEffect(() => {
    if (confirmAbandon) keepAction.current?.focus();
    else if (wasConfirming.current) abandonToggle.current?.focus();
    wasConfirming.current = confirmAbandon;
  }, [confirmAbandon]);
  const changePhase = (next: Phase) => {
    phaseRef.current = next; setPhase(next); input.current.clear(); padArmed.current = false;
    if (sim.current) { sim.current.previous = emptyInput(); sim.current.queued = {}; }
  };
  const begin = () => {
    if (!ready.current || abandoningRef.current || confirmAbandonRef.current || document.hidden || !['ready', 'paused'].includes(phaseRef.current)) return;
    setHelp(false); changePhase('playing'); root.current?.focus();
  };
  const pause = () => { if (phaseRef.current !== 'playing') return; changePhase('paused'); if (sim.current) callbacks.current.onSnapshot?.(snapshotSimulation(sim.current)); };

  useEffect(() => {
    if (!host.current) return;
    changePhase('ready'); setError(''); setAssets(''); ready.current = false;
    const normalized = normalizeLevel(level);
    const state = createSimulation(normalized, operator, initialSnapshot ?? undefined); sim.current = state;
    let renderer: ReturnType<typeof createRenderer>;
    try { renderer = createRenderer(host.current, normalized, matchMedia('(prefers-reduced-motion: reduce)').matches, operator, setAssets); }
    catch (e) { setError(`无法启动场景渲染：${e instanceof Error ? e.message : '浏览器图形上下文不可用'}`); return; }
    ready.current = true;
    root.current?.focus({ preventScroll: true });
    const names = new Map(level.enemies.map(e => [e.id, e.name]));
    const specs = new Map(normalized.enemies.map(e => [e.id, e]));
    let frame = 0, last = performance.now(), accumulator = 0, nextHud = 0, hudElapsed = -1, nextSave = state.elapsed + 5, completed = false, padStart = false;
    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000); last = now;
      const pad = readGamepad();
      const focused = !document.hidden && document.hasFocus() && !!root.current?.contains(document.activeElement);
      if (focused && pad?.start && !padStart) { if (phaseRef.current === 'playing') pause(); else if (phaseRef.current === 'paused' || phaseRef.current === 'ready') begin(); }
      padStart = !!pad?.start;
      if (!pad || !Object.values(pad.input).some(Boolean)) padArmed.current = true;
      if (phaseRef.current === 'playing') {
        accumulator += delta;
        while (accumulator >= FIXED_STEP) {
          stepSimulation(state, input.current.sample(focused && padArmed.current ? pad?.input : undefined), normalized, operator);
          accumulator -= FIXED_STEP;
        }
        if (state.elapsed >= nextSave) { nextSave = state.elapsed + 5; callbacks.current.onSnapshot?.(snapshotSimulation(state)); }
        if (state.outcome && !completed) {
          completed = true; changePhase('finished');
          callbacks.current.onComplete({ runId, levelId: level.id, outcome: state.outcome, durationMs: Math.round(state.elapsed * 1000), kills: state.kills, damageTaken: state.damageTaken, hpRemaining: state.player.hp, bestChain: state.bestChain, snapshot: snapshotSimulation(state) });
        }
      } else accumulator = 0;
      if (now >= nextHud && state.elapsed !== hudElapsed) {
        nextHud = now + 100; hudElapsed = state.elapsed;
        const p = state.player;
        let elite: Hud['elite'] = null, nearest = ELITE_HUD_RANGE;
        for (const e of state.enemies) {
          const spec = specs.get(e.id);
          if (e.hp <= 0 || spec?.kind !== 'elite') continue;
          const distance = Math.abs(e.x - p.x);
          if (distance < nearest && Math.abs(e.y - p.y) < 220) { nearest = distance; elite = { name: names.get(e.id) || '重装守卫', hp: e.hp, max: spec.hp }; }
        }
        const nearbyProp = state.props.find(prop => !prop.broken && Math.abs(prop.x - p.x) < 125 && Math.abs(prop.y + prop.height - p.y - p.height) < 45);
        const fighting = state.enemies.some(e => e.hp > 0 && Math.abs(e.x - p.x) < 180 && Math.abs(e.y - p.y) < 100);
        setHud({ prop: fighting ? null : nearbyProp?.kind ?? null, hp: p.hp, kills: state.kills, seconds: Math.floor(state.elapsed), skill: p.skillCooldown, dash: p.dashCooldown, support: p.supportCooldown, progress: Math.max(0, Math.min(100, p.x / Math.max(1, level.width - 120) * 100)), chain: state.chain, combo: p.combo, elite });
      }
      renderer.render(state); frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const release = () => { input.current.clear(); pause(); };
    const visibility = () => { if (document.hidden) release(); };
    const down = (event: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) || event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.code === 'Space' || event.code === 'Enter') && (event.target as HTMLElement).tagName === 'BUTTON') return;
      if (event.code === 'Escape' && !event.repeat) {
        event.preventDefault();
        if (confirmAbandonRef.current) { setConfirmAbandon(false); return; }
        if (phaseRef.current === 'playing') pause(); else if (phaseRef.current === 'paused') begin(); return;
      }
      const action = keyActions[event.code];
      if (action && phaseRef.current === 'playing') { event.preventDefault(); if (!event.repeat) input.current.press(`key:${event.code}`, action); }
    };
    const up = (event: KeyboardEvent) => input.current.release(`key:${event.code}`);
    const pads = () => setGamepad(!!readGamepad());
    pads();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    window.addEventListener('gamepadconnected', pads); window.addEventListener('gamepaddisconnected', pads);
    return () => { ready.current = false; cancelAnimationFrame(frame); renderer.destroy(); input.current.clear(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('gamepadconnected', pads); window.removeEventListener('gamepaddisconnected', pads); };
    // A run owns immutable level/operator data. Autosave callback changes must not restart its simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, attempt]);

  const exit = async () => {
    if (!sim.current || !callbacks.current.onExit || abandoningRef.current) return;
    abandoningRef.current = true; setAbandoning(true); setAbandonError(''); changePhase('paused');
    try { await callbacks.current.onExit(snapshotSimulation(sim.current)); }
    catch (cause) { setAbandonError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { abandoningRef.current = false; setAbandoning(false); }
  };
  const abandon = async () => {
    if (!onAbandon || abandoningRef.current) return;
    changePhase('paused'); abandoningRef.current = true; setAbandoning(true); setAbandonError('');
    try { await onAbandon(); } catch (e) { setAbandonError(e instanceof Error ? e.message : '放弃失败，请重试。'); }
    finally { abandoningRef.current = false; setAbandoning(false); }
  };
  const touch = (action: Action, cooling = false) => ({
    'aria-disabled': phase !== 'playing' || cooling,
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (phaseRef.current !== 'playing' || cooling || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      input.current.press(`pointer:${event.pointerId}`, action);
    },
    onPointerUp: (event: React.PointerEvent) => input.current.release(`pointer:${event.pointerId}`),
    onPointerCancel: (event: React.PointerEvent) => input.current.release(`pointer:${event.pointerId}`),
    onLostPointerCapture: (event: React.PointerEvent) => input.current.release(`pointer:${event.pointerId}`),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === 'Enter' || event.key === ' ') && phaseRef.current === 'playing') {
        event.preventDefault(); if (!cooling && !event.repeat) input.current.press(`button:${action}:${event.code}`, action);
      }
    },
    onKeyUp: (event: React.KeyboardEvent) => input.current.release(`button:${action}:${event.code}`),
    onBlur: () => input.current.releasePrefix(`button:${action}:`),
  });
  const cooldown = (value: number) => value > 0 ? `${value.toFixed(1)}s` : '就绪';
  // Remaining cooldown as a 0–1 fill for the ability buttons.
  const meter = (value: number, total: number) => ({ '--sv-cd': Math.max(0, Math.min(1, value / total)) }) as React.CSSProperties;
  const critical = hud.hp > 0 && hud.hp < operator.maxHp * 0.3;
  return <section className="sideview-battle" ref={root} tabIndex={-1} aria-label={`${level.name}实时动作关卡`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pause(); }}>
    <header className="sv-header">
      <div className="sv-mission"><h2>{level.name}</h2><p>{clearRequired ? '清除全部守卫，解除出口封锁，抵达撤离点。' : '突破阻碍，抵达撤离点即可完成行动。'}</p></div>
      <div className="sv-header-actions">{gamepad && <span className="sv-pad" title="手柄已连接"><Gamepad2 size={16} aria-label="手柄已连接" /></span>}<span className="sv-time" aria-label="行动时间">{Math.floor(hud.seconds / 60).toString().padStart(2, '0')}:{(hud.seconds % 60).toString().padStart(2, '0')}</span><button type="button" onClick={() => phase === 'playing' ? pause() : begin()} disabled={phase === 'finished' || !!error || abandoning} aria-label={phase === 'playing' ? '暂停行动' : '继续行动'}>{phase === 'playing' ? <Pause size={18} /> : <Play size={18} />}</button>{onExit && <button type="button" onClick={exit} disabled={abandoning} aria-label={practice ? '保存演练并返回大厅' : '保存并离开'}><LogOut size={18} /></button>}</div>
    </header>
    <div className="sv-stage">
      <div className="sv-canvas" ref={host} />
      <div className="sv-status">
        <div className={`sv-health${critical ? ' sv-critical' : ''}`}><div><strong>{operator.name}</strong><span>{Math.ceil(hud.hp)} / {operator.maxHp}</span></div><div className="sv-health-track" role="progressbar" aria-label="生命值" aria-valuemin={0} aria-valuemax={operator.maxHp} aria-valuenow={Math.ceil(hud.hp)}><i style={{ transform: `scaleX(${Math.max(0, hud.hp / operator.maxHp)})` }} /></div></div>
        <div className="sv-status-side">
          <div className="sv-objective"><Crosshair size={15}/><span>{clearRequired ? `守卫 ${hud.kills}/${level.enemies.length} · ${hud.kills === level.enemies.length ? '出口已开放' : '出口封锁中'}` : '目标：抵达撤离点'}</span></div>
          {hud.chain >= 2 && <div className={`sv-chain${hud.chain >= 8 ? ' sv-chain-hot' : ''}`} aria-hidden="true"><strong>{hud.chain}</strong><span>连击</span>{hud.combo > 0 && <i>{[1, 2, 3].map(n => <b key={n} className={n <= hud.combo ? 'on' : ''} />)}</i>}</div>}
        </div>
      </div>
      {hud.elite && phase === 'playing' && <div className="sv-elite" role="group" aria-label={`${hud.elite.name} 生命 ${Math.ceil(hud.elite.hp)} / ${hud.elite.max}`}><span>{hud.elite.name}<small>霸体 · 蓄力后突进</small></span><div><i style={{ transform: `scaleX(${hud.elite.hp / hud.elite.max})` }} /></div></div>}
      {phase === 'playing' && hud.prop && !assets && <p className="sv-environment-hint">{hud.prop === 'lamp' ? '警示灯可打灭' : '废弃罐体可击碎'}<span>近战 · 技能 · 闪避冲撞</span></p>}
      {assets && <p className="sv-asset-status" role="status">{assets}</p>}
      <div className="sv-route" role="progressbar" aria-label="关卡进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hud.progress)}><i style={{ transform: `scaleX(${hud.progress / 100})` }} /></div>
      {(phase !== 'playing' || error) && <div className="sv-curtain">
        <div className="sv-brief" role={error ? 'alert' : undefined}>
          <h3>{error ? '场景未能启动' : phase === 'finished' ? (sim.current?.outcome === 'victory' ? '撤离成功' : '行动中止') : phase === 'paused' ? '行动已暂停' : '进入雨幕'}</h3>
          <p>{error || (phase === 'finished' ? (practice ? '演练结束，正在整理结果。' : '行动结果已交给结算系统。') : phase === 'paused' ? '准备好后继续。离开页面或切换窗口会自动暂停。' : '留意橙色攻击预警与红色突进路线。近战连击可打断普通敌人；命中前闪避，赢得反击时机。')}</p>
          {error && <button type="button" className="sv-primary" onClick={() => setAttempt(value => value + 1)}>重新加载场景</button>}
          {(phase === 'ready' || phase === 'paused') && !error && <><div className="sv-brief-keys"><span><kbd>A</kbd><kbd>D</kbd> 移动</span><span><kbd>Space</kbd> 跳跃</span><span><kbd>Shift</kbd> 闪避</span><span><kbd>J</kbd> 近战连击</span><span><kbd>K</kbd> 技能</span><span><kbd>L</kbd> 援护</span></div>{gamepad && <p className="sv-pad-keys"><Gamepad2 size={14} aria-hidden="true" />手柄：摇杆移动 · A 跳跃 · B 闪避 · X 近战 · Y 技能 · RB 援护 · Start 暂停</p>}<button type="button" className="sv-primary" onClick={begin} disabled={abandoning}><Play size={17}/>{phase === 'paused' || initialSnapshot ? '继续行动' : '开始行动'}</button></>}
          {onExit && <button type="button" className="sv-exit" onClick={exit} disabled={abandoning}>{practice ? '保存演练并返回大厅' : '保存并离开'}</button>}
          {(phase === 'ready' || phase === 'paused') && !error && <div className="sv-brief-help"><p className="sv-touch-hint">触屏：同时按住方向与动作按钮。横屏可获得更宽视野。</p><button type="button" className="sv-help-toggle" onClick={() => setHelp(value => !value)} aria-expanded={help} aria-controls="sideview-help">{help ? '收起操作说明' : '查看操作说明'}</button></div>}
          {phase === 'paused' && onAbandon && (confirmAbandon ? <div className="sv-abandon-confirm"><p>{practice ? '结束本次演练？本机保存的进度会清除。' : '结束本次关卡？放弃后不发放通关奖励。'}</p><button type="button" onClick={abandon} disabled={abandoning}>{abandoning ? '正在结束行动…' : '确认放弃'}</button><button ref={keepAction} type="button" className="sv-exit" onClick={() => setConfirmAbandon(false)} disabled={abandoning}>保留行动</button></div> : <button ref={abandonToggle} type="button" className="sv-abandon" onClick={() => setConfirmAbandon(true)} disabled={abandoning}>{practice ? '放弃演练' : '放弃本次行动'}</button>)}
          {abandonError && <p role="alert">{abandonError}</p>}
        </div>
      </div>}
    </div>
    <footer className="sv-controls">
      <div className="sv-movement"><button type="button" {...touch('left')} disabled={phase !== 'playing'} aria-label="向左移动"><ArrowLeft size={22}/><kbd>A</kbd></button><button type="button" {...touch('right')} disabled={phase !== 'playing'} aria-label="向右移动"><ArrowRight size={22}/><kbd>D</kbd></button><button type="button" {...touch('jump')} disabled={phase !== 'playing'} aria-label="跳跃"><ArrowUp size={22}/><span>跳跃</span><kbd>Space</kbd></button></div>
      <div className="sv-abilities">
        <button type="button" {...touch('dash', hud.dash > 0)} style={meter(hud.dash, COOLDOWNS.dash)} disabled={phase !== 'playing'} aria-label={`闪避 ${cooldown(hud.dash)}`}><Shield size={20}/><span>闪避</span><small>{cooldown(hud.dash)}</small><kbd>Shift</kbd></button>
        <button type="button" {...touch('attack')} disabled={phase !== 'playing'} aria-label="近战攻击"><Swords size={20}/><span>近战</span><small>三段连击</small><kbd>J</kbd></button>
        <button type="button" className="sv-skill" {...touch('skill', hud.skill > 0)} style={meter(hud.skill, COOLDOWNS.skill)} disabled={phase !== 'playing'} aria-label={`范围技能 ${cooldown(hud.skill)}`}><Sparkles size={20}/><span>裂光</span><small>{cooldown(hud.skill)}</small><kbd>K</kbd></button>
        <button type="button" {...touch('support', hud.support > 0)} style={meter(hud.support, COOLDOWNS.support)} disabled={phase !== 'playing'} aria-label={`${supportLabel} ${cooldown(hud.support)}`}><Crosshair size={20}/><span>援护</span><small>{cooldown(hud.support)}</small><kbd>L</kbd></button>
      </div>
      <button type="button" className="sv-help-toggle" onClick={() => { pause(); setHelp(v => !v); }} aria-expanded={help} aria-controls="sideview-help">操作说明</button>
    </footer>
    {help && <div className="sv-help" id="sideview-help" tabIndex={0} role="region" aria-label="操作与战术说明"><p><strong>移动与战斗</strong>：A / D 或方向键移动，Space / W / ↑ 跳跃；短按小跳，长按高跳。Shift 闪避（{COOLDOWNS.dash} 秒），J 近战：连按打出三段连击，第三击击退并打断普通敌人的蓄力；K 范围技能（{COOLDOWNS.skill} 秒），L 呼叫{supportLabel}（{COOLDOWNS.support} 秒，恢复 30 生命并打击附近敌人）。Esc 暂停。</p><p><strong>预警与反击</strong>：橙色地面条是守卫的斩击范围，虚线是弩手的瞄准线，红色通道是重装守卫的突进路线；重装守卫有霸体，只有技能和援护能打断。在攻击命中前闪避触发「极限闪避」，技能冷却缩短 1.5 秒。坠落会扣除生命并回到最近的安全落脚点。</p><p><strong>街区互动</strong>：近战、技能和闪避冲撞能击碎路边罐体、打灭警示灯；碎片不会伤人，也不会掉落物品。重新进入关卡时这些场景物件会复原。</p><p>支持手柄（标准布局）。移动设备可同时按住方向与动作按钮。{clearRequired ? '出口前的空气墙会阻止通行；清除全部守卫后解除封锁。' : '抵达最右侧撤离点即可完成行动，无需清除全部守卫。'}进度每 5 秒保存；{practice ? '“保存演练并返回大厅”会在本机保留进度。' : '“保存并离开”会挂起当前行动。'}</p></div>}
    <span className="sv-sr-only" aria-live="polite">{phase === 'finished' ? (sim.current?.outcome === 'victory' ? '撤离成功' : '行动失败') : clearRequired && hud.kills === level.enemies.length ? '全部守卫已清除，出口封锁解除，前往最右侧撤离点。' : ''}</span>
  </section>;
}
