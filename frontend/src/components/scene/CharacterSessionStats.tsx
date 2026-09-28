import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { confirmAction } from "../../stores/confirmStore";
import { useAppStore } from "../../stores/appStore";
import type { SessionCharacterStatsDTO, StatValue } from "../../types";
import StatValuesForm from "../roles/StatValuesForm";

/** Explicit save keeps edits local until committed and never loses a delayed save on popup close. */
export default function CharacterSessionStats({ sessionId, name }: { sessionId: string; name: string }) {
  const api = useApi();
  const refresh = useAppStore((s) => s.statsRefreshKey);
  const notify = useAppStore((s) => s.triggerStatsRefresh);
  const [row, setRow] = useState<SessionCharacterStatsDTO | null>(null);
  const [pending, setPending] = useState<Record<string, StatValue | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const loadVersion = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const version = ++loadVersion.current;
    setLoading(true); setError("");
    api.getSessionCharacterStats(sessionId).then((data) => {
      if (!cancelled && version === loadVersion.current) setRow(data.characters.find((entry) => entry.name === name) || null);
    }).catch((err: Error) => { if (!cancelled && version === loadVersion.current) setError(err.message || "数值加载失败，请重试"); })
      .finally(() => { if (!cancelled && version === loadVersion.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, sessionId, name, refresh, retry]);
  const values = { ...row?.values };
  for (const [key, value] of Object.entries(pending)) {
    if (value === null) delete values[key]; else values[key] = value;
  }
  const save = async (reset = false) => {
    if (saving || loading || !row) return;
    if (reset && !await confirmAction(`清除「${name}」的会话数值改动？`, { title: "清除会话数值改动", confirmLabel: "清除改动" })) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const result = reset ? await api.resetSessionCharacterStats(sessionId, name)
        : await api.saveSessionCharacterStats(sessionId, name, pending);
      // 刷新请求可能早于保存发出、晚于保存返回，不能用它覆盖保存结果。
      ++loadVersion.current;
      setLoading(false); setRow(result); setPending({}); setSaved(true); notify();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  };
  const hasStats = row && (row.fields.length > 0 || Object.keys(row.values).length > 0 || Object.keys(pending).length > 0);
  return <section className="character-session-stats" aria-label="会话数值">
    <h4 className="text-xs text-gray-300 mb-2 font-medium">会话叙事数值</h4>
    <p className="text-xs text-gray-400 mb-3">由世界书字段、角色初值与会话改动共同决定，改动仅对本会话生效。</p>
    {error && <p role="alert" className="text-xs text-red-400 mb-2">{error} <button type="button" onClick={() => setRetry((n) => n + 1)}>重新加载</button></p>}
    {loading && !row && <p role="status" className="text-xs text-gray-400">加载数值中…</p>}
    {!loading && !row && !error && <p className="text-xs text-gray-400">当前角色没有可用的会话数值。</p>}
    {!loading && row && !hasStats && !error && <p className="text-xs text-gray-400">尚未定义叙事数值。</p>}
    {row && hasStats && <>
      {!row.fields.length && <p className="text-xs text-gray-400 mb-2">未定义统一字段，可添加自定义数值。</p>}
      <StatValuesForm fields={row.fields} values={values} sources={row.sources} ownSource="session" disabled={saving || loading}
        onChange={(key, value) => { setPending((prev) => ({ ...prev, [key]: value })); setSaved(false); }} />
      <div className="flex flex-wrap gap-2 items-center mt-3">
        <button type="button" className="btn-primary text-xs" disabled={saving || loading || !Object.keys(pending).length} onClick={() => void save()}>{saving ? "保存中…" : "保存数值"}</button>
        <button type="button" className="app-danger-button text-xs text-gray-400 hover:text-gray-200" disabled={saving || loading || !Object.keys(row.session_values).length} onClick={() => void save(true)}>恢复全局值</button>
        <span role="status" className="text-xs text-gray-400">{Object.keys(pending).length ? "有未保存修改" : saved ? "已保存" : ""}</span>
      </div>
    </>}
  </section>;
}
