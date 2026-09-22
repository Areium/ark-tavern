/**
 * 场景面板「数值」页 —— 阵容角色的会话数值（世界书统一字段 × 角色全局值 × 会话值）。
 *
 * 这是 `ScenePanelContext.stats` 的参考实现：第三方面板要读写数值时照这里的用法即可。
 * 编辑写在会话层（只对本会话生效，随剧情树节点回档）；「重置」清掉会话值回到角色全局值。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenePanelProps } from "../../plugins/scenePanels";
import type { SessionCharacterStatsDTO, StatValue } from "../../types";
import { useAppStore } from "../../stores/appStore";
import AppIcon from "../AppIcon";
import AvatarPlaceholder from "../chat/AvatarPlaceholder";
import StatValuesForm from "../roles/StatValuesForm";

export default function CharacterStatsPanel({ ctx }: ScenePanelProps) {
  const { setCurrentView, setWorldbookJumpId } = useAppStore();
  const [rows, setRows] = useState<SessionCharacterStatsDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const pending = useRef<Record<string, Record<string, StatValue | null>>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await ctx.stats.list();
      setRows(data.characters);
      setOpen((current) => current && data.characters.some((c) => c.name === current) ? current : (data.characters[0]?.name ?? null));
    } catch (err: any) {
      setError(err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [ctx.stats]);

  useEffect(() => { void load(); }, [load, ctx.sessionId, ctx.refresh.stats, ctx.refresh.character, ctx.refresh.chat]);

  /** 本地先改、600ms 后合并提交（同一角色多次改动合成一次请求） */
  const change = (name: string, key: string, value: StatValue | null) => {
    setRows((prev) => prev.map((row) => {
      if (row.name !== name) return row;
      const values = { ...row.values };
      const sources = { ...row.sources };
      const sessionValues = { ...row.session_values };
      if (value === null) {
        delete sessionValues[key];
        const field = row.fields.find((f) => f.key === key);
        if (field) { values[key] = field.default as StatValue; sources[key] = "default"; }
        else { delete values[key]; delete sources[key]; }
      } else {
        values[key] = value; sources[key] = "session"; sessionValues[key] = value;
      }
      return { ...row, values, sources, session_values: sessionValues };
    }));
    pending.current[name] = { ...(pending.current[name] || {}), [key]: value };
    if (timers.current[name]) clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(async () => {
      const batch = pending.current[name];
      delete pending.current[name];
      if (!batch) return;
      setSaving(name);
      try {
        const saved = await ctx.stats.set(name, batch);
        setRows((prev) => prev.map((row) => (row.name === name ? saved : row)));
      } catch (err: any) {
        setError(err.message || "保存失败");
        void load();
      } finally {
        setSaving(null);
      }
    }, 600);
  };

  const reset = async (name: string) => {
    if (!window.confirm(`清除「${name}」在本会话的全部数值改动，回到角色全局值？`)) return;
    setSaving(name);
    try {
      const saved = await ctx.stats.reset(name);
      setRows((prev) => prev.map((row) => (row.name === name ? saved : row)));
    } catch (err: any) {
      setError(err.message || "重置失败");
    } finally {
      setSaving(null);
    }
  };

  const jumpToBook = (bookId: string) => {
    setWorldbookJumpId(bookId || null);
    setCurrentView("worldbook");
  };

  const bookId = ctx.session?.worldbook_id || rows.find((r) => r.worldbook_id)?.worldbook_id || "";
  const noFields = rows.length > 0 && rows.every((r) => r.fields.length === 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-gray-500 leading-relaxed">
          改动只对本会话生效，随剧情节点回档；叙述时模型会看到这些数值。
        </p>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="text-[11px] text-gray-500 hover:text-gray-300 shrink-0 ml-2" title="重新拉取">
          <AppIcon name="refresh" size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {noFields && (
        <div className="stat-hint">
          <AppIcon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>
            {bookId ? "当前世界书还没有定义统一数值字段，" : "会话未绑定世界书，"}
            下面只能自由填写自定义键。
            {bookId && (
              <button type="button" className="underline ml-1 hover:text-amber-200" onClick={() => jumpToBook(bookId)}>
                去世界书定义字段
              </button>
            )}
          </span>
        </div>
      )}
      {!loading && rows.length === 0 && !error && (
        <p className="text-gray-500 text-xs text-center py-4">阵容为空，先在会话大厅添加角色</p>
      )}
      {rows.map((row) => {
        const expanded = open === row.name;
        const sessionCount = Object.keys(row.session_values).length;
        return (
          <section key={row.name} className={`stat-char ${expanded ? "is-open" : ""}`}>
            <button type="button" className="stat-char-head" onClick={() => setOpen(expanded ? null : row.name)}
              aria-expanded={expanded}>
              <AvatarPlaceholder name={row.name} size="sm" sessionId={ctx.sessionId} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-xs font-medium truncate">
                  {row.name}
                  {row.is_player && <span className="ml-1.5 text-[10px] text-amber-300/80">主控</span>}
                </span>
                <span className="block text-[10px] text-gray-500 truncate">
                  {row.fields.length ? `${row.fields.length} 个字段` : "无统一字段"}
                  {sessionCount > 0 && ` · 会话改动 ${sessionCount} 项`}
                  {saving === row.name && " · 保存中…"}
                </span>
              </span>
              <AppIcon name={expanded ? "expand" : "forward"} size={13} className="text-gray-500 shrink-0" />
            </button>
            {expanded && (
              <div className="stat-char-body">
                <StatValuesForm fields={row.fields} values={row.values} sources={row.sources}
                  ownSource="session" onChange={(key, value) => change(row.name, key, value)} />
                {sessionCount > 0 && (
                  <button type="button" className="stat-reset" onClick={() => void reset(row.name)} disabled={saving === row.name}>
                    <AppIcon name="refresh" size={11} />清除本会话改动
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
