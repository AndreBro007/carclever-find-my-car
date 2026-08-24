/**
 * Shared risk-tier classification (feature/lower-risk-mvp) — used by BOTH
 * the ordinary-search-card RISK badge and the lower_risk ranking axis.
 * Deliberately separate from BuyerCheck's own 4-outcome scheme
 * (app/[transport]/route.ts's buildBuyerCheck()): that scheme is tuned for
 * a narrative, direct-VIN-lookup writeup and doesn't need a clean
 * "positive vs merely unknown" split. This module exists specifically to
 * make that split explicit, since lower_risk ranking needs it (positive
 * evidence ranks above no-evidence, which ranks above known concerns) and
 * ordinary cards must never treat "unknown" as a warning.
 *
 * Reuses the exact same evidence Buyer Check already reads — no new
 * Auto.dev field, no new API, no numeric score. All four inputs
 * (crossCheckVin, buildHistorySummary, buildCpoSummary,
 * detectDataConflicts in app/[transport]/route.ts / lib/qualifier-
 * accounting.ts) already operate directly on a raw AutoDevListing, so this
 * can run at the lean (pre-stage-2) pipeline stage for lower_risk ranking,
 * and again at the full-detail stage for the final card's displayed tier
 * — same "lean informs ordering, full-detail is authoritative for the
 * card" pattern already used for best_for_budget/body-style elsewhere in
 * this pipeline.
 *
 * "unknown ≠ false" throughout: a listing with zero known concerns AND
 * zero positive evidence is "unknown", never "amber". Ordinary cards must
 * never display anything for "unknown" or "positive" — only "amber"/"red"
 * ever produce a visible badge there (see cardHtml() in
 * lib/results-card.ts). The positive/unknown distinction exists purely
 * for lower_risk's internal ranking order, not for ordinary-card display.
 */

export type RiskTier = "positive" | "unknown" | "amber" | "red";

export interface RiskEvidence {
  verification: { identityVerificationStatus: "verified_match" | "potential_match" | "failed" | "unknown" };
  history: { state: "known_clean" | "known_issues" | "unreported" };
  condition: { cpoEvidenceState: "confirmed_cpo" | "reported_not_cpo" | "unknown" };
  dataConflicts: string[];
}

/**
 * Deterministic, simple precedence — no numeric score of any kind:
 *
 * 1. Count concerns: a failed VIN identity check, a reported accident, or
 *    any existing data conflict (e.g. NHTSA make/model/cylinder
 *    mismatches from detectDataConflicts()) each count as one concern.
 * 2. Zero concerns + at least one genuine positive signal (explicitly
 *    reported clean history, or confirmed CPO) -> "positive". A
 *    successful VIN identity check alone is NOT counted as positive
 *    evidence here — it confirms the vehicle's identity, not that it's a
 *    lower-risk buy, so "VIN verified, but history unreported and CPO
 *    unknown" is "unknown", not "positive" (fixed in the lower-risk-mvp
 *    follow-up; the original version incorrectly treated verified_match
 *    as a third positive signal on its own).
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
  const hasDataConflict = evidence.dataConflicts.length > 0;

  let concernCount = 0;
  if (identityFailed) concernCount++;
  if (hasAccidentIssue) concernCount++;
  if (hasDataConflict) concernCount++;

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

const RISK_TIER_RANK: Record<RiskTier, number> = { positive: 0, unknown: 1, amber: 2, red: 3 };

/** Lower rank = ranked first for lower_risk. Exported so ranking and any
 * future consumer share one single source of truth for tier order. */
export function riskTierRank(tier: RiskTier): number {
  return RISK_TIER_RANK[tier];
}
