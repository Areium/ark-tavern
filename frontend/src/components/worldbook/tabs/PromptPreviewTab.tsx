import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../../hooks/useApi";
import { useAppStore, type WorldBookTab } from "../../../stores/appStore";
import { buildSaveBody } from "../../../hooks/useWorldbookDraft";
import { avatarUrl, characterName, useCharacterDirectory } from "../panel";
import type {
  WorldBookPreviewMode, WorldBookPromptLayer, WorldBookPromptPreviewDTO,
  WorldBookPromptPreviewOrderDTO, WorldBookPromptPreviewRequest,
} from "../../../types";
import {
  describeReasons, describeSite, describeTotals, findSkeletonWorldbookBlocks,
  groupDropped, orderUidForBlock, parseInjectionBlocks, previewAnchorId, recentDialogueCount,
  sessionRecentText, siteOf, type InjectionBlock,
} from "../../../utils/worldbookPromptPreview";
import type { WorldBookTabProps } from "./types";
import "../../../styles/worldbook-prompt-preview.css";

/**
 * 工作台第 3 个页签：Prompt 预览（A-2）。
 *
 * 回答的是「**这一轮**实际插进去什么、插在哪个位置、什么顺序」——按单轮，不是按书。
 * 请求体严格按契约 §3.1；固定 `seed`，所以同一份输入连续两次的结果一致。
 * 纯逻辑（未插入原因分组与文案、`### 名称` 锚点解析、骨架块定位、摘要文案、会话对话拼接）
 * 全部在 `utils/worldbookPromptPreview.ts`，这里只做状态与渲染。
 */

/** 分工文案（写死）：与「分类与载入」的范围预览各回答一半问题。 */
export const PROMPT_PREVIEW_SCOPE_NOTE =
  "配置概览的范围预览回答「哪些是候选」；这里回答「这一轮实际插进去什么、插在哪个位置、什么顺序」。前者按书，后者按单轮。";
/** 固定种子提示（写死）。 */
export const SEED_NOTE = "概率条目按固定种子抽取，结果可复现。";
/** 手动追加是单轮语义：只进请求体，不进统一草稿。 */
export const MANUAL_ONLY_NOTE = "仅本次预览：手动追加的条目只影响这一次请求，不写进统一草稿。";
export const DEFAULT_SEED = 0;
export const DEFAULT_IDENTITY = "博士";
export const DEFAULT_RECENT_LIMIT = 10;

export const PREVIEW_MODES: Array<{ id: WorldBookPreviewMode; label: string; hint: string }> = [
  { id: "narrative", label: "剧情模式", hint: "稳定层插在 <reference> 块内，动态层插在 <world_book> 块内" },
  { id: "free", label: "自由模式", hint: "稳定层与动态层都插在 system_parts 里" },
];
export const MODE_LABELS: Record<string, string> = Object.fromEntries(
  PREVIEW_MODES.map((item) => [item.id, item.label]),
);
export const LAYER_LABELS: Record<string, string> = { stable: "稳定层", dynamic: "动态层" };
/** 原因 → 该去哪一页修（未列出的原因只在提示里给做法，不做跳转）。 */
export const DROP_REASON_TABS: Record<string, WorldBookTab> = {
  not_in_scope: "load",
  node_binding_demoted: "load",
  budget_exceeded: "load",
  disabled: "entries",
  empty_content: "entries",
};
export const TAB_LABELS: Record<string, string> = { load: "分类与载入", entries: "条目" };

/** Prompt 预览请求：防抖 + 过时响应保护（同一套模式见 `useWorldbookDraft.useScopePreview`）。 */
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

export default function PromptPreviewTab({ ctx, onNotice }: WorldBookTabProps) {
  const { detail, draft, roster, setRoster } = ctx;
  const characters = useCharacterDirectory();

  const [mode, setMode] = useState<WorldBookPreviewMode>("narrative");
  const [inputText, setInputText] = useState("");
  const [recentText, setRecentText] = useState("");
  const [recentLimit, setRecentLimit] = useState(DEFAULT_RECENT_LIMIT);
  const [manualUids, setManualUids] = useState<string[]>([]);
  const [manualQuery, setManualQuery] = useState("");
  const [fullScope, setFullScope] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [identity, setIdentity] = useState(DEFAULT_IDENTITY);
  const [textOpen, setTextOpen] = useState(false);
  const [hitUid, setHitUid] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(true);

  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionMessages = useAppStore(
    (state) => (state.activeSessionId ? state.sessionMessages[state.activeSessionId] : undefined));
  const setPromptPreviewOrder = useAppStore((state) => state.setPromptPreviewOrder);
  const setWorldbookTab = useAppStore((state) => state.setWorldbookTab);

  const policy = useMemo(() => buildSaveBody(draft, null), [draft]);
  const requestBody = useMemo<WorldBookPromptPreviewRequest>(() => {
    const body: WorldBookPromptPreviewRequest = {
      mode,
      input_text: inputText,
      recent_text: recentText,
      roster_character_ids: roster,
      manual_entry_uids: manualUids,
      full_scope: fullScope,
      identity,
      active_char: null,
      seed: DEFAULT_SEED,
      policy,
    };
    const budget = Number.parseInt(budgetInput, 10);
    // 留空＝用书里的预算：不猜一个数字出来
    if (Number.isFinite(budget) && budget > 0) body.budget_tokens = budget;
    return body;
  }, [mode, inputText, recentText, roster, manualUids, fullScope, identity, budgetInput, policy]);

  const { data: preview, loading, error, retry } = usePromptPreview(
    detail.id, requestBody, detail.import_config?.revision);

  // R-6：预览结果经 appStore 传给节点视图；失败、换书一律清空，绝不留下别的书的顺序
  useEffect(() => {
    if (!preview) return;
    setPromptPreviewOrder({
      bookId: detail.id,
      mode,
      order: preview.order.map(({ uid, seq, layer, position, group_weight, depth }) =>
        ({ uid, seq, layer, position, group_weight, depth })),
    });
  }, [preview, mode, detail.id, setPromptPreviewOrder]);
  useEffect(() => { if (error) setPromptPreviewOrder(null); }, [error, setPromptPreviewOrder]);
  useEffect(() => { setPromptPreviewOrder(null); }, [detail.id, setPromptPreviewOrder]);

  const totals = useMemo(() => (preview ? describeTotals(preview.totals, preview.order) : null), [preview]);
  const droppedGroups = useMemo(() => groupDropped(preview?.dropped), [preview]);
  const skeletonInsert = useMemo(() => new Map(
    findSkeletonWorldbookBlocks(preview?.skeleton).map((block) => [block.index, block])), [preview]);
  /**
   * 本轮注入的条目名（按层）：条目正文自己也会写 `### ` 小标题，锚点只认这些名字，
   * 否则中栏会把一条条目劈成几块、还长出点不开的死锚点（见 `parseInjectionBlocks` 注释）。
   */
  const anchorNames = useMemo(() => {
    const stable: string[] = [];
    const dynamic: string[] = [];
    for (const entry of preview?.order || []) {
      const list = entry.layer === "stable" ? stable : dynamic;
      if (entry.name) list.push(entry.name);
      list.push(entry.uid);
    }
    return { stable, dynamic };
  }, [preview]);
  const stableBlocks = useMemo(
    () => (textOpen ? parseInjectionBlocks(preview?.stable_text, anchorNames.stable) : []),
    [preview, anchorNames, textOpen]);
  const dynamicBlocks = useMemo(
    () => (textOpen ? parseInjectionBlocks(preview?.dynamic_text, anchorNames.dynamic) : []),
    [preview, anchorNames, textOpen]);

  const dialogueCount = recentDialogueCount(sessionMessages);
  const canFill = !!activeSessionId && dialogueCount > 0;
  const fillHint = !activeSessionId
    ? "当前没有打开的会话：先去「会话大厅」进入一个会话，这里才取得到真实对话。"
    : dialogueCount === 0
      ? "当前会话还没有 user / assistant 消息。"
      : `当前会话有 ${dialogueCount} 条真实对话。`;
  const fillFromSession = () => {
    const text = sessionRecentText(sessionMessages, recentLimit);
    if (!text) { onNotice("当前会话没有可用的真实对话。"); return; }
    setRecentText(text);
    onNotice(`已用当前会话最近 ${Math.min(recentLimit, dialogueCount)} 条真实对话填充。`);
  };

  const jumpToEntry = (block: InjectionBlock) => {
    const uid = orderUidForBlock(preview?.order, block);
    if (!uid) return;
    setHitUid(uid);
    const node = typeof document === "undefined" ? null : document.getElementById(`wbpp-order-${uid}`);
    node?.scrollIntoView({ block: "nearest" });
  };

  const filteredManual = useMemo(() => {
    const query = manualQuery.trim().toLowerCase();
    return detail.entries.filter((entry) => !query
      || (entry.name || "").toLowerCase().includes(query)
      || entry.uid.toLowerCase().includes(query));
  }, [detail.entries, manualQuery]);

  const renderLayerText = (layer: WorldBookPromptLayer, blocks: ReturnType<typeof parseInjectionBlocks>) =>
    <div className="wbpp-block">
      <p className="wbpp-block-site">
        {LAYER_LABELS[layer]}插入位置：{describeSite(siteOf(preview?.sites, layer)) || "服务端未给出位置说明"}
      </p>
      <div className="wbpp-block-body">
        {!blocks.length && <p className="wbpp-empty">这一层没有内容被插进去。</p>}
        {blocks.map((block) => {
          const uid = orderUidForBlock(preview?.order, block);
          return <div key={previewAnchorId(layer, block.index)}>
            {block.name
              ? <button type="button" className="wbpp-anchor" id={previewAnchorId(layer, block.index)}
                  onClick={() => jumpToEntry(block)}>
                  ### {block.name}
                  <small>{uid ? `点击定位右栏：${uid}` : "右栏没有同名条目"}</small>
                </button>
              : <span className="wbd-note">（无锚点开头）</span>}
            {block.body && <div className="wbpp-text-body">{block.body}</div>}
          </div>;
        })}
      </div>
    </div>;

  const renderOrderRow = (entry: WorldBookPromptPreviewOrderDTO) => {
    const override = entry.override_from_node;
    const reasons = describeReasons(entry.reasons, entry.matched_keys);
    return <li key={entry.uid} id={`wbpp-order-${entry.uid}`} className={hitUid === entry.uid ? "is-hit" : undefined}>
      <span className="wbpp-seq">{entry.seq + 1}</span>
      <div className="wbpp-order-main">
        <div className="wbpp-order-title">
          <span className="wbpp-layer" data-wbpp-layer={entry.layer}>{LAYER_LABELS[entry.layer] || entry.layer}</span>
          <strong>{entry.name || entry.uid}</strong>
          <small>{entry.uid}</small>
        </div>
        <span className="wbpp-meta">
          position {entry.position} · 权重 {entry.group_weight} · 深度 {entry.depth} · 约 {entry.estimated_tokens} token
        </span>
        <span className="wbpp-reasons">
          {reasons.length
            ? reasons.map((reason, index) => <em key={`${reason}-${index}`}>{index ? " · " : ""}{reason}</em>)
            : "服务端未给出命中原因"}
        </span>
        {override && <div className="wbpp-override">
          position 被节点绑定覆盖为 {override.position ?? entry.position}（动态层）
          {override.node_id ? `；节点：${override.node_id}` : ""}
          {override.depth !== undefined ? `；depth → ${override.depth}` : ""}
          {override.group_weight !== undefined ? `；group_weight → ${override.group_weight}` : ""}
        </div>}
      </div>
    </li>;
  };

  return <section className="wbpp" aria-label="Prompt 预览">
    <header className="wbpp-head">
      <div>
        <p className="wbg-eyebrow">PROMPT PREVIEW</p>
        <h3>Prompt 预览</h3>
        <p className="wbpp-scope">{PROMPT_PREVIEW_SCOPE_NOTE}</p>
      </div>
      <div className="wbpp-modes" role="group" aria-label="宿主模式（必选，两个宿主的插入点不同）">
        {PREVIEW_MODES.map((item) => <button key={item.id} type="button" title={item.hint}
          aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}
      </div>
    </header>

    <div className="wbpp-skeleton">
      <div className="wbpp-skeleton-head">
        <strong>宿主提示词骨架</strong>
        <span>{MODE_LABELS[mode]} · 世界书块实心高亮</span>
        {loading && <span>计算中…</span>}
        {!loading && preview && <span>顺序即插入顺序</span>}
      </div>
      {preview?.skeleton?.length
        ? <ol className="wbpp-skeleton-list">{preview.skeleton.map((block, index) => {
          const worldbook = skeletonInsert.get(index);
          return <li key={block.id || index} className={"wbpp-skel" + (block.is_worldbook ? " is-worldbook" : "")}
            data-wbpp-worldbook={block.is_worldbook ? "1" : "0"}>
            <span>{block.label}</span>
            {worldbook?.insertLabel ? <em className="wbpp-skel-insert">{worldbook.insertLabel}</em> : null}
          </li>;
        })}</ol>
        : <p className="wbpp-hint">{loading ? "正在按当前输入计算本轮注入…" : "预览结果到达后显示宿主提示词骨架。"}</p>}
    </div>

    <div className="wbpp-grid">
      {/* ── 左栏：输入 ── */}
      <aside className="wbpp-col wbpp-col-scroll" aria-label="预览输入">
        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>当前输入</h4>
              <p className="wbpp-hint">这一轮玩家要说的话；关键词命中就按它算。</p></div>
            {loading && <span className="wbpp-hint">计算中…</span>}
          </div>
          <textarea className="wbpp-field wbpp-textarea" aria-label="当前输入" value={inputText}
            placeholder="例如：阿米娅，我们出发吧" onChange={(event) => setInputText(event.target.value)} />
        </section>

        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>最近对话</h4>
              <p className="wbpp-hint">扫描深度内的历史文本；触发型条目靠它命中。</p></div>
          </div>
          <textarea className="wbpp-field wbpp-textarea" aria-label="最近对话" value={recentText}
            placeholder="可粘贴，也可用下面的按钮从当前会话填入" onChange={(event) => setRecentText(event.target.value)} />
          <div className="wbpp-row wbpp-row-between">
            <label className="wbpp-row">最近
              <input className="wbpp-field" style={{ width: 58 }} type="number" min={1} max={50}
                aria-label="填充条数" value={recentLimit}
                onChange={(event) => setRecentLimit(Math.max(1, Number.parseInt(event.target.value, 10) || 1))} />
              条
            </label>
            <button type="button" className="wbpp-button" disabled={!canFill} title={fillHint}
              onClick={fillFromSession}>用当前会话最近 {recentLimit} 条真实对话填充</button>
          </div>
          <p className={"wbpp-hint" + (canFill ? "" : " is-warn")}>{fillHint}</p>
        </section>

        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>试选阵容</h4>
              <p className="wbpp-hint">与「配置概览」共用同一份阵容状态，只影响预览，不写进配置。</p></div>
            <button type="button" className="wbpp-button" aria-expanded={rosterOpen}
              onClick={() => setRosterOpen((value) => !value)}>{rosterOpen ? "收起" : "展开"}</button>
          </div>
          {rosterOpen && <>
            <div className="wbpp-picker">
              {roster.map((id) => <span key={id} className="wbpp-chip is-on">
                <img src={avatarUrl(id)} alt="" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                <span>{characterName(characters, id)}</span>
                <button type="button" aria-label={`移出试选阵容 ${characterName(characters, id)}`}
                  onClick={() => setRoster((current) => current.filter((item) => item !== id))}>×</button>
              </span>)}
              {!roster.length && <span className="wbpp-hint">未选角色：只会看到基础设定与常驻内容。</span>}
            </div>
            <div className="wbpp-picker">
              {(characters || []).map((character) => <button key={character.id} type="button"
                className={"wbpp-chip" + (roster.includes(character.id) ? " is-on" : "")}
                aria-pressed={roster.includes(character.id)}
                onClick={() => setRoster((current) => current.includes(character.id)
                  ? current.filter((item) => item !== character.id)
                  : [...current, character.id])}>
                <img src={avatarUrl(character.id)} alt=""
                  onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                <span>{character.name}</span>
              </button>)}
              {characters === null && <p className="wbpp-hint">正在读取角色目录…</p>}
              {characters?.length === 0 && <p className="wbpp-hint">角色目录为空，可前往「资产」导入角色卡。</p>}
            </div>
          </>}
        </section>

        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>手动追加条目</h4>
              <p className="wbpp-hint">{MANUAL_ONLY_NOTE}</p></div>
            <span className="wbpp-hint">已选 {manualUids.length}</span>
          </div>
          <input className="wbpp-field" aria-label="筛选条目" placeholder="筛选条目名或 uid"
            value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} />
          <div className="wbpp-manual">
            {filteredManual.map((entry) => <label key={entry.uid}>
              <input type="checkbox" checked={manualUids.includes(entry.uid)}
                onChange={() => setManualUids((current) => current.includes(entry.uid)
                  ? current.filter((uid) => uid !== entry.uid)
                  : [...current, entry.uid])} />
              <strong>{entry.name || entry.uid}</strong>
              <small>{entry.uid}</small>
            </label>)}
            {!filteredManual.length && <p className="wbpp-hint">没有匹配的条目。</p>}
          </div>
        </section>

        <section className="wbpp-card">
          <div className="wbpp-card-head"><div><h4>预算与身份</h4></div></div>
          <label className="wbpp-label">token 预算
            <input className="wbpp-field" type="number" min={0} aria-label="token 预算"
              placeholder="留空＝用书里的预算" value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)} />
          </label>
          <label className="wbpp-label">玩家身份（{"{{user}}"} 宏替换）
            <input className="wbpp-field" aria-label="玩家身份" value={identity}
              onChange={(event) => setIdentity(event.target.value)} />
          </label>
          <label className="wbpp-row">
            <input type="checkbox" checked={fullScope}
              onChange={(event) => setFullScope(event.target.checked)} />
            全量兼容（忽略起点规则，把全书当候选）
          </label>
          <p className="wbpp-seed">固定种子 seed={DEFAULT_SEED}。{SEED_NOTE}</p>
          <div className="wbpp-row wbpp-row-between">
            <button type="button" className="wbpp-button wbpp-button-primary" onClick={retry}
              disabled={loading}>{loading ? "计算中…" : "重新预览"}</button>
            <span className="wbpp-hint">请求是只读的：不写盘、不动候选缓存。</span>
          </div>
        </section>
      </aside>

      {/* ── 中栏：最终文本 ── */}
      <main className="wbpp-col wbpp-col-scroll" aria-label="最终文本">
        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>最终文本</h4>
              <p className="wbpp-hint">默认折叠：先看摘要，再按需要逐字核对拼装结果。</p></div>
            <button type="button" className="wbpp-button" aria-expanded={textOpen}
              onClick={() => setTextOpen((value) => !value)}>{textOpen ? "收起全文" : "展开全文"}</button>
          </div>
          {error && <div className="wbpp-notice is-error" role="alert">
            Prompt 预览失败：{error}
            <button type="button" className="wbpp-button" onClick={retry}>重试</button>
          </div>}
          {totals && <>
            <ul className="wbpp-totals">
              <li>{totals.stable}</li>
              <li>{totals.dynamic}</li>
              <li>{totals.budget}</li>
              <li data-wbpp-truncated={preview?.totals.truncated ? "1" : "0"}>{totals.truncation}</li>
              <li>{totals.matched}</li>
            </ul>
          </>}
          {!totals && !error && <p className="wbpp-hint">{loading ? "正在计算本轮注入…" : "还没有预览结果。"}</p>}
          {textOpen && preview && <>
            {renderLayerText("stable", stableBlocks)}
            {renderLayerText("dynamic", dynamicBlocks)}
          </>}
        </section>
      </main>

      {/* ── 右栏：条目与顺序 ── */}
      <aside className="wbpp-col wbpp-col-scroll" aria-label="条目与顺序">
        <section className="wbpp-card">
          <div className="wbpp-card-head">
            <div><h4>条目与顺序</h4>
              <p className="wbpp-hint">按 seq 排：position 升序 → 权重降序 → 深度升序 → uid。</p></div>
            {preview && <span className="wbpp-hint">{preview.order.length} 条</span>}
          </div>
          {preview?.order?.length
            ? <ol className="wbpp-order">{preview.order.map(renderOrderRow)}</ol>
            : <p className="wbpp-hint">{loading ? "正在计算…" : "这一轮没有任何条目被插进去。"}</p>}
        </section>
      </aside>
    </div>

    {/* ── 底部：未插入 ── */}
    <details className="wbpp-dropped">
      <summary>未插入条目{preview ? `（${preview.dropped.length}）` : ""}</summary>
      <div className="wbpp-dropped-body">
        {!preview && <p className="wbpp-hint">预览完成后，这里按原因列出没被插进去的条目与修复入口。</p>}
        {preview && !droppedGroups.length && <p className="wbpp-hint">这一轮没有条目被排除在外。</p>}
        {droppedGroups.map((group) => <section key={group.reason} className="wbpp-drop-group">
          <div className="wbpp-drop-head">
            <b>{group.label}</b>
            <span className="wbd-count">{group.items.length}</span>
            <span>{group.hint}</span>
            {DROP_REASON_TABS[group.reason] && <button type="button" className="wbpp-button"
              onClick={() => setWorldbookTab(DROP_REASON_TABS[group.reason])}>
              去「{TAB_LABELS[DROP_REASON_TABS[group.reason]]}」处理
            </button>}
          </div>
          <ul className="wbpp-drop-items">
            {group.items.map((item) => <li key={item.uid}>{item.name || item.uid}<small>{item.uid}</small></li>)}
          </ul>
        </section>)}
      </div>
    </details>
  </section>;
}
