/**
 * Qualifier accounting — closes two real gaps found in the Aug 15 baseline
 * (SYS-20260815-001/002/003/006):
 *
 * 1. The text summary the host model reads only ever states WARNINGS
 *    (a reported accident, a data anomaly) — a clean, fully-matching result
 *    gets no positive confirmation at all. A user who explicitly asked for
 *    blue/CPO/no-accidents/V8 has no way to tell from the text whether that
 *    was actually honored, without a follow-up question.
 * 2. A genuine cross-field data conflict (e.g. `series` text disagreeing
 *    with `cylinders`, found live on a real F-150 VIN) looked identical to
 *    the host model's own suitability commentary — both surfaced, if at
 *    all, as vague prose. These need to be structurally distinct: one is a
 *    fact about the data, the other is an opinion about the vehicle.
 *
 * Design principle (André, Aug 15, verbatim intent): cards stay lean by
 * default — critical fields only. Any field that was part of the user's
 * *stated* search intent gets dynamically promoted into the visible
 * confirmation, not a fixed checklist and never a wall of caveats. Nothing
 * is added for a field the user never asked about.
 */
import type { AutoDevListing } from "./auto-dev-client";

export interface CardIntentInput {
  exteriorColor?: string;
  interiorColor?: string;
  drivetrain?: string;
  transmission?: string;
  cylinders?: number;
  doors?: number;
  vehicleType?: string;
  used?: boolean;
  cpo?: boolean;
  noAccidents?: boolean;
  oneOwner?: boolean;
  seatsMinPreference?: number;
  /**
   * Set only when the body-style filter (bodyType or vehicleType) had to be
   * dropped entirely to find any results (SYS-20260816-046/050) — the value
   * the user originally asked for, kept here so each result can be checked
   * against it even though it's no longer an active filter. Real reason this
   * exists: dropping the filter can surface a genuinely different body style
   * for a nameplate that spans several (e.g. Convertible results for a
   * Mercedes E-Class Sedan request) — this must never look like a plain
   * confirmed match when it isn't one.
   */
  droppedBodyStyleFilter?: string | null;
  /**
   * Set when the user explicitly asked for a named trim/variant
   * (trimRequired, SYS-20260823) — a hard eligibility requirement, unlike
   * trimPreference. By the time buildIntentConfirmations runs, route.ts has
   * already excluded any candidate whose trim doesn't confirm this, so this
   * only needs a positive confirmation line, never a "NOT the requested X"
   * branch the way droppedBodyStyleFilter needs one.
   */
  trimRequired?: string;
}

export interface CardForConfirmation {
  identity: { trim: string | null };
  detail: { interiorColor: string | null; exteriorColor: string | null; cylinders: number | null; cpoNote: string; ownerHistoryNote: string | null; seatsNote: string };
  powertrain: { drivetrain: string | null; transmission: string | null };
  body: { doors: number | null; vehicleType: string | null; bodyStyle: string | null };
  condition: { used: boolean | null };
  history: { note: string };
}

/**
 * Builds the short, per-result confirmation line — only for fields the user
 * actually specified in this search. Reports the real value on the card,
 * not the requested value, so this reflects the truth about this specific
 * vehicle, not an assumption that the filter worked.
 */
export function buildIntentConfirmations(input: CardIntentInput, card: CardForConfirmation): string[] {
  const confirmations: string[] = [];

  if (input.exteriorColor && card.detail.exteriorColor) {
    confirmations.push(`${card.detail.exteriorColor} exterior`);
  }
  if (input.interiorColor && card.detail.interiorColor) {
    confirmations.push(`${card.detail.interiorColor} interior`);
  }
  if (input.drivetrain && card.powertrain.drivetrain) {
    confirmations.push(card.powertrain.drivetrain);
  }
  if (input.transmission && card.powertrain.transmission) {
    confirmations.push(card.powertrain.transmission);
  }
  if (input.cylinders != null && card.detail.cylinders != null) {
    confirmations.push(`${card.detail.cylinders}-cylinder`);
  }
  if (input.doors != null && card.body.doors != null) {
    confirmations.push(`${card.body.doors}-door`);
  }
  // trimRequired confirmation: by construction, only trim-confirmed
  // candidates reach this point when trimRequired is set (route.ts
  // excludes anything else at both stage 1 and stage 2), so this is a
  // plain positive confirmation — no "NOT the requested X" branch needed.
  if (input.trimRequired && card.identity.trim) {
    confirmations.push(card.identity.trim);
  }
  // Body-style confirmation when the filter had to be dropped
  // (droppedBodyStyleFilter set). The "else if (actual)" branch below IS
  // reachable in normal operation (SYS-20260816-057): route.ts hard-excludes
  // a confirmed mismatch at both stage 1 and stage 2, but ONLY when doing so
  // still leaves at least one real candidate — if excluding would reduce a
  // genuine candidate pool to nothing (Auto.dev's own tag can be wrong for a
  // genuinely correct vehicle, not just a genuinely different one — a real
  // Volvo V90 wagon is tagged "Crossover" there), the mismatch is shown
  // rather than hidden, and this branch is exactly what discloses that
  // honestly instead of it looking like an unqualified "Confirmed: X" line.
  if (input.droppedBodyStyleFilter) {
    const target = input.droppedBodyStyleFilter.toLowerCase();
    const actual = card.body.bodyStyle ?? card.body.vehicleType;
    const matches =
      card.body.bodyStyle?.toLowerCase() === target || card.body.vehicleType?.toLowerCase() === target;
    if (matches) {
      confirmations.push(actual as string);
    } else if (actual) {
      confirmations.push(
        `${actual} — NOT the requested ${input.droppedBodyStyleFilter}; shown because a body-style filter had to be dropped to find any real matches for this model`,
      );
    }
  } else if (input.vehicleType && card.body.vehicleType) {
    confirmations.push(card.body.vehicleType);
  }
  if (input.used != null && card.condition.used != null) {
    confirmations.push(card.condition.used ? "used" : "new");
  }
  if (input.cpo === true) {
    confirmations.push(card.detail.cpoNote);
  }
  if (input.noAccidents === true || input.oneOwner === true) {
    // Always surface the real history note when the user asked about either
    // — this is the fix for "no accidents"/"one owner" only appearing in
    // text when there's a WARNING, never as a positive confirmation.
    confirmations.push(card.history.note);
  }
  if (input.seatsMinPreference != null) {
    // Seats is never a hard filter (Trust Class C, same as CPO/history) —
    // always disclose, whether it meets the preference, falls short, or is
    // unreported, never exclude on it.
    confirmations.push(card.detail.seatsNote);
  }

  return confirmations;
}

/**
 * Genuine, structural data-conflict detection — mechanical only, same
 * discipline as post-verify.ts (no semantic judgment, just cross-field
 * agreement). Real case found live (Aug 15): a listing's `series` field said
 * "6cyl" while its own `cylinders` field said 8, on the same VIN. Kept
 * deliberately separate from any suitability commentary — this reports a
 * fact about the data, not an opinion about the vehicle.
 */
export function detectDataConflicts(listing: AutoDevListing): string[] {
  const conflicts: string[] = [];
  const series = listing.vehicle?.series;
  const cylinders = listing.vehicle?.cylinders;

  if (series && cylinders != null) {
    const match = String(series).match(/(\d+)\s*cyl/i);
    if (match) {
      const seriesCylinders = Number(match[1]);
      if (seriesCylinders !== cylinders) {
        conflicts.push(
          `This listing's data disagrees with itself on cylinder count (${cylinders} vs. ${seriesCylinders} reported elsewhere) — verify directly before trusting either number.`,
        );
      }
    }
  }

  return conflicts;
}

/**
 * The structured, top-level qualifierAccounting array — one entry per
 * constraint the user actually stated, reporting how it was handled.
 * Deliberately scoped to what Find My Car itself controls: it cannot
 * account for the calling LLM's own model-list resolution (that stays
 * outside this tool's visibility, by design), only for the structured
 * fields this tool directly filters or discloses on.
 */
export interface QualifierAccountingEntry {
  requested: string;
  tier: "structural_filter" | "disclosed_not_filtered";
  applied: string;
}

export function buildQualifierAccounting(input: CardIntentInput): QualifierAccountingEntry[] {
  const entries: QualifierAccountingEntry[] = [];

  const structural: Array<[keyof CardIntentInput, string]> = [
    ["exteriorColor", "exterior color"],
    ["interiorColor", "interior color"],
    ["drivetrain", "drivetrain"],
    ["transmission", "transmission"],
    ["cylinders", "cylinder count"],
    ["doors", "door count"],
    ["vehicleType", "vehicle type"],
    ["used", "new/used"],
    ["trimRequired", "trim/variant"],
  ];
  for (const [key, label] of structural) {
    const value = input[key];
    if (value != null && value !== "") {
      entries.push({ requested: label, tier: "structural_filter", applied: `filtered on ${label} = ${value}` });
    }
  }

  if (input.cpo === true) {
    entries.push({
      requested: "certified pre-owned",
      tier: "disclosed_not_filtered",
      applied: "never used to exclude results — disclosed per result instead (CPO status can't be disproven by the data, only confirmed when present)",
    });
  }
  if (input.noAccidents === true) {
    entries.push({
      requested: "no accidents",
      tier: "disclosed_not_filtered",
      applied: "never used to exclude results — disclosed per result instead (history is unreported for roughly half of listings)",
    });
  }
  if (input.oneOwner === true) {
    entries.push({
      requested: "one owner",
      tier: "disclosed_not_filtered",
      applied: "never used to exclude results — disclosed per result instead",
    });
  }
  if (input.seatsMinPreference != null) {
    entries.push({
      requested: `${input.seatsMinPreference}+ seats`,
      tier: "disclosed_not_filtered",
      applied: "never used to exclude results — seating capacity is a real response field but not a documented Auto.dev filter, so it's disclosed per result instead",
    });
  }

  return entries;
}
