/**
 * 对话舞台（视觉小说视图）—— 背景 + 场景角色立绘 + 底部对话框，逐句推进。
 *
 * 只演「当前这一段」（`utils/stageScript.ts` 折算最新一条叙述 / 回复），玩家点击对话框
 * 推进；说话的角色立绘高亮、其余压暗；走到末尾若有选项就在舞台上亮出来。
 * 完整消息流仍可通过「记录」打开（由 ChatPanel 提供）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useApi } from "../../hooks/useApi";
import type { BranchChoice, ChatMessage, StageDTO } from "../../types";
import {
  buildStageScript, proceduralBackground, speakerOfStep, stagePositions,
} from "../../utils/stageScript";
import AppIcon from "../AppIcon";
import AvatarPlaceholder from "../chat/AvatarPlaceholder";

interface Props {
  sessionId: string;
  messages: ChatMessage[];
  sceneCharacters: string[];
  playerName: string;
  characterColors: Record<string, string>;
  fontSize: number;
  waiting: boolean;
  onPlaybackChange: (sessionId: string, messages: ChatMessage[], complete: boolean) => void;
  elapsedSeconds: number;
  choicesDisabled: boolean;
  onChoice: (choice: string, branch?: BranchChoice) => void;
  onOpenLog: () => void;
  stageOnly: boolean;
  actionInput?: React.ReactNode;
  onExitStageOnly: () => void;
  musicMuted: boolean;
  onToggleMusic: () => void;
  onStart: () => void;
  chatMode: "story" | "free";
}

/** 打字机速度（字 / 秒）；生成完成后才开始舞台演出。 */
const TYPE_CPS = 45;

type StageSceneSnapshot = {
  sessionId: string;
  stage: StageDTO | null;
  sprites: StageDTO["characters"];
  focus: string | null;
};
// Survives switching to the log layout or another session, without retaining an
// unbounded history of stages. Only visual data is retained, never message text.
const sceneSnapshots = new Map<string, StageSceneSnapshot>();
const MAX_SCENE_SNAPSHOTS = 8;

type PortraitAdjustment = { x: number; y: number; scale: number };
type PortraitBounds = { width: number; height: number; left: number; top: number; right: number; bottom: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const layoutKey = (sessionId: string) => `ark_stage_portraits_${sessionId}`;

function readPortraitLayout(sessionId: string): Record<string, PortraitAdjustment> {
  try {
    const raw = JSON.parse(localStorage.getItem(layoutKey(sessionId)) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Record<string, PortraitAdjustment> = {};
    for (const [name, value] of Object.entries(raw)) {
      const entry = value as Partial<PortraitAdjustment>;
      if (Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.scale)) {
        result[name] = { x: clamp(entry.x!, 5, 95), y: clamp(entry.y!, -25, 45), scale: clamp(entry.scale!, .4, 2.2) };
      }
    }
    return result;
  } catch { return {}; }
}

/** Measure the visible pixels so transparent padding does not change apparent height or alignment. */
function portraitBounds(img: HTMLImageElement): PortraitBounds {
  const width = img.naturalWidth, height = img.naturalHeight;
  const fallback = { width, height, left: 0, top: 0, right: width, bottom: height };
  if (!width || !height) return fallback;
  try {
    const factor = Math.min(1, 256 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * factor));
    canvas.height = Math.max(1, Math.round(height * factor));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return fallback;
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (right < left || bottom < top) return fallback;
    return { width, height,
      left: left / canvas.width * width, top: top / canvas.height * height,
      right: (right + 1) / canvas.width * width, bottom: (bottom + 1) / canvas.height * height };
  } catch { return fallback; } // Cross-origin images still get dimension-based sizing.
}

export default function StageView({
  sessionId, messages, sceneCharacters, playerName, characterColors, fontSize, waiting,
  elapsedSeconds, choicesDisabled, onChoice, onOpenLog, stageOnly, onExitStageOnly,
  musicMuted, onToggleMusic, onStart, chatMode, actionInput, onPlaybackChange,
}: Props) {
  const api = useApi();
  const { envRefreshKey, characterRefreshKey, resourceVersion, highlightedSpeaker, setHighlightedSpeaker } = useAppStore();
  const [stage, setStage] = useState<StageDTO | null>(null);
  const [failedBackground, setFailedBackground] = useState<string | null>(null);
  const [failedSprites, setFailedSprites] = useState<string[]>([]);
  const [editingPortraits, setEditingPortraits] = useState(false);
  const [selectedPortrait, setSelectedPortrait] = useState<string | null>(null);
  const [portraitLayout, setPortraitLayout] = useState(() => readPortraitLayout(sessionId));
  const [imageBounds, setImageBounds] = useState<Record<string, PortraitBounds>>({});
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<{ name: string; pointerX: number; pointerY: number; x: number; y: number } | null>(null);
  useEffect(() => { setStage(null); }, [sessionId]);
  useEffect(() => { setFailedSprites([]); }, [sessionId, resourceVersion]);
  useEffect(() => { setFailedBackground(null); }, [sessionId, resourceVersion]);
  useEffect(() => {
    setPortraitLayout(readPortraitLayout(sessionId));
    setEditingPortraits(false);
    setSelectedPortrait(null);
  }, [sessionId]);

  const savePortraitLayout = useCallback((next: Record<string, PortraitAdjustment>) => {
    setPortraitLayout(next);
    try { localStorage.setItem(layoutKey(sessionId), JSON.stringify(next)); } catch { /* Storage can be disabled. */ }
  }, [sessionId]);

  // ── 舞台数据：背景 / 立绘 / 环境（环境、阵容、资源覆盖变化时重拉） ──
  useEffect(() => {
    let cancelled = false;
    api.getStage(sessionId).then((data) => {
      if (!cancelled) {
        setStage(data);
        setFailedBackground(null); // Retry once per successful refresh, never on image failure itself.
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, sessionId, envRefreshKey, characterRefreshKey, resourceVersion]);

  // ── 脚本与游标 ──
  const script = useMemo(
    () => buildStageScript(messages, [...new Set([...sceneCharacters, playerName].filter(Boolean))], playerName),
    [messages, sceneCharacters, playerName],
  );
  const [cursor, setCursor] = useState({ key: "", step: 0 });
  const step = cursor.key === script.key ? cursor.step : 0;
  const current = script.steps[Math.min(step, Math.max(0, script.steps.length - 1))];
  const atEnd = step >= script.steps.length - 1;
  const presenting = waiting || script.streaming;

  // 新一段开始：回到第一步
  useEffect(() => { setCursor({ key: script.key, step: 0 }); }, [script.key]);

  // ── 打字机 ──
  const [typedState, setTypedState] = useState({ key: "", count: 0 });
  const text = current?.text || "";
  const typingKey = `${script.key}:${step}`;
  const typed = typedState.key === typingKey ? typedState.count : 0;
  useEffect(() => {
    if (presenting) return;
    setTypedState({ key: typingKey, count: 0 });
    const total = text.length;
    if (!total) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const n = Math.min(total, Math.floor(((now - start) / 1000) * TYPE_CPS) + 1);
      setTypedState((previous) => ({ key: typingKey, count: Math.max(previous.key === typingKey ? previous.count : 0, n) }));
      if (n < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, typingKey, presenting]);
  const typing = !presenting && typed < text.length;
  const complete = !presenting && !typing && (script.steps.length === 0 || atEnd);
  const showChoices = !!script.choiceMessage && complete;
  useLayoutEffect(() => { onPlaybackChange(sessionId, messages, complete); }, [sessionId, messages, complete, onPlaybackChange]);

  // ── 说话人高亮：步进时同步到全局（场景角色列表也会亮） ──
  const sourceMessage = messages[script.messageIndex];
  const fallbackSpeaker = sourceMessage?.role === "character" && sourceMessage.content?.trim() && !script.steps.some((entry) => entry.kind === "dialogue") ? sourceMessage.character : undefined;
  const speaker = presenting ? undefined : speakerOfStep(current) || fallbackSpeaker;
  const [pulse, setPulse] = useState(0);
  useEffect(() => { setHighlightedSpeaker(speaker ?? null); }, [speaker, setHighlightedSpeaker]);
  useEffect(() => () => setHighlightedSpeaker(null), [setHighlightedSpeaker]);

  const advance = useCallback(() => {
    if (presenting || choicesDisabled || editingPortraits) return;
    if (typing) { setTypedState({ key: typingKey, count: text.length }); return; }
    setPulse((p) => p + 1);
    if (step < script.steps.length - 1) setCursor({ key: script.key, step: step + 1 });
  }, [presenting, choicesDisabled, editingPortraits, typing, typingKey, text.length, step, script.key, script.steps.length]);
  const back = useCallback(() => {
    if (step > 0) setCursor({ key: script.key, step: step - 1 });
  }, [step, script.key]);

  const rootRef = useRef<HTMLDivElement>(null);
  const fastForwardTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastForwardDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlPress = useRef<{ holding: boolean } | null>(null);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const stopFastForward = useCallback(() => {
    if (fastForwardTimer.current !== null) clearInterval(fastForwardTimer.current);
    fastForwardTimer.current = null;
    if (fastForwardDelay.current !== null) clearTimeout(fastForwardDelay.current);
    fastForwardDelay.current = null;
    controlPress.current = null;
  }, []);
  useEffect(() => {
    const onRelease = (event: KeyboardEvent) => {
      // A short, standalone Ctrl press advances only on release, after combo detection.
      if (event.key === "Control" && controlPress.current && !controlPress.current.holding
        && !event.altKey && !event.metaKey && !event.shiftKey) advanceRef.current();
      if (event.key === "Control" || !event.ctrlKey) stopFastForward();
    };
    const onCombo = (event: KeyboardEvent) => { if (event.key !== "Control") stopFastForward(); };
    const onVisibility = () => { if (document.hidden) stopFastForward(); };
    window.addEventListener("keyup", onRelease);
    window.addEventListener("keydown", onCombo);
    window.addEventListener("blur", stopFastForward);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopFastForward();
      window.removeEventListener("keyup", onRelease);
      window.removeEventListener("keydown", onCombo);
      window.removeEventListener("blur", stopFastForward);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stopFastForward]);
  useEffect(() => { stopFastForward(); }, [script.key, presenting, choicesDisabled, editingPortraits, complete, stopFastForward]);
  const backgroundPress = useRef<{ x: number; y: number } | null>(null);
  const isBackground = (target: EventTarget | null) => target instanceof HTMLElement
    && (target === rootRef.current || target.classList.contains("stage-bg") || target.classList.contains("stage-dialog-wrap"));
  const advanceBackground = (event: React.MouseEvent<HTMLDivElement>) => {
    const press = backgroundPress.current;
    backgroundPress.current = null;
    if (!press || !isBackground(event.target) || editingPortraits || event.defaultPrevented
      || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5
      || window.getSelection()?.toString()) return;
    advance();
  };
  useEffect(() => { if (stageOnly) rootRef.current?.focus(); }, [stageOnly]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && stageOnly && !editingPortraits) { e.preventDefault(); onExitStageOnly(); return; }
    if (editingPortraits) {
      if (e.key === "Escape") { e.preventDefault(); setEditingPortraits(false); }
      return;
    }
    if (e.nativeEvent.isComposing || e.altKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [contenteditable]")) return;
    if (e.key === "Control") {
      if (e.repeat || e.shiftKey || presenting || choicesDisabled || complete || controlPress.current) return;
      controlPress.current = { holding: false };
      fastForwardDelay.current = setTimeout(() => {
        fastForwardDelay.current = null;
        if (!controlPress.current) return;
        controlPress.current.holding = true;
        advanceRef.current();
        fastForwardTimer.current = setInterval(() => advanceRef.current(), 180);
      }, 450);
      return;
    }
    if (e.ctrlKey || target.closest("[role=button]")) return;
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); advance(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  };

  // ── 立绘落位 ──
  const npcSprites = stage?.characters ?? sceneCharacters.map((name) => ({ name, skin_url: null, avatar_url: null, color: characterColors[name] ?? null, active: false }));
  const segmentSpeakers = new Set(script.steps.map(speakerOfStep).filter((name): name is string => !!name));
  if (!segmentSpeakers.size && fallbackSpeaker) segmentSpeakers.add(fallbackSpeaker);
  // Filter against the whole completed segment, never the current typewriter sentence.
  // Completed narration and empty scripts have no speakers.
  const player = stage?.player;
  const cast = npcSprites.filter((sprite) => sprite.name !== player?.name);
  if (player?.name) cast.push({ ...player, active: false });
  const roster = [...new Map(cast.map((sprite) => [sprite.name, sprite])).values()];
  const nextSprites = roster.filter((sprite) => segmentSpeakers.has(sprite.name)
    || (editingPortraits && sprite.name === selectedPortrait));
  // Keep the last committed visual scene while the next script and stage data arrive.
  // Scope the snapshot to the session so switching sessions never borrows another cast.
  const lastScene = useRef<StageSceneSnapshot | null>(null);
  const previousScene = lastScene.current?.sessionId === sessionId
    ? lastScene.current : sceneSnapshots.get(sessionId) ?? null;
  const visibleStage = presenting ? previousScene?.stage ?? null : stage;
  const sprites = presenting ? previousScene?.sprites ?? [] : nextSprites;
  const focus = presenting ? previousScene?.focus ?? null : highlightedSpeaker ?? speaker ?? null;
  useLayoutEffect(() => {
    const snapshot = presenting ? previousScene : { sessionId, stage, sprites: nextSprites, focus };
    if (!snapshot) return;
    lastScene.current = snapshot;
    // Refresh recency even when remounting mid-generation; never cache that
    // generation's incomplete roster or newly fetched environment.
    sceneSnapshots.delete(sessionId);
    sceneSnapshots.set(sessionId, snapshot);
    if (sceneSnapshots.size > MAX_SCENE_SNAPSHOTS) {
      const oldestSession = sceneSnapshots.keys().next().value;
      if (oldestSession !== undefined) sceneSnapshots.delete(oldestSession);
    }
  });
  const positions = stagePositions(sprites.length);
  const someoneSpeaking = !!focus && sprites.some((s) => s.name === focus);

  const bgUrl = visibleStage?.background.url && visibleStage.background.url !== failedBackground ? visibleStage.background.url : null;
  const bgStyle = bgUrl
    ? { backgroundImage: `url("${bgUrl}")` }
    : { backgroundImage: proceduralBackground(visibleStage?.time || "", visibleStage?.weather || "") };
  const nameColor = speaker ? characterColors[speaker] || sprites.find((s) => s.name === speaker)?.color || undefined : undefined;

  const empty = messages.length === 0;
  const selectedIndex = sprites.findIndex((sprite) => sprite.name === selectedPortrait);
  const selectedDefaultX = positions[Math.max(0, selectedIndex)] ?? 50;
  const selectedAdjustment = selectedPortrait
    ? portraitLayout[selectedPortrait] ?? { x: selectedDefaultX, y: 0, scale: 1 }
    : null;
  const changePortrait = (name: string, defaults: PortraitAdjustment, patch: Partial<PortraitAdjustment>) => {
    savePortraitLayout({ ...portraitLayout, [name]: { ...defaults, ...portraitLayout[name], ...patch } });
  };
  const onSpriteLoad = (url: string, img: HTMLImageElement) => {
    const bounds = portraitBounds(img);
    setImageBounds((previous) => ({ ...previous, [url]: bounds }));
  };

  return (
    <div ref={rootRef} className={`stage ${stageOnly && actionInput ? "has-action-input" : ""}`} tabIndex={0} onKeyDown={onKey} onBlur={stopFastForward} aria-label="对话舞台"
      onPointerDown={(event) => { backgroundPress.current = event.button === 0 && isBackground(event.target) && !editingPortraits ? { x: event.clientX, y: event.clientY } : null; }}
      onPointerCancel={() => { backgroundPress.current = null; }} onClick={advanceBackground}>
      <div className="stage-bg" style={bgStyle} aria-hidden="true" />
      {bgUrl && <img src={bgUrl} alt="" className="hidden" onError={() => setFailedBackground(bgUrl)} />}
      <div className="stage-vignette" aria-hidden="true" />

      {/* 环境角标 */}
      {visibleStage && (visibleStage.location || visibleStage.weather || visibleStage.time) && (
        <div className="stage-env" title={visibleStage.atmosphere?.join("、") || undefined}>
          {visibleStage.location && <span><AppIcon name="location" size={11} />{visibleStage.location}</span>}
          {visibleStage.weather && <span><AppIcon name="weather" size={11} />{visibleStage.weather}</span>}
          {visibleStage.time && <span><AppIcon name="time" size={11} />{visibleStage.time}</span>}
        </div>
      )}

      {/* 顶部工具 */}
      <div className="stage-tools">
        {stageOnly && <button type="button" className="stage-exit" onClick={onExitStageOnly} title="退出纯舞台（Esc）" aria-label="退出纯舞台"><AppIcon name="minimize" size={13} /><span>退出舞台</span></button>}
        <button type="button" onClick={onToggleMusic} aria-label={musicMuted ? "开启背景音乐" : "静音背景音乐"}
          title={musicMuted ? "开启背景音乐" : "静音背景音乐"} aria-pressed={!musicMuted}>
          <AppIcon name={musicMuted ? "volumeOff" : "volume"} size={13} />
        </button>
        <button type="button" onClick={back} disabled={step === 0} title="上一句（←）" aria-label="上一句"><AppIcon name="back" size={13} /><span>上一句</span></button>
        <button type="button" onClick={onOpenLog} title="查看完整对话记录" aria-label="查看对话记录"><AppIcon name="docs" size={13} /><span>记录</span></button>
        <button type="button" aria-pressed={editingPortraits} onClick={() => {
          setEditingPortraits((value) => !value);
          setSelectedPortrait(sprites[0]?.name ?? roster[0]?.name ?? null);
        }} title="调整立绘大小和位置" aria-label={editingPortraits ? "完成立绘调整" : "调整立绘"}><AppIcon name="settings" size={13} /><span>{editingPortraits ? "完成调整" : "调整立绘"}</span></button>
      </div>

      {editingPortraits && (
        <div className="stage-edit-panel" role="group" aria-label="立绘调整">
          <label className="stage-edit-select">角色
            <select value={selectedPortrait ?? ""} onChange={(event) => setSelectedPortrait(event.target.value)}>
              {roster.map((sprite) => <option key={sprite.name} value={sprite.name}>{sprite.name}</option>)}
            </select>
          </label>
          {selectedPortrait && selectedAdjustment ? <>
            <p className="stage-edit-hint">拖动立绘调整位置，也可使用下方滑块微调。设置会保存在当前浏览器的本会话中。</p>
            <label className="stage-edit-range">大小 <output>{Math.round(selectedAdjustment.scale * 100)}%</output>
              <input type="range" min="40" max="220" step="5" value={Math.round(selectedAdjustment.scale * 100)}
                onChange={(event) => changePortrait(selectedPortrait, selectedAdjustment, { scale: Number(event.target.value) / 100 })} />
            </label>
            <label className="stage-edit-range">左右 <output>{Math.round(selectedAdjustment.x)}%</output>
              <input type="range" min="5" max="95" step="1" value={selectedAdjustment.x}
                onChange={(event) => changePortrait(selectedPortrait, selectedAdjustment, { x: Number(event.target.value) })} />
            </label>
            <label className="stage-edit-range">高低 <output>{Math.round(selectedAdjustment.y)}%</output>
              <input type="range" min="-25" max="45" step="1" value={selectedAdjustment.y}
                onChange={(event) => changePortrait(selectedPortrait, selectedAdjustment, { y: Number(event.target.value) })} />
            </label>
            <button type="button" className="stage-edit-reset" onClick={() => {
              const next = { ...portraitLayout }; delete next[selectedPortrait]; savePortraitLayout(next);
            }}>恢复该角色默认位置与大小</button>
          </> : <p className="stage-edit-hint">当前没有可调整的角色立绘。</p>}
        </div>
      )}

      {/* 立绘按非透明像素统一可见高度和底线；编辑时可额外预览所选角色。 */}
      <div
        className={`stage-cast ${someoneSpeaking && !editingPortraits ? "has-focus" : ""} ${editingPortraits ? "is-editing" : ""}`}
      >
        {sprites.map((sprite, i) => {
          const speaking = focus === sprite.name;
          const x = portraitLayout[sprite.name]?.x ?? positions[i];
          const y = portraitLayout[sprite.name]?.y ?? 0;
          const scale = portraitLayout[sprite.name]?.scale ?? 1;
          const bounds = sprite.skin_url ? imageBounds[sprite.skin_url] : undefined;
          const visibleWidth = bounds ? bounds.right - bounds.left : 0;
          const visibleHeight = bounds ? bounds.bottom - bounds.top : 0;
          const targetHeight = stageSize.height * (sprites.length >= 4 ? .68 : sprites.length === 3 ? .73 : .78);
          const maxWidth = stageSize.width * (sprites.length >= 4 ? .26 : sprites.length === 3 ? .34 : sprites.length === 2 ? .48 : .56);
          const imageScale = bounds && visibleWidth && visibleHeight
            ? Math.min(targetHeight / visibleHeight, maxWidth / visibleWidth) * scale : 0;
          const imageStyle: React.CSSProperties | undefined = bounds ? {
            width: bounds.width * imageScale,
            height: bounds.height * imageScale,
            left: -(bounds.left + visibleWidth / 2) * imageScale,
            bottom: -(bounds.height - bounds.bottom) * imageScale,
          } : undefined;
          return (
            <div
              key={sprite.name}
              className={`stage-sprite ${!sprite.skin_url || failedSprites.includes(sprite.skin_url) ? "is-avatar" : ""} ${speaking && !editingPortraits ? "is-speaking" : ""} ${speaking && pulse && !editingPortraits ? (pulse % 2 ? "is-pulse-a" : "is-pulse-b") : ""} ${selectedPortrait === sprite.name && editingPortraits ? "is-selected" : ""}`}
              style={{ left: `${x}%`, bottom: `${y}%`, zIndex: editingPortraits && selectedPortrait === sprite.name ? 7 : speaking ? 5 : 1 }}
              onClick={() => {
                if (editingPortraits) { setSelectedPortrait(sprite.name); return; }
                setHighlightedSpeaker(sprite.name); setPulse((p) => p + 1);
              }}
              onPointerDown={(event) => {
                if (!editingPortraits) return;
                event.preventDefault(); event.stopPropagation();
                setSelectedPortrait(sprite.name);
                dragRef.current = { name: sprite.name, pointerX: event.clientX, pointerY: event.clientY, x, y };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!editingPortraits || drag?.name !== sprite.name || !stageSize.width || !stageSize.height) return;
                changePortrait(sprite.name, { x: positions[i], y: 0, scale: 1 }, {
                  x: clamp(drag.x + (event.clientX - drag.pointerX) / stageSize.width * 100, 5, 95),
                  y: clamp(drag.y - (event.clientY - drag.pointerY) / stageSize.height * 100, -25, 45),
                });
              }}
              onPointerUp={() => { dragRef.current = null; }}
              onPointerCancel={() => { dragRef.current = null; }}
              title={sprite.name}
            >
              {sprite.skin_url && !failedSprites.includes(sprite.skin_url) ? (
                <img src={sprite.skin_url} alt={sprite.name} className="stage-sprite-img" style={imageStyle} draggable={false}
                  onLoad={(event) => onSpriteLoad(sprite.skin_url!, event.currentTarget)}
                  onError={() => setFailedSprites((prev) => [...prev, sprite.skin_url!])} />
              ) : (
                <div className="stage-sprite-card" style={{ borderColor: sprite.color || undefined }}>
                  <AvatarPlaceholder name={sprite.name} size="md" sessionId={sessionId} />
                  <span>{sprite.name}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="stage-dialog-wrap">
      {/* 对话框 */}
        {empty && !waiting ? (
          <div className="stage-dialog is-empty">
            {chatMode === "story" ? (
              <>
                <p className="stage-dialog-text">故事尚未开始。</p>
                <button type="button" className="stage-start" onClick={onStart}>开始剧情</button>
              </>
            ) : (
              <p className="stage-dialog-text">在下方输入消息，与场景中的角色对话。</p>
            )}
          </div>
        ) : (
          <div
            className={`stage-dialog ${presenting ? "is-waiting" : ""} ${current?.kind === "player" ? "is-player" : ""} ${current?.kind === "system" ? "is-system" : ""}`}
            onClick={(event) => { event.stopPropagation(); if (!window.getSelection()?.toString()) advance(); }}
            onKeyDown={(event) => { if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); advance(); } }}
            role="button"
            aria-label="推进当前对话"
            aria-disabled={presenting || choicesDisabled || editingPortraits}
            tabIndex={0}
            style={{ fontSize: `${fontSize}px` }}
          >
            {(speaker || (current?.kind === "player")) && (
              <div className="stage-name" style={nameColor ? { "--role-color": nameColor } as React.CSSProperties : undefined}>
                <span className="stage-name-avatar"><AvatarPlaceholder name={speaker || playerName} size="sm" sessionId={sessionId} /></span>
                <span>{speaker || playerName}</span>
              </div>
            )}
            <div className={`stage-dialog-text ${current?.kind === "narration" ? "is-narration" : ""}`}>
              {presenting ? (
                <span className="stage-waiting">
                  <i /><i /><i />
                  <span>正在排演下一幕{elapsedSeconds > 0 ? `（${elapsedSeconds}s）` : ""}…</span>
                </span>
              ) : (
                <>
                  {text.slice(0, typed)}
                  {typing && <span className="stage-caret" />}
                </>
              )}
            </div>
            {!presenting && text && (
              <div className="stage-dialog-foot">
                <span className="stage-progress">{Math.min(step + 1, script.steps.length)} / {script.steps.length}{!complete && " · Ctrl 快进"}</span>
                {!atEnd && !typing && <span className="stage-next" aria-hidden="true">▼</span>}
                {atEnd && !typing && !showChoices && <span className="stage-next is-end">继续输入 ↓</span>}
              </div>
            )}
          </div>
        )}
      {/* 选项 */}
      {showChoices && script.choiceMessage && (
        <div className="stage-choices" role="group" aria-label="选项">
          <span className="stage-choices-title">选择一项，或自由输入</span>
          {script.choiceMessage.branches?.length
            ? script.choiceMessage.branches.map((b) => (
              <button key={b.id} type="button" className="stage-choice" disabled={choicesDisabled}
                onClick={() => onChoice(b.label, b)} title={b.target_beat_id ? `目标节点：${b.target_beat_id}` : undefined}>
                <span>{b.label}</span>
                {b.intent && <em>{b.intent}</em>}
              </button>
            ))
            : script.choiceMessage.choices?.map((choice, ci) => (
              <button key={ci} type="button" className="stage-choice" disabled={choicesDisabled} onClick={() => onChoice(choice)}>
                <span>{choice}</span>
              </button>
            ))}
        </div>
      )}

        {actionInput}
      </div>
    </div>
  );
}
