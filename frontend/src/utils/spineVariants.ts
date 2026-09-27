import { getBaseUrl } from "./baseUrl";

export type SpineVariants = Record<string, string>;

/** Registry is refreshed for each battle, so newly installed content is available immediately. */
export async function loadSpineVariants(): Promise<SpineVariants> {
  const response = await fetch(`${await getBaseUrl()}/api/assets/spine-variants`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`模型目录读取失败（${response.status}）`);
  const payload = await response.json();
  const variants: SpineVariants = Object.create(null);
  if (!payload.variants || typeof payload.variants !== "object" || Array.isArray(payload.variants)) return variants;
  for (const [name, value] of Object.entries(payload.variants)) {
    // Content paths may be nested; reject traversal and URL fragments before constructing asset URLs.
    if (name && typeof value === "string" && /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value)) variants[name] = value;
  }
  return variants;
}

export function hasSpineVariant(name: string, variants: SpineVariants): boolean {
  return Object.prototype.hasOwnProperty.call(variants, name);
}
