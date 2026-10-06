import { useEffect, useState } from "react";
import { DEFAULT_WINDOW_PRESET, WINDOW_PRESETS, type WindowMode, type WindowPresetId, type WindowState } from "../shared/windowSettings";

const MODES: { id: WindowMode; label: string }[] = [
  { id: "windowed", label: "窗口" },
  { id: "maximized", label: "窗口全屏" },
  { id: "fullscreen", label: "全屏" },
];

export default function WindowSettings() {
  const bridge = window.electronAPI;
  const supported = !!bridge?.getWindowState;
  const [state, setState] = useState<WindowState | null>(null);
  const [selected, setSelected] = useState<WindowPresetId | "">(DEFAULT_WINDOW_PRESET.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supported || !bridge) return;
    let active = true;
    const update = (next: WindowState) => {
      if (!active) return;
      setState(next);
      setSelected(WINDOW_PRESETS.find(p => p.width === next.width && p.height === next.height)?.id ?? "");
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
    try { setState(await action()); }
    catch (err) { setError(err instanceof Error ? err.message : "窗口调整失败，请重试。"); }
    finally { setPending(false); }
  };

  return (
    <section className="card">
      <h3 className="panel-title">窗口</h3>
      <div className="flex items-center justify-between gap-4 mb-4">
        <span className="text-sm font-medium">显示模式</span>
        <div role="group" aria-label="显示模式" className="flex gap-1">
          {MODES.map(mode => (
            <button key={mode.id} type="button" aria-pressed={state?.mode === mode.id}
              disabled={!supported || !state || pending}
              onClick={() => { if (bridge) void apply(() => bridge.setWindowMode(mode.id)); }}
              className={"px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                (state?.mode === mode.id ? "bg-amber-500/10 text-amber-300 border-amber-500/40" : "bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700/40")}
            >{mode.label}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor="window-size" className="text-sm font-medium shrink-0">窗口尺寸</label>
        <select id="window-size" value={selected} disabled={!supported || !state || pending}
          onChange={event => setSelected(event.target.value as WindowPresetId)}
          className="flex-1 min-w-0 px-3 py-2 rounded-md border border-gray-700 bg-gray-900 text-sm text-gray-200 disabled:opacity-50 focus:border-amber-500/50">
          <option value="" disabled>自定义</option>
          {WINDOW_PRESETS.map(preset => {
            const fits = !state || state.availablePresets.includes(preset.id);
            return <option key={preset.id} value={preset.id} disabled={!fits}>
              {preset.width} × {preset.height}{preset.id === DEFAULT_WINDOW_PRESET.id ? "（默认）" : preset.id === "2560x1440" ? "（2K）" : ""}{fits ? "" : " · 屏幕空间不足"}
            </option>;
          })}
        </select>
        <button type="button" className="btn btn-primary text-sm" disabled={!supported || !state || !selected || pending}
          onClick={() => { if (bridge && selected) void apply(() => bridge.setWindowPreset(selected)); }}>应用</button>
      </div>
      <p className="text-xs text-gray-500 mt-3" aria-live="polite">
        {supported ? state ? `当前 ${state.width} × ${state.height} · ${MODES.find(mode => mode.id === state.mode)?.label}` : "正在读取窗口尺寸…" : "窗口设置需在桌面客户端中使用。"}
      </p>
      {supported && <p className="text-xs text-gray-500 mt-1">应用尺寸会切换为窗口模式，仍可自由拖动窗口边缘。</p>}
      {error && <p role="alert" className="text-xs text-red-400 mt-2">{error}</p>}
    </section>
  );
}
