import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAppStore } from "../stores/appStore";
import type { Session, SessionWorldbookEntryOverridesDTO, WorldBookDetail } from "../types";
import { bookEntryStats, isSystemEntry } from "../utils/worldbookLayer";
import AppIcon from "./AppIcon";
import "../styles/worldbook-session-entries.css";

/**
 * 会话条目：按分类浏览「这本书默认怎么开关」，并可对单个会话特调。
 *
 * **系统层条目（节点图 / 节点绑定）不在这里出现**：它们按设计永不注入，
 * 给它一个会话开关只会误导（拨了也不会有任何变化）。数量另起一行说明，
 * 免得作者以为条目丢了；分母也相应换成「会注入的条目」。
 */
export default function IndexManager({ book, onRefresh, onEditDefaults }: {
  book: WorldBookDetail; onRefresh: () => Promise<void>; onEditDefaults: () => void;
}) {
  const api = useApi();
  const indexSessionId = useAppStore((state) => state.indexSessionId);
  const setIndexSessionId = useAppStore((state) => state.setIndexSessionId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [source, setSource] = useState("global");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(false);
  const [config, setConfig] = useState<SessionWorldbookEntryOverridesDTO | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const matchingSessions = useMemo(() => sessions.filter((session) => session.worldbook_id === book.id), [sessions, book.id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listSessions().then((result) => { if (active) setSessions(result); })
      .catch((reason: Error) => { if (active) setError(reason.message || "会话列表加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!indexSessionId || loading) return;
    if (matchingSessions.some((session) => session.id === indexSessionId)) {
      setSource(indexSessionId); setIndexSessionId(null);
    }
  }, [indexSessionId, loading, matchingSessions, setIndexSessionId]);

  useEffect(() => {
    if (!loading && source !== "global" && !matchingSessions.some((session) => session.id === source)) setSource("global");
  }, [loading, source, matchingSessions]);

  useEffect(() => {
    const token = ++generation.current;
    setConfig(null); setNotice(""); setSaving(null); savingRef.current = false;
    if (source === "global") { setConfigLoading(false); return; }
    setConfigLoading(true); setError("");
    api.getSessionWorldbookEntryOverrides(source).then((result) => {
      if (token !== generation.current) return;
      if (result.book_id !== book.id) throw new Error("会话绑定的世界书已变化，请刷新会话列表。");
      setConfig(result);
    }).catch((reason: Error) => { if (token === generation.current) setError(reason.message || "会话配置加载失败"); })
      .finally(() => { if (token === generation.current) setConfigLoading(false); });
    return () => { generation.current += 1; };
  }, [api, book.id, source, refreshVersion]);

  const refresh = async () => {
    if (savingRef.current) return;
    setLoading(true); setError(""); setNotice("");
    try {
      const [, result] = await Promise.all([onRefresh(), api.listSessions()]);
      setSessions(result); setRefreshVersion((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "刷新失败，请重试"); }
    finally { setLoading(false); }
  };

  const updateEntry = async (uid: string, value: string) => {
    if (!config || savingRef.current || config.session_id !== source) return;
    const token = generation.current;
    savingRef.current = true; setSaving(uid); setError(""); setNotice("");
    try {
      const result = await api.patchSessionWorldbookEntryOverride(source, {
        expected_scope_revision: config.scope_revision, entry_uid: uid,
        enabled: value === "default" ? null : value === "enabled",
      });
      if (token !== generation.current) return;
      if (result.book_id !== book.id) throw new Error("会话绑定的世界书已变化，请刷新。");
      setConfig(result); setNotice("已保存，仅对当前会话生效");
    } catch (reason) {
      if (token === generation.current) {
        setError(reason instanceof Error ? reason.message : "保存失败，请刷新后重试");
        // A conflict must not leave a stale revision available for another edit.
        if ((reason as { status?: number }).status === 409) setConfig(null);
      }
    } finally {
      if (token === generation.current) { savingRef.current = false; setSaving(null); }
    }
  };

  // 系统层条目（节点图 / 节点绑定）永不注入：不进分类列表，也不当分母。
  const stats = useMemo(() => bookEntryStats(book.entries), [book.entries]);
  const listedCount = stats.total - stats.system;
  const injectionEntries = useMemo(
    () => book.entries.filter((entry) => !isSystemEntry(entry)), [book.entries]);

  const groups = useMemo(() => {
    const known = new Map((book.categories || []).map((item) => [item.id, item]));
    const categoryName = (id: string): string => {
      const names: string[] = []; const seen = new Set<string>(); let current = known.get(id);
      while (current && !seen.has(current.id)) {
        seen.add(current.id); names.unshift(current.name); current = current.parent_id ? known.get(current.parent_id) : undefined;
      }
      return names.join(" / ") || "未分类";
    };
    const result = [...known.values()].sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({ id: item.id, name: categoryName(item.id), entries: injectionEntries.filter((entry) => entry.category_id === item.id) }));
    const unclassified = injectionEntries.filter((entry) => !entry.category_id || !known.has(entry.category_id));
    if (unclassified.length) result.push({ id: "__unclassified", name: "未分类", entries: unclassified });
    return result;
  }, [book, injectionEntries]);
  const visibleGroups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return groups.filter((group) => category === "all" || group.id === category).map((group) => ({ ...group,
      entries: group.entries.filter((entry) => !search || [entry.name, entry.content, ...entry.trigger_keys].join(" ").toLocaleLowerCase().includes(search)),
    })).filter((group) => group.entries.length);
  }, [groups, category, query]);
  const session = matchingSessions.find((item) => item.id === source);
  const visibleCount = visibleGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const effectiveEntries = new Map(config?.entries.map((entry) => [entry.uid, entry]));
  const changeSource = (value: string) => { generation.current += 1; setSource(value); setConfig(null); setNotice(""); setError(""); };

  return <div className="wbse">
    <header className="wbse-intro"><div><h2>条目默认与会话特调</h2><p>按分类浏览「{book.name}」的条目。世界书中的启用状态是默认值；选择会话后，可单独调整该会话的条目开关。</p></div>
      <button type="button" disabled={loading || !!saving} onClick={() => void refresh()}><AppIcon name="refresh" size={14} />{loading ? "刷新中…" : "刷新"}</button></header>
    {error && <div className="wbse-error" role="alert">{error} 请使用右上角刷新重试。</div>}
    <div className="wbse-layout">
      <aside className="wbse-sources" aria-label="配置源"><h3>配置源</h3>
        <button type="button" disabled={!!saving} className={source === "global" ? "is-selected" : ""} aria-pressed={source === "global"} onClick={() => { if (source !== "global") changeSource("global"); }}><AppIcon name="globe" size={15} /><span>世界书默认<small>{listedCount} 个条目</small></span></button>
        <h3>绑定此书的会话 <span>{matchingSessions.length}</span></h3>
        {loading && !sessions.length ? <p role="status">正在加载会话…</p> : !matchingSessions.length ? <p>暂无绑定此世界书的会话。创建会话时选择此书，即可在这里单独调整。</p> : matchingSessions.map((item) => <button type="button" key={item.id} disabled={!!saving} className={source === item.id ? "is-selected" : ""} aria-pressed={source === item.id} title={item.name} onClick={() => { if (source !== item.id) changeSource(item.id); }}><AppIcon name="file" size={15} /><span>{item.name || "未命名会话"}<small>{item.mode === "story" ? "剧情会话" : "自由会话"}{!item.usable && " · 暂不可用"}</small></span></button>)}
      </aside>
      <section className="wbse-content" aria-label="世界书条目配置">
        <div className="wbse-context"><div><h3>{session?.name || "世界书默认"}</h3><p>{source === "global" ? "这里展示条目自身的默认开关。修改默认值请前往条目编辑，未设置特调的会话会跟随默认。" : "调整仅影响当前会话，自动保存。跟随默认沿用条目开关与会话载入范围；单独启用将加入会话候选，停用则排除。实际注入仍受触发条件与预算约束。"}</p></div>{source === "global" && <button type="button" className="is-sm" onClick={onEditDefaults}>编辑默认值</button>}</div>
        <div className="wbse-filters"><label>搜索条目<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、正文或触发词" /></label><label>分类<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}（{group.entries.length}）</option>)}</select></label></div>
        <div className="wbse-count" role="status">{configLoading ? "正在加载会话设置…" : `显示 ${visibleCount} / ${listedCount} 个条目`}{notice && <span>{notice}</span>}</div>
        {!!stats.system && <p className="wbse-system-note" role="note">
          另有 <b>{stats.system}</b> 条系统层条目（节点图 / 节点绑定）永不注入，因此不在此列出，
          也不需要会话开关；它们只服务画布与系统判定。
        </p>}
        {!visibleCount && <div className="wbse-empty">{listedCount ? "没有匹配的条目，试试其他关键词或分类。" : "这本世界书还没有条目，请先在条目页添加内容。"}</div>}
        {visibleGroups.map((group) => <section className={`wbse-group${source === "global" ? " is-compact" : ""}`} key={group.id}><h4>{group.name}<span>{group.entries.length}</span></h4>{source === "global" ? <div className="wbse-entry-grid">
          {group.entries.map((entry) => <span className={`wbse-entry-name${entry.enabled === false ? " is-disabled" : ""}`} key={entry.uid} title={entry.enabled === false ? `${entry.name || "未命名条目"}（默认停用）` : entry.name || "未命名条目"}>{entry.name || "未命名条目"}</span>)}
        </div> : group.entries.map((entry) => {
          const item = effectiveEntries.get(entry.uid);
          const defaultEnabled = item?.default_enabled ?? entry.enabled !== false;
          const value = config?.overrides[entry.uid];
          return <article className="wbse-entry" key={entry.uid}><div className="wbse-entry-copy"><strong>{entry.name || "未命名条目"}</strong><p>{entry.content || "暂无正文"}</p><small>{entry.always_active ? "常驻条目" : "关键词触发"} · 默认{defaultEnabled ? "启用" : "停用"}</small></div>
            <div className="wbse-entry-control"><select aria-label={`${entry.name || "未命名条目"}的会话开关`} disabled={loading || configLoading || !!saving || !config || !item} value={value === undefined ? "default" : value ? "enabled" : "disabled"} onChange={(event) => void updateEntry(entry.uid, event.target.value)}><option value="default">跟随默认（{defaultEnabled ? "启用" : "停用"}）</option><option value="enabled">仅此会话启用</option><option value="disabled">仅此会话停用</option></select><small>{saving === entry.uid ? "正在保存…" : item ? `当前${item.effective_enabled ? "启用" : "停用"}${value === undefined ? " · 跟随默认" : " · 已特调"}` : "等待加载配置"}</small></div>
          </article>;
        })}</section>)}
      </section>
    </div>
  </div>;
}
