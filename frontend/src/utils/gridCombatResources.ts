import type { CombatUnitDTO } from "../types";
import { hasSpineVariant, type SpineVariants } from "./spineVariants";

type ResourceUnit = Pick<CombatUnitDTO, "team" | "name" | "character_id" | "worldbook_id" | "avatar_url">;

/** Display names are resource keys only for enemies, and never without an owner. */
export function gridSpineActor(unit: ResourceUnit): { bookId: string; characterId: string } | null {
  const characterId = unit.team === "player" ? unit.character_id : unit.name;
  if (!unit.worldbook_id || !characterId || /[/\\]/.test(characterId) || characterId === "." || characterId === "..") return null;
  return { bookId: unit.worldbook_id, characterId };
}

/** Changes invalidate in-flight loads even when the combat unit_id is reused. */
export function gridUnitResourceKey(unit: ResourceUnit): string {
  return JSON.stringify([unit.team, unit.worldbook_id, unit.character_id,
    unit.team === "enemy" ? unit.name : "", unit.avatar_url]);
}

export interface GridSpineResource {
  bookId: string;
  characterId: string;
  variant: string;
  dir: "Front" | "Back";
  fileName: string;
  cacheKey: string;
}

export function gridSpineResource(unit: ResourceUnit, registries: ReadonlyMap<string, SpineVariants>): GridSpineResource | null {
  const actor = gridSpineActor(unit);
  if (!actor) return null;
  const variants = registries.get(actor.bookId);
  if (!variants || !hasSpineVariant(actor.characterId, variants)) return null;
  const variant = variants[actor.characterId];
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(variant)) return null;
  const dir = unit.team === "player" ? "Front" : "Back";
  return { ...actor, variant, dir, fileName: variant.split("/").pop()!,
    cacheKey: JSON.stringify([actor.bookId, actor.characterId, variant, dir]) };
}

/** Append the filename first; the owner query belongs on every final asset URL. */
export function gridSpineFileUrl(resource: GridSpineResource, file: string): string {
  const parts = file.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || /[\\?#]/.test(file)) {
    throw new Error(`无效的模型文件路径：${file}`);
  }
  return `/api/assets/characters/${encodeURIComponent(resource.characterId)}/spine/${resource.variant}/${resource.dir}/${parts.map(encodeURIComponent).join("/")}?worldbook_id=${encodeURIComponent(resource.bookId)}`;
}

export interface GridResourceRequest { unitId: string; resourceKey: string }

/** Object tokens prevent an old A -> B -> A completion from clearing the new A. */
export function createGridResourceLoadGuard() {
  const requests = new Map<string, GridResourceRequest>();
  return {
    get: (unitId: string) => requests.get(unitId),
    begin(unitId: string, resourceKey: string): GridResourceRequest {
      const request = { unitId, resourceKey };
      requests.set(unitId, request);
      return request;
    },
    isCurrent: (request: GridResourceRequest) => requests.get(request.unitId) === request,
    finish(request: GridResourceRequest) {
      if (requests.get(request.unitId) === request) requests.delete(request.unitId);
    },
    cancel: (unitId: string) => requests.delete(unitId),
    clear: () => requests.clear(),
    entries: () => requests.entries(),
  };
}
