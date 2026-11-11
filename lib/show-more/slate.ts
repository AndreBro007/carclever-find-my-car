/**
 * R4-6 SHOW 8 MORE, step 2 (11 Nov 2026; André approved the build on the test branch; design: getcarwise-docs PHASE_C_P3B_EXPANDED_LISTING_CARDS_DESIGN_20261107.md sections 3 and 4).
 * The stored list ("slate") behind one search and the rules for growing it: pure logic, no database and no network here (the evaluator is passed in).
 *
 * Rules kept from the design: a slot number is bound to one VIN for good (slots only ever grow at the end, never reassigned, reordered or removed); the reserve is the next cars in the
 * order fixed at the first search; a car that cannot be checked right now is PENDING (kept in place, uses no number, one attempt per request, three attempts then final "could not check");
 * a car with verified evidence against the search is EXCLUDED with one fixed reason; the total is capped at 16.
 */
export const SLATE_CAP = 16;
export const SLATE_TTL_MS = 24 * 60 * 60 * 1000;
export const SLATE_MAX_ATTEMPTS = 3;

export type TriState = "confirmed" | "unconfirmed" | "na";
export type Stars = 0 | 1 | 2 | 3 | 4 | 5 | "none" | "unavailable";
export type ExcludeReason = "contradicted_filter" | "outside_radius" | "removed" | "limit_break";

/** A numbered car. Price is the whole-dollar price when first shown. */
export interface Slot { vin: string; price: number; drive: TriState; fuel: TriState; stars: Stars }
/** A car waiting after the shown ones, in the order fixed at the first search. */
export interface ReserveEntry { vin: string; drive: TriState; fuel: TriState; attempts: number; pending: boolean }
export interface Excluded { vin: string; reason: ExcludeReason }

export interface Slate {
  version: number;
  /** How many cars the first reply showed (0 to 8); "added" is always counted against this. */
  firstShown: number;
  slots: Slot[];
  reserve: ReserveEntry[];
  /** Cars that failed every attempt: final for this list, not excluded for cause, never shown, never retried. */
  couldNotCheck: string[];
  excluded: Excluded[];
  /** Best value searches only: each pool car's value line as first judged (fixed words and numbers), repeated under its number at expansion. */
  valueLines?: Record<string, string>;
  /** Distance from the search ZIP per car in whole miles as first judged (a search with a ZIP only), repeated on the card pill at expansion. */
  distances?: Record<string, number>;
}

/** What checking one reserve car came to. */
export type Outcome =
  | { kind: "pass"; slot: Slot }
  | { kind: "exclude"; reason: ExcludeReason }
  | { kind: "pending" };

export type Evaluate = (entry: ReserveEntry) => Promise<Outcome>;

export function newSlate(slots: Slot[], reserve: Array<Pick<ReserveEntry, "vin" | "drive" | "fuel">>, excluded: Excluded[] = []): Slate {
  const seen = new Set<string>();
  for (const s of slots) { if (seen.has(s.vin)) throw new Error(`duplicate VIN in slots: ${s.vin}`); seen.add(s.vin); }
  const cleanReserve = reserve.filter((r) => !seen.has(r.vin)).map((r) => ({ vin: r.vin, drive: r.drive, fuel: r.fuel, attempts: 0, pending: false }));
  const room = Math.max(0, SLATE_CAP - slots.length - excluded.length);
  return { version: 1, firstShown: slots.length, slots: [...slots], reserve: cleanReserve.slice(0, room), couldNotCheck: [], excluded: [...excluded] };
}

export function isExpired(expiresAtMs: number, nowMs: number): boolean { return nowMs >= expiresAtMs; }

/** The first N numbered cars of the list, exactly as committed (same numbers, same VINs): "show 8" after 16 returns the first 8. */
export function viewSlots(slate: Slate, total: number): Slot[] { return slate.slots.slice(0, Math.max(0, Math.min(total, SLATE_CAP, slate.slots.length))); }

export interface ExpandResult { slate: Slate; changed: boolean; addedNow: number }

/**
 * Grow the list towards `total` (at most 16). Reserve cars are checked in their reserve order, in parallel batches of the number still missing;
 * a pass is appended after the last slot (original reserve order inside the batch); an exclusion is recorded with its reason; a pending car stays where it is,
 * with one more attempt counted, and after the third attempt becomes "could not check" for good. Slots already numbered are never touched.
 */
export async function expandSlate(slate: Slate, total: number, evaluate: Evaluate): Promise<ExpandResult> {
  const target = Math.min(Math.max(total, 0), SLATE_CAP);
  let next: Slate = { ...slate, slots: [...slate.slots], reserve: [...slate.reserve], couldNotCheck: [...slate.couldNotCheck], excluded: [...slate.excluded] };
  let changed = false;
  let addedNow = 0;
  const triedThisRequest = new Set<string>(); // one attempt per car per request
  while (next.slots.length < target) {
    const need = target - next.slots.length;
    const batch = next.reserve.filter((r) => !triedThisRequest.has(r.vin)).slice(0, need);
    if (batch.length === 0) break;
    const outcomes = await Promise.all(batch.map((entry) => evaluate(entry).catch((): Outcome => ({ kind: "pending" }))));
    batch.forEach((entry, i) => {
      triedThisRequest.add(entry.vin);
      const out = outcomes[i];
      const idx = next.reserve.findIndex((r) => r.vin === entry.vin);
      if (idx < 0) return;
      changed = true;
      if (out.kind === "pass") {
        next.reserve.splice(idx, 1);
        if (!next.slots.some((s) => s.vin === out.slot.vin) && next.slots.length < SLATE_CAP) { next.slots.push(out.slot); addedNow += 1; }
      } else if (out.kind === "exclude") {
        next.reserve.splice(idx, 1);
        next.excluded.push({ vin: entry.vin, reason: out.reason });
      } else {
        const attempts = entry.attempts + 1;
        if (attempts >= SLATE_MAX_ATTEMPTS) { next.reserve.splice(idx, 1); next.couldNotCheck.push(entry.vin); }
        else next.reserve[idx] = { ...entry, attempts, pending: true };
      }
    });
  }
  if (changed) next.version = slate.version + 1;
  return { slate: changed ? next : slate, changed, addedNow };
}

export type ContinuationState = "more_available" | "pending_retry" | "only_could_not_check" | "none_left";
export interface SlateCounts {
  shown: number; added: number; leftOut: Record<ExcludeReason, number>; leftOutTotal: number;
  pending: number; couldNotCheck: number; reserveLeft: number; canAdd: number; state: ContinuationState;
}

/** Every number in the reply text comes from here (counts equal rows; no total is invented for a bounded list). */
export function slateCounts(slate: Slate, shownTotal: number = slate.slots.length): SlateCounts {
  const leftOut: Record<ExcludeReason, number> = { contradicted_filter: 0, outside_radius: 0, removed: 0, limit_break: 0 };
  for (const e of slate.excluded) leftOut[e.reason] += 1;
  const pending = slate.reserve.filter((r) => r.pending).length;
  const fresh = slate.reserve.length - pending;
  const shown = Math.min(shownTotal, slate.slots.length);
  const alreadyThere = slate.slots.length - shown; // cars already in the list but not asked for this time (another request grew it, or fewer were asked for)
  const canAdd = alreadyThere + Math.min(SLATE_CAP - slate.slots.length, slate.reserve.length);
  const state: ContinuationState = alreadyThere > 0 || fresh > 0 ? "more_available" : pending > 0 ? "pending_retry" : slate.couldNotCheck.length > 0 ? "only_could_not_check" : "none_left";
  return { shown, added: Math.max(0, shown - slate.firstShown), leftOut, leftOutTotal: slate.excluded.length, pending, couldNotCheck: slate.couldNotCheck.length, reserveLeft: slate.reserve.length, canAdd, state };
}
