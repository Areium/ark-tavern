/**
 * 对话舞台（视觉小说视图）—— 背景 + 场景角色立绘 + 底部对话框，逐句推进。
 *
 * 只演「当前这一段」（`utils/stageScript.ts` 折算最新一条叙述 / 回复），玩家点击对话框
 * 推进；说话的角色立绘高亮、其余压暗；走到末尾若有选项就在舞台上亮出来。
 * 完整消息流仍可通过「记录」打开（由 ChatPanel 提供）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  elapsedSeconds: number;
  choicesDisabled: boolean;
  onChoice: (choice: string, branch?: BranchChoice) => void;
  onOpenLog: () => void;
  onStart: () => void;
  chatMode: "story" | "free";
}

/** 打字机速度（字 / 秒）；流式生成时不用打字机（文本本来就在长） */
const TYPE_CPS = 45;

export default function StageView({
  sessionId, messages, sceneCharacters, playerName, characterColors, fontSize, waiting,
  elapsedSeconds, choicesDisabled, onChoice, onOpenLog, onStart, chatMode,
}: Props) {
  const api = useApi();
  const { envRefreshKey, characterRefreshKey, resourceVersion, highlightedSpeaker, setHighlightedSpeaker } = useAppStore();
  const [stage, setStage] = useState<StageDTO | null>(null);
  const [bgFailed, setBgFailed] = useState(false);
  const [failedSprites, setFailedSprites] = useState<string[]>([]);
  useEffect(() => { setStage(null); }, [sessionId]);
  useEffect(() => { setFailedSprites([]); }, [sessionId, resourceVersion]);

  // ── 舞台数据：背景 / 立绘 / 环境（环境、阵容、资源覆盖变化时重拉） ──
  useEffect(() => {
    let cancelled = false;
    api.getStage(sessionId).then((data) => { if (!cancelled) { setStage(data); setBgFailed(false); } }).catch(() => {});
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
  const showChoices = !!script.choiceMessage && (script.steps.length === 0 || atEnd) && !script.streaming;

  // 新一段开始：回到第一步
  useEffect(() => { setCursor({ key: script.key, step: 0 }); }, [script.key]);

  // ── 打字机 ──
  const [typed, setTyped] = useState(0);
  const text = current?.text || "";
  useEffect(() => {
    if (script.streaming) { setTyped(text.length); return; }
    setTyped(0);
    const total = text.length;
    if (!total) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const n = Math.min(total, Math.floor(((now - start) / 1000) * TYPE_CPS) + 1);
      setTyped(n);
      if (n < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, script.key, step, script.streaming]);
  const typing = !script.streaming && typed < text.length;

  // ── 说话人高亮：步进时同步到全局（场景角色列表也会亮） ──
  const sourceMessage = messages[script.messageIndex];
  const fallbackSpeaker = sourceMessage?.role === "character" && sourceMessage.content?.trim() && !script.steps.some((entry) => entry.kind === "dialogue") ? sourceMessage.character : undefined;
  const speaker = speakerOfStep(current) || fallbackSpeaker;
  const [pulse, setPulse] = useState(0);
  useEffect(() => { setHighlightedSpeaker(speaker ?? null); }, [speaker, setHighlightedSpeaker]);
  useEffect(() => () => setHighlightedSpeaker(null), [setHighlightedSpeaker]);

  const advance = useCallback(() => {
    if (typing) { setTyped(text.length); return; }
    setPulse((p) => p + 1);
    if (step < script.steps.length - 1) setCursor({ key: script.key, step: step + 1 });
  }, [typing, text.length, step, script.key, script.steps.length]);
  const back = useCallback(() => {
    if (step > 0) setCursor({ key: script.key, step: step - 1 });
  }, [step, script.key]);

  const rootRef = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); advance(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  };

  // ── 立绘落位 ──
  const npcSprites = stage?.characters ?? sceneCharacters.map((name) => ({ name, skin_url: null, avatar_url: null, color: characterColors[name] ?? null, active: false }));
  const segmentSpeakers = new Set(script.steps.map(speakerOfStep).filter((name): name is string => !!name));
  if (!segmentSpeakers.size && fallbackSpeaker) segmentSpeakers.add(fallbackSpeaker);
  // Filter against the whole completed segment, never the current typewriter sentence.
  // Only unfinished streaming keeps the roster; completed narration and empty scripts have no speakers.
  const player = stage?.player;
  const cast = npcSprites.filter((sprite) => sprite.name !== player?.name);
  if (player?.name && segmentSpeakers.has(player.name)) cast.push({ ...player, active: false });
  const sprites = [...new Map(cast.map((sprite) => [sprite.name, sprite])).values()]
    .filter((sprite) => script.streaming || segmentSpeakers.has(sprite.name));
  const positions = stagePositions(sprites.length);
  const focus = highlightedSpeaker ?? speaker ?? null;
  const someoneSpeaking = !!focus && sprites.some((s) => s.name === focus);

  const bgUrl = !bgFailed ? stage?.background.url ?? null : null;
  const bgStyle = bgUrl
    ? { backgroundImage: `url("${bgUrl}")` }
    : { backgroundImage: proceduralBackground(stage?.time || "", stage?.weather || "") };
  const nameColor = speaker ? characterColors[speaker] || sprites.find((s) => s.name === speaker)?.color || undefined : undefined;

  const empty = messages.length === 0;

  return (
    <div ref={rootRef} className="stage" tabIndex={0} onKeyDown={onKey} aria-label="对话舞台">
      <div className="stage-bg" style={bgStyle} aria-hidden="true" />
      {bgUrl && <img src={bgUrl} alt="" className="hidden" onError={() => setBgFailed(true)} />}
      <div className="stage-vignette" aria-hidden="true" />

      {/* 环境角标 */}
      {stage && (stage.location || stage.weather || stage.time) && (
        <div className="stage-env" title={stage.atmosphere?.join("、") || undefined}>
          {stage.location && <span><AppIcon name="location" size={11} />{stage.location}</span>}
          {stage.weather && <span><AppIcon name="weather" size={11} />{stage.weather}</span>}
          {stage.time && <span><AppIcon name="time" size={11} />{stage.time}</span>}
        </div>
      )}

      {/* 顶部工具 */}
      <div className="stage-tools">
        <button type="button" onClick={back} disabled={step === 0} title="上一句（←）"><AppIcon name="back" size={13} />上一句</button>
        <button type="button" onClick={onOpenLog} title="查看完整对话记录"><AppIcon name="docs" size={13} />记录</button>
      </div>

      {/* 立绘：人越多越小，避免三四张全身像叠成一团；点击高亮时用两套动画名交替，重复点击也会再闪一次 */}
      <div
        className={`stage-cast ${someoneSpeaking ? "has-focus" : ""}`}
        style={{
          "--sprite-h": sprites.length >= 4 ? "70%" : sprites.length === 3 ? "78%" : sprites.length === 2 ? "84%" : "88%",
          "--sprite-w": sprites.length >= 4 ? "28%" : sprites.length === 3 ? "36%" : "46%",
        } as React.CSSProperties}
      >
        {sprites.map((sprite, i) => {
          const speaking = focus === sprite.name;
          return (
            <div
              key={sprite.name}
              className={`stage-sprite ${!sprite.skin_url || failedSprites.includes(sprite.skin_url) ? "is-avatar" : ""} ${speaking ? "is-speaking" : ""} ${speaking && pulse ? (pulse % 2 ? "is-pulse-a" : "is-pulse-b") : ""}`}
              style={{ left: `${positions[i]}%`, zIndex: speaking ? 5 : 1 }}
              onClick={() => { setHighlightedSpeaker(sprite.name); setPulse((p) => p + 1); }}
              title={sprite.name}
            >
              {sprite.skin_url && !failedSprites.includes(sprite.skin_url) ? (
                <img src={sprite.skin_url} alt={sprite.name} className="stage-sprite-img" draggable={false} onError={() => setFailedSprites((prev) => [...prev, sprite.skin_url!])} />
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

      {/* 选项 */}
      {showChoices && script.choiceMessage && (
        <div className="stage-choices" role="group" aria-label="选项">
          <span className="stage-choices-title">— 请选择 —</span>
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

      {/* 对话框 */}
      <div className="stage-dialog-wrap">
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
            className={`stage-dialog ${current?.kind === "player" ? "is-player" : ""} ${current?.kind === "system" ? "is-system" : ""}`}
            onClick={advance}
            role="button"
            tabIndex={-1}
            style={{ fontSize: `${fontSize}px` }}
          >
            {(speaker || (current?.kind === "player")) && (
              <div className="stage-name" style={nameColor ? { "--role-color": nameColor } as React.CSSProperties : undefined}>
                <AvatarPlaceholder name={speaker || playerName} size="sm" sessionId={sessionId} />
                <span>{speaker}</span>
              </div>
            )}
            <div className={`stage-dialog-text ${current?.kind === "narration" ? "is-narration" : ""}`}>
              {waiting && !text ? (
                <span className="stage-waiting">
                  <i /><i /><i />
                  <span>正在编织下一段{elapsedSeconds > 0 ? `（${elapsedSeconds}s）` : ""}…</span>
                </span>
              ) : (
                <>
                  {script.streaming ? text : text.slice(0, typed)}
                  {(script.streaming || typing) && <span className="stage-caret" />}
                </>
              )}
            </div>
            {!script.streaming && !waiting && text && (
              <div className="stage-dialog-foot">
                <span className="stage-progress">{Math.min(step + 1, script.steps.length)} / {script.steps.length}</span>
                {!atEnd && !typing && <span className="stage-next" aria-hidden="true">▼</span>}
                {atEnd && !typing && !showChoices && <span className="stage-next is-end">继续输入 ↓</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
