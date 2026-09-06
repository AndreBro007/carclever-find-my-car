/**
 * Shared PURCHASE-RISK-TIER classification (feature/lower-risk-mvp,
 * SYS-20260827 buyer-risk-vs-data-quality fix) — used by BOTH the
 * ordinary-search-card RISK badge and the lower_risk ranking axis.
 * Deliberately separate from BuyerCheck's own 4-outcome scheme
 * (app/[transport]/route.ts's buildBuyerCheck()): that scheme is tuned for
 * a narrative, direct-VIN-lookup writeup and doesn't need a clean
 * "positive vs merely unknown" split. This module exists specifically to
 * make that split explicit, since lower_risk ranking needs it (positive
 * evidence ranks above no-evidence, which ranks above known concerns) and
 * ordinary cards must never treat "unknown" as a warning.
 *
 * CRITICAL BOUNDARY (fixed here after a real production case: a brand-new
 * 2026 F-150 Raptor with 18 miles got a RISK badge purely because its
 * listing data disagreed on cylinder count):
 *
 *   A) evidence the VEHICLE may be a higher-risk purchase (accident
 *      history, failed VIN identity) is PURCHASE-RISK evidence — this
 *      module's job.
 *   B) evidence the LISTING/PROVIDER DATA needs verification (e.g. an
 *      NHTSA cylinder-count mismatch from detectDataConflicts()) is
 *      DATA-QUALITY/verification information — genuinely useful to a
 *      buyer (especially for towing/configuration-sensitive purchases),
 *      but NOT evidence the vehicle itself has a problem. A data conflict
 *      alone must never move a listing off "unknown" into "amber"/"red",
 *      and must never suppress genuine positive evidence (clean history +
 *      a data conflict is still "positive").
 *
 * dataConflicts is deliberately NOT a field on RiskEvidence below — not
 * merely unused, genuinely absent, so this type itself documents the
 * boundary rather than relying on a comment to explain an unused field.
 * detectDataConflicts() output remains fully available elsewhere
 * (cardShape.dataConflicts in route.ts, buildBuyerCheck()'s
 * needsVerification) — this module simply never sees it, by design.
 *
 * Reuses the exact same purchase-risk evidence Buyer Check already reads
 * — no new Auto.dev field, no new API, no numeric score. All three inputs
 * (crossCheckVin, buildHistorySummary, buildCpoSummary in
 * app/[transport]/route.ts) already operate directly on a raw
 * AutoDevListing, so this can run at the lean (pre-stage-2) pipeline
 * stage for lower_risk ranking, and again at the full-detail stage for
 * the final card's displayed tier — same "lean informs ordering,
 * full-detail is authoritative for the card" pattern already used for
 * best_for_budget/body-style elsewhere in this pipeline.
 *
 * "unknown ≠ false" throughout: a listing with zero known purchase-risk
 * concerns AND zero positive evidence is "unknown", never "amber".
 * Ordinary cards must never display anything for "unknown" or "positive"
 * — only "amber"/"red" ever produce a visible badge there (see
 * cardHtml() in lib/results-card.ts). The positive/unknown distinction
 * exists purely for lower_risk's internal ranking order, not for
 * ordinary-card display.
 */

export type RiskTier = "positive" | "unknown" | "amber" | "red";

export interface RiskEvidence {
  verification: { identityVerificationStatus: "verified_match" | "potential_match" | "failed" | "unknown" };
  history: { state: "known_clean" | "known_issues" | "unreported" };
  condition: { cpoEvidenceState: "confirmed_cpo" | "reported_not_cpo" | "unknown" };
}

/**
 * Deterministic, simple precedence — no numeric score of any kind, and
 * only genuine PURCHASE-RISK signals (see module doc above for the
 * data-quality/verification boundary this deliberately excludes):
 *
 * 1. Count purchase-risk concerns: a failed VIN identity check, or a
 *    reported accident/history issue — each counts as one concern.
 *    (Structured as a count, not just two independent booleans, so a
 *    future genuine third purchase-risk concern type can be added without
 *    reshaping this function — see "OR multiple genuine buyer-risk
 *    concerns" in the RED case below. Only two concern types exist today;
 *    identity failure alone already forces red regardless.)
 * 2. Zero concerns + at least one genuine positive signal (explicitly
 *    reported clean history, or confirmed CPO) -> "positive". A
 *    successful VIN identity check alone is NOT counted as positive
 *    evidence — it confirms the vehicle's identity, not that it's a
 *    lower-risk buy, so "VIN verified, but history unreported and CPO
 *    unknown" is "unknown", not "positive".
 * 3. Zero concerns and no positive signal either -> "unknown" (the
 *    common, honest default — most listings simply don't report enough
 *    to say anything either way).
 * 4. A failed identity check on its own, OR two or more concerns
 *    together -> "red" (identity failure is treated as inherently
 *    stronger on its own, matching BuyerCheck's own top-precedence
 *    significant_concern rule).
 * 5. Exactly one concern, and it isn't an identity failure -> "amber".
 *
 * Ownership (multiple owners) and title status are deliberately NOT
 * counted here: real multi-owner confirmation is exceptionally rare in
 * the underlying data (a "not reported as one-owner" disclosure is
 * itself neutral, not a confirmed multi-owner fact), and titleStatus is
 * the same field BuyerCheck itself deliberately excludes as still
 * unverified in the client contract (lib/auto-dev-client.ts). Both would
 * need real, reliably-populated evidence before being added here.
 */
export function classifyRiskTier(evidence: RiskEvidence): RiskTier {
  const identityFailed = evidence.verification.identityVerificationStatus === "failed";
  const hasAccidentIssue = evidence.history.state === "known_issues";

  let concernCount = 0;
  if (identityFailed) concernCount++;
  if (hasAccidentIssue) concernCount++;

  if (concernCount === 0) {
    // Deliberately excludes verified_match — VIN identity verification
    // confirms WHICH vehicle this is, not that it's a lower-risk buy to
    // purchase. Only genuine condition/history-quality signals count.
    const hasPositiveEvidence =
      evidence.history.state === "known_clean" ||
      evidence.condition.cpoEvidenceState === "confirmed_cpo";
    return hasPositiveEvidence ? "positive" : "unknown";
  }

  if (identityFailed || concernCount >= 2) return "red";
  return "amber";
}

/**
 * (SYS-20260904-004) Companion to classifyRiskTier() — returns the actual
 * reason(s) behind an "amber"/"red" tier, in the same order of precedence
 * classifyRiskTier() itself uses, so a host AI asked "why is this
 * flagged?" has a ready structured answer instead of having to
 * reverse-engineer it from scattered card fields. Built from the exact
 * same evidence already computed for the tier itself -- no new data
 * collection. Always returns an empty array for "positive"/"unknown" --
 * there is nothing to explain about the absence of a concern.
 */
export function explainRiskTier(evidence: RiskEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.verification.identityVerificationStatus === "failed") {
    reasons.push("VIN identity check failed — one or more listed attributes (make/year) conflict with what the VIN itself decodes to.");
  }
  if (evidence.history.state === "known_issues") {
    reasons.push("A reported accident or history issue is on file for this vehicle.");
  }
  return reasons;
}

const RISK_TIER_RANK: Record<RiskTier, number> = { positive: 0, unknown: 1, amber: 2, red: 3 };

/** Lower rank = ranked first for lower_risk. Exported so ranking and any
 * future consumer share one single source of truth for tier order. */
export function riskTierRank(tier: RiskTier): number {
  return RISK_TIER_RANK[tier];
}
