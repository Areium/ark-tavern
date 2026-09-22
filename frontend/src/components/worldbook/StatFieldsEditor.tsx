/**
 * 世界书「统一数值字段」编辑器 —— 定义这本书下所有角色共用的数值字段。
 *
 * 字段类型：number（可带 min / max / step / 默认）、text、bool、select（选项）。
 * 键名是数据里的 key（角色 frontmatter `stats` 与会话数值都按它存），标签是界面显示名。
 */
import { useEffect, useMemo, useState } from "react";
import type { StatFieldDTO, StatFieldType } from "../../types";
import AppIcon from "../AppIcon";

interface Props {
  fields: StatFieldDTO[];
  saving?: boolean;
  onSave: (fields: StatFieldDTO[]) => Promise<void> | void;
  onClose: () => void;
}

const TYPE_LABELS: Record<StatFieldType, string> = { number: "数值", text: "文本", bool: "开关", select: "选项" };
const KEY_RE = /^[A-Za-z0-9_\-一-鿿]{1,32}$/;

interface Row {
  key: string; label: string; type: StatFieldType; min: string; max: string; step: string; default: string; options: string; group: string; description: string;
}

function toRow(f: StatFieldDTO): Row {
  return {
    key: f.key, label: f.label || "", type: f.type || "number",
    min: f.min != null ? String(f.min) : "", max: f.max != null ? String(f.max) : "", step: f.step != null ? String(f.step) : "",
    default: f.default != null ? String(f.default) : "", options: (f.options || []).join(", "),
    group: f.group || "", description: f.description || "",
  };
}

/** 行 → 字段定义（纯函数，供断言脚本使用）。返回错误文案或 null。 */
export function rowsToFields(rows: Row[]): { fields: StatFieldDTO[]; error: string | null } {
  const fields: StatFieldDTO[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const key = r.key.trim();
    if (!KEY_RE.test(key)) return { fields: [], error: `第 ${i + 1} 行的键名非法（1–32 位字母 / 数字 / 下划线 / 中文）` };
    if (seen.has(key)) return { fields: [], error: `键名重复：${key}` };
    seen.add(key);
    const field: StatFieldDTO = { key, label: r.label.trim() || key, type: r.type };
    if (r.group.trim()) field.group = r.group.trim();
    if (r.description.trim()) field.description = r.description.trim();
    if (r.type === "number") {
      for (const k of ["min", "max", "step"] as const) {
        if (r[k].trim() !== "") {
          const n = Number(r[k]);
          if (!Number.isFinite(n)) return { fields: [], error: `「${field.label}」的 ${k} 不是数字` };
          field[k] = n;
        }
      }
      if (r.default.trim() !== "") {
        const n = Number(r.default);
        if (!Number.isFinite(n)) return { fields: [], error: `「${field.label}」的默认值不是数字` };
        field.default = n;
      }
    } else if (r.type === "bool") {
      field.default = /^(true|1|yes|是|on)$/i.test(r.default.trim());
    } else if (r.type === "select") {
      const options = r.options.split(/[,，、|\n]/).map((s) => s.trim()).filter(Boolean);
      if (!options.length) return { fields: [], error: `「${field.label}」是选项类型，至少填一个选项` };
      field.options = Array.from(new Set(options));
      field.default = field.options.includes(r.default.trim()) ? r.default.trim() : field.options[0];
    } else {
      field.default = r.default;
    }
    fields.push(field);
  }
  return { fields, error: null };
}

const EMPTY_ROW: Row = { key: "", label: "", type: "number", min: "", max: "", step: "", default: "", options: "", group: "", description: "" };

export default function StatFieldsEditor({ fields, saving, onSave, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>(() => fields.map(toRow));
  const [error, setError] = useState("");
  useEffect(() => { setRows(fields.map(toRow)); }, [fields]);

  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(fields.map(toRow)), [rows, fields]);

  const update = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => setRows((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    const { fields: parsed, error: err } = rowsToFields(rows);
    if (err) { setError(err); return; }
    setError("");
    await onSave(parsed);
  };

  const inputCls = "wber-sf-input";

  return (
    <div className="wber-create" role="dialog" aria-label="统一数值字段">
      <div className="wber-create-card wber-sf-card">
        <h3>统一数值字段</h3>
        <p>这本书下的角色共用这些字段：角色页「数值」按它编辑默认值，对话页场景面板「数值」按它记录会话内的变化，叙述时模型也会看到。</p>

        <div className="wber-sf-list">
          {rows.length === 0 && <div className="wber-sf-empty">还没有字段。点「添加字段」开始，例如：体力（number，0–100，默认 100）、金钱（number）、好感（number，0–10）。</div>}
          {rows.map((row, i) => (
            <div key={i} className="wber-sf-row">
              <div className="wber-sf-grid">
                <label>键名<input className={`${inputCls} is-mono`} value={row.key} placeholder="hp" onChange={(e) => update(i, { key: e.target.value })} /></label>
                <label>标签<input className={inputCls} value={row.label} placeholder="体力" onChange={(e) => update(i, { label: e.target.value })} /></label>
                <label>类型
                  <select className={inputCls} value={row.type} onChange={(e) => update(i, { type: e.target.value as StatFieldType })}>
                    {(Object.keys(TYPE_LABELS) as StatFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </label>
                <label>分组<input className={inputCls} value={row.group} placeholder="可选" onChange={(e) => update(i, { group: e.target.value })} /></label>
                {row.type === "number" && (
                  <>
                    <label>最小<input className={`${inputCls} is-mono`} value={row.min} placeholder="0" onChange={(e) => update(i, { min: e.target.value })} /></label>
                    <label>最大<input className={`${inputCls} is-mono`} value={row.max} placeholder="100" onChange={(e) => update(i, { max: e.target.value })} /></label>
                    <label>步长<input className={`${inputCls} is-mono`} value={row.step} placeholder="1" onChange={(e) => update(i, { step: e.target.value })} /></label>
                    <label>默认<input className={`${inputCls} is-mono`} value={row.default} placeholder="0" onChange={(e) => update(i, { default: e.target.value })} /></label>
                  </>
                )}
                {row.type === "select" && (
                  <>
                    <label className="is-wide">选项（逗号分隔）<input className={inputCls} value={row.options} placeholder="平静, 警惕, 愤怒" onChange={(e) => update(i, { options: e.target.value })} /></label>
                    <label>默认<input className={inputCls} value={row.default} placeholder="平静" onChange={(e) => update(i, { default: e.target.value })} /></label>
                  </>
                )}
                {row.type === "bool" && (
                  <label>默认
                    <select className={inputCls} value={/^(true|1|yes|是|on)$/i.test(row.default) ? "true" : "false"} onChange={(e) => update(i, { default: e.target.value })}>
                      <option value="false">否</option><option value="true">是</option>
                    </select>
                  </label>
                )}
                {row.type === "text" && (
                  <label className="is-wide">默认<input className={inputCls} value={row.default} onChange={(e) => update(i, { default: e.target.value })} /></label>
                )}
                <label className="is-wide">说明<input className={inputCls} value={row.description} placeholder="可选：这项数值的含义 / 变化规则" onChange={(e) => update(i, { description: e.target.value })} /></label>
              </div>
              <div className="wber-sf-actions">
                <button type="button" className="is-icon is-sm is-ghost" title="上移" aria-label="上移" disabled={i === 0} onClick={() => move(i, -1)}><AppIcon name="collapseAll" size={13} /></button>
                <button type="button" className="is-icon is-sm is-ghost" title="下移" aria-label="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><AppIcon name="expandAll" size={13} /></button>
                <button type="button" className="is-icon is-sm is-ghost is-danger" title="删除字段" aria-label="删除字段" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}><AppIcon name="trash" size={13} /></button>
              </div>
            </div>
          ))}
        </div>

        <div className="wber-sf-add">
          <button type="button" className="is-sm" onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}><AppIcon name="plus" size={13} />添加字段</button>
          <small>删除字段不会删除角色里已存的值，只是界面上不再按字段展示（会归入「自定义」）。</small>
        </div>

        {error && <div className="wber-alert" role="alert">{error}</div>}
        <div className="wber-dialog-actions">
          <button type="button" className="is-ghost" onClick={onClose}>取消</button>
          <button type="button" className="is-primary" disabled={!!saving || (!dirty && rows.length === fields.length)} onClick={() => void save()}>{saving ? "保存中…" : "保存字段"}</button>
        </div>
      </div>
    </div>
  );
}
