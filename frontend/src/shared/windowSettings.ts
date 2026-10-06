/** 内容区逻辑像素；与前端设计规范的验收视口保持一致。 */
export const WINDOW_PRESETS = [
  { id: "1280x720", width: 1280, height: 720 },
  { id: "1400x900", width: 1400, height: 900 },
  { id: "1600x900", width: 1600, height: 900 },
  { id: "1920x1080", width: 1920, height: 1080 },
  { id: "2560x1440", width: 2560, height: 1440 },
] as const;

export type WindowPresetId = typeof WINDOW_PRESETS[number]["id"];
export type WindowMode = "windowed" | "maximized" | "fullscreen";
export const DEFAULT_WINDOW_PRESET = WINDOW_PRESETS[1];

export interface WindowState {
  width: number;
  height: number;
  mode: WindowMode;
  /** 当前选中的尺寸预设；自定义尺寸或未选择预设时为 null。 */
  presetId: WindowPresetId | null;
  /** 所选预设超出屏幕可用空间、已按比例适配为当前实际尺寸时为 true。 */
  fitted: boolean;
}
