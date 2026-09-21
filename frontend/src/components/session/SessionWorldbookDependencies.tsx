import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import type { SessionInheritancePreviewDTO, SessionWorldbookDependenciesDTO } from "../../types";

/** 会话级依赖微调（纯人工）：增删 requires / related、屏蔽继承、恢复继承、按 local wins 展示冲突。 */
export function SessionWorldbookDependencies({ sessionId }: { sessionId: string }) {
  const api = useApi();
  const [value, setValue] = useState<SessionWorldbookDependenciesDTO | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fromUid, setFromUid] = useState("");
  const [toUid, setToUid] = useState("");
  const [relation, setRelation] = useState<"requires" | "related">("requires");
  const [expand, setExpand] = useState(true);
  const [inheritance, setInheritance] = useState<SessionInheritancePreviewDTO | null>(null);
  const requestVersion = useRef(0);
  const load = async () => {
    const version = ++requestVersion.current;
    try {
      const dependencies = await api.getSessionWorldbookDependencies(sessionId);
      if (version !== requestVersion.current) return;
      setValue(dependencies);
      setError("");
    } catch (e: any) {
      if (version === requestVersion.current) setError(e?.message || "读取失败");
    }
  };
  useEffect(() => {
    requestVersion.current += 1;
    setValue(null);
    setInheritance(null);
    void load();
    return () => { requestVersion.current += 1; };
  }, [sessionId]);
  const names = useMemo(() => new Map((value?.entries || []).map((e) => [e.uid, e.name || e.uid])), [value]);
  const save = async (a: string, b: string, rel: "requires" | "related" | "none", enable = false) => {
    if (!value) return; setBusy(true); setError("");
    try { setValue(await api.patchSessionWorldbookDependency(sessionId, { from_uid: a, to_uid: b, relation: rel, expected_scope_revision: value.scope_revision, enable_source_expansion: enable })); setFromUid(""); setToUid(""); }
    catch (e: any) { setError(e?.message || "保存失败"); } finally { setBusy(false); }
  };
  if (!value) return <div className="detail-section p-4 text-xs text-gray-500">{error || "正在读取会话依赖…"}</div>;
  const rows = [...value.effective_requires_edges.map((e) => ({ ...e, relation: "requires" as const })), ...value.effective_related_edges.map((e) => ({ ...e, relation: "related" as const }))];
  return <div className="detail-section p-4 space-y-3">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-gray-300">🧩 会话依赖微调</h3><p className="text-[10px] text-gray-500 mt-1">继承版本 {value.inheritance?.policy_revision ?? "—"} · 本地修订 {value.scope_revision}。修改只影响本会话。</p></div><button className="text-[11px] text-blue-300 hover:underline" onClick={() => void load()}>刷新</button></div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    <div className="grid grid-cols-3 gap-2">
      <select className="input text-xs" aria-label="依赖来源" value={fromUid} onChange={(event) => setFromUid(event.target.value)}>
        <option value="">选择来源条目</option>
        {value.entries.map((entry) => <option key={entry.uid} value={entry.uid}>{entry.name || entry.uid} · {entry.uid}</option>)}
      </select>
      <select className="input text-xs" aria-label="依赖目标" value={toUid} onChange={(event) => setToUid(event.target.value)}>
        <option value="">选择目标条目</option>
        {value.entries.map((entry) => <option key={entry.uid} value={entry.uid}>{entry.name || entry.uid} · {entry.uid}</option>)}
      </select>
      <select className="input text-xs" value={relation} onChange={(event) => setRelation(event.target.value as "requires" | "related")}>
        <option value="requires">必要依赖</option><option value="related">关联浏览</option>
      </select>
    </div>
    {relation === "requires" && <label className="flex gap-2 items-start text-[11px] text-gray-400"><input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} /><span>同时让来源起点展开必要依赖。关闭时只保存关系；若起点当前“不展开”，目标不会进入候选。</span></label>}
    <button className="btn text-xs px-3 py-1.5 bg-blue-600/30 text-blue-200" disabled={busy || !fromUid || !toUid} onClick={() => void save(fromUid, toUid, relation, relation === "requires" && expand)}>新增 / 调整关系</button>
    <details className="wbg-details" open><summary>当前有效关系 <span>{rows.length}</span></summary><div className="max-h-48 overflow-y-auto space-y-1 mt-2">{rows.map((row) => { const key = `${row.relation}:${row.from_uid}|${row.to_uid}`; return <div key={key} className="flex items-center justify-between gap-2 text-[11px] bg-gray-800/50 rounded px-2 py-1.5"><span className="truncate"><b>{names.get(row.from_uid) || row.from_uid}</b> → {names.get(row.to_uid) || row.to_uid} · {row.relation === "requires" ? "必要" : "关联"} · {value.edge_origins[key] === "local" ? "本地" : "继承"}</span><span className="shrink-0 flex gap-2"><button className="text-red-300" onClick={() => void save(row.from_uid, row.to_uid, "none")}>删除/屏蔽</button><button className="text-blue-300" onClick={async () => { setBusy(true); try { setValue(await api.restoreSessionWorldbookDependencies(sessionId, { expected_scope_revision: value.scope_revision, from_uid: row.from_uid, to_uid: row.to_uid })); } catch (e: any) { setError(e?.message || "恢复失败"); } finally { setBusy(false); } }}>恢复继承</button></span></div>; })}{!rows.length && <p className="text-[11px] text-gray-600">当前没有依赖关系。</p>}</div></details>
    {!!value.suppressed_edges.length && <details className="wbg-details">
      <summary>已屏蔽的继承关系 <span>{value.suppressed_edges.length}</span></summary>
      <div className="space-y-1 mt-2">{value.suppressed_edges.map((edge) => <div
        key={`${edge.relation}:${edge.from_uid}|${edge.to_uid}`}
        className="flex items-center justify-between text-[11px] bg-gray-800/50 rounded px-2 py-1.5">
        <span>{names.get(edge.from_uid) || edge.from_uid} → {names.get(edge.to_uid) || edge.to_uid} · {edge.relation}</span>
        <button disabled={busy} className="text-blue-300" onClick={async () => {
          setBusy(true);
          try { setValue(await api.restoreSessionWorldbookDependencies(sessionId, {
            expected_scope_revision: value.scope_revision,
            from_uid: edge.from_uid, to_uid: edge.to_uid,
          })); } catch (e: any) { setError(e?.message || "恢复失败"); }
          finally { setBusy(false); }
        }}>恢复继承</button>
      </div>)}</div>
    </details>}
    <details className="wbg-details">
      <summary>本会话实际纳入条目 <span>{value.resolved_entry_uids.length}</span></summary>
      <div className="max-h-40 overflow-y-auto mt-2 space-y-1">{value.entries.filter((entry) => entry.selected).map((entry) => <div key={entry.uid} className="text-[11px] flex justify-between gap-2">
        <span>{entry.name || entry.uid}</span><small className="text-gray-500">{entry.reasons.join("、") || "继承范围"}</small>
      </div>)}</div>
    </details>
    <p className="text-[10px] text-gray-500">实际载入 {value.resolved_entry_uids.length} 条。保存后数量来自服务端重算；“关联”只浏览，不扩大范围。</p>
    <div className="flex flex-wrap gap-2"><button className="text-xs px-3 py-1.5 rounded bg-gray-700 text-gray-300" onClick={async () => { setBusy(true); try { setValue(await api.restoreSessionWorldbookDependencies(sessionId, { expected_scope_revision: value.scope_revision })); } catch (e: any) { setError(e?.message || "恢复失败"); } finally { setBusy(false); } }}>撤销全部本地调整</button><button className="text-xs px-3 py-1.5 rounded bg-gray-700 text-gray-300" onClick={async () => { setBusy(true); try { setInheritance(await api.previewSessionWorldbookInheritance(sessionId)); } catch (e: any) { setError(e?.message || "预览失败"); } finally { setBusy(false); } }}>预览更新全局继承</button></div>
    {inheritance && <div className="rounded border border-amber-700/50 bg-amber-950/20 p-3 text-[11px] space-y-2">
      <p>全局版本 {inheritance.from_policy_revision} → {inheritance.to_policy_revision}；边变化 {inheritance.changes.length} 条，起点规则变化 {inheritance.rule_changes.length} 条，实际范围 +{inheritance.scope_added.length} / -{inheritance.scope_removed.length}，冲突 {inheritance.conflicts.length} 条。本地覆盖保留且优先。</p>
      {!!inheritance.changes.length && <ul className="max-h-32 overflow-y-auto space-y-1">{inheritance.changes.map((item, index) => <li key={`${item.kind}:${item.relation}:${item.from_uid}|${item.to_uid}:${index}`}>
        {item.kind === "added" ? "新增" : "移除"} · {item.relation} · {names.get(item.from_uid) || item.from_uid} → {names.get(item.to_uid) || item.to_uid}
      </li>)}</ul>}
      {!!inheritance.rule_changes.length && <ul className="max-h-32 overflow-y-auto space-y-1">{inheritance.rule_changes.map((item) => <li key={item.entry_uid}>
        起点{item.kind === "added" ? "新增" : item.kind === "removed" ? "移除" : "调整"}：{names.get(item.entry_uid) || item.entry_uid}
        {item.after ? `（${item.after.activation} / ${item.after.expansion}）` : ""}
      </li>)}</ul>}
      {(inheritance.scope_added.length > 0 || inheritance.scope_removed.length > 0) && <p className="text-gray-400">
        范围新增：{inheritance.scope_added.map((uid) => names.get(uid) || uid).join("、") || "无"}；范围移除：{inheritance.scope_removed.map((uid) => names.get(uid) || uid).join("、") || "无"}
      </p>}
      {!!inheritance.conflicts.length && <ul className="text-amber-300 space-y-1">{inheritance.conflicts.map((item) => <li key={`${item.from_uid}|${item.to_uid}`}>
        冲突：{names.get(item.from_uid) || item.from_uid} → {names.get(item.to_uid) || item.to_uid}，全局 {item.inherited_relation} / 本地 {item.local_relation}，将保留本地。
      </li>)}</ul>}
      <button disabled={busy} className="text-amber-200 underline" onClick={async () => { setBusy(true); try { setValue(await api.updateSessionWorldbookInheritance(sessionId, { expected_scope_revision: inheritance.expected_scope_revision, preview_hash: inheritance.preview_hash })); setInheritance(null); } catch (e: any) { setError(e?.message || "更新失败"); } finally { setBusy(false); } }}>确认更新本会话继承</button>
    </div>}
  </div>;
}
