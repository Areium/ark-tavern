import { useEffect, useState } from "react";
import { DEFAULT_WINDOW_PRESET, WINDOW_PRESETS, type WindowMode, type WindowPresetId, type WindowState } from "../shared/windowSettings";

const MODES: { id: WindowMode; label: string }[] = [
  { id: "windowed", label: "窗口" },
  { id: "maximized", label: "窗口全屏" },
  { id: "fullscreen", label: "全屏" },
];

/** 下拉框取值：尺寸预设直接用预设 id，显示模式加 mode: 前缀区分。 */
const MODE_VALUES = [
  { value: "mode:maximized", label: "窗口全屏" },
  { value: "mode:fullscreen", label: "全屏" },
] as const;

const stateValue = (state: WindowState): string =>
  state.mode === "windowed" ? state.presetId ?? "" : `mode:${state.mode}`;

const presetLabel = (id: WindowPresetId): string => {
  const preset = WINDOW_PRESETS.find(p => p.id === id);
  if (!preset) return id;
  return `${preset.width} × ${preset.height}${preset.id === DEFAULT_WINDOW_PRESET.id ? "（默认）" : preset.id === "2560x1440" ? "（2K）" : ""}`;
};

export default function WindowSettings() {
  const bridge = window.electronAPI;
  const supported = !!bridge?.getWindowState;
  const [state, setState] = useState<WindowState | null>(null);
  const [selected, setSelected] = useState<string>(DEFAULT_WINDOW_PRESET.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supported || !bridge) return;
    let active = true;
    const update = (next: WindowState) => {
      if (!active) return;
      setState(next);
      setSelected(stateValue(next));
    };
    const unsubscribe = bridge.onWindowStateChange(update);
    void bridge.getWindowState().then(update).catch(() => {
      if (active) setError("无法读取窗口状态，请重新打开设置。");
    });
    return () => { active = false; unsubscribe(); };
  }, [bridge, supported]);

  const apply = async (action: () => Promise<WindowState>) => {
    setPending(true);
    setError("");
    try {
      const next = await action();
      setState(next);
      setSelected(stateValue(next));
    }
    catch (err) { setError(err instanceof Error ? err.message : "窗口调整失败，请重试。"); }
    finally { setPending(false); }
  };

  return (
    <section className="card">
      <h3 className="panel-title">窗口</h3>
      <div className="flex items-center gap-3">
        <label htmlFor="window-display" className="text-sm font-medium shrink-0">尺寸与模式</label>
        <select id="window-display" value={selected} disabled={!supported || !state || pending}
          onChange={event => {
            const value = event.target.value;
            setSelected(value);
            if (!bridge) return;
            if (value === "mode:maximized") void apply(() => bridge.setWindowMode("maximized"));
            else if (value === "mode:fullscreen") void apply(() => bridge.setWindowMode("fullscreen"));
            else void apply(() => bridge.setWindowPreset(value as WindowPresetId));
          }}
          className="flex-1 min-w-0 px-3 py-2 rounded-md border border-gray-700 bg-gray-900 text-sm text-gray-200 disabled:opacity-50 focus:border-amber-500/50">
          <option value="" disabled>自定义</option>
          {WINDOW_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{presetLabel(preset.id)}</option>)}
          {MODE_VALUES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500 mt-3" aria-live="polite">
        {supported ? state
          ? `当前 ${state.width} × ${state.height} · ${MODES.find(mode => mode.id === state.mode)?.label}` +
            (state.fitted && state.presetId ? `（${presetLabel(state.presetId)} 超出屏幕可用空间，已按比例适配）` : "")
          : "正在读取窗口尺寸…" : "窗口设置需在桌面客户端中使用。"}
      </p>
      {supported && <p className="text-xs text-gray-500 mt-1">选择后立即生效；窗口尺寸超出屏幕可用空间时按比例适配，仍可自由拖动窗口。</p>}
      {error && <p role="alert" className="text-xs text-red-400 mt-2">{error}</p>}
    </section>
  );
}
