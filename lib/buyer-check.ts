/**
 * VIN Buyer Check (extracted from app/[transport]/route.ts,
 * SYS-20260827 buyer-risk-vs-data-quality fix) — moved into its own module
 * so it can be imported directly by tests (route.ts is a Next.js route
 * file; only specific named exports like GET/POST/config are permitted
 * there, so a plain named export of this function broke the build). Pure
 * extraction — no logic changed, same function body, same behavior.
 */
import type { VerificationResult } from "./vin-cross-check";
import type { RecallInfo } from "./nhtsa-recalls-client";

export interface BuyerCheck {
  outcome: "promising" | "verify_before_proceeding" | "caution" | "significant_concern";
  goodSigns: string[];
  concerns: string[];
  needsVerification: string[];
  nextSteps: string[];
  /** Recalls (V2.3, check_vehicle only — never populated for ordinary
   * search cards). Null when no recall lookup was attempted (e.g. no
   * make/model/year was resolvable at all). A lookup FAILURE still
   * produces a non-null RecallInfo with state "unavailable" — this field
   * is only null when the lookup itself was never attempted, per
   * DECISION-20260902-008's "honest partial Buyer Check" requirement. */
  recall: RecallInfo | null;
}

/**
 * VIN Buyer Check (preview MVP, feature/vin-buyer-check) — attached ONLY to
 * the direct-VIN-lookup result, never to normal search results. Pure
 * function over evidence buildResultCard() already produced for this same
 * card — no new Auto.dev call, no new data source, no new MCP tool.
 *
 * Hard rules this function follows:
 * - unknown is never treated as a concern — every "we don't know" signal
 *   (unreported history, unconfirmed identity attributes, unknown CPO
 *   status, no Carfax link) goes into needsVerification, never concerns.
 * - Never invents an accident/title/CPO/history fact — every string here is
 *   either a verbatim existing field (history.note, dataConflicts entries)
 *   or a generic, evidence-agnostic verification suggestion.
 * - No numeric risk/deal/value score of any kind.
 * - titleStatus is deliberately NOT used — that source field is still
 *   unverified in the current client contract (lib/auto-dev-client.ts
 *   marks retailListing.titleStatus "unconfirmed").
 *
 * Outcome precedence (first match wins):
 * 1. identityVerificationStatus === "failed" -> significant_concern.
 * 2. A known accident/history issue (history.state === "known_issues")
 *    -> caution. (SYS-20260827: a data conflict alone no longer
 *    independently triggers caution — see needsVerification below.)
 * 3. No concerns at all AND strong positive evidence (identity confirmed,
 *    history reported clean, no unresolved data conflict) -> promising.
 * 4. Otherwise -> verify_before_proceeding (the common, honest default —
 *    e.g. identity only "potential_match," clean-but-unreported history,
 *    or a data conflict alone: real evidence exists but isn't strong
 *    enough either way, or something material still needs confirming
 *    before this can be called promising).
 */
export function buildBuyerCheck(
  card: {
    verification: VerificationResult;
    history: { state: "known_clean" | "known_issues" | "unreported"; note: string; ownerNote: string | null };
    condition: { cpoEvidenceState: "confirmed_cpo" | "reported_not_cpo" | "unknown" };
    detail: { carfaxUrl: string | null };
    dataConflicts: string[];
  },
  recall: RecallInfo | null = null,
): BuyerCheck {
  const goodSigns: string[] = [];
  const concerns: string[] = [];
  const needsVerification: string[] = [];
  const nextSteps: string[] = [];

  // Identity verification (lib/vin-cross-check.ts — derived offline from
  // VIN anatomy: model year, manufacturer, transcription validity).
  if (card.verification.identityVerificationStatus === "verified_match") {
    goodSigns.push("VIN identity confirmed — the reported year and make match what's encoded in the VIN itself.");
  } else if (card.verification.identityVerificationStatus === "failed") {
    const conflicting = card.verification.conflictingAttributes.join(", ") || "one or more reported attributes";
    concerns.push(
      `VIN identity check failed — ${conflicting} reported by this listing does not match what's encoded in the VIN itself.`,
    );
  } else {
    needsVerification.push(
      "VIN identity could not be fully confirmed from the VIN alone — verify the year and make against the actual vehicle before proceeding.",
    );
  }
  if (card.verification.unknownAttributes.length > 0) {
    needsVerification.push(
      `${card.verification.unknownAttributes.join(" and ")} cannot be confirmed from the VIN alone (VIN anatomy doesn't encode this) — confirm independently, e.g. via a dealer VIN decode or the vehicle's window sticker.`,
    );
  }

  // History (lib/qualifier-accounting.ts-adjacent buildHistorySummary()) —
  // verbatim existing note, never re-worded or embellished.
  if (card.history.state === "known_clean") {
    goodSigns.push(card.history.note);
  } else if (card.history.state === "known_issues") {
    concerns.push(card.history.note);
  } else {
    needsVerification.push(card.history.note);
  }

  // CPO status.
  if (card.condition.cpoEvidenceState === "confirmed_cpo") {
    goodSigns.push("Certified Pre-Owned (CPO) — reported by the dealer.");
  } else if (card.condition.cpoEvidenceState === "unknown") {
    needsVerification.push("CPO status was not reported for this listing — ask the dealer if certification matters to you.");
  }
  // "reported_not_cpo" is neutral (not flagged either way) — this listing
  // simply wasn't marked CPO, which isn't itself a concern.

  // Data conflicts already curated by detectDataConflicts() (e.g. NHTSA
  // make/model/cylinder mismatches) — reused verbatim, not re-derived.
  // SYS-20260827 fix: a data conflict is verification information (the
  // listing/spec data disagrees on something and needs confirming — e.g.
  // cylinder count for a towing-configuration question), NOT evidence the
  // VEHICLE itself is a purchase-risk concern. Goes into
  // needsVerification, never concerns — a data conflict can still keep
  // this Buyer Check from reaching "promising" (see outcome logic below),
  // but it must never read alongside a genuine accident/identity concern
  // as if it were one.
  if (card.dataConflicts.length > 0) {
    needsVerification.push(...card.dataConflicts);
  }

  // Carfax availability.
  if (card.detail.carfaxUrl) {
    needsVerification.push("Review the linked Carfax report for full accident/title history before purchase.");
  } else {
    needsVerification.push("No Carfax link was available on this listing — request an independent vehicle history report before purchase.");
  }

  // Generic, evidence-agnostic next steps — never specific to a fact we
  // don't actually have.
  if (concerns.length > 0) {
    nextSteps.push("Ask the dealer directly about the flagged item(s) above and get documentation before proceeding.");
  }
  if (needsVerification.length > 0) {
    nextSteps.push("Independently verify the items listed above — via Carfax, a trusted mechanic, or the dealer — before finalizing a purchase.");
  }
  nextSteps.push("Have a pre-purchase inspection done by an independent mechanic if you haven't already.");

  // Recalls (V2.3, DECISION-20260902-008): a severe (parkIt/parkOutSide)
  // recall is a manufacturer safety directive, not a listing-data
  // signal — distinct enough from every other input here that it gets its
  // own concern line and can independently push the outcome to at least
  // "caution" (never silently folded into needsVerification the way a
  // routine recall or an unavailable lookup is). Routine/none/unavailable
  // states are surfaced via the `recall` field itself, not restated here
  // as a concern — a routine recall alone should not read as alarming.
  if (recall?.state === "severe") {
    concerns.push(recall.detail);
    nextSteps.push("Do not delay on the recall above — contact the dealer/manufacturer about remedy availability before proceeding.");
  } else if (recall?.state === "routine") {
    needsVerification.push(recall.detail);
  } else if (recall?.state === "unavailable") {
    needsVerification.push("Recall status could not be retrieved for this vehicle — check manually via NHTSA before purchase.");
  }

  let outcome: BuyerCheck["outcome"];
  if (card.verification.identityVerificationStatus === "failed") {
    outcome = "significant_concern";
  } else if (card.history.state === "known_issues" || recall?.state === "severe") {
    // SYS-20260827 fix: dataConflicts.length > 0 removed from this
    // condition — a data conflict alone is verification information, not
    // a reason for "caution" on its own (see the needsVerification push
    // above and the module's own risk-tier boundary in lib/risk-tier.ts).
    // A genuine accident/history concern still triggers caution exactly
    // as before; a data conflict riding alongside an accident doesn't
    // change the outcome (still caution, because of the accident) — it
    // simply doesn't independently cause caution by itself anymore. A
    // severe recall (V2.3) is added as an equal trigger for the same
    // reason an accident is: real, current safety-relevant evidence.
    outcome = "caution";
  } else if (
    card.verification.identityVerificationStatus === "verified_match" &&
    card.history.state === "known_clean" &&
    card.dataConflicts.length === 0
  ) {
    outcome = "promising";
  } else {
    // Data-conflict-only case lands here: a data conflict alone isn't a
    // concern, but it IS something material that still needs verification
    // before this can be called "promising" — verify_before_proceeding is
    // the correct, honest outcome (not caution, not promising).
    outcome = "verify_before_proceeding";
  }

  return { outcome, goodSigns, concerns, needsVerification, nextSteps, recall };
}
