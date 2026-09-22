/**
 * 舞台脚本 —— 把消息流折算成视觉小说式的「逐句推进」脚本（纯逻辑，无 React）。
 *
 * 对话页的舞台模式只关心「当前这一段」：把最新一条叙述 / 角色回复拆成若干步（叙述、
 * 台词），玩家点击对话框逐步推进；走到末尾若紧跟着一条选项消息，就把选项亮出来。
 * 流式生成中的叙述作为单独一步实时显示。
 */
import type { ChatMessage } from "../types";
import { parseDialogue, normalizeSegments, type DialogueSegment } from "./dialogueParser";

export type StageStepKind = "narration" | "dialogue" | "player" | "system";

export interface StageStep {
  kind: StageStepKind;
  text: string;
  /** 说话人（dialogue / player 时有） */
  speaker?: string;
}

export interface StageScript {
  /** 脚本来源消息在消息数组中的下标（-1 = 没有可演的消息） */
  messageIndex: number;
  /** 一个稳定的键：消息下标 + 轮次 + 变体 —— 变了就从第一步重新开始 */
  key: string;
  steps: StageStep[];
  /** 脚本末尾紧跟的选项消息（可选） */
  choiceMessage: ChatMessage | null;
  choiceIndex: number;
  /** 正在流式生成：文本随时变化，不做逐步推进 */
  streaming: boolean;
}

const EMPTY: StageScript = {
  messageIndex: -1, key: "empty", steps: [], choiceMessage: null, choiceIndex: -1, streaming: false,
};

/** 一句台词太长时按句号 / 换行拆成多步，避免对话框塞不下 */
export const STEP_MAX_CHARS = 140;

export function splitLongText(text: string, limit = STEP_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];
  const out: string[] = [];
  let current = "";
  // 先按换行切，再按句末标点切；每一片都尽量不超过 limit
  const pieces = trimmed.split(/\n+/).flatMap((line) => line.split(/(?<=[。！？!?；;…])/));
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    if (current && current.length + piece.length > limit) {
      out.push(current);
      current = piece;
    } else {
      current = current ? current + piece : piece;
    }
  }
  if (current) out.push(current);
  // 单片仍超长（没有标点的长段）：硬切
  return out.flatMap((chunk) => {
    if (chunk.length <= limit * 1.5) return [chunk];
    const hard: string[] = [];
    for (let i = 0; i < chunk.length; i += limit) hard.push(chunk.slice(i, i + limit));
    return hard;
  });
}

function segmentsOf(msg: ChatMessage, sceneCharacters: string[]): DialogueSegment[] {
  let segments: DialogueSegment[] = (msg.dialogueSegments as DialogueSegment[] | undefined) || [];
  if (!segments.length) segments = parseDialogue(msg.content || "", msg.character, sceneCharacters);
  return normalizeSegments(segments);
}

/** 把一条消息展开成舞台步骤 */
export function stepsForMessage(msg: ChatMessage, sceneCharacters: string[], playerName: string): StageStep[] {
  if (msg.role === "user") {
    return splitLongText(msg.content).map((text) => ({ kind: "player" as const, text, speaker: playerName }));
  }
  if (msg.role === "system") {
    return splitLongText(msg.content).map((text) => ({ kind: "system" as const, text }));
  }
  const steps: StageStep[] = [];
  for (const seg of segmentsOf(msg, sceneCharacters)) {
    if (seg.type === "dialogue") {
      for (const text of splitLongText(seg.text)) steps.push({ kind: "dialogue", text, speaker: seg.speaker || msg.character });
    } else {
      for (const text of splitLongText(seg.text)) steps.push({ kind: "narration", text });
    }
  }
  if (!steps.length && msg.content?.trim()) {
    steps.push({ kind: msg.role === "character" ? "dialogue" : "narration", text: msg.content.trim(), speaker: msg.character });
  }
  return steps;
}

/** 选项消息：system 且带 choices / branches */
export function isChoiceMessage(msg: ChatMessage | undefined | null): boolean {
  return !!msg && msg.role === "system" && !!(msg.choices?.length || msg.branches?.length);
}

/**
 * 从消息流里取「当前要演的一段」：
 *  - 最后一条非选项消息（叙述 / 角色回复 / 玩家输入 / 系统提示）作为脚本；
 *  - 若其后紧跟选项消息，作为脚本的收尾选项；
 *  - 只有选项、没有正文时（如刚回档），脚本为空但选项照常显示。
 */
export function buildStageScript(
  messages: ReadonlyArray<ChatMessage>,
  sceneCharacters: string[],
  playerName: string,
): StageScript {
  if (!messages.length) return EMPTY;
  let choiceIndex = -1;
  let index = messages.length - 1;
  if (isChoiceMessage(messages[index])) {
    choiceIndex = index;
    index -= 1;
  }
  if (index < 0) {
    return { ...EMPTY, choiceMessage: messages[choiceIndex] ?? null, choiceIndex, key: `choice-${choiceIndex}` };
  }
  const msg = messages[index];
  const streaming = !!msg.streaming;
  const steps = streaming
    ? [{ kind: (msg.role === "character" ? "dialogue" : "narration") as StageStepKind, text: msg.content || "", speaker: msg.character }]
    : stepsForMessage(msg, sceneCharacters, playerName);
  return {
    messageIndex: index,
    key: `${index}:${msg.round ?? ""}:${msg.variantIndex ?? 0}:${streaming ? "s" : "d"}`,
    steps,
    choiceMessage: choiceIndex >= 0 ? messages[choiceIndex] : null,
    choiceIndex,
    streaming,
  };
}

/** 当前步的说话人（叙述 / 系统 → 无） */
export function speakerOfStep(step: StageStep | undefined): string | undefined {
  if (!step) return undefined;
  return step.kind === "dialogue" || step.kind === "player" ? step.speaker : undefined;
}

/** 立绘落位：把 N 个角色均匀铺在舞台宽度上（返回每个角色中心点的百分比位置） */
export function stagePositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [50];
  const margin = count <= 3 ? 22 : 12;
  const span = 100 - margin * 2;
  return Array.from({ length: count }, (_, i) => margin + (span * i) / (count - 1));
}

/** 时段 / 天气 → 程序化背景（没有任何背景图时的兜底渐变） */
export function proceduralBackground(time: string, weather: string): string {
  const t = time || "";
  const w = weather || "";
  let top = "#1d2a44", bottom = "#0b0e14";
  if (/清晨|早/.test(t)) { top = "#3b4a6b"; bottom = "#c8a56a"; }
  else if (/上午|中午|白天/.test(t)) { top = "#4a6f9a"; bottom = "#a9c3d6"; }
  else if (/下午/.test(t)) { top = "#5b6f94"; bottom = "#c9a37a"; }
  else if (/黄昏|傍晚/.test(t)) { top = "#3a2c4a"; bottom = "#c46a3e"; }
  else if (/深夜/.test(t)) { top = "#05070d"; bottom = "#141a2b"; }
  else if (/夜/.test(t)) { top = "#0d1428"; bottom = "#1f2a48"; }
  if (/雨|暴/.test(w)) { top = mix(top, "#2c3440", 0.5); bottom = mix(bottom, "#1a1f27", 0.5); }
  if (/雪/.test(w)) { top = mix(top, "#6d7d90", 0.4); bottom = mix(bottom, "#b7c3cf", 0.4); }
  if (/雾/.test(w)) { top = mix(top, "#5a6068", 0.5); bottom = mix(bottom, "#8a9099", 0.5); }
  if (/沙/.test(w)) { top = mix(top, "#8a6a3a", 0.5); bottom = mix(bottom, "#c19a5b", 0.5); }
  return `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`;
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a), pb = hex(b);
  if (!pa || !pb) return a;
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hex(color: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
