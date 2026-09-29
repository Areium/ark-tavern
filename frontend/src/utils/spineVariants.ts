import { getBaseUrl } from "./baseUrl";

export type SpineVariants = Record<string, string>;

/** Registry is refreshed for each battle, so newly installed content is available immediately. */
export async function loadSpineVariants(bookId?: string): Promise<SpineVariants> {
  // Undefined preserves sideview's existing unscoped request; an explicit empty
  // owner must never accidentally broaden into a cross-book lookup.
  const query = bookId === undefined ? "" : `?worldbook_id=${encodeURIComponent(bookId)}`;
  const response = await fetch(`${await getBaseUrl()}/api/assets/spine-variants${query}`, { signal: AbortSignal.timeout(5000) });
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

/** One cache per grid scene: coalesce concurrent reads by owner, refresh next battle. */
export function createSpineVariantCache(): (bookId: string) => Promise<SpineVariants> {
  const requests = new Map<string, Promise<SpineVariants>>();
  return (bookId) => {
    if (!bookId) return Promise.resolve(Object.create(null) as SpineVariants);
    let request = requests.get(bookId);
    if (!request) {
      request = loadSpineVariants(bookId);
      requests.set(bookId, request);
    }
    return request;
  };
}
