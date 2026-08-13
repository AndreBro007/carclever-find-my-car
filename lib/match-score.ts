/**
 * Match Score — 0.55 statedCriteriaFit + 0.30 resolvedCriteriaFit + 0.15 identityConfidence
 * (SYS-20260812-012, weights provisional).
 *
 * matchScoreBreakdown.penalizedByRelaxation formula is DELIBERATELY NOT
 * implemented here yet — deferred to real coding/testing data per
 * SYS-20260812-013. `penalizedByRelaxation` is present in the output shape
 * but always empty/zero for now. Do not guess a number without real data.
 */
import type { AutoDevListing } from "./auto-dev-client";
import type { ParsedIntent } from "./intent-parser";
import type { VerificationResult } from "./vin-cross-check";

// make/model fields can be comma-separated OR lists (Auto.dev's native comma
// syntax, e.g. "Suburban,Tahoe,Expedition" for a size-qualified search per
// the model-name-expansion pattern — see route.ts tool description). Exact
// string equality against the whole list would always fail; check membership.
function matchesAnyInList(value: string | undefined, list: string): boolean {
  if (!value) return false;
  const options = list.split(",").map((s) => s.trim().toLowerCase());
  return options.includes(value.trim().toLowerCase());
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
  if (v.hardConstraintStatus === "verified_match") return 1.0;
  if (v.hardConstraintStatus === "potential_match") return 0.6;
  return 0.0;
}

function statedCriteriaFit(listing: AutoDevListing, intent: ParsedIntent): number {
  // Simple, explainable v1: count how many stated hard constraints the
  // listing actually satisfies. Trim is intentionally excluded from this
  // hard-constraint count (ranking input only, handled below).
  const checks: boolean[] = [];
  const hc = intent.hardConstraints;
  const v = listing.vehicle;
  const rl = listing.retailListing;

  if (hc.priceMax != null) checks.push((rl?.price ?? Infinity) <= hc.priceMax);
  if (hc.priceMin != null) checks.push((rl?.price ?? 0) >= hc.priceMin);
  if (hc.yearMin != null) checks.push((v?.year ?? 0) >= hc.yearMin);
  if (hc.yearMax != null) checks.push((v?.year ?? Infinity) <= hc.yearMax);
  if (hc.mileageMax != null) checks.push((rl?.miles ?? Infinity) <= hc.mileageMax);
  if (hc.make) checks.push(matchesAnyInList(v?.make, hc.make));
  if (hc.model) checks.push(matchesAnyInList(v?.model, hc.model));

  let base = checks.length === 0 ? 1.0 : checks.filter(Boolean).length / checks.length;

  // Trim preference: bonus, never a gate. Non-matching/unknown trim doesn't
  // reduce base below what the hard constraints already earned — it simply
  // doesn't add the bonus (SYS-20260812-023/025).
  if (intent.semantic.trimPreference) {
    const trimMatches =
      (v?.trim ?? "").toLowerCase() === intent.semantic.trimPreference.toLowerCase();
    base = trimMatches ? Math.min(1, base + 0.05) : base;
  }

  return Math.max(0, Math.min(1, base));
}

function resolvedCriteriaFit(listing: AutoDevListing, intent: ParsedIntent): number {
  if (intent.semantic.goals.length === 0 && intent.semantic.seatsMin == null) {
    return 1.0; // no soft/semantic intent to resolve against — neutral
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
  return score;
}

export function computeMatchScore(
  listing: AutoDevListing,
  intent: ParsedIntent,
  verification: VerificationResult,
): MatchScoreResult {
  const stated = statedCriteriaFit(listing, intent);
  const resolved = resolvedCriteriaFit(listing, intent);
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
