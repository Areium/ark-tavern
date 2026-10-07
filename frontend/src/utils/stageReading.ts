import type { StageScript, StageStep } from "./stageScript";

export interface ReadingPage { text: string; sourceStart: number; sourceEnd: number }
// The runtime (Chromium/Node) supports Segmenter; keep ES2020 project lib unchanged.
const Segmenter = (Intl as unknown as { Segmenter: new (locale?: string, options?: { granularity: string }) => {
  segment: (text: string) => Iterable<{ segment: string; index: number }>;
} }).Segmenter;
const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string) => Array.from(segmenter.segment(text));

/** Fixed boundaries: only the final page may grow as more text arrives. */
export function paginatePreview(text: string, limit = 140): ReadingPage[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Invalid page size");
  const units = graphemes(text);
  const pages: ReadingPage[] = [];
  for (let i = 0; i < units.length; i += limit) {
    const sourceStart = units[i].index;
    const sourceEnd = units[i + limit]?.index ?? text.length;
    pages.push({ text: text.slice(sourceStart, sourceEnd), sourceStart, sourceEnd });
  }
  return pages;
}

/** JSON streams have no readable prose until text_complete supplies canonical text. */
export function isJsonPreview(text: string): boolean {
  return /^[\s\uFEFF]*(?:\[\s*(?:\{|\]|$)|\{\s*(?:"|\}|$)|```)/.test(text);
}

/** Only exact transformations can establish an offset; never fuzzy-match a sentence. */
export function canonicalOffset(raw: string, canonical: string, offset: number): number | null {
  if (raw === canonical) return Math.min(offset, canonical.length);
  if (raw && canonical.endsWith(raw)) return canonical.length - raw.length + offset;
  if (canonical && raw.endsWith(canonical)) return Math.max(0, offset - (raw.length - canonical.length));
  return null;
}

export function stepAtSource(steps: StageStep[], offset: number): number | null {
  if (!steps.length || steps.some(step => step.sourceStart === undefined || step.sourceEnd === undefined)) return null;
  // An offset in a removed speaker label belongs to the following utterance.
  const index = steps.findIndex(step => offset < step.sourceEnd!);
  return index < 0 ? steps.length - 1 : index;
}

export interface ReadingCursor {
  key: string;
  step: number;
  mode: "preview" | "formal" | "plain";
  sourceStart: number;
  raw: string;
  revealed?: boolean;
  readRanges?: Array<{ start: number; end: number }>;
}

function addReadRange(ranges: NonNullable<ReadingCursor["readRanges"]>, start: number, end: number) {
  const sorted = [...ranges, { start, end }].sort((a, b) => a.start - b.start);
  const merged: typeof sorted = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

const cursors = new Map<string, ReadingCursor>();
const MAX_CURSORS = 48;
export const readingKey = (sessionId: string, scriptKey: string) => JSON.stringify([sessionId, scriptKey]);
export const cachedReading = (key: string) => cursors.get(key);
export function rememberReading(cursor: ReadingCursor): void {
  cursors.delete(cursor.key);
  cursors.set(cursor.key, cursor);
  while (cursors.size > MAX_CURSORS) cursors.delete(cursors.keys().next().value!);
}

/** Resolve in render so completion/remount never briefly paints the first page. */
export function resolveReading(script: StageScript, key: string, previous?: ReadingCursor): { cursor: ReadingCursor; steps: StageStep[] } {
  const matching = previous?.key === key ? previous : undefined;
  let steps = script.steps;
  let mode: ReadingCursor["mode"] = script.preview ? "preview" : "formal";
  let step = matching?.step ?? 0;
  let revealed = matching?.revealed;
  let raw = script.previewText;
  let readRanges = matching?.readRanges ?? [];
  if (!script.preview && matching?.mode === "preview") {
    const finalRaw = script.previewText || matching.raw;
    const offset = canonicalOffset(finalRaw, script.content, matching.sourceStart);
    readRanges = readRanges.flatMap(range => {
      const start = canonicalOffset(finalRaw, script.content, range.start);
      const end = canonicalOffset(finalRaw, script.content, range.end);
      return start !== null && end !== null && end > start ? [{ start, end }] : [];
    });
    const mapped = offset === null ? null : stepAtSource(steps, offset);
    if (mapped === null && matching.raw) mode = "plain";
    else { step = mapped ?? 0; revealed = true; }
  } else if (!script.preview && matching?.mode === "plain") mode = "plain";
  if (mode === "plain") {
    // Keep the already displayed source for this generation when alignment fails.
    raw = script.previewText || matching?.raw || script.content;
    steps = paginatePreview(raw).map(page => ({ ...page, kind: "narration" }));
    revealed = true;
  }
  step = Math.max(0, Math.min(step, steps.length - 1));
  if (mode === "preview" && steps[step]) readRanges = addReadRange(readRanges, steps[step].sourceStart!, steps[step].sourceEnd!);
  if (mode === "formal" && readRanges.some(range => (steps[step]?.sourceStart ?? Infinity) < range.end
    && (steps[step]?.sourceEnd ?? -1) > range.start)) revealed = true;
  return {
    steps,
    cursor: { key, step, mode, sourceStart: steps[step]?.sourceStart ?? 0, raw, revealed, readRanges },
  };
}
