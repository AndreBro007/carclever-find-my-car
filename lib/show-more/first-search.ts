/**
 * R4-6 step 3b (11 Nov 2026): turning the first search's result into the stored list (design sections 3 and 8), plus the texts. Pure; the route passes plain data in.
 * On wherever the code is deployed (the preview-only switch was removed on André's yes, 11 Nov 2026: the release is the merge, there is no setting to forget).
 */
import { newSlate, type Excluded, type Slate, type Slot, type Stars, type TriState } from "./slate";

export const HINT_MARKER = "[more]";

export function starsOf(rating: unknown): Stars { return typeof rating === "number" && rating >= 0 && rating <= 5 ? (Math.round(rating) as 0 | 1 | 2 | 3 | 4 | 5) : "none"; }
export function triState(required: boolean, confirmed: boolean): TriState { return !required ? "na" : confirmed ? "confirmed" : "unconfirmed"; }

export interface ShownCard { vin: string; price: number | null; rating?: number }
export interface FirstSearchData {
  shown: ShownCard[];
  /** The cars after the shown ones, in the order fixed at the first search (stage-1 verified). */
  reserveVins: string[];
  /** Cars the detail stage rejected at the first search. */
  excludedVins: string[];
  driveRequired: boolean; driveConfirmed: Set<string>;
  fuelRequired: boolean; fuelMatched: Set<string> | null;
  /** Best value only: VIN to the car's value line text. */
  valueLines?: Map<string, string>;
  /** VIN to whole miles from the search ZIP. */
  distances?: Map<string, number>;
}

const norm = (v: string) => String(v ?? "").trim().toUpperCase();

/** Null when there is nothing to expand (no priced shown car, or an empty reserve): then no row is written and no hint is sent. */
export function buildFirstSearchSlate(d: FirstSearchData): Slate | null {
  const slots: Slot[] = [];
  const shownVins = new Set<string>();
  for (const c of d.shown) {
    const vin = norm(c.vin);
    if (!vin || shownVins.has(vin) || typeof c.price !== "number" || !Number.isFinite(c.price)) return null; // a card we cannot freeze exactly: no list
    shownVins.add(vin);
    slots.push({ vin, price: Math.round(c.price), drive: triState(d.driveRequired, d.driveConfirmed.has(vin)), fuel: triState(d.fuelRequired, d.fuelMatched != null && d.fuelMatched.has(vin)), stars: starsOf(c.rating) });
  }
  if (slots.length === 0) return null;
  const excludedSet = new Set(d.excludedVins.map(norm));
  const excluded: Excluded[] = [...excludedSet].filter((v) => v && !shownVins.has(v)).map((vin) => ({ vin, reason: "contradicted_filter" as const }));
  const reserve = [...new Set(d.reserveVins.map(norm))].filter((v) => v && !shownVins.has(v) && !excludedSet.has(v))
    .map((vin) => ({ vin, drive: triState(d.driveRequired, d.driveConfirmed.has(vin)), fuel: triState(d.fuelRequired, d.fuelMatched != null && d.fuelMatched.has(vin)) }));
  if (reserve.length === 0) return null;
  const slate = newSlate(slots, reserve, excluded);
  if (d.valueLines && d.valueLines.size > 0) {
    const keep = new Set([...slate.slots.map((x) => x.vin), ...slate.reserve.map((x) => x.vin)]);
    const lines: Record<string, string> = {};
    for (const [vin, line] of d.valueLines) { const v = norm(vin); if (keep.has(v) && VALUE_LINE_OK.test(line)) lines[v] = line; }
    if (Object.keys(lines).length) slate.valueLines = lines;
  }
  if (d.distances && d.distances.size > 0) {
    const keep = new Set([...slate.slots.map((x) => x.vin), ...slate.reserve.map((x) => x.vin)]);
    const out: Record<string, number> = {};
    for (const [vin, mi] of d.distances) { const v = norm(vin); if (keep.has(v) && Number.isFinite(mi) && mi >= 0 && mi <= 3000) out[v] = Math.round(mi); }
    if (Object.keys(out).length) slate.distances = out;
  }
  return slate;
}
/** Only text our own value function can produce: starts with "Value: ", one line, bounded. */
export const VALUE_LINE_OK = /^Value: [^\n]{1,260}$/;

export function hintNote(ref: string): string {
  return `${HINT_MARKER} More cars are available for this search. Reference ${ref}. To see more, ask for more and call show_more_vehicles with this reference and the total number of cars wanted (up to 16).`;
}
export function moreText(ref: string): string {
  return `\n\nMore cars from this same search: reference ${ref} (valid for 24 hours). To see more, call show_more_vehicles with this reference and the total number of cars to show (up to 16); the cars above keep their numbers.`;
}
