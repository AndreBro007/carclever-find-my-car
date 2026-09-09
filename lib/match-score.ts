/**
 * Match Score — 0.55 statedCriteriaFit + 0.30 resolvedCriteriaFit + 0.15 identityConfidence
 * (SYS-20260812-012, weights provisional — UNCHANGED by SYS-20260907-V2.4 below).
 *
 * matchScoreBreakdown.penalizedByRelaxation formula is DELIBERATELY NOT
 * implemented here yet — deferred to real coding/testing data per
 * SYS-20260812-013. `penalizedByRelaxation` is present in the output shape
 * but always empty/zero for now. Do not guess a number without real data.
 *
 * SYS-20260907-V2.4 (André-approved, contained): two additions, both
 * strictly bounded, neither touches the 0.55/0.30/0.15 weights, the
 * Strong/Good/Partial labels, or penalizedByRelaxation's deferral above.
 *   1. statedCriteriaFit's price checks were purely binary (in/out of
 *      range), so any two candidates both satisfying priceMax/priceMin
 *      scored identically regardless of how close to the ceiling/floor
 *      they actually were — the root cause of the "identical matchScore
 *      on structurally different vehicles" observation. Now graded/
 *      continuous within the same [0,1] contribution the boolean used to
 *      occupy, so differentiation happens without changing what "in
 *      budget" means or the overall score's scale.
 *   2. A modest, secondary Used-value tie-break in resolvedCriteriaFit —
 *      NOT a hard filter, NOT a blanket Used bias, NOT a penalty against
 *      New. Gated strictly on the caller's own explicit intent
 *      (CardIntentInput.used): only applies when the user did not
 *      explicitly request New-only (used === false), so explicit
 *      New-only intent is structurally unaffected (query-level filtering
 *      already returns New-only results in that case — there are no Used
 *      candidates left for this to influence). Explicit Used/CPO intent
 *      is unaffected in meaning (already query-filtered), just receives
 *      the same modest nudge uniformly, which doesn't change relative
 *      ordering incorrectness. Deliberately simple (a flat modest bonus,
 *      with a small extra allowance for a low-mileage/"nearly-new" Used
 *      vehicle) rather than a real trim-vs-New value comparison, which
 *      is out of scope for a bounded fix — matches this file's existing
 *      "intentionally simple, real formula deferred" pattern.
 */
import type { AutoDevListing } from "./auto-dev-client";
import type { ParsedIntent } from "./intent-parser";
import type { VerificationResult } from "./vin-cross-check";
import type { CardIntentInput } from "./qualifier-accounting";
import { modelSatisfiesRequested } from "./model-match";

// Continuous price-proximity credit, replacing a bare boolean in/out-of-range
// check. Keeps the same [0,1] contribution slot statedCriteriaFit's checks[]
// array already used — 0.85 floor for any candidate that satisfies the
// constraint at all (so the overall score distribution doesn't shift
// dramatically from the old binary-1.0 baseline), plus up to 0.15 of
// graded bonus for being further from the ceiling/floor than merely
// scraping by. A violated constraint still scores 0, same as before.
function priceCeilingScore(price: number | null | undefined, priceMax: number): number {
  const p = price ?? Infinity;
  if (p > priceMax) return 0;
  if (priceMax <= 0) return 0.85; // guard against divide-by-zero on a degenerate ceiling
  const headroom = 1 - p / priceMax; // 0 at the ceiling, ->1 as price->0
  return 0.85 + 0.15 * Math.max(0, Math.min(1, headroom));
}

function priceFloorScore(price: number | null | undefined, priceMin: number): number {
  const p = price ?? 0;
  if (p < priceMin) return 0;
  if (priceMin <= 0) return 0.85; // no meaningful "distance above zero" to grade
  // Grade distance above the floor relative to the floor itself, capped so
  // an extreme outlier price doesn't run away with the bonus.
  const aboveFloor = (p - priceMin) / priceMin;
  return 0.85 + 0.15 * Math.max(0, Math.min(1, aboveFloor));
}

// make fields can be comma-separated OR lists (Auto.dev's native comma
// syntax, e.g. "Suburban,Tahoe,Expedition" for a size-qualified search per
// the model-name-expansion pattern — see route.ts tool description). Exact
// string equality against the whole list would always fail; check membership.
// Model matching uses the directional modelSatisfiesRequested() below
// instead (SYS-20260824) — make matching stays symmetric/prefix-tolerant
// here, unchanged.
//
// Uses String() rather than relying on the TS type (`string | undefined`)
// matching runtime reality — real bug found 2026-08-14 (diversity.ts): the
// API can return unexpected types Auto.dev's own docs don't fully guarantee
// against, and TS types don't protect against that at runtime.
function matchesAnyInList(value: unknown, list: string): boolean {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  const options = list.split(",").map((s) => s.trim().toLowerCase());
  return options.some((opt) => v === opt || v.startsWith(opt) || opt.startsWith(v));
}

export interface MatchScoreBreakdown {
  statedCriteriaFit: number; // 0-1
  resolvedCriteriaFit: number; // 0-1
  identityConfidence: number; // 0-1
  penalizedByRelaxation: string[]; // always [] until the formula is designed
}

export interface MatchScoreResult {
  matchScore: number; // 0-100
  matchScoreLabel: string;
  breakdown: MatchScoreBreakdown;
}

function identityConfidenceFrom(v: VerificationResult): number {
  if (v.identityVerificationStatus === "verified_match") return 1.0;
  if (v.identityVerificationStatus === "potential_match") return 0.6;
  return 0.0;
}

function statedCriteriaFit(listing: AutoDevListing, intent: ParsedIntent): number {
  // Simple, explainable v1: count how many stated hard constraints the
  // listing actually satisfies. Trim is intentionally excluded from this
  // hard-constraint count (ranking input only, handled below).
  //
  // Price checks are graded (0/0.85-1.0), not boolean, per SYS-20260907-V2.4
  // above — everything else (year/mileage/make/model) stays a plain 0/1
  // boolean, unchanged, matching the specific, bounded scope of that fix.
  const checks: number[] = [];
  const hc = intent.hardConstraints;
  const v = listing.vehicle;
  const rl = listing.retailListing;

  if (hc.priceMax != null) checks.push(priceCeilingScore(rl?.price, hc.priceMax));
  if (hc.priceMin != null) checks.push(priceFloorScore(rl?.price, hc.priceMin));
  if (hc.yearMin != null) checks.push((v?.year ?? 0) >= hc.yearMin ? 1 : 0);
  if (hc.yearMax != null) checks.push((v?.year ?? Infinity) <= hc.yearMax ? 1 : 0);
  if (hc.mileageMax != null) checks.push((rl?.miles ?? Infinity) <= hc.mileageMax ? 1 : 0);
  if (hc.make) checks.push(matchesAnyInList(v?.make, hc.make) ? 1 : 0);
  if (hc.model) checks.push(modelSatisfiesRequested(hc.model, v?.model) ? 1 : 0);

  let base = checks.length === 0 ? 1.0 : checks.reduce((sum, c) => sum + c, 0) / checks.length;

  // Trim preference: bonus, never a gate. Non-matching/unknown trim doesn't
  // reduce base below what the hard constraints already earned — it simply
  // doesn't add the bonus (SYS-20260812-023/025).
  if (intent.semantic.trimPreference) {
    const trimMatches =
      String(v?.trim ?? "").toLowerCase() === String(intent.semantic.trimPreference ?? "").toLowerCase();
    base = trimMatches ? Math.min(1, base + 0.05) : base;
  }

  return Math.max(0, Math.min(1, base));
}

// Modest Used-value tie-break (SYS-20260907-V2.4). Secondary influence
// only — never a hard filter, never a blanket Used bias, never a penalty
// against New. Strictly gated: only applies when the caller did NOT
// explicitly request New-only (intentInput.used === false means explicit
// New-only, and query-level filtering already guarantees no Used
// candidates exist in that case anyway — this function being a no-op then
// is belt-and-suspenders, not the primary guarantee). Only rewards a
// candidate actually reported Used; unreported/unknown gets nothing,
// same fail-safe posture as the rest of this file.
const USED_VALUE_BONUS = 0.04;
const NEARLY_NEW_USED_BONUS = 0.02; // additional, only for clearly low-mileage Used
const NEARLY_NEW_MILEAGE_THRESHOLD = 15_000;

function usedValueTieBreak(listing: AutoDevListing, intentInput: CardIntentInput): number {
  if (intentInput.used === false) return 0; // explicit New-only — no influence at all
  const isReportedUsed = listing.retailListing?.used === true;
  if (!isReportedUsed) return 0;
  const miles = listing.retailListing?.miles;
  const nearlyNew = typeof miles === "number" && miles <= NEARLY_NEW_MILEAGE_THRESHOLD;
  return USED_VALUE_BONUS + (nearlyNew ? NEARLY_NEW_USED_BONUS : 0);
}

function resolvedCriteriaFit(
  listing: AutoDevListing,
  intent: ParsedIntent,
  intentInput: CardIntentInput,
): number {
  if (intent.semantic.vehicleNeeds.length === 0 && intent.semantic.seatsMin == null) {
    // No soft/semantic intent to resolve against. Previously a flat 1.0 —
    // now 0.96, deliberately leaving just enough headroom (0.04-0.06) for
    // the Used-value tie-break below to actually differentiate mixed
    // New/Used results in this exact case (a plain high-budget search
    // with no stated needs is precisely the scenario ChatGPT flagged: a
    // hard 1.0 ceiling would make the tie-break a permanent no-op here).
    // A New candidate that doesn't qualify for the tie-break still gets
    // 0.96 — a ~1-point matchScore difference from the old 1.0 baseline,
    // uniform and small, not a penalty targeted at New specifically.
    const neutralBase = 0.96;
    return Math.min(1, neutralBase + usedValueTieBreak(listing, intentInput));
  }
  // v1: presence of a goal-relevant signal nudges the score; this is
  // intentionally simple and honest about being a weak signal, consistent
  // with the "inferred, not stated" framing (SYS-20260812-002 §5).
  let score = 0.7; // baseline for "has semantic intent, mostly unverifiable on Starter tier"
  if (intent.semantic.seatsMin != null) {
    // We don't have seat count reliably on Starter tier (SYS-20260812-025) —
    // can't verify, so this stays neutral rather than rewarding or penalizing.
    score = 0.6;
  }
  return Math.min(1, score + usedValueTieBreak(listing, intentInput));
}

export function computeMatchScore(
  listing: AutoDevListing,
  intent: ParsedIntent,
  verification: VerificationResult,
  intentInput: CardIntentInput,
): MatchScoreResult {
  const stated = statedCriteriaFit(listing, intent);
  const resolved = resolvedCriteriaFit(listing, intent, intentInput);
  const identity = identityConfidenceFrom(verification);

  const raw = 0.55 * stated + 0.3 * resolved + 0.15 * identity;
  const matchScore = Math.round(raw * 100);

  const matchScoreLabel =
    matchScore >= 85 ? "Strong match" : matchScore >= 65 ? "Good match" : "Partial match";

  return {
    matchScore,
    matchScoreLabel,
    breakdown: {
      statedCriteriaFit: stated,
      resolvedCriteriaFit: resolved,
      identityConfidence: identity,
      penalizedByRelaxation: [], // TODO: design formula once real coding/testing data exists
    },
  };
}
