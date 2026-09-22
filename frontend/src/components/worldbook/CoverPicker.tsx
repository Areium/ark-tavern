import { useRef, useState } from "react";
import AppIcon from "../AppIcon";
import { formatBytes } from "../../utils/worldbookLayer";

/**
 * 世界书封面：**从本地文件选择**，压缩后以 data URL 内嵌进世界书。
 *
 * 为什么不收图片地址：封面要跟着书走。存成外链时，导出 JSON 只带走一个 URL，
 * 换台机器、断网、对方图床挂掉，封面就没了。内嵌（`data:image/...;base64`）
 * 让 `cover_image` 成为书自身的一部分，导出 → 导入原样还原，也不需要额外的
 * 资源目录约定。
 *
 * 代价是 base64 比原图大 ~33%，所以入库前先压缩：
 *   1. 长边缩到 {@link COVER_MAX_EDGE}（封面在界面上最大也就几百像素宽）；
 *   2. 优先编码 WebP，不可用则回退 JPEG（都没有 alpha 需求，白底铺平）；
 *   3. 从高到低试质量，直到体积落到 {@link COVER_MAX_BYTES} 以内。
 * 结果通常几十 KB —— 与一封带图邮件同量级，整本书 JSON 不会被撑爆。
 */

/** 长边像素上限。封面展示尺寸远小于此，再大只是徒增 base64 体积。 */
export const COVER_MAX_EDGE = 512;
/** 压缩后体积上限（字节）。超过就继续降质量。 */
export const COVER_MAX_BYTES = 160 * 1024;
/** 质量阶梯：从上往下试，取第一个满足体积上限的。 */
export const COVER_QUALITY_LADDER = [0.86, 0.74, 0.62, 0.5, 0.4];
/** 编码格式偏好：WebP 更小；Electron/Chromium 不支持时回退 JPEG。 */
export const COVER_MIME_PREFERENCE = ["image/webp", "image/jpeg"];

export interface CoverCompressResult {
  /** 入库用的 data URL（`data:image/webp;base64,...`） */
  dataUrl: string;
  /** 压缩后字节数 */
  bytes: number;
  /** 原图字节数 */
  originalBytes: number;
  width: number;
  height: number;
  mime: string;
}

export interface CoverCompressOptions {
  maxEdge?: number;
  maxBytes?: number;
  qualityLadder?: readonly number[];
  mimePreference?: readonly string[];
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") { resolve(null); return; }
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

/** 把任意图片 Blob 解码成可绘制的位图；优先 `createImageBitmap`，否则用 `<img>`。 */
async function decodeImage(source: Blob): Promise<{ draw: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(source);
      return { draw: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch { /* 回退到 <img> 路径（例如 SVG / 不支持的格式） */ }
  }
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("无法解码这张图片，请换一张 PNG / JPG / WebP。"));
      element.src = url;
    });
    return {
      draw: image, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (reason) {
    URL.revokeObjectURL(url);
    throw reason;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取压缩后的封面失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 压缩一张封面图并返回可直接入库的 data URL。
 *
 * 抛出的错误带着人话（不是 `NotSupportedError` 这类），界面可以直接展示。
 */
export async function compressCoverImage(
  file: Blob, options: CoverCompressOptions = {},
): Promise<CoverCompressResult> {
  if (!file || !file.size) throw new Error("这张图片是空的，请重新选择文件。");
  const maxEdge = options.maxEdge ?? COVER_MAX_EDGE;
  const maxBytes = options.maxBytes ?? COVER_MAX_BYTES;
  const ladder = options.qualityLadder ?? COVER_QUALITY_LADDER;
  const mimes = options.mimePreference ?? COVER_MIME_PREFERENCE;

  const decoded = await decodeImage(file);
  try {
    const { width, height } = decoded;
    if (!width || !height) throw new Error("这张图片没有可用的尺寸信息，请换一张。");
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片（缺少 canvas 2d 上下文）。");
    // JPEG 没有 alpha：先铺白底，否则透明区域会变成黑块。
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
    context.drawImage(decoded.draw, 0, 0, targetWidth, targetHeight);

    let best: { blob: Blob; mime: string } | null = null;
    for (const mime of mimes) {
      for (const quality of ladder) {
        const blob = await encodeCanvas(canvas, mime, quality);
        if (!blob || !blob.size) continue;
        if (blob.type && blob.type !== mime) break;  // 该格式不被支持，换下一个
        if (!best || blob.size < best.blob.size) best = { blob, mime };
        if (blob.size <= maxBytes) { best = { blob, mime }; break; }
      }
      if (best && best.blob.size <= maxBytes) break;
    }
    if (!best) throw new Error("压缩封面失败，请换一张 PNG / JPG / WebP 图片。");

    return {
      dataUrl: await blobToDataUrl(best.blob),
      bytes: best.blob.size,
      originalBytes: file.size,
      width: targetWidth,
      height: targetHeight,
      mime: best.mime,
    };
  } finally {
    decoded.release();
  }
}

/** 压缩结果的人话文案：`原图 2.4 MB → 68 KB（512×768）`。 */
export function coverCompressSummary(result: CoverCompressResult): string {
  const size = result.originalBytes > result.bytes
    ? `原图 ${formatBytes(result.originalBytes)} → ${formatBytes(result.bytes)}`
    : `${formatBytes(result.bytes)}`;
  return `${size}（${result.width}×${result.height}）`;
}

/**
 * 封面选择器。
 *
 * `variant="field"`：表单里的一行控件（新建对话框 / 编辑介绍）。
 * `variant="overlay"`：盖在封面图上的按钮（悬停或聚焦时出现）。
 */
export default function CoverPicker({
  value, onChange, variant = "field", emptyLabel = "选择本地图片", onNotice, disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  variant?: "field" | "overlay";
  emptyLabel?: string;
  onNotice?: (text: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(""); setSummary("");
    try {
      const result = await compressCoverImage(file);
      onChange(result.dataUrl);
      setSummary(coverCompressSummary(result));
      onNotice?.(`封面已更新：${coverCompressSummary(result)}，随世界书一起保存与导出。`);
    } catch (reason: any) {
      const message = reason?.message || "封面处理失败，请换一张图片。";
      setError(message);
      onNotice?.(message);
    } finally {
      setBusy(false);
    }
  };

  const trigger = <button
    type="button"
    className={variant === "overlay" ? "wber-cover-overlay-button" : "wber-cover-picker-main"}
    disabled={disabled || busy}
    onClick={() => input.current?.click()}
    title={value ? "更换封面（从本地选择图片，自动压缩后随书保存）" : "从本地选择封面图片"}
  >
    <AppIcon name="upload" size={14} />
    {busy ? "压缩中…" : value ? "更换封面" : emptyLabel}
  </button>;

  const hiddenInput = <input
    ref={input}
    className="wber-hidden"
    type="file"
    accept="image/*"
    aria-label="选择封面图片文件"
    onChange={(event) => { const file = event.target.files?.[0]; void pick(file); event.target.value = ""; }}
  />;

  if (variant === "overlay") return <>{trigger}{hiddenInput}</>;

  return <div className="wber-cover-picker">
    <span className="wber-cover-picker-preview" aria-hidden="true">
      {value ? <img src={value} alt="" /> : <span>无封面</span>}
    </span>
    <span className="wber-cover-picker-copy">
      <span className="wber-cover-picker-actions">
        {trigger}
        {value && <button type="button" className="is-sm is-ghost" disabled={disabled || busy}
          onClick={() => { onChange(""); setSummary(""); setError(""); }}>移除封面</button>}
      </span>
      <small>{error || summary || `从本地选择图片，自动压缩后内嵌进这本书，导出时一起带走（长边 ${COVER_MAX_EDGE}px 以内）。`}</small>
    </span>
    {hiddenInput}
  </div>;
}
