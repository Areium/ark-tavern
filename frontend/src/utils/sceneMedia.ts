import type { PlotGraphNodeDTO, SceneMediaConfigDTO, SceneVisualDTO } from "../types";

/** Only book-owned image paths are persisted; serving URLs are presentation details. */
export function sceneAssetPath(url: string, bookId: string, assetPath: string): string | null {
  try {
    if (!url.startsWith("/api/assets/")) return null;
    const parsed = new URL(url, "http://scene.local");
    if (parsed.origin !== "http://scene.local" || parsed.hash) return null;
    if (parsed.searchParams.getAll("worldbook_id").length !== 1 || parsed.searchParams.get("worldbook_id") !== bookId) return null;
    const prefix = "/api/assets/";
    if (!parsed.pathname.startsWith(prefix)) return null;
    // API categories may be aliases, e.g. combat_backgrounds -> combat/backgrounds.
    // Only the explicit server-provided book-relative path is authoritative.
    return validSceneAsset(assetPath) ? assetPath : null;
  } catch { return null; }
}

export function validSceneAsset(asset: string): boolean {
  return !!asset && asset.length <= 1024 && !/[\\\\?#:%\u0000-\u001f]/.test(asset)
    && /^[a-z][a-z_]*\//.test(asset)
    && asset.split("/").every(part => !!part && part !== "." && part !== "..")
    && /\.(png|jpe?g|webp|gif|bmp)$/i.test(asset);
}

export function sceneAssetUrl(asset: string, bookId: string): string {
  if (!validSceneAsset(asset)) return "";
  return `/api/worldbooks/${encodeURIComponent(bookId)}/presentation-image?asset=${encodeURIComponent(asset)}`;
}

export function newSceneVisual(role: SceneVisualDTO["role"] = "background"): SceneVisualDTO {
  return { kind: "image", asset: "", role, fit: role === "cg" ? "contain" : "cover", position: [50, 50], portraits: role === "cg" ? "hide" : "show" };
}

export function sceneMediaErrors(media?: SceneMediaConfigDTO): string[] {
  if (!media) return [];
  const errors: string[] = [];
  if (media.background && !validSceneAsset(media.background.asset)) errors.push("进入节点画面尚未选择本书图片。");
  for (const [index, event] of (media.events || []).entries()) {
    const title = event.title?.trim() || `事件 ${index + 1}`;
    if (event.trigger.kind === "choice" && !event.trigger.choice_key) errors.push(`${title}：请选择作者分支。`);
    if (event.trigger.kind === "condition" && !event.conditions?.length) errors.push(`${title}：至少添加一个条件。`);
    if (!event.actions.length || event.actions.some(action => !validSceneAsset(action.visual.asset))) errors.push(`${title}：请选择本书图片。`);
    if ((event.conditions || []).some(condition => condition.kind === "stat"
      ? !condition.actor || !condition.key || (typeof condition.value === "number" && !Number.isFinite(condition.value))
      : !condition.item_id)) errors.push(`${title}：请补全触发条件。`);
  }
  return errors;
}

export function graphSceneMediaError(nodes: PlotGraphNodeDTO[]): string | null {
  for (const node of nodes) {
    const errors = sceneMediaErrors(node.scene_media);
    if (errors.length) return `「${node.title || node.id}」${errors[0]}`;
  }
  return null;
}

export function sceneMediaBadge(media?: SceneMediaConfigDTO): string {
  if (!media) return "";
  const labels = [];
  if (media.background) labels.push(media.background.role === "cg" ? "CG" : "背景");
  if (media.events?.length) labels.push(`${media.events.length} 演出`);
  return labels.join(" · ");
}
