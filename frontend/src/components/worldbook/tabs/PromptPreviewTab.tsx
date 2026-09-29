import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../../hooks/useApi";
import { buildSaveBody } from "../../../hooks/useWorldbookDraft";
import type { WorldBookEntryDTO, WorldBookPromptLayer, WorldBookPromptPreviewDTO, WorldBookPromptPreviewRequest } from "../../../types";
import { bookEntryStats } from "../../../utils/worldbookLayer";
import type { WorldBookPanelProps } from "../panel";
import "../../../styles/worldbook-prompt-preview.css";

export const PROMPT_PREVIEW_SCOPE_NOTE = "预览本世界书全部启用条目的插入内容，未启用的条目不参与预览。";
export const SYSTEM_LAYER_PREVIEW_NOTE = "系统层条目（节点图 / 节点绑定）不是注入内容：它们只服务画布与系统判定，永不进提示词，因此既不出现在这里，也不计入 token。";
export const DYNAMIC_TRIGGER_NOTE = "动态层逐条展示所有启用的动态条目；全书预览不代表当前对话已触发。实际对话中，条目会按载入范围、关键词匹配、主副关键词组合和触发概率等规则插入；设为常驻但位于动态位置的条目无需关键词触发。实际插入还受预算与节点规则影响。";

export function describeDynamicTrigger(entry: WorldBookEntryDTO): string {
  const primary = entry.trigger_keys || [];
  const secondary = entry.secondary_keys || [];
  let condition: string;
  if (entry.always_active) {
    condition = "常驻，无需关键词命中";
  } else if (entry.selective) {
    condition = primary.length
      ? `主关键词任一命中（${primary.join("、")}）${secondary.length ? `，且副关键词任一命中（${secondary.join("、")}）` : ""}`
      : "未设置主关键词，无法由关键词自动触发";
  } else {
    const keys = [...primary, ...secondary];
    condition = keys.length
      ? `主或副关键词任一命中（${keys.join("、")}）`
      : "未设置关键词，无法由关键词自动触发";
  }
  const matching = entry.always_active ? "" : `；${entry.case_sensitive ? "区分大小写" : "不区分大小写"}${entry.match_whole_words ? "，匹配完整单词" : ""}`;
  const probability = entry.probability < 100 ? `；通过后以 ${entry.probability}% 概率插入` : "";
  return `${condition}${matching}${probability}。`;
}

function entryPreviewText(entry: WorldBookEntryDTO): string {
  const content = (entry.content || "").split("{{user}}").join("玩家").split("{{char}}").join("");
  return entry.name ? `### ${entry.name}\n${content}` : content;
}

function usePromptPreview(
  bookId: string, body: WorldBookPromptPreviewRequest, revision: number | undefined,
) {
  const api = useApi();
  const [data, setData] = useState<WorldBookPromptPreviewDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);
  // 语义键：内容没变就不重发（引用变了不算变化）
  const bodyKey = JSON.stringify(body);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  // 换书时清空：绝不把上一本书的预览留在新书上
  useEffect(() => { setData(null); setError(""); }, [bookId]);

  useEffect(() => {
    const seq = ++sequence.current;
    if (!bookId) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api.previewWorldbookPrompt(bookId, bodyRef.current)
        .then((value) => { if (seq === sequence.current) { setData(value); setError(""); } })
        .catch((e) => {
          if (seq !== sequence.current) return;       // 过时响应直接丢弃
          setData(null);
          setError(e instanceof Error ? e.message : "Prompt 预览失败");
        })
        .finally(() => { if (seq === sequence.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [api, bookId, bodyKey, revision, nonce]);

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, retry };
}

export default function PromptPreviewTab({ ctx, onNotice }: {
  ctx: Pick<WorldBookPanelProps, "detail" | "draft">;
  onNotice: (text: string) => void;
}) {
  const { detail, draft } = ctx;
  const [layer, setLayer] = useState<WorldBookPromptLayer>("stable");
  const policy = useMemo(() => buildSaveBody(draft), [draft]);
  const requestBody = useMemo<WorldBookPromptPreviewRequest>(() => ({
    mode: "narrative", all_entries: true, policy,
  }), [policy]);
  const { data: preview, loading, error, retry } = usePromptPreview(
    detail.id, requestBody, detail.import_config?.revision);
  const text = preview ? (layer === "stable" ? preview.stable_text : preview.dynamic_text) : "";
  const counts = {
    stable: preview?.order.filter((entry) => entry.layer === "stable").length ?? 0,
    dynamic: preview?.order.filter((entry) => entry.layer === "dynamic").length ?? 0,
  };
  const entriesByUid = useMemo(() => new Map(detail.entries.map((entry) => [entry.uid, entry])), [detail.entries]);
  const dynamicEntries = preview?.order.filter((entry) => entry.layer === "dynamic") ?? [];
  // 系统层条目不进预览、不计 token —— 在这里显式说清有哪些被排除，避免作者以为漏了。
  const stats = useMemo(() => bookEntryStats(detail.entries), [detail.entries]);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(`已复制${layer === "stable" ? "静态层" : "动态层"}文本。`);
    } catch { onNotice("复制失败，请选中文本后手动复制。"); }
  };

  return <section className="wbpp wbpp-reader" aria-label="Prompt 预览">
    <header className="wbpp-head">
      <div>
        <p className="wbg-eyebrow">PROMPT PREVIEW</p>
        <h3>世界书插入内容</h3>
        <p className="wbpp-hint">{PROMPT_PREVIEW_SCOPE_NOTE}</p>
      </div>
      <button type="button" className="wbpp-button" onClick={retry} disabled={loading}>
        {loading ? "更新中…" : "刷新预览"}
      </button>
    </header>

    <div className="wbpp-reader-toolbar">
      <div className="wbpp-modes" role="group" aria-label="预览层切换">
        <button type="button" aria-pressed={layer === "stable"} onClick={() => setLayer("stable")}>
          静态层 <span className="wbpp-reader-count">{counts.stable}</span>
        </button>
        <button type="button" aria-pressed={layer === "dynamic"} onClick={() => setLayer("dynamic")}>
          动态层 <span className="wbpp-reader-count">{counts.dynamic}</span>
        </button>
        <span className="wbpp-help">
          <button type="button" className="wbpp-help-trigger" aria-label="动态层触发方式"
            aria-describedby="wbpp-trigger-help">?</button>
          <span role="tooltip" id="wbpp-trigger-help" className="wbpp-help-content">{DYNAMIC_TRIGGER_NOTE}</span>
        </span>
      </div>
      <button type="button" className="wbpp-button" disabled={!text || loading || !!error} onClick={copyText}>复制本层文本</button>
    </div>

    <p className="wbpp-hint wbpp-system-note" role="note">
      {SYSTEM_LAYER_PREVIEW_NOTE}
      {!!stats.system && <> 本书有 <b>{stats.system}</b> 条系统层条目，已排除。</>}
      {!!stats.disabled && <> 另有 <b>{stats.disabled}</b> 条已停用。</>}
    </p>

    <section className="wbpp-reader-panel" aria-label="最终文本" aria-busy={loading}>
      <div className="wbpp-reader-caption">
        <h4>{layer === "stable" ? "静态层 · 固定插入" : "动态层 · 触发后插入"}</h4>
        <p className="wbpp-hint">{layer === "stable"
          ? "展示设置为常驻、位于静态位置的固定内容。"
          : "逐条展示全部启用的动态内容及其触发条件。"}</p>
      </div>
      {error ? <div className="wbpp-notice is-error" role="alert">预览失败：{error}
        <button type="button" className="wbpp-button" onClick={retry}>重试</button>
      </div> : loading ? <p className="wbpp-empty" role="status">正在生成预览…</p>
        : layer === "dynamic" && dynamicEntries.length ? <div className="wbpp-entry-list">
          {dynamicEntries.map((item) => {
            const entry = entriesByUid.get(item.uid);
            return <article className="wbpp-entry" key={item.uid}>
              <div className="wbpp-entry-head">
                <h5>{item.name}</h5>
                <p><b>触发条件</b><span>{entry ? describeDynamicTrigger(entry) : "条目详情暂不可用。"}</span></p>
              </div>
              <pre className="wbpp-entry-text">{item.text ?? (entry ? entryPreviewText(entry) : "条目正文暂不可用。")}</pre>
            </article>;
          })}
        </div>
        : text ? <pre className="wbpp-reader-text">{text}</pre>
          : <p className="wbpp-empty">{preview ? `本世界书没有启用的${layer === "stable" ? "静态" : "动态"}内容。` : "正在准备预览…"}</p>}
    </section>
  </section>;
}
