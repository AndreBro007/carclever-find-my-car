import { resolveLinks } from "./link-resolution";
import type { VehicleListing } from "./listing-types";

const label = (make: unknown, model: unknown): string => [make, model].filter((x) => typeof x === "string" && x.trim()).join(" ");

/** Model-level Edmunds "similar vehicles" page (with our Impact tracking): used by default, new when asked. Null when it cannot be built. */
export function modelLevelLink(make: string, model: string, isNew: boolean): string | null {
  const l = resolveLinks({ vehicle: { make, model }, ...(isNew ? { retailListing: { used: false } } : {}) } as unknown as VehicleListing);
  return l.affiliateFallbackUrl;
}

/**
 * Dead end 1: the buyer sees the list and likes none of it. One closing line hands them to Edmunds, which asks for or confirms their
 * location. Built from the best match's make and model.
 */
export function closingExitLine(cards: any[]): string {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  const top = cards.find((c) => c?.identity?.make && c?.identity?.model);
  if (!top) return "";
  const url = modelLevelLink(String(top.identity.make), String(top.identity.model), top.condition?.inventoryType === "new");
  return url ? `\n\nNot seeing the right one? More ${label(top.identity.make, top.identity.model)} on Edmunds (all trims): ${url}` : "";
}

/** Dead end 2: no results for a named make and model. The same exit instead of nothing. "" when one make and one model are not named. */
export function zeroResultsExitLine(make: unknown, model: unknown, used: unknown, trim?: unknown): string {
  const mk = typeof make === "string" ? make.trim() : "", md = typeof model === "string" ? model.trim() : "";
  if (!mk || !md || md.includes(",") || mk.includes(",")) return "";
  const url = modelLevelLink(mk, md, used === false);
  const tr = typeof trim === "string" ? trim.trim() : "";
  return url ? `\n\nSee all ${used === false ? "new" : "used"} ${label(mk, md)} on Edmunds (all trims${tr ? `, not filtered to ${tr}` : ""}): ${url}` : "";
}

/** Highest match score first; among equal scores the nearest dealer first (unknown distance last). Returns a new array. */
export function sortByScoreThenDistance<T extends { ranking: { matchScore: number }; identity: { vin: string } }>(cards: T[], miles: Map<string, number>): T[] {
  const dist = (c: T): number => miles.get(c.identity.vin) ?? 1e9;
  return [...cards].sort((a, b) => b.ranking.matchScore - a.ranking.matchScore || dist(a) - dist(b));
}
