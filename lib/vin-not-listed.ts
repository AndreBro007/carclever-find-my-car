import { decodeNhtsaElectrification } from "./nhtsa-client";
import { resolveLinks } from "./link-resolution";
import type { AutoDevListing } from "./auto-dev-client";

const ACRONYM_MAKES = new Set(["BMW", "GMC", "MG", "AMG"]);
/** NHTSA writes makes in capitals: "TOYOTA" -> "Toyota", "LAND ROVER" -> "Land Rover", "MERCEDES-BENZ" -> "Mercedes-Benz"; acronyms stay ("BMW", "GMC"). */
export function titleCaseMake(s: string): string {
  return s.trim().split(/(\s+)/).map((w) => (ACRONYM_MAKES.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()))).join("");
}
const cap = titleCaseMake;

export interface NotListedDeps { decode?: typeof decodeNhtsaElectrification; resolve?: typeof resolveLinks; currentYear?: number }

/**
 * A VIN that is not in our listings is a dead end for the buyer (and for us). Decode it with NHTSA (free) to learn year, make and
 * model, then return the same Edmunds affiliate "similar vehicles" link the rest of the app uses (the "View similar" destination).
 * Nothing is substituted: the first sentence of the reply still says the VIN is not listed. Returns "" when the VIN cannot be
 * decoded or no similar-vehicles link can be built.
 */
export async function notListedLinksText(vin: string, deps: NotListedDeps = {}): Promise<string> {
  const decode = deps.decode ?? decodeNhtsaElectrification;
  const resolve = deps.resolve ?? resolveLinks;
  const r = await decode(vin, null, null, null);
  if (!r || !r.make || !r.model || !r.modelYear) return "";
  const year = Number(r.modelYear);
  if (!Number.isFinite(year)) return "";
  const make = cap(r.make), model = r.model;
  const trim = r.trimOptions.length === 1 ? r.trimOptions[0] : undefined; // only when NHTSA names exactly one trim
  const nowYear = deps.currentYear ?? new Date().getFullYear();
  const isNew = year >= nowYear; // current or next model year: treat as a new car (category link, no exact-VIN attempt)
  const listing = { vin, vehicle: { make, model, year, ...(trim ? { trim } : {}) }, ...(isNew ? { retailListing: { used: false } } : {}) } as unknown as AutoDevListing;
  const links = resolve(listing);
  const label = `${year} ${make} ${model}${trim ? " " + trim : ""}`;
  const lines: string[] = [];
  // Only the similar-vehicles link: an exact-VIN or availability link would imply the car exists, and for a VIN we do not list it often leads nowhere.
  if (links.affiliateFallbackUrl) lines.push(`Similar ${label} for sale on Edmunds: ${links.affiliateFallbackUrl}`);
  if (lines.length === 0) return "";
  return `\n\nThis VIN decodes to a ${label}.\n${lines.join("\n")}`;
}
