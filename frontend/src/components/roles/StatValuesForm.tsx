/**
 * 数值表单 —— 按世界书统一字段渲染一组可编辑的值（角色页「数值」与场景面板「数值」共用）。
 *
 * 字段内的值按类型给控件（数字 / 文本 / 开关 / 下拉）；字段外的自定义键列在「自定义」组，
 * 可以增删。每个键可带来源标记（默认 / 全局 / 会话），调用方决定要不要显示。
 */
import { useState } from "react";
import type { StatFieldDTO, StatSource, StatValue } from "../../types";
import AppIcon from "../AppIcon";

export const SOURCE_LABELS: Record<StatSource, string> = { default: "默认", global: "全局", session: "会话" };

interface Props {
  fields: StatFieldDTO[];
  values: Record<string, StatValue>;
  sources?: Record<string, StatSource>;
  /** 值改动：`null` 表示清掉本层的值（会话层 = 回到全局；全局层 = 删键） */
  onChange: (key: string, value: StatValue | null) => void;
  disabled?: boolean;
  /** 允许添加字段外的自定义键 */
  allowCustom?: boolean;
  /** 显示来源标记 */
  showSource?: boolean;
  /** 本层「有自己的值」的来源（会话面板 = session，角色页 = global）——用于「清除」按钮是否可用 */
  ownSource?: StatSource;
}

/** 把字段按 group 分组（保持出现顺序；无组的排最前） */
export function groupFields(fields: StatFieldDTO[]): Array<{ group: string; fields: StatFieldDTO[] }> {
  const order: string[] = [];
  const map = new Map<string, StatFieldDTO[]>();
  for (const field of fields) {
    const group = field.group || "";
    if (!map.has(group)) { map.set(group, []); order.push(group); }
    map.get(group)!.push(field);
  }
  order.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
  return order.map((group) => ({ group, fields: map.get(group)! }));
}

/** 字段外的自定义键 */
export function customKeys(fields: StatFieldDTO[], values: Record<string, StatValue>): string[] {
  const known = new Set(fields.map((f) => f.key));
  return Object.keys(values).filter((k) => !known.has(k));
}

const inputCls = "w-full bg-gray-900 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-200 focus:border-amber-500/50 disabled:opacity-50";

function FieldControl({ field, value, disabled, onChange }: {
  field: StatFieldDTO; value: StatValue | undefined; disabled?: boolean; onChange: (v: StatValue) => void;
}) {
  if (field.type === "bool") {
    return (
      <label className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
        <input type="checkbox" className="checkbox" checked={!!value} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
        {value ? "是" : "否"}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <select className={inputCls} value={String(value ?? "")} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.type === "number") {
    const num = typeof value === "number" ? value : Number(value ?? field.default ?? 0);
    const max = field.max;
    const min = field.min;
    const pct = max != null && min != null && max > min ? Math.max(0, Math.min(100, ((num - min) / (max - min)) * 100)) : null;
    return (
      <div className="flex items-center gap-2">
        <input type="number" className={`${inputCls} font-mono text-right w-24 shrink-0`} value={Number.isFinite(num) ? num : ""}
          min={min} max={max} step={field.step ?? 1} disabled={disabled}
          onChange={(e) => { const v = e.target.value; if (v === "") return; const n = Number(v); if (Number.isFinite(n)) onChange(n); }} />
        {pct != null && (
          <div className="stat-meter flex-1" title={`${num} / ${max}`}>
            <div className="stat-meter-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        {pct == null && max != null && <span className="text-[11px] text-gray-500">/ {max}</span>}
      </div>
    );
  }
  return (
    <input type="text" className={inputCls} value={String(value ?? "")} disabled={disabled}
      onChange={(e) => onChange(e.target.value)} />
  );
}

export default function StatValuesForm({
  fields, values, sources, onChange, disabled, allowCustom = true, showSource = true, ownSource,
}: Props) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const custom = customKeys(fields, values);
  const groups = groupFields(fields);

  const addCustom = () => {
    const key = newKey.trim();
    if (!key || !/^[A-Za-z0-9_\-一-鿿]{1,32}$/.test(key)) return;
    const raw = newValue.trim();
    const asNumber = raw !== "" && /^[-+]?\d+(\.\d+)?$/.test(raw) ? Number(raw) : null;
    onChange(key, asNumber ?? raw);
    setNewKey("");
    setNewValue("");
  };

  const sourceBadge = (key: string) => {
    if (!showSource || !sources?.[key]) return null;
    const source = sources[key];
    return (
      <span className={`stat-source is-${source}`} title={`当前值来自：${SOURCE_LABELS[source]}`}>
        {SOURCE_LABELS[source]}
      </span>
    );
  };

  const clearButton = (key: string) => {
    if (!ownSource || sources?.[key] !== ownSource || disabled) return null;
    return (
      <button type="button" className="stat-clear" title={ownSource === "session" ? "清除会话值，回到全局值" : "删除这个值"}
        onClick={() => onChange(key, null)} aria-label="清除">
        <AppIcon name="close" size={11} />
      </button>
    );
  };

  return (
    <div className="stat-form">
      {groups.map(({ group, fields: groupFields }) => (
        <section key={group || "__default"} className="stat-group">
          {group && <h4 className="stat-group-title">{group}</h4>}
          {groupFields.map((field) => (
            <div key={field.key} className="stat-row">
              <div className="stat-row-head">
                <span className="stat-label" title={field.description || field.key}>{field.label}</span>
                {sourceBadge(field.key)}
                {clearButton(field.key)}
              </div>
              <FieldControl field={field} value={values[field.key]} disabled={disabled}
                onChange={(v) => onChange(field.key, v)} />
              {field.description && <p className="stat-desc">{field.description}</p>}
            </div>
          ))}
        </section>
      ))}

      {(custom.length > 0 || allowCustom) && (
        <section className="stat-group">
          <h4 className="stat-group-title">自定义</h4>
          {custom.map((key) => (
            <div key={key} className="stat-row is-custom">
              <div className="stat-row-head">
                <span className="stat-label font-mono">{key}</span>
                {sourceBadge(key)}
                {!disabled && (
                  <button type="button" className="stat-clear" title="删除这个自定义值" aria-label={`删除 ${key}`}
                    onClick={() => onChange(key, null)}>
                    <AppIcon name="trash" size={11} />
                  </button>
                )}
              </div>
              <input type="text" className={inputCls} value={String(values[key] ?? "")} disabled={disabled}
                onChange={(e) => {
                  const raw = e.target.value;
                  const n = raw.trim() !== "" && /^[-+]?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
                  onChange(key, n);
                }} />
            </div>
          ))}
          {allowCustom && !disabled && (
            <div className="stat-add">
              <input type="text" className={`${inputCls} font-mono`} placeholder="键名" value={newKey}
                onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }} />
              <input type="text" className={inputCls} placeholder="值" value={newValue}
                onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }} />
              <button type="button" className="stat-add-btn" onClick={addCustom} disabled={!newKey.trim()} title="添加自定义数值">
                <AppIcon name="plus" size={13} />
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
