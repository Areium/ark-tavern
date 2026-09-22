/**
 * 角色页「数值」页签 —— 编辑角色的全局数值（写进角色目录 index.md 的 `stats`）。
 *
 * 字段来自角色所属世界书的统一字段（`worldbook_id` → `stat_fields`）；没有字段时仍可自由填写
 * 自定义键。会话里的实际数值 = 这里的全局值 + 会话覆盖（场景面板「数值」页）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { CharacterStatsDTO, StatValue } from "../../types";
import AppIcon from "../AppIcon";
import { ActionButton } from "./RoleWidgets";
import StatValuesForm from "./StatValuesForm";

interface Props {
  characterId: string;
}

export default function CharacterStatsEditor({ characterId }: Props) {
  const api = useApi();
  const { setCurrentView, setWorldbookJumpId } = useAppStore();
  const [data, setData] = useState<CharacterStatsDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const pending = useRef<Record<string, StatValue | null>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.getCharacterStats(characterId));
    } catch (err: any) {
      setError(err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, characterId]);

  useEffect(() => { void load(); }, [load]);

  const change = (key: string, value: StatValue | null) => {
    setData((prev) => {
      if (!prev) return prev;
      const values = { ...prev.values };
      const sources = { ...prev.sources };
      const stored = { ...prev.stored };
      if (value === null) {
        delete stored[key];
        const field = prev.fields.find((f) => f.key === key);
        if (field) { values[key] = field.default as StatValue; sources[key] = "default"; }
        else { delete values[key]; delete sources[key]; }
      } else {
        values[key] = value; sources[key] = "global"; stored[key] = value;
      }
      return { ...prev, values, sources, stored };
    });
    pending.current[key] = value;
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const batch = pending.current;
      pending.current = {};
      try {
        setData(await api.saveCharacterStats(characterId, batch));
        setStatus("saved");
      } catch (err: any) {
        setError(err.message || "保存失败");
        setStatus("idle");
        void load();
      }
    }, 600);
  };

  const jumpToBook = () => {
    if (!data?.worldbook_id) return;
    setWorldbookJumpId(data.worldbook_id);
    setCurrentView("worldbook");
  };

  if (loading && !data) return <p className="text-xs text-gray-500 py-4 text-center">加载中…</p>;
  if (!data) return <p className="text-xs text-red-400">{error || "无法读取数值"}</p>;

  return (
    <div className="max-w-xl space-y-4">
      <div className="flex items-start gap-2 text-[11px] text-gray-500 leading-relaxed">
        <AppIcon name="info" size={13} className="mt-0.5 shrink-0" />
        <span>
          这里是角色的<b className="text-gray-300">全局默认值</b>，写进角色目录的 <code className="font-mono">index.md</code>。
          会话里的实际数值以此为基础，再叠加该会话的改动（对话页场景面板「数值」）。
          {data.worldbook_name
            ? <>统一字段来自世界书「{data.worldbook_name}」。</>
            : <>该角色未标注来源世界书，因此没有统一字段；可在「资产」页标注来源，或直接填写自定义键。</>}
        </span>
      </div>

      {data.worldbook_id && data.fields.length === 0 && (
        <div className="stat-hint">
          <AppIcon name="warning" size={13} className="mt-0.5 shrink-0" />
          <span>
            世界书「{data.worldbook_name || data.worldbook_id}」还没有定义统一数值字段。
            <button type="button" className="underline ml-1 hover:text-amber-200" onClick={jumpToBook}>去世界书定义</button>
          </span>
        </div>
      )}

      <StatValuesForm fields={data.fields} values={data.values} sources={data.sources} ownSource="global" onChange={change} />

      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>{status === "saving" ? "保存中…" : status === "saved" ? "已保存" : error ? <span className="text-red-400">{error}</span> : ""}</span>
        {data.worldbook_id && (
          <ActionButton icon="worldbook" variant="ghost" onClick={jumpToBook} title="在世界书工作台编辑这本书的统一字段">
            编辑统一字段
          </ActionButton>
        )}
      </div>
    </div>
  );
}
