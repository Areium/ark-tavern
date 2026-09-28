export interface DialogueSegment {
  type: "narration" | "dialogue";
  text: string;
  speaker?: string;
}

type RawSegment = { type?: string; text?: unknown; speaker?: unknown };
const SPEECH = "(?:说道|说|道|问道|问|答道|回答|答|喊道|喊|提醒|补充|解释|开口|喃喃|嘀咕)(?:道)?";
const MODIFIER = "(?:(?:轻|低|沉|高|大|小)声|(?:平静|认真|缓缓|冷冷|淡淡|坚定|轻轻)(?:地)?|笑着|哭着|接着|继续|突然)";
const punctuationOnly = /^[\s，,、：:；;。.!！?？…—]*$/;
const escapeRegex = (name: string) => name.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");

/** Require a named subject with a speech predicate or a bare name label.
 * Merely mentioning/looking at a character never identifies a speaker.
 */
function attribution(text: string, names: string[]): { speaker?: string; labelStart?: number } {
  const recipient = [...names, "他", "她", "他们", "她们", "你", "你们", "众人", "大家"].map(escapeRegex).join("|");
  const speechTail = new RegExp("^(?:" + MODIFIER + "|(?:对|向)(?:" + recipient + ")){0,3}" + SPEECH + "\\s*[：:，,。.!！?？]*\\s*$");
  let result: { speaker?: string; labelStart?: number } = {};
  let latest = -1;
  for (const name of names) {
    const pattern = new RegExp("(^|[\\s。！？!?；;，,])(" + escapeRegex(name) + ")(?![A-Za-z0-9_])", "g");
    for (const match of text.matchAll(pattern)) {
      const start = match.index! + match[1].length;
      const tail = text.slice(start + name.length);
      const label = /^\s*[：:]\s*$/.test(tail);
      if ((label || speechTail.test(tail)) && start > latest) {
        latest = start;
        result = { speaker: name, labelStart: label || !/[，,对向]/.test(tail) ? start : undefined };
      }
    }
  }
  return result;
}

/** Closed corner/curly quotes are dialogue; incomplete quotes stay untouched.
 * Explicit attribution beats the message default. Continuation crosses only
 * punctuation, never a narrative action or a new paragraph.
 */
export function parseDialogue(text: string, knownSpeaker: string | undefined, sceneCharacters: string[]): DialogueSegment[] {
  if (!text) return [];
  const names = [...new Set([...sceneCharacters, knownSpeaker || ""].map(name => name.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const quotes = [...text.matchAll(/「([^」]*)」|“([^”]*)”/g)];
  const segments: DialogueSegment[] = [];
  let cursor = 0;
  let lastSpeaker: string | undefined;
  for (let index = 0; index < quotes.length; index++) {
    const quote = quotes[index];
    const start = quote.index!;
    const end = start + quote[0].length;
    const before = text.slice(cursor, start);
    const after = text.slice(end, quotes[index + 1]?.index ?? text.length);
    const preceding = attribution(before, names);
    // A postposed attribution must start immediately after this quote.
    const postClause = after.match(/^[ \t，,]*([^。！？!?；;\n：:]+)(?:[。！？!?；;]|$)/)?.[1] || "";
    const following = attribution(postClause, names);
    const postSpeaker = following.speaker && postClause.trimStart().startsWith(following.speaker)
      ? following.speaker : undefined;
    const unknownLabel = !preceding.speaker && /[^\s：:]+\s*[：:]\s*$/.test(before);
    const continuation = punctuationOnly.test(before) && !/\n\s*\n/.test(before);
    const speaker = preceding.speaker || postSpeaker || (unknownLabel ? undefined : knownSpeaker || (continuation ? lastSpeaker : undefined));
    const narration = preceding.labelStart === undefined ? before : before.slice(0, preceding.labelStart);
    if (narration.trim()) segments.push({ type: "narration", text: narration });
    segments.push({ type: "dialogue", text: quote[1] ?? quote[2], speaker });
    lastSpeaker = speaker;
    cursor = end;
  }
  if (text.slice(cursor).trim()) segments.push({ type: "narration", text: text.slice(cursor) });
  return segments;
}

/** Missing speaker may continue adjacent dialogue; explicit null/empty means
 * unknown and clears the chain. Narration and invalid segments end the chain.
 */
export function normalizeSegments(segments: ReadonlyArray<RawSegment>): DialogueSegment[] {
  if (!Array.isArray(segments)) return [];
  const result: DialogueSegment[] = [];
  let lastSpeaker: string | undefined;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") { lastSpeaker = undefined; continue; }
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (seg.type !== "dialogue") {
      lastSpeaker = undefined;
      if (text) result.push({ type: "narration", text });
      continue;
    }
    const speaker = Object.prototype.hasOwnProperty.call(seg, "speaker")
      ? (typeof seg.speaker === "string" ? seg.speaker.trim() || undefined : undefined)
      : lastSpeaker;
    lastSpeaker = speaker;
    if (text) result.push({ type: "dialogue", text, speaker });
  }
  return result;
}
