import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { type AutoDevListing, type ListingsQuery } from "@/lib/auto-dev-client";
import { searchListingsLean, getListingByVin, searchListingByVinExact, getModelFacets } from "@/lib/auto-dev-client";
// Widening ladder re-enabled 2026-08-16 (SYS-20260816-008). It was bypassed on
// Aug 13 per André's request — "search itself needs to work correctly before any
// widening logic runs on top of it." That precondition is now met: the stage-2
// price-ceiling bug (SYS-20260816-004) is fixed and the full A/B/C prompt suite
// verified 9/9 the same day. Re-enabled via a rewritten, injected API rather
// than the old call — see lib/loosening-ladder.ts header for exactly why.
import { widenSearchIfThin, type StepName } from "@/lib/loosening-ladder";
import { isConfirmedOutsideRadius } from "@/lib/geo-verification";
import { verifyAgainstConstraints } from "@/lib/post-verify";
import { parseIntent } from "@/lib/intent-parser";
import { applyDiversity } from "@/lib/diversity";
import { crossCheckVin, type VerificationResult } from "@/lib/vin-cross-check";
import { classifyRiskTier, explainRiskTier, riskTierRank, type RiskTier } from "@/lib/risk-tier";
import { buildBuyerCheck, type BuyerCheck } from "@/lib/buyer-check";
import { applyConfigurationVarietyPass } from "@/lib/configuration-variety";
import { withFindMatchingVehicleErrorBoundary } from "@/lib/tool-error-boundary";
import { computeMatchScore } from "@/lib/match-score";
import { resolveLinks } from "@/lib/link-resolution";
import { sanitizeDealerName } from "@/lib/dealer-name";
import { applyKnownHybridOverride, formatFuelTypeForDisplay } from "@/lib/fuel-type";
import { decodeNhtsaElectrification, nhtsaIndicatesElectrified, type NhtsaElectrificationResult, type ElectrificationState, ELECTRIFICATION_POOL_SIZE, electrificationStateSatisfies } from "@/lib/nhtsa-client";
import { isAnomalousPrice, buildCpoSummary, buildHistorySummary, applyLocalBestForBudgetOrdering, applyLocalLowerRiskOrdering } from "@/lib/local-ranking";
import { FindMatchingVehicleInput } from "@/lib/find-matching-vehicle-input"; // [unverified citation removed]
import { getCorpusCountForDescription, initCorpusCount } from "@/lib/corpus-count";
import { CAPABILITIES } from "@/lib/capabilities";
import { buildIntentConfirmations, detectDataConflicts, buildQualifierAccounting, type CardIntentInput } from "@/lib/qualifier-accounting";
import { RESULTS_CARD_RESOURCE_URI, buildResultsCardHtml, getAppOrigin } from "@/lib/results-card";
import { signImageUrl } from "@/lib/image-proxy-sign";
import { trimMatches } from "@/lib/trim-match";
import { formatVehicleTitle } from "@/lib/vehicle-title";
import {
  FindMatchingVehicleOutputSchema,
  type FindMatchingVehicleOutput,
} from "@/lib/find-matching-vehicle-output";
import {
  buildConstraintChecks,
  aggregateSearchConstraintStatus,
  type ConstraintEvidenceRequest,
} from "@/lib/constraint-evidence";

initCorpusCount();

// Description rules 2 and 4 below are adapted from the proven, live-tested
// tool-description language in AUTODEV_V2_NLP_SEARCH_REDESIGN.md §5.1
// (Sky redesign, approved July 26, 2026) — same architecture principle
// Find My Car already uses (calling LLM owns intent, server stays thin and
// deterministic), just with more explicit coaching for known data quirks.
const FIND_MATCHING_VEHICLE_DESCRIPTION = () => `Finds current vehicles for sale in the United States and returns a concise shortlist matching a user's stated requirements. Appropriate for listing requests with explicit criteria, optimization goals such as lowest price, newest, lowest mileage, or best within a stated budget, practical needs such as a large family SUV or commuter vehicle, or an exact current listing by VIN.

Search inputs include make, model, price, year, mileage, location, body style, drivetrain, transmission, trim, seating, color, condition, electrification, and purchase priority. Most direct criteria are matched against actual listing data; seating, certification, and history-related requests reflect available evidence, which may be confirmed, unconfirmed, or unreported rather than guaranteed. Practical needs such as a large family SUV, a teen-driver car, or a vehicle for towing are interpreted before the search runs to identify relevant candidates; this tool then searches and ranks them using actual listing data — it does not independently establish reliability, safety, running cost, towing suitability, condition, accident-free history, or certification. When a practical need implies a vehicle class, resolve it into real matching model names yourself and include them in model before calling this tool (for example, a large family SUV might include CR-V, RAV4, or Highlander; a reliable commuter car might include Corolla, Civic, or Mazda3), every time, alongside the related need stated in vehicleNeeds. For a broad hybrid, plug-in hybrid, or electric request, likewise resolve suitable real model or variant names and include them in model before calling the tool. For required hybrid or plug-in hybrid searches, use electrified variants only; for preferred searches, acceptable base-model alternatives may also be included.

An exact 17-character VIN refers to one specific listing; if unavailable, that outcome is reported rather than substituting a similar vehicle. Electrification requests state accepted types — hybrid (including mild hybrid), plug-in hybrid, electric — and whether required or preferred. A vehicle's primary fuel label alone does not determine hybrid or plug-in-hybrid status. For an unambiguous city-only request, a representative ZIP may be supplied as the local search anchor; results disclose the overall local, state-wide, or nationwide scope.

Results include current matching listings, viewing links where available, and available evidence about confirmed, unconfirmed, or changed criteria. Missing history, ownership, certification, or specification data remains unknown and is never treated as proof a vehicle satisfies or fails a request. When stating how many results are shown, use \`resultsShown\` — the exact, guaranteed-accurate count of items in \`results\` — never \`totalMatches\` or \`totalCandidatesConsidered\`, which describe a broader match-pool size and can differ from what's actually shown below.

This tool is for vehicle-listing searches — not general automotive education, maintenance, financing, leasing, unsupported categories, or comparisons not requiring current listings.`;



const ResolveDealerUrlOutput = z.object({
  affiliateUrl: z.string().nullable(),
  affiliateFallbackUrl: z.string().nullable(),
  dealerListingUrl: z.string().nullable(),
  isCarvana: z.boolean(),
  linkStatus: z.enum(["both-available", "edmunds-only", "dealer-only", "fallback-only", "none-available"]),
  // Updated 2026-09-04 (SYS-20260904-002) to match the new deterministic
  // checkAvailSource enum on LinkResolution ("exact" | "close" | "none") —
  // the earlier host-search-driven values ("confirmed-exact" /
  // "targeted-fallback" / "unconfirmed") no longer apply now that live
  // search has been retired.
  checkAvailSource: z.enum(["exact", "close", "none"]),
});

const SHORTLIST_SIZE = 5;


/**
 * Result-count strategy (SYS-20260816-008).
 *
 * Broad, exploratory searches ("SUV good for a family under 40k") get a larger
 * shortlist than precise ones ("blue 2020 Civic EX manual"). Real reason: on a
 * broad search the host model tends to narrow the list further in its own
 * answer — a live Aug 16 run returned 5 good vehicles and the user was shown 3
 * — so a set of 5 can reach the user as 2-3 and read as thin inventory when the
 * underlying pool was in the thousands. A precise search has no such problem
 * and padding it would only add weaker matches.
 *
 * Costs nothing extra upstream in the common case: the diversity step already
 * over-fetches to SHORTLIST_SIZE * 2 candidates and then discards the surplus.
 * Only stage-2 per-VIN detail calls scale with this, and those run in parallel.
 */
const BROAD_SHORTLIST_SIZE = 8;

// ELECTRIFICATION_POOL_SIZE and electrificationStateSatisfies() moved to
// lib/nhtsa-client.ts ([unverified citation removed]) — imported at the top of this file
// — so they're unit-testable; Next.js Route Handler files can't export
// arbitrary names for direct test imports.

/**
 * Absolute wall-clock budget from request start, after which NO new widening
 * call is started. vercel.json caps this route at 60s; a single lean search can
 * take 40s worst case (25s + 15s degraded retry). 15s keeps the pathological
 * path bounded at roughly 15s (elapsed) + 25s (one in-flight call) + stage 2,
 * comfortably inside 60s, while leaving normal searches (~1-3s) free to widen.
 * This guard is what prevents a repeat of the real Aug 12 timeout incident.
 */
const WIDENING_TIME_BUDGET_MS = 15_000;
// Vercel's configured function maxDuration (see vercel.json). Used to cap the
// widening budget so a slow primary search shortens the widening window
// instead of risking a hard platform timeout mid-ladder.
const VERCEL_MAX_DURATION_MS = 60_000;
// Time held back for stage-2 per-VIN detail fetches, card assembly and the
// response write after widening finishes — widening must not consume the
// entire remaining window.
const RESPONSE_ASSEMBLY_RESERVE_MS = 20_000;

/**
 * Resolves the calling LLM's decoded priorityAxis into Auto.dev's single-field
 * sort. Same decode-then-execute pattern as the rest of the tool: the LLM reads
 * the user's actual sentence and picks the axis; we map it deterministically.
 *
 * This exists because inferring priority from *which fields happen to be set*
 * is genuinely ambiguous — a user with both priceMax and mileageMax could mean
 * "SUV under $60k, low mileage is a nice-to-have" or "lowest mileage SUV,
 * $60k is just a cap" - identical structured params, opposite intent. Only the
 * sentence itself disambiguates that, so it's the LLM's job, not a heuristic.
 *
 * best_for_budget (default) reflects the app's actual purpose: find the best
 * vehicle for what they're describing, not the cheapest one that qualifies.
 * Sampling from the top of a stated budget (price.desc) tends to correlate
 * with newer years/better trims — without us having to encode that correlation
 * ourselves. Falls back to year.desc when there's no price ceiling to anchor to.
 */
/**
 * CPO disclosure — same Trust Class C treatment as history (SYS-20260812-050/051).
 * cpo=false is explicitly forbidden as definitive proof of non-CPO (CPO-001).
 * Never excludes; always discloses what's actually known.
 */
// buildCpoSummary moved to lib/local-ranking.ts ([unverified citation removed]) —
// imported at the top of this file, same reasoning as electrificationStateSatisfies above.


/**
 * Seats disclosure — same Trust Class C treatment as CPO/history
 * (SYS-20260815 follow-up). `vehicle.seats` is a real response field, but
 * confirmed absent from Auto.dev's documented Vehicle Filters list (field
 * audit, 2026-08-14) — it can be reported, never queried as a hard filter.
 * `seatsMinPreference` was collected as input since early in the build and
 * did nothing until now — this closes that gap, without ever excluding a
 * result on seat count (a below-preference or unreported seat count is
 * disclosed, not dropped — same "unknown != false" discipline as history/CPO).
 */
function buildSeatsSummary(
  listing: AutoDevListing,
  seatsMin: number | undefined,
): { state: "meets_or_exceeds" | "below_requested" | "reported" | "unknown"; note: string } {
  const seats = listing.vehicle?.seats;
  if (seats == null) {
    return {
      state: "unknown",
      note: seatsMin != null
        ? `Seating capacity not reported by this listing — can't confirm it meets the requested ${seatsMin}+ seats.`
        : "Seating capacity not reported by this listing.",
    };
  }
  if (seatsMin == null) {
    return { state: "reported", note: `${seats} seats.` };
  }
  if (seats >= seatsMin) {
    return { state: "meets_or_exceeds", note: `${seats} seats — meets the requested ${seatsMin}+ seat minimum.` };
  }
  return {
    state: "below_requested",
    note: `${seats} seats — below the requested ${seatsMin}+ seat minimum. Shown anyway since seat count is a soft preference, not a hard filter.`,
  };
}

/**
 * History disclosure — Trust Class C. Extended (SYS-20260812-051 audit) to
 * cover owner count alongside accidents; previously only accidents were
 * checked despite oneOwner being a real, collected input doing nothing.
 * "discover broadly, then verify locally or cross-API" — NEVER a query filter
 * (already removed as one, SYS-20260812-047), only a post-search disclosure.
 *
 * Design principle (agreed with André): never exclude a result on MISSING
 * history data — only on a known, positive contradiction. Always disclose
 * confidence honestly per result, and point to the Carfax link (free
 * passthrough, SYS-20260812-022) as the independent source when Auto.dev's
 * own data can't fully answer the question. This is the general pattern for
 * "user asked for something we can't be fully sure about" - run broadly,
 * never silently narrow the pool, be explicit about what we actually know.
 */
// buildHistorySummary moved to lib/local-ranking.ts ([unverified citation removed]) —
// imported at the top of this file.


function resolveSort(
  priorityAxis: "best_for_budget" | "cheapest" | "lowest_mileage" | "newest" | "lower_risk" | undefined,
  priceMax: number | undefined,
): string | undefined {
  switch (priorityAxis) {
    case "cheapest":
      return "price.asc";
    case "lowest_mileage":
      return "miles.asc";
    case "newest":
      return "year.desc";
    // lower_risk has no natural provider-level sort field (Auto.dev has no
    // risk/history sort) — ranking happens entirely via local reordering
    // (applyLocalLowerRiskOrdering(), below), same architecture as
    // best_for_budget. Provider retrieval falls back to the same
    // price-aware default best_for_budget already uses.
    case "best_for_budget":
    case "lower_risk":
    default:
      return priceMax != null ? "price.desc" : "year.desc";
  }
}

const CANDIDATE_POOL_SIZE = 100; // Growth plan cap per docs; silently clamps to 20 on Starter

// Shared anomalous-price rule (feature/value-based-best-for-budget follow-up):
// hoisted to module scope so the "price-likely-inaccurate" card badge
// (buildResultCard, below) and the best_for_budget ranking's price
// weighting (applyLocalBestForBudgetOrdering, immediately below) both read
// the exact same threshold/definition — cannot drift into two independent
// $1,000 rules. Real evidence (Aug 14) that motivated the original badge:
// a listing priced $85 for a 2024 CR-V passed every filter cleanly and got
// VIN-verified — the price itself is the obviously bad data, not the
// identity.
// ANOMALOUS_PRICE_FLOOR/isAnomalousPrice moved to lib/local-ranking.ts
// ([unverified citation removed]) — imported at the top of this file. Still the single
// shared definition used by both this file's own price-badge logic (below)
// and the ordering functions (also now in that lib file).

// applyLocalBestForBudgetOrdering() and applyLocalLowerRiskOrdering() moved
// to lib/local-ranking.ts ([unverified citation removed]), along with buildCpoSummary,
// buildHistorySummary, isAnomalousPrice/ANOMALOUS_PRICE_FLOOR — imported at
// the top of this file. Moved specifically so these pure ordering functions
// are unit-testable: Next.js Route Handler files only permit a fixed set of
// named exports (GET/POST/etc), confirmed by a real local build failure
// this session ("X is not a valid Route export field") when a direct
// export was attempted from this file.



// Same deployed origin the widget declares in its CSP resourceDomains —
// imported directly from lib/results-card.ts's getAppOrigin() rather than a
// second hardcoded copy, so the two can never drift out of sync again
// (this constant used to be a manually-duplicated literal; that's exactly
// the class of bug fixed in SYS-20260831-002 — one dynamic source now).

function signedImageProxyUrl(rawImageUrl: string | null): string | null {
  if (!rawImageUrl) return null;
  // Signing must never fail the whole tool call — if IMAGE_PROXY_SECRET is
  // unexpectedly missing or signing throws for any reason, fall back to no
  // image rather than a 500; the widget already renders the existing
  // "Photo unavailable" placeholder for a null cardImageUrl. The proxy
  // route itself still fails closed (403) for any unsigned/invalid request.
  try {
    const sig = signImageUrl(rawImageUrl);
    return getAppOrigin() + "/api/img-proxy?u=" + encodeURIComponent(rawImageUrl) + "&sig=" + sig;
  } catch {
    return null;
  }
}

async function buildResultCard(
  listing: AutoDevListing,
  intent: ReturnType<typeof parseIntent>,
  intentInput: CardIntentInput,
  nhtsa?: NhtsaElectrificationResult | null,
  evidenceRequest?: ConstraintEvidenceRequest,
  relaxedFields?: ReadonlySet<string>,
) {
  const verification = crossCheckVin(listing); // now local/synchronous — no API call
  const { matchScore, matchScoreLabel, breakdown } = computeMatchScore(listing, intent, verification, intentInput);

  // Trim fill from NHTSA (SYS-20260904-004): only when Auto.dev's own
  // trim is missing AND NHTSA decoded at least one candidate. Simple rule
  // by design — take the first candidate even when NHTSA is ambiguous
  // (picking one is trivially simple; requiring an unambiguous single
  // answer here, unlike the trim-conflict badge below, was judged not
  // worth the added complexity for what's just a URL-construction input).
  // Never overrides a trim Auto.dev already supplied.
  const effectiveListing: AutoDevListing =
    !listing.vehicle?.trim && nhtsa?.trimOptions?.length
      ? { ...listing, vehicle: { ...listing.vehicle, trim: nhtsa.trimOptions[0] } }
      : listing;
  const links = resolveLinks(effectiveListing);

  // Suppress entirely if no usable outbound link — a result with zero
  // actionable CTAs isn't useful regardless of Match Score (SYS-20260812-023/024).
  if (links.linkStatus === "none-available") return null;

  const v = listing.vehicle;
  const rl = listing.retailListing;

  const normalizedFuel = applyKnownHybridOverride(v?.year, v?.make, v?.model, v?.fuel);
  // NHTSA (SYS-20260819-002): Auto.dev's fuel field has no electrification
  // signal at all, so the model-name allowlist above is a best-effort
  // partial mitigation, not a complete fix. When NHTSA's authoritative
  // decode says electrified and Auto.dev/the allowlist both missed it,
  // trust NHTSA — it's manufacturer-submitted data, not another guess.
  const finalNormalizedFuel =
    normalizedFuel === "gasoline" && nhtsaIndicatesElectrified(nhtsa)
      ? (nhtsa!.electrificationLevel!.toLowerCase().includes("phev") ? "plug_in_hybrid" : "hybrid")
      : normalizedFuel;
  const historySummary = buildHistorySummary(listing);
  const cpoSummary = buildCpoSummary(listing);
  const seatsSummary = buildSeatsSummary(listing, intent.semantic.seatsMin);
  // Computed once here (feature/lower-risk-mvp), reused for cardShape's
  // own dataConflicts field below — this is disclosed as verification
  // information (SYS-20260827: a listing/spec data-quality signal, e.g.
  // an NHTSA cylinder-count mismatch, useful for a buyer to verify
  // before relying on a spec like towing configuration), deliberately
  // NOT passed into classifyRiskTier() below — see lib/risk-tier.ts's
  // module doc for the full purchase-risk-vs-data-quality boundary.
  const dataConflicts = detectDataConflicts(listing);
  // Risk tier (feature/lower-risk-mvp) — computed for EVERY card, not just
  // direct-VIN-lookup ones, using only genuine purchase-risk evidence
  // (VIN identity check, reported accident history, CPO status —
  // deliberately NOT dataConflicts, per SYS-20260827). Attached to
  // cardShape below (c.risk.tier) so the ordinary-search-card RISK badge
  // (amber/red only, never green, never for unknown/positive — see
  // lib/results-card.ts) can use it without any new data source. This is
  // display-only here; lower_risk's actual ranking
  // (applyLocalLowerRiskOrdering(), above) runs earlier, at the lean
  // stage, using the same classifyRiskTier() function.
  const riskTier = classifyRiskTier({
    verification,
    history: historySummary,
    condition: { cpoEvidenceState: cpoSummary.state },
  });
  // (SYS-20260904-004) Companion reasons, same evidence, so a host AI
  // asked "why is this flagged?" has a ready structured answer instead of
  // reverse-engineering it from other card fields. Always empty for
  // "positive"/"unknown" — see explainRiskTier()'s own doc.
  const riskReasons = explainRiskTier({
    verification,
    history: historySummary,
    condition: { cpoEvidenceState: cpoSummary.state },
  });

  // Photos must never block the search-results critical path (real evidence:
  // 868ms median Photos latency, SYS-20260812-014/021). Leave the gallery
  // empty here — it's populated only via the separate, lazy
  // get_vehicle_photos tool call.
  const photos: string[] = [];

  const badges: string[] = [];
  if (verification.identityVerificationStatus === "verified_match") badges.push("vin-verified");
  if (verification.identityVerificationStatus === "failed") badges.push("vin-conflicting");
  if (nhtsa?.makeConflict) badges.push("nhtsa-make-conflict");
  if (nhtsa?.modelConflict) badges.push("nhtsa-model-conflict");
  if (nhtsa?.cylindersConflict) badges.push("nhtsa-cylinders-conflict");
  // Trim conflict (SYS-20260904-004): a DATA-QUALITY signal (does the
  // listing's claimed trim match what the VIN itself decodes to?), not a
  // purchase-risk one — deliberately a badge, never fed into
  // classifyRiskTier() below, same boundary lib/risk-tier.ts's module doc
  // already establishes for make/model/cylinder conflicts (the real
  // production bug that boundary exists to prevent: a brand-new,
  // perfectly fine F-150 Raptor once got wrongly flagged amber purely
  // from a data mismatch). Only fires when Auto.dev actually claims a
  // trim (nothing to conflict with otherwise -- that's the missing-trim
  // fill case above, a different thing) AND NHTSA decoded at least one
  // candidate. Checks membership against ALL candidates, however many
  // there are -- if NHTSA says "EX, X-Line" and Auto.dev says "X-Line",
  // that's a valid answer, not a conflict; only flags when the claimed
  // trim matches NONE of them.
  const claimedTrim = listing.vehicle?.trim;
  if (
    claimedTrim &&
    nhtsa?.trimOptions?.length &&
    !nhtsa.trimOptions.some((t) => t.trim().toLowerCase() === String(claimedTrim).trim().toLowerCase())
  ) {
    badges.push("nhtsa-trim-conflict");
  }
  if (nhtsa && nhtsaIndicatesElectrified(nhtsa) && normalizedFuel === "gasoline") badges.push("nhtsa-electrification-confirmed");
  if (intent.semantic.vehicleNeeds.length > 0) badges.push("inferred-match");
  if (historySummary.state === "known_issues") badges.push("history-issues-reported");
  if (cpoSummary.state === "confirmed_cpo") badges.push("cpo-confirmed");
  // Real evidence (Aug 14): a listing priced $85 for a 2024 CR-V passed every
  // filter cleanly and got VIN-verified — the price itself is the obviously
  // bad data, not the identity. Flag rather than silently present as trustworthy.
  // ANOMALOUS_PRICE_FLOOR/isAnomalousPrice() are shared module-level (see
  // above applyLocalBestForBudgetOrdering) so this badge and the
  // best_for_budget ranking's price weighting can never drift apart.
  if (isAnomalousPrice(listing.retailListing?.price)) {
    badges.push("price-likely-inaccurate");
  }

  const cardShape = {
    canonicalVehicleId: listing.vin,
    // Ordinary-search-card risk badge input (feature/lower-risk-mvp):
    // amber/red only ever get displayed on an ordinary card (see
    // cardHtml() in lib/results-card.ts) — "positive"/"unknown" are
    // carried here for lower_risk ranking's internal use and completeness
    // of the structured data, never surfaced as a card badge either way.
    risk: { tier: riskTier, reasons: riskReasons },
    identity: {
      vin: listing.vin,
      year: v?.year ?? null,
      // Reverted to plain passthrough (fix/provider-string-runtime-safety
      // review follow-up, SYS-20260828): the earlier String()-coercion
      // here prevented an output-schema crash but risked displaying
      // literal garbage ("1958", "[object Object]") as if it were a real
      // vehicle fact. Now that lib/auto-dev-client.ts's normalizeListing()/
      // leanRowToListing() guarantee every AutoDevListing entering this
      // function already has correct runtime string types (a genuine
      // string survives, anything malformed becomes undefined at
      // ingestion — see that module's own doc comment), `v?.make ?? null`
      // is safe and correct again: `v.make` is either a real string or
      // already undefined by the time it reaches here, never a stray
      // number/array/object. Malformed provider data now surfaces as
      // null ("unknown"), never as a fabricated display string.
      make: v?.make ?? null,
      model: v?.model ?? null,
      trim: v?.trim ?? null,
      series: v?.series ?? null,
      squishVin: v?.squishVin ?? null,
      bodyStyleConfig: v?.style ?? null, // confirmed real (e.g. "4dr SUV") - short structural descriptor, not narrative text
    },
    condition: {
      inventoryType: (rl?.used === false ? "new" : rl?.used === true ? "used" : "unknown") as "new" | "used" | "unknown",
      used: rl?.used ?? null,
      cpo: rl?.cpo ?? null,
      cpoEvidenceState: cpoSummary.state,
    },
    powertrain: {
      type: finalNormalizedFuel,
      engine: v?.engine ?? null,
      drivetrain: v?.drivetrain ?? null,
      transmission: v?.transmission ?? null,
    },
    body: {
      bodyStyle: v?.bodyStyle ?? null,
      vehicleType: v?.type ?? null,
      doors: v?.doors ?? null,
    },
    listing: {
      price: rl?.price ?? null,
      mileage: rl?.miles ?? null,
      dealer: rl?.dealer ? sanitizeDealerName(rl.dealer) : null,
      dealerId: rl?.dealerId ?? null,
      city: rl?.city ?? null,
      state: rl?.state ?? null,
      zip: rl?.zip ?? null,
      rawVdp: rl?.vdp ?? null,
      resolvedDestination: links.dealerListingUrl,
      destinationClass: links.dealerListingUrl ? "dealer_or_aggregator" : null,
    },
    history: historySummary,
    media: {
      primaryImage: rl?.primaryImage ?? null,
      cardImageUrl: signedImageProxyUrl(rl?.primaryImage ?? null),
      photoUrls: photos,
    },
    verification,
    // matchScoreLabel cast: lib/match-score.ts's MatchScoreResult interface
    // declares matchScoreLabel as plain `string`, but the actual runtime
    // computation there is always exactly one of these three literals
    // (`matchScore >= 85 ? "Strong match" : matchScore >= 65 ? "Good match"
    // : "Partial match"`). This cast is a compile-time-only annotation
    // matching that deterministic reality — it changes no runtime value,
    // and lib/match-score.ts itself (the ranking formula/logic) is untouched.
    ranking: { matchScore, matchScoreLabel: matchScoreLabel as "Strong match" | "Good match" | "Partial match", breakdown },
    links: {
      affiliateUrl: links.affiliateUrl,
      affiliateFallbackUrl: links.affiliateFallbackUrl,
      dealerListingUrl: links.dealerListingUrl,
      isCarvana: links.isCarvana,
      linkStatus: links.linkStatus,
      // Added 2026-09-03 (SYS-20260903-006) — was missing here the same way
      // it was briefly missing from ResolveDealerUrlOutput (SYS-20260903-005);
      // this is the OTHER place LinkResolution gets narrowed to a card-local
      // shape. Kept even though find_matching_vehicle always redacts the
      // URLs themselves — "none/unconfirmed" is still useful diagnostic
      // signal distinct from "URL redacted pending verification".
      checkAvailSource: links.checkAvailSource,
    },
    detail: {
      carfaxUrl: CAPABILITIES.carfaxPassthrough ? rl?.carfaxUrl ?? null : null,
      cpoNote: cpoSummary.note,
      ownerHistoryNote: historySummary.ownerNote,
      interiorColor: v?.interiorColor ?? null,
      exteriorColor: v?.exteriorColor ?? null,
      cylinders: v?.cylinders ?? null,
      seats: v?.seats ?? null,
      seatsNote: seatsSummary.note,
      dataConfidence: v?.confidence ?? null, // real field, 0.0-1.0 per docs, unresearched use case - surfaced for observation
      historyUsageType: listing.history?.usageType ?? null,
      historyPersonalUse: listing.history?.personalUse ?? null,
      titleStatus: rl?.titleStatus ?? null,
      fuelTypeDisplay: formatFuelTypeForDisplay(finalNormalizedFuel, v?.fuel),
    },
    badges,
  };

  // Constraint evidence (SYS-20260825): built from the exact same resolved
  // listing (v/rl) the card above is built from — purely observational,
  // computed after cardShape and never fed back into it or into any
  // decision this function already made above (links suppression, badges,
  // Match Score, etc. are all already finalized by this point).
  const constraintChecks = buildConstraintChecks(
    evidenceRequest ?? {},
    {
      make: v?.make ?? null,
      model: v?.model ?? null,
      price: rl?.price ?? null,
      year: v?.year ?? null,
      mileage: rl?.miles ?? null,
      bodyStyle: v?.bodyStyle ?? null,
      vehicleType: v?.type ?? null,
      drivetrain: v?.drivetrain ?? null,
      transmission: v?.transmission ?? null,
      exteriorColor: v?.exteriorColor ?? null,
      interiorColor: v?.interiorColor ?? null,
      doors: v?.doors ?? null,
      cylinders: v?.cylinders ?? null,
      used: rl?.used ?? null,
      state: rl?.state ?? null,
      trim: v?.trim ?? null,
    },
    relaxedFields ?? new Set(),
  );
  const searchConstraintStatus = aggregateSearchConstraintStatus(constraintChecks);

  return {
    ...cardShape,
    // Qualifier accounting (SYS-20260815 follow-up): dynamic, per-result
    // confirmation of only the fields the user actually asked about — keeps
    // the card lean while closing the "text summary only ever warns, never
    // confirms" gap found in the Aug 15 baseline.
    intentConfirmations: buildIntentConfirmations(intentInput, cardShape),
    dataConflicts,
    // Constraint evidence (SYS-20260825): additive, observational only —
    // built from the same already-resolved listing the rest of this card
    // uses, never participates in eligibility/ranking/ordering decisions.
    // See lib/constraint-evidence.ts for the full contract.
    constraintChecks,
    searchConstraintStatus,
  };
}


const handler = createMcpHandler((server) => {
  // MCP Apps (SEP-1865) result-card widget — a STATIC resource, registered
  // once. Real per-search data is delivered to it client-side via
  // ui/notifications/tool-result (see lib/results-card.ts); this server-side
  // registration never re-renders per request. Hosts that don't support MCP
  // Apps ignore this entirely and fall back to the tool's normal
  // content/structuredContent response below, unchanged.
  server.registerResource(
    "find-my-car-results-card",
    RESULTS_CARD_RESOURCE_URI,
    {
      title: "CarClever - Find My Car results",
      description: "Compact vehicle result carousel: photo, price, mileage, match score, one Edmunds click-through CTA per card.",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          // Photo domains vary per dealer/Auto.dev listing and can't be
          // enumerated — photos are proxied through our own first-party
          // origin instead (see app/api/img-proxy/route.ts), so only this
          // one domain needs declaring here.
          //
          // domain: intentionally omitted for cross-host MCP Apps
          // compatibility — hosts may use their own default sandbox
          // origin when it's absent (per SEP-1865, the field is
          // optional). Confirmed live (SYS-20260825): a plain-origin
          // value here caused Claude to fetch this resource successfully
          // but fail to mount/render it; Claude iOS rendered correctly
          // once the field was removed, ChatGPT unaffected either way.
          // Do NOT restore a plain Vercel-origin value without
          // re-validating against a live Claude test first.
          csp: { resourceDomains: [getAppOrigin()] },
          prefersBorder: false,
        },
      },
    },
    async (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: buildResultsCardHtml(),
          // Per SEP-1865, CSP/prefersBorder must be present on the
          // resources/read response's content item itself, not only on the
          // static registration config above — confirmed via a live check
          // against the deployed endpoint (the registration-level _meta
          // alone did not surface here).
          //
          // domain: intentionally omitted here too, same reasoning as the
          // registration-level _meta.ui above. openai/outputTemplate (on
          // the tool registration, unrelated to this block) is untouched.
          //
          // EXPERIMENT (experiment/openai-widget-domain-metadata-only,
          // André's direction, metadata-only test, preview only): added
          // openai/widgetDomain as a namespaced compatibility field,
          // separate from _meta.ui.domain (which stays absent — see
          // above, do not restore it without re-validating against a
          // live Claude test first, per SYS-20260825). Registration-level
          // _meta is intentionally NOT touched in this experiment.
          _meta: {
            ui: {
              csp: { resourceDomains: [getAppOrigin()] },
              prefersBorder: false,
            },
            "openai/widgetDomain": getAppOrigin(),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "find_matching_vehicle",
    {
      description: FIND_MATCHING_VEHICLE_DESCRIPTION(),
      inputSchema: FindMatchingVehicleInput.shape,
      outputSchema: FindMatchingVehicleOutputSchema,
      // Canonical output contract. All live structuredContent construction paths
      // are compile-time validated against this schema via `satisfies`.
      annotations: { title: "Find Matching Vehicle", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      // (SYS-20260904-002) Restored — find_matching_vehicle is once again a
      // single, self-sufficient call that renders directly. The mandatory
      // two-call host-verification flow (SYS-20260903-006 through -013) was
      // retired: it worked and was verified live, but cost 85-100 seconds
      // per search, dominated by live search time with no way to reduce it.
      // Replaced with a fully deterministic, condition-aware link design
      // (see lib/link-resolution.ts) approved by both Andre and ChatGPT
      // after reviewing real (not proxy) hit-rate data. Per SEP-1865: hosts
      // that don't support MCP Apps ignore this field and the tool behaves
      // exactly as before (text/structuredContent only). Also set the
      // ChatGPT-specific compatibility alias per OpenAI's own docs
      // ("ChatGPT also honors _meta['openai/outputTemplate'] as a
      // compatibility alias") for extra robustness on that host.
      _meta: {
        ui: { resourceUri: RESULTS_CARD_RESOURCE_URI },
        "openai/outputTemplate": RESULTS_CARD_RESOURCE_URI,
      },
    },
    async (input) => {
      return withFindMatchingVehicleErrorBoundary(async () => {
      // Anchored before any upstream work so the widening budget accounts for
      // everything already spent (primary search, facet correction, retries).
      const requestStartedAt = Date.now();
      const intent = parseIntent(input);

      // Direct VIN lookup (SYS-20260824): when the user supplies an exact
      // VIN, this looks up that one vehicle directly and returns early —
      // the normal search/widening/diversity/backfill pipeline below never
      // runs for this path. Reuses the existing getListingByVin() call and
      // the same buildResultCard() enrichment (verification, NHTSA, image
      // signing, link resolution) as a normal search result, so the card
      // is built exactly the same way a search result's card would be.
      // Any other stated constraint (price, trim, etc.) is checked against
      // THIS vehicle and disclosed honestly — never used to exclude it or
      // substitute a different vehicle.
      if (input.vin) {
        const rawVin = input.vin.trim().toUpperCase();
        // Basic 17-character VIN format check — real VINs never contain I,
        // O, or Q (reserved, to avoid confusion with 1/0). Not a full
        // check-digit/WMI decode, just a cheap, real format validation.
        const vinFormatValid = /^[A-HJ-NPR-Z0-9]{17}$/.test(rawVin);

        if (!vinFormatValid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${input.vin}" doesn't look like a valid 17-character VIN (VINs never contain the letters I, O, or Q) — double-check it and try again.`,
              },
            ],
            structuredContent: {
              meta: {
                totalCandidatesConsidered: 0,
                totalMatches: 0,
                resultsShown: 0,
                corpusSizeApprox: getCorpusCountForDescription(),
                relaxations: [],
                dataNotes: [],
                scopeNote: "vin_lookup",
                serviceError: null,
                interpretationNotes: [`"${input.vin}" is not a valid 17-character VIN format.`],
                qualifierAccounting: [],
              },
              results: [],
            } satisfies FindMatchingVehicleOutput,
          };
        }

        const [fullListing, exactSearchRow] = await Promise.all([
          getListingByVin(rawVin),
          searchListingByVinExact(rawVin),
        ]);

        if (!fullListing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No listing found for VIN ${rawVin} in current live inventory — this exact vehicle isn't currently available (or was already sold/delisted). Not substituting a similar vehicle since a specific VIN was requested.`,
              },
            ],
            structuredContent: {
              meta: {
                totalCandidatesConsidered: 0,
                totalMatches: 0,
                resultsShown: 0,
                corpusSizeApprox: getCorpusCountForDescription(),
                relaxations: [],
                dataNotes: [],
                scopeNote: "vin_lookup",
                serviceError: null,
                interpretationNotes: [`Exact VIN lookup for ${rawVin} found no matching live listing.`],
                qualifierAccounting: [],
              },
              results: [],
            } satisfies FindMatchingVehicleOutput,
          };
        }

        // Price reconciliation (SYS-20260824, confirmed live for VIN
        // W1N4N5BB1TJ864755): getListingByVin() — the path-form
        // /listings/{vin} full-detail endpoint — can return a stale price
        // ($61,515) where the LISTINGS SEARCH endpoint's exact vehicle.vin=
        // filter returns the canonical, live-matching price ($59,935, same
        // as Edmunds and normal search's own lean price). Only price is
        // ever merged from the search-endpoint row — every other field
        // (photo, dealer, location, drivetrain, Carfax, used/new, history,
        // mileage, year, make, model, trim, etc.) stays exactly as returned
        // by full-detail. The exact search row's own VIN is verified before
        // its price is trusted at all — Auto.dev's docs don't guarantee
        // this filter can never near-match, so this code doesn't assume it.
        const searchPrice =
          exactSearchRow && exactSearchRow.vin === rawVin ? exactSearchRow.retailListing?.price ?? null : null;
        const fullPrice = fullListing.retailListing?.price ?? null;
        if (searchPrice != null && fullPrice != null && searchPrice !== fullPrice) {
          console.log(
            `[find_matching_vehicle] vin_price_disagreement vin=${rawVin} searchPrice=${searchPrice} fullPrice=${fullPrice} chosenPrice=${searchPrice}`,
          );
        }
        const resolvedListing: AutoDevListing =
          searchPrice != null && fullListing.retailListing
            ? { ...fullListing, retailListing: { ...fullListing.retailListing, price: searchPrice } }
            : fullListing;

        const nhtsaResult = await decodeNhtsaElectrification(
          resolvedListing.vin,
          resolvedListing.vehicle?.make,
          resolvedListing.vehicle?.model,
          resolvedListing.vehicle?.cylinders,
        );

        const vinIntentInput: CardIntentInput = {
          exteriorColor: input.exteriorColor,
          interiorColor: input.interiorColor,
          drivetrain: input.drivetrain,
          transmission: input.transmission,
          cylinders: input.cylinders,
          doors: input.doors,
          vehicleType: input.vehicleType,
          used: input.used,
          cpo: input.cpo,
          noAccidents: input.noAccidents,
          oneOwner: input.oneOwner,
          seatsMinPreference: intent.semantic.seatsMin,
          droppedBodyStyleFilter: null,
          trimRequired: intent.trimRequired,
        };

        const vinCard = await buildResultCard(
          resolvedListing,
          intent,
          vinIntentInput,
          nhtsaResult,
          {
            make: input.make,
            model: input.model,
            priceMin: input.priceMin,
            priceMax: input.priceMax,
            yearMin: input.yearMin,
            yearMax: input.yearMax,
            mileageMax: input.mileageMax,
            bodyType: input.bodyType,
            drivetrain: input.drivetrain,
            transmission: input.transmission,
            exteriorColor: input.exteriorColor,
            interiorColor: input.interiorColor,
            vehicleType: input.vehicleType,
            doors: input.doors,
            cylinders: input.cylinders,
            used: input.used,
            state: input.state,
            trimRequired: intent.trimRequired,
          },
          // A direct VIN lookup never widens/relaxes anything — this is
          // always the exact requested VIN, so no field is ever "relaxed"
          // here.
          new Set(),
        );
        // (SYS-20260904-002) Data-only redaction removed — restored to
        // direct rendering with the new deterministic condition-aware
        // links from resolveLinks().
        const vinCards = vinCard ? [vinCard] : [];

        // VIN Buyer Check (feature/vin-buyer-check, preview MVP): attached
        // ONLY here, on the direct-VIN-lookup result — never on normal
        // search results. Pure function over the same evidence
        // buildResultCard() already produced for vinCard above; no new
        // Auto.dev call, no new data source.
        const buyerCheck = vinCard ? buildBuyerCheck(vinCard) : null;
        const vinCardsWithBuyerCheck = vinCard && buyerCheck ? [{ ...vinCard, buyerCheck }] : vinCards;

        // Other stated hard constraints (price/year/mileage) are checked
        // against THIS vehicle and disclosed — never used to exclude it or
        // substitute a different one. make/model deliberately omitted: a
        // VIN already identifies an exact vehicle regardless of what
        // make/model the user also stated.
        const vinConstraintViolations = verifyAgainstConstraints(resolvedListing, {
          priceMax: intent.hardConstraints.priceMax,
          priceMin: intent.hardConstraints.priceMin,
          yearMin: intent.hardConstraints.yearMin,
          yearMax: intent.hardConstraints.yearMax,
          mileageMax: intent.hardConstraints.mileageMax,
        });
        const vinDataNotes: string[] =
          vinConstraintViolations.length > 0
            ? [
                `This exact vehicle doesn't fully meet the other stated criteria (${vinConstraintViolations.join(
                  ", ",
                )}) — shown anyway since a specific VIN identifies exactly one vehicle, never substituted for a different one.`,
              ]
            : [];

        const BUYER_CHECK_OUTCOME_LABEL: Record<BuyerCheck["outcome"], string> = {
          promising: "Promising",
          verify_before_proceeding: "Verify before proceeding",
          caution: "Caution",
          significant_concern: "Significant concern",
        };

        const vinSummary =
          vinCards.length === 0
            ? `VIN ${rawVin} was found in inventory but couldn't be built into a displayable result (no usable dealer or affiliate link available for it).`
            : (() => {
                const c = vinCards[0];
                const id = c.identity;
                const l = c.listing;
                const r = c.ranking;
                const priceStr = l.price != null ? `$${l.price.toLocaleString()}` : "price unavailable";
                const mileageStr = l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "mileage unknown";
                const dealerStr = l.dealer ? ` — ${l.dealer}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}` : "";
                // Never route the user to dealerListingUrl (including
                // Carvana) — affiliateUrl (exact-VIN for Used, close
                // trim-specific for New/Carvana) first, then
                // affiliateFallbackUrl (close for Used, loose for
                // New/Carvana) labeled as a fallback, never as "this
                // vehicle". dealerListingUrl stays available internally on
                // structuredContent only, never surfaced here.
                const primaryLinkStr = c.links.affiliateUrl
                  ?? (c.links.affiliateFallbackUrl ? `Similar options on Edmunds: ${c.links.affiliateFallbackUrl}` : null)
                  ?? "no link available";
                const violationNote =
                  vinConstraintViolations.length > 0
                    ? `\n   ⚠️ Doesn't fully meet: ${vinConstraintViolations.join(", ")} — this is the exact VIN requested, not a different vehicle.`
                    : "";
                const buyerCheckText = buyerCheck
                  ? `\n\nBuyer Check: ${BUYER_CHECK_OUTCOME_LABEL[buyerCheck.outcome]}` +
                    (buyerCheck.goodSigns.length > 0 ? `\n  Good signs: ${buyerCheck.goodSigns.join(" ")}` : "") +
                    (buyerCheck.concerns.length > 0 ? `\n  Concerns: ${buyerCheck.concerns.join(" ")}` : "") +
                    (buyerCheck.needsVerification.length > 0
                      ? `\n  Needs verification: ${buyerCheck.needsVerification.join(" ")}`
                      : "") +
                    (buyerCheck.nextSteps.length > 0 ? `\n  Next steps: ${buyerCheck.nextSteps.join(" ")}` : "")
                  : "";
                return `Found the exact vehicle for VIN ${rawVin}:\n\n${formatVehicleTitle(id)} — ${priceStr}, ${mileageStr}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}${violationNote}\n   Link: ${primaryLinkStr}${buyerCheckText}`;
              })();

        return {
          content: [{ type: "text" as const, text: vinSummary }],
          structuredContent: {
            meta: {
              totalCandidatesConsidered: 1,
              totalMatches: vinCards.length,
              resultsShown: vinCardsWithBuyerCheck.length,
              corpusSizeApprox: getCorpusCountForDescription(),
              relaxations: [],
              dataNotes: vinDataNotes,
              scopeNote: "vin_lookup",
              serviceError: null,
              interpretationNotes: [`Direct VIN lookup for ${rawVin} — identifies exactly one vehicle; no broader search was run.`],
              qualifierAccounting: buildQualifierAccounting(vinIntentInput),
            },
            results: vinCardsWithBuyerCheck,
          } satisfies FindMatchingVehicleOutput,
        };
      }

      // trimRequired (SYS-20260823): a hard eligibility requirement,
      // enforced locally — deliberately never sent to Auto.dev as a query
      // filter (vehicle.trim isn't trusted there as a hard filter param,
      // same as everywhere else in this file). Stage-1 lean data may have
      // trim; when it doesn't, a candidate stays provisional rather than
      // being excluded outright, since stage-2 full-detail can resolve it.
      // At stage 2, a still-missing or non-matching trim must NOT satisfy
      // the requirement — see trimRequiredFullFilter below.
      const trimRequired = intent.trimRequired;
      const trimRequiredLeanFilter = (c: AutoDevListing): boolean => {
        if (!trimRequired) return true;
        const reported = c.vehicle?.trim;
        if (reported == null || reported === "") return true; // provisional — stage 2 may resolve it
        return trimMatches(trimRequired, reported);
      };
      const trimIsConfirmedMatch = (c: AutoDevListing): boolean =>
        !!trimRequired && trimMatches(trimRequired, c.vehicle?.trim);
      const trimRequiredFullFilter = (c: AutoDevListing): boolean => {
        if (!trimRequired) return true;
        // Full detail is the last word — a still-missing or non-matching
        // trim can no longer stay provisional here.
        return trimMatches(trimRequired, c.vehicle?.trim);
      };

      // "Lowest mileage" almost always means "lowest mileage used car" in
      // real buy-intent — a new car being low-mileage isn't a finding worth
      // surfacing as the best match, and Auto.dev has no separate "demo"
      // category (confirmed: retailListing.used is a strict true=used/
      // false=new boolean, nothing else) — a demo vehicle without a prior
      // retail owner would carry used:false, same bucket as genuinely new.
      // So defaulting to used:true when the user hasn't stated a new/used
      // preference correctly excludes both, using the one real signal
      // available. Never silent — always disclosed via dataNotes below,
      // same discipline as every other default/relaxation in this tool.
      // Respects an explicit input.used if the user actually asked for new.
      const lowestMileageDefaultedToUsed = input.priorityAxis === "lowest_mileage" && input.used == null;
      const effectiveUsed = lowestMileageDefaultedToUsed ? true : input.used;

      // Lean ZIP validation (2026-08-15) — Auto.dev silently ignores an
      // invalid ZIP and returns unfiltered, effectively nationwide results
      // with no error and no signal anything went wrong (confirmed live:
      // zip=00000 returned real Camrys from GA/WA/TX). A real host model
      // usually catches this upstream before it reaches us, but that's not
      // something this tool controls or can rely on — same "don't trust the
      // caller's input, verify and disclose" principle as everything else
      // here. Real fix required TWO checks, not one — a bare 5-digit format
      // check alone is insufficient: "00000" IS 5 digits, so it passed a
      // naive regex and reproduced the exact same bug (confirmed live via
      // the first version of this fix). No US ZIP has all-identical digits
      // (00000/11111/.../99999 are unassigned), so that's added as a cheap,
      // real second check — not a full ZIP database, deliberately lean.
      const rawZip = intent.hardConstraints.location?.zip;
      const zipFormatValid = rawZip == null || /^\d{5}$/.test(rawZip);
      const zipNotAllSameDigit = rawZip == null || !/^(\d)\1{4}$/.test(rawZip);
      const zipIsValid = zipFormatValid && zipNotAllSameDigit;

      const baseQuery: ListingsQuery = {
        make: intent.hardConstraints.make,
        model: intent.hardConstraints.model,
        bodyType: intent.hardConstraints.bodyType,
        priceMin: intent.hardConstraints.priceMin,
        priceMax: intent.hardConstraints.priceMax,
        yearMin: intent.hardConstraints.yearMin,
        yearMax: intent.hardConstraints.yearMax,
        mileageMax: intent.hardConstraints.mileageMax,
        zip: zipIsValid ? rawZip : undefined,
        radius: zipIsValid ? intent.hardConstraints.location?.radiusMiles : undefined,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        vehicleType: input.vehicleType,
        doors: input.doors,
        cylinders: input.cylinders,
        used: effectiveUsed,
        // cpo NOT sent as a filter — CPO-001 forbids treating cpo=false as
        // definitive. input.cpo still collected, used for disclosure below.
        state: input.state,
        // accidentCount/ownerCount NOT sent as query filters — history is null
        // in 53% of real listings, so hard-filtering would violate "unknown != false".
        sort: resolveSort(input.priorityAxis, intent.hardConstraints.priceMax),
        limit: CANDIDATE_POOL_SIZE,
      };

      // Two-stage search (SYS-20260812-060): lean ?select= primary search for
      // the full candidate pool (smaller payload, faster), then full-detail
      // refetch via parallel /listings/{vin} calls for just the shortlist.
      //
      // EXPERIMENT (preview only, experiment/value-based-best-for-budget):
      // for a condition-neutral search (baseQuery.used == null — the user
      // never asked for NEW or USED specifically), a single query relies
      // entirely on the provider sort to decide which ~100 rows come back.
      // Live-tested: for a BMW X5 near 10001 with priorityAxis
      // best_for_budget (no priceMax -> year.desc sort), that single
      // top-100 window was 100% NEW, 0% USED. Explicit NEW/USED searches
      // are untouched below — this only changes the condition-neutral case.
      //
      // Fix: run the two conditions as separate lean searches in parallel
      // (each still capped at CANDIDATE_POOL_SIZE, same sort/filters/limit
      // as before — nothing else about either query changes, and no
      // additional API calls beyond these two), then dedupe-merge into one
      // combined pool before handing off to the downstream pipeline
      // (eligibility, trim handling, the new value-based
      // applyLocalBestForBudgetOrdering below, applyConfigurationVarietyPass,
      // applyDiversity, Match Score, cards, links, Buyer Check — all
      // otherwise unchanged). No NEW/USED quota is forced anywhere.
      //
      // SYS-20260825 fix: the merge above is a straight concatenation
      // (NEW rows first, then USED), never globally re-sorted by price.
      // That's fine for best_for_budget (applyLocalBestForBudgetOrdering
      // re-ranks the merged pool by value below), but for cheapest/
      // lowest_mileage/newest — which bypass that re-ranking and rely
      // entirely on provider sort order surviving into the shortlist —
      // the merge silently destroyed the global ordering. Confirmed live:
      // "cheapest BMW X5 near 10001, new or used fine" returned a $71,500
      // NEW X5 as cheapest while a $70,489 USED X5 was in the same live
      // pool. Fix: only fair-pool for best_for_budget/unset, the one axis
      // that actually re-ranks the merged result afterward. cheapest/
      // lowest_mileage/newest keep the original single-query path, so
      // Auto.dev's own global sort (price.asc/miles.asc/year.desc) is
      // preserved intact across NEW+USED exactly as it was before fair
      // pooling was introduced. Ranking formula, anomaly handling,
      // diversity, Match Score, hard filters, and UI are untouched.
      const useFairPool =
        baseQuery.used == null &&
        (input.priorityAxis === "best_for_budget" || input.priorityAxis == null);
      let rawResult: { data: AutoDevListing[]; total: number | null; error?: string; degraded?: string };
      if (useFairPool) {
        const [newResult, usedResult] = await Promise.all([
          searchListingsLean({ ...baseQuery, used: false }),
          searchListingsLean({ ...baseQuery, used: true }),
        ]);
        const seenVins = new Set<string>();
        const mergedData: AutoDevListing[] = [];
        for (const c of [...newResult.data, ...usedResult.data]) {
          if (c.vin && !seenVins.has(c.vin)) {
            seenVins.add(c.vin);
            mergedData.push(c);
          }
        }
        // Same "unreliable total -> null" discipline already used elsewhere
        // (SYS-20260819 doors-param fix) — if either side's total is
        // unknown, the combined total is unknown too, never silently
        // presented as a real number built from a partial sum.
        const mergedTotal =
          newResult.total != null && usedResult.total != null ? newResult.total + usedResult.total : null;
        // A genuine error only surfaces if BOTH sub-queries failed — one
        // succeeding still gives a real, usable (if partial) result, same
        // "partial beats nothing" principle already used for the stage-2
        // full-detail fallback below.
        const mergedError = newResult.error && usedResult.error ? `${newResult.error} ${usedResult.error}` : undefined;
        const mergedDegraded =
          newResult.degraded || usedResult.degraded
            ? [newResult.degraded, usedResult.degraded].filter(Boolean).join(" ")
            : undefined;
        rawResult = { data: mergedData, total: mergedTotal, error: mergedError, degraded: mergedDegraded };
      } else {
        rawResult = await searchListingsLean(baseQuery);
      }
      let candidates = rawResult.data;
      let total = rawResult.total;
      const relaxations: Array<{ step: string; detail: string }> = [];
      for (const c of intent.modelPrefixesStripped) {
        relaxations.push({
          step: "model_prefix_correction",
          detail: `"${c.original}" includes the manufacturer name, which Auto.dev's model field never does — corrected to "${c.corrected}".`,
        });
      }

      // The query that actually produced the rows in `candidates`. Both the
      // model-name correction below and the widening ladder can change it, and
      // post-verification MUST then check against THIS rather than the original
      // baseQuery — otherwise the rows those steps just gained get stripped
      // straight back out, silently undoing them (SYS-20260816-008).
      let effectiveQuery: ListingsQuery = baseQuery;
      // Extended (2026-08-15) — previously only distinguished "local" vs
      // "nationwide" on ZIP validity, so a genuinely absent ZIP (no location
      // given at all — e.g. a bare state-only or fully unscoped search)
      // silently reported as "local" with zero disclosure. Confirmed live:
      // a real "Toyota Camry in Texas" search (state filter, no ZIP) showed
      // scopeNote: "local" despite covering the entire state — the only
      // reason the user got an honest caveat was the host model choosing to
      // add one unprompted, not this tool. Same "don't rely on the caller's
      // good behavior" principle as the invalid-ZIP fix.
      const scopeNote: "local" | "statewide" | "nationwide" =
        rawZip != null && !zipIsValid
          ? "nationwide"
          : rawZip == null && baseQuery.state
          ? "statewide"
          : rawZip == null
          ? "nationwide"
          : "local";

      // Facet-grounded model-name correction (design doc §4), added
      // 2026-08-15 — fixes the real MX-5 regression (SYS-20260815-001):
      // model strings that don't exactly match Auto.dev's data (e.g. "MX-5"
      // vs the real "MX-5 Miata") return a clean silent zero rather than an
      // error. ONLY runs when the primary search genuinely found nothing AND
      // a specific model was requested — every search that already returns
      // results is completely unaffected, so this adds no latency to the
      // common case. One corrective re-search only, never a loop, and the
      // correction is always disclosed via relaxations, never silent.
      if (total === 0 && candidates.length === 0 && baseQuery.model) {
        const requestedModels = baseQuery.model.split(",").map((m) => m.trim());
        const realModels = await getModelFacets(baseQuery);

        const corrections = requestedModels.map((requested) => {
          const lower = requested.toLowerCase();
          const match = realModels.find((real) => {
            const realLower = real.value.toLowerCase();
            return realLower !== lower && (realLower.startsWith(lower) || lower.startsWith(realLower));
          });
          return { requested, corrected: match?.value ?? null };
        });

        const anyCorrected = corrections.some((c) => c.corrected);
        if (anyCorrected) {
          const correctedModelString = corrections
            .map((c) => c.corrected ?? c.requested)
            .join(",");
          const retryQuery: ListingsQuery = { ...baseQuery, model: correctedModelString };
          const retryResult = await searchListingsLean(retryQuery);

          if (retryResult.data.length > 0) {
            candidates = retryResult.data;
            total = retryResult.total;
            effectiveQuery = retryQuery;
            for (const c of corrections) {
              if (c.corrected) {
                relaxations.push({
                  step: "model_name_correction",
                  detail: `"${c.requested}" isn't a recognized model name in current inventory — corrected to "${c.corrected}".`,
                });
              }
            }
          }
        }
      }

      // Tracks the body-style value dropped by the fallback below, if any —
      // used downstream to hard-exclude any candidate whose OWN reported
      // body style/type doesn't match it, at both stage 1 (SYS-20260816-051)
      // and stage 2 (SYS-20260816-052), since the two can genuinely
      // disagree for the same VIN. Closes the real flaw found in
      // SYS-20260816-047: dropping the filter entirely can surface a
      // genuinely different body style, e.g. Convertible results for a
      // Sedan request, since some nameplates like E-Class genuinely span
      // multiple body styles. André's explicit decision (SYS-20260816-051):
      // known-wrong data is excluded outright, not shown with a caveat.
      let droppedBodyStyle: string | undefined;
      // Tracks which of the two possible fields were actually present (and
      // therefore actually dropped) — droppedStyle above only ever holds
      // ONE label string even when both bodyType and vehicleType were
      // supplied and both got dropped, so evidence wiring further down
      // needs its own record of which field(s) were truly requested and
      // truly relaxed (SYS-20260825 follow-up fix — the evidence wiring
      // previously always marked "bodyType" regardless of which field(s)
      // were actually involved).
      let droppedBodyTypeField = false;
      let droppedVehicleTypeField = false;

      // Body-style filter drop (SYS-20260816-046): vehicle.type/vehicle.bodyStyle
      // tagging is genuinely inconsistent per model, not a clean rule that can
      // be predicted or substituted for — confirmed live: Volvo V90 (a wagon)
      // is actually tagged "Crossover" in the real data, not "Wagon" or
      // "Luxury" as an earlier hypothesis this same day assumed. Retrying with
      // a DIFFERENT specific body-style value would just be guessing again.
      // When a specific model is already named, the model itself already
      // implies its own body style, so the body-style filter is redundant
      // confirmation that can backfire on inconsistent tagging — safer to
      // drop it entirely than to guess at a replacement. Runs after the
      // model-name-correction attempt above has already had its chance, and
      // only if still at zero. One retry, never a loop, always disclosed.
      if (total === 0 && candidates.length === 0 && effectiveQuery.model && (effectiveQuery.bodyType || effectiveQuery.vehicleType)) {
        const droppedStyle = effectiveQuery.bodyType ?? effectiveQuery.vehicleType;
        const hadBodyType = !!effectiveQuery.bodyType;
        const hadVehicleType = !!effectiveQuery.vehicleType;
        const { bodyType: _droppedBodyType, vehicleType: _droppedVehicleType, ...withoutBodyStyle } = effectiveQuery;
        const retryResult = await searchListingsLean(withoutBodyStyle);

        if (retryResult.data.length > 0) {
          candidates = retryResult.data;
          total = retryResult.total;
          effectiveQuery = withoutBodyStyle;
          droppedBodyStyle = droppedStyle;
          droppedBodyTypeField = hadBodyType;
          droppedVehicleTypeField = hadVehicleType;
          relaxations.push({
            step: "body_style_filter_dropped",
            detail: `Dropped the body-style filter ("${droppedStyle}") after it returned zero results for the requested model — the model already implies its own body style, and body-style tagging can be inconsistent for some vehicles.`,
          });
        }
      }

      // --- Result-count target (SYS-20260816-008) ---
      // A search is "broad" when it isn't anchored to specific model names, or
      // when the need was expressed as vehicleNeeds rather than exact hard filters.
      // Those are the searches where the host model tends to narrow the answer
      // further on its own, so they get the larger shortlist.
      const isBroadSearch = !baseQuery.model || (input.vehicleNeeds != null && input.vehicleNeeds.length > 0);
      const targetCount = isBroadSearch ? BROAD_SHORTLIST_SIZE : SHORTLIST_SIZE;

      // How many results the user would actually SEE: post-verification AND
      // post-diversity. Widening decisions must use this rather than the raw
      // provider count — a query can return 100 rows that verification strips
      // to two, which is exactly the "plenty of inventory, thin answer" case
      // this whole mechanism exists for.
      const usableCount = (rows: AutoDevListing[], q: ListingsQuery) =>
        applyDiversity(
          rows
            .filter((c) => verifyAgainstConstraints(c, q).length === 0)
            .filter(trimRequiredLeanFilter),
          targetCount,
        ).length;

      // Populated only if the widening block below actually runs — used to
      // build an honest empty-result message (SYS-20260816-030) rather than
      // a generic one that can contradict what the tool just tried.
      let widenAttemptedSteps: StepName[] = [];
      // True when the ladder ran out of time/call budget with steps still
      // untried — distinct from "tried everything relevant and none helped."
      // Must never be presented as a completed search (SYS-20260817-003).
      let widenStoppedEarly = false;

      // Widen only when the result set is genuinely thin — i.e. the standard
      // shortlist can't even be filled. Deliberately NOT triggered by merely
      // falling short of the larger broad-search target: that would fire on
      // most broad searches and spend an upstream call for a marginal gain.
      // A real service error is not "thin results" and must never widen.
      if (!rawResult.error && usableCount(candidates, effectiveQuery) < SHORTLIST_SIZE) {
        // Deadline is anchored HERE, when widening actually starts — not at
        // request start (real bug, confirmed by code + measurement 2026-08-17,
        // SYS-20260817-003). Anchoring at request start meant the primary
        // search plus the model-name-correction and body-style-drop retries
        // all consumed the widening budget before widening began: real
        // measured latencies on exactly the slow paths that need widening
        // were 12.6s, 22.1s and 35.0s against a 15s budget, so the ladder
        // could be fully expired before its first call — silently, and
        // indistinguishably from genuine scarcity.
        //
        // Also capped against the remaining time before Vercel's 60s
        // maxDuration, so a slow primary search can still shorten the
        // widening window rather than pushing the whole request into a
        // platform timeout — it just no longer zeroes it out by default.
        const elapsed = Date.now() - requestStartedAt;
        const remainingBeforePlatformTimeout = Math.max(
          0,
          VERCEL_MAX_DURATION_MS - elapsed - RESPONSE_ASSEMBLY_RESERVE_MS,
        );
        const wideningBudget = Math.min(WIDENING_TIME_BUDGET_MS, remainingBeforePlatformTimeout);

        const widenedOutcome = await widenSearchIfThin(
          effectiveQuery,
          // Widening only needs a number to compare against MIN_ACCEPTABLE —
          // when Auto.dev's total is missing (e.g. vehicle.doors filter, SYS-20260819-001),
          // candidates.length is the best available proxy for that decision.
          // This fallback is local to the widening check only; the real
          // `total` variable (possibly still null) is untouched below and
          // still reported honestly to the user unless widening actually fires.
          { data: candidates, total: total ?? candidates.length },
          {
            search: searchListingsLean,
            usableCount,
            minAcceptable: SHORTLIST_SIZE,
            priceFlexibility: input.priceFlexibility ?? "strict",
            priorityAxis: input.priorityAxis,
            deadline: Date.now() + wideningBudget,
          },
        );
        if (widenedOutcome.widened) {
          candidates = widenedOutcome.data;
          total = widenedOutcome.total;
          effectiveQuery = widenedOutcome.query;
          relaxations.push(...widenedOutcome.relaxations);
        }
        widenAttemptedSteps = widenedOutcome.attemptedSteps;
        widenStoppedEarly = widenedOutcome.stoppedEarly;
      }

      // Post-verification (SYS-20260812-035, redesign doc §5.4 step 6):
      // Auto.dev can silently swallow/mishandle params and return rows that
      // don't actually satisfy a stated filter. Mechanical check only — no
      // semantic/size-class judgment, that stays the calling LLM's job.
      const verifiedCandidates = candidates.filter(
        (c) => verifyAgainstConstraints(c, effectiveQuery).length === 0,
      );
      const violationRate = candidates.length > 0
        ? (candidates.length - verifiedCandidates.length) / candidates.length
        : 0;

      // Body-style hard exclude (SYS-20260816-051, replacing the SYS-20260816-050
      // sort-preference approach): André's explicit design decision — known-
      // wrong data should be EXCLUDED, not disclosed-and-shown. A user
      // skimming a "Strong match" result won't necessarily read a caveat
      // line closely; from their perspective a wrong body style is just a
      // wrong listing, whether the cause is our tool or Auto.dev's data.
      // This is a real, deliberate distinction from the "unknown != false"
      // principle used elsewhere (accident history, CPO): those are
      // genuinely AMBIGUOUS data, so disclosure-not-exclusion is correct.
      // A reported body-style/type that explicitly disagrees with what was
      // asked is not ambiguous — it's a confirmed mismatch. A listing with
      // NEITHER field reported is still unknown, not wrong, and stays
      // eligible rather than being excluded on missing data — same
      // unknown-isn't-false discipline, just applied to exclusion instead
      // of disclosure.
      //
      // Real flaw found live 2026-08-16 (SYS-20260816-057): Auto.dev's own
      // categorization can be wrong for genuinely correct vehicles, not just
      // for genuinely different ones — a real Volvo V90 (a wagon) is tagged
      // "Crossover" there, not "Wagon." For E-Class, the excluded candidates
      // really were a different body style (a Convertible is not a Sedan) —
      // exclusion was correct. For V90, EVERY real match got excluded
      // because the model's own tag is wrong, not because the car is wrong
      // — this hid a genuinely correct answer entirely. There's no reliable
      // way to tell these two cases apart from the tag alone. So: exclusion
      // only applies when it still leaves at least one real candidate:
      // never let it reduce an existing, real candidate pool to nothing.
      // If literally zero candidates in the whole pool match, the filter is
      // not applied at all — the same "never silently drop a real match"
      // principle already used for the widening ladder and elsewhere,
      // extended here. Mismatched candidates surfaced this way still get
      // their honest per-result "NOT the requested X" disclosure
      // (qualifier-accounting.ts) rather than looking like a plain match.
      const bodyStyleMatchFilter = (c: AutoDevListing) => {
        const target = droppedBodyStyle!.toLowerCase();
        // Runtime-safety fix (fix/provider-string-runtime-safety,
        // SYS-20260828): String()-coerced before .toLowerCase() — plain
        // optional chaining (`c.vehicle?.bodyStyle?.toLowerCase()`) only
        // guards against null/undefined, not against a present-but-wrong-
        // type value; a live production crash confirmed Auto.dev can
        // return a non-string value for a sibling field (vehicle.trim,
        // observed as the number 1958) despite its declared string type,
        // and vehicle.bodyStyle/vehicle.type carry the exact same
        // unreliable-typing risk from the same provider. Coercing to a
        // literal string here can only ever produce a value that fails
        // to equal `target` (an unusual coerced string is extremely
        // unlikely to accidentally match a real body-style name) — never
        // silently invents a match, just avoids crashing on one.
        const reportedStyle = c.vehicle?.bodyStyle != null ? String(c.vehicle.bodyStyle).toLowerCase() : null;
        const reportedType = c.vehicle?.type != null ? String(c.vehicle.type).toLowerCase() : null;
        if (reportedStyle == null && reportedType == null) return true;
        return reportedStyle === target || reportedType === target;
      };
      const bodyStyleFilteredCandidates = droppedBodyStyle
        ? (() => {
            const filtered = verifiedCandidates.filter(bodyStyleMatchFilter);
            return filtered.length > 0 ? filtered : verifiedCandidates;
          })()
        : verifiedCandidates;

      // Trim requirement, stage 1 (SYS-20260823): a confirmed non-match is
      // excluded outright — unlike bodyStyleFilteredCandidates above, there
      // is deliberately NO "never reduce a real pool to zero" fallback here.
      // Body style has that fallback because Auto.dev's own tagging can be
      // wrong for a genuinely correct vehicle (real Volvo V90 tagged
      // "Crossover"); trimRequired is instead an explicit user-stated hard
      // requirement, same category as priceMax — showing a confirmed wrong
      // trim to avoid an empty result would silently violate the exact
      // requirement being fixed here.
      const trimFilteredCandidates = trimRequired
        ? bodyStyleFilteredCandidates.filter(trimRequiredLeanFilter)
        : bodyStyleFilteredCandidates;

      // Prefer a confirmed trim match ahead of a provisional (trim
      // unknown at lean stage) candidate before diversity/shortlisting —
      // stable sort, so candidates within each group keep their existing
      // relative order (already sorted per Auto.dev's own sort/priorityAxis).
      const trimOrderedCandidates = trimRequired
        ? [...trimFilteredCandidates].sort((a, b) => {
            const aRank = trimIsConfirmedMatch(a) ? 0 : 1;
            const bRank = trimIsConfirmedMatch(b) ? 0 : 1;
            return aRank - bRank;
          })
        : trimFilteredCandidates;

      // Electrification-required pre-filter.
      // Runs BEFORE diversity/shortlist slicing, on a BOUNDED pool of up to
      // ELECTRIFICATION_POOL_SIZE (currently 20 — an UNVALIDATED placeholder,
      // not a measured value; see the open validation question documented
      // on ELECTRIFICATION_POOL_SIZE in lib/nhtsa-client.ts) candidates from
      // the front of the already-ranked list — never the full candidate set,
      // to keep the added NHTSA-call latency bounded. Only runs for electrificationRequirement: "required";
      // "preferred" and unset are zero-cost here (existing shortlist-stage
      // decode at the getListingByVin refetch below still runs regardless,
      // for the badge logic).
      //
      // A vehicle is kept only if NHTSA's own decode CONFIRMS one of the
      // requested electrificationTypes — unknown/ambiguous/not_electrified
      // are all excluded, never assumed to satisfy the request (audit
      // Section C, "unknown != false" standing principle). Per André
      // (Sep 9 2026): "hybrid" implicitly includes "mild_hybrid";
      // "plug_in_hybrid"/"electric" are never implied by "hybrid".
      //
      // KNOWN LIMITATION, flagged not hidden: this decodes the top-20 pool
      // by rank, not the full trimOrderedCandidates set. If fewer than
      // targetCount of those 20 confirm, the shortlist is genuinely shorter
      // — the code deliberately does NOT expand the pool past 20 to backfill,
      // since that's the exact bounded-latency tradeoff the spike measured
      // and André signed off on. `electrificationShortfall` below surfaces
      // this to the response's dataNotes rather than silently truncating.
      const electrificationRequired =
        input.electrificationRequirement === "required" &&
        input.electrificationTypes != null &&
        input.electrificationTypes.length > 0;
      // [unverified citation removed]: "preferred" reuses the exact same bounded top-20
      // pool/decode mechanism as "required" — never an additional/unbounded
      // NHTSA call budget, and never both required+preferred at once since
      // they're mutually exclusive enum values. Unlike "required", nothing
      // is excluded here: candidates outside the top-20 pool (rank 21+)
      // simply have no decode data and electrificationMatchOf() returns
      // false for them — they're neither promoted nor penalized, just not
      // preferentially reordered, which keeps this genuinely bounded-latency
      // rather than decoding the whole candidate set.
      const electrificationPreferred =
        input.electrificationRequirement === "preferred" &&
        input.electrificationTypes != null &&
        input.electrificationTypes.length > 0;
      // [unverified citation removed]: real TypeScript compile failure, reproduced and
      // confirmed locally before this fix — mutating an outer `let` from
      // inside a nested async closure (the previous version of this code)
      // breaks TS's control-flow narrowing at the read site 400+ lines
      // below (`if (electrificationShortfall)` was typed `never` there,
      // a genuine TS limitation with this pattern, not a false alarm).
      // Fixed by having the closure RETURN both values together instead
      // of mutating a captured variable — ordinary destructuring narrows
      // correctly.
      const electrificationResult = electrificationRequired
        ? await (async () => {
            const requestedTypes = input.electrificationTypes!;
            const pool = trimOrderedCandidates.slice(0, ELECTRIFICATION_POOL_SIZE);
            const poolNhtsa = await Promise.all(
              pool.map((c) =>
                decodeNhtsaElectrification(c.vin, c.vehicle?.make, c.vehicle?.model, c.vehicle?.cylinders),
              ),
            );
            const confirmed = pool.filter((_, i) =>
              electrificationStateSatisfies(poolNhtsa[i]?.electrificationState, requestedTypes),
            );
            const shortfall =
              confirmed.length < targetCount
                ? { requested: targetCount, confirmed: confirmed.length }
                : null;
            return { candidates: confirmed, shortfall, matchedVins: null as Set<string> | null };
          })()
        : electrificationPreferred
        ? await (async () => {
            // Ranking-only: no exclusion, no shortfall. Bounded to the same
            // top-20 pool as "required" (ELECTRIFICATION_POOL_SIZE) — see
            // comment above.
            const requestedTypes = input.electrificationTypes!;
            const pool = trimOrderedCandidates.slice(0, ELECTRIFICATION_POOL_SIZE);
            const poolNhtsa = await Promise.all(
              pool.map((c) =>
                decodeNhtsaElectrification(c.vin, c.vehicle?.make, c.vehicle?.model, c.vehicle?.cylinders),
              ),
            );
            const matchedVins = new Set(
              pool
                .filter((_, i) => electrificationStateSatisfies(poolNhtsa[i]?.electrificationState, requestedTypes))
                .map((c) => c.vin),
            );
            return { candidates: trimOrderedCandidates, shortfall: null as { requested: number; confirmed: number } | null, matchedVins };
          })()
        : {
            candidates: trimOrderedCandidates,
            shortfall: null as { requested: number; confirmed: number } | null,
            matchedVins: null as Set<string> | null,
          };
      const electrificationFilteredCandidates = electrificationResult.candidates;
      const electrificationShortfall = electrificationResult.shortfall;
      // Predicate form for the ordering functions below. Deliberately
      // undefined (not a function that always returns false) when
      // electrification-preferred wasn't requested at all, so
      // applyLocalBestForBudgetOrdering/applyLocalLowerRiskOrdering's own
      // "absent electrificationMatchOf -> zero effect" short-circuit
      // applies and existing non-electrification searches are byte-for-byte
      // unchanged.
      const electrificationMatchOf = electrificationResult.matchedVins
        ? (c: AutoDevListing) => electrificationResult.matchedVins!.has(c.vin)
        : undefined;

      const diversified = applyDiversity(
        // EXPERIMENT (preview only): local best_for_budget ordering, applied
        // only for that axis (or unset, its default) — cheapest/
        // lowest_mileage/newest pass through unchanged. Provider retrieval/
        // sort (resolveSort() above) is completely untouched.
        //
        // lower_risk (feature/lower-risk-mvp): same architecture, its own
        // local reordering pass (applyLocalLowerRiskOrdering, above) —
        // mutually exclusive with best_for_budget's pass, never both.
        //
        // KNOWN LIMITATION, flagged not hidden ([unverified citation removed]): the
        // cheapest/lowest_mileage/newest axes intentionally do NOT get an
        // electrification-preferred nudge — those three axes' own module
        // docs establish "provider's exact sort is untouched" as a
        // deliberate guarantee, and adding a ranking nudge there would
        // break that documented exactness. electrificationRequirement:
        // "preferred" currently only affects ordering under best_for_budget
        // (default) and lower_risk.
        input.priorityAxis === "best_for_budget" || input.priorityAxis == null
          ? applyConfigurationVarietyPass(
              applyLocalBestForBudgetOrdering(electrificationFilteredCandidates, intent.semantic.trimPreference, electrificationMatchOf),
            )
          : input.priorityAxis === "lower_risk"
          ? applyLocalLowerRiskOrdering(electrificationFilteredCandidates, electrificationMatchOf)
          : electrificationFilteredCandidates,
        targetCount * 2,
      );
      const leanShortlist = diversified.slice(0, targetCount);
      // Held in reserve for stage-2 backfill (SYS-20260817-013) if body-style
      // exclusion leaves the shortlist short — these already passed stage-1
      // lean verification and the stage-1 body-style filter, they just
      // haven't had a stage-2 full-detail check yet. Capped at targetCount
      // spares (diversified is built to targetCount*2), so backfill is
      // bounded by construction — never an open-ended search for more.
      const spareLean = diversified.slice(targetCount, targetCount * 2);

      // Stage 2: full detail for exactly the shortlisted vehicles, in parallel.
      // Confirmed working, exact, fast (4.66s for 5 VINs), SYS-20260812-060.
      // Falls back to the lean row itself if a single fetch fails - a partial
      // result (still has vin/make/model/year/price/miles, still gets a real
      // Edmunds link) beats silently dropping a real match.
      const fullDetail = await Promise.all(
        leanShortlist.map((lean) => getListingByVin(lean.vin)),
      );
      const refetched = leanShortlist.map((lean, i) => fullDetail[i] ?? lean);

      // NHTSA electrification check (SYS-20260819-002): same shortlist stage
      // as the full-detail refetch above, run in parallel, never blocks the
      // search — a failed/slow NHTSA call just means that one result keeps
      // relying on Auto.dev's own (known-incomplete) fuel field, same as
      // before this feature existed.
      const nhtsaResults = await Promise.all(
        refetched.map((listing) =>
          decodeNhtsaElectrification(
            listing.vin,
            listing.vehicle?.make,
            listing.vehicle?.model,
            listing.vehicle?.cylinders,
          ),
        ),
      );
      // Keyed by VIN, not index — backfill spares (spareLean, added later if
      // body-style exclusion leaves the shortlist short) never went through
      // this lookup, so a positional zip would silently misalign. Cards for
      // any VIN not in this map simply get `undefined`, same as before this
      // feature existed.
      const nhtsaByVin = new Map(refetched.map((listing, i) => [listing.vin, nhtsaResults[i]]));

      // Post-refetch re-verification (SYS-20260816-004): getListingByVin is a
      // separate, independent Auto.dev fetch and can return a price (or other
      // hard-constraint fields) that differs from the already-verified stage-1
      // lean data — e.g. a live price change between the search call and the
      // per-VIN refetch. Without this check, a listing that correctly passed
      // priceMax/verifyAgainstConstraints at stage 1 could reach the user
      // over budget at stage 2 with zero re-verification, even under
      // priceFlexibility: "strict". Real, confirmed bug — not Auto.dev
      // buffering, not a caller-side parameter mistake (found investigating
      // André's live testing question, root-caused by reading this file).
      //
      // Fixed (SYS-20260822): this used to fall back to the *lean* record
      // whenever the fresh full-detail record violated a constraint. That's
      // backwards — the fresh full-detail fetch is authoritative here, so a
      // confirmed contradiction (e.g. price now over budget) must never be
      // hidden by reverting to older, possibly-stale lean data. A real
      // production result was found missing primaryImage, used/new status,
      // dealer location, drivetrain and Carfax while still showing
      // price/mileage — root cause was exactly this substitution silently
      // serving a stale/incomplete lean row while looking "resolved". Now:
      // a confirmed constraint violation on the full-detail record excludes
      // that candidate entirely (never substitutes lean) and the caller
      // backfills from the spare pool, same architecture as the existing
      // body-style backfill below. A genuine full-detail *lookup failure*
      // (fetch returned null) is a different case — lean fallback is still
      // fine there since we have no fresher data to trust or distrust —
      // logged separately as detail_lookup_failed.
      //
      // Fixed again (SYS-20260823, VIN W1N4N5BB1TJ864755 confirmed live):
      // full-detail is authoritative for everything EXCEPT price. Auto.dev's
      // full-detail endpoint was observed returning $61,515 for a VIN whose
      // live listing (Edmunds-confirmed) and stage-1 lean/listings price
      // were both $59,935 — full-detail's own price was simply wrong. Price
      // now uses the stage-1 lean price as canonical whenever present
      // (logged as stage2_price_disagreement when the two differ), while
      // every other full-detail field is retained unchanged. This is a
      // single-field override, not the whole-record lean substitution that
      // was removed above.
      //
      // Uses effectiveQuery, not baseQuery: if the widening ladder ran, stage 1
      // verified against the widened constraints, so stage 2 must too — checking
      // against the original would reject exactly the rows widening just gained
      // and silently undo it (SYS-20260816-008).
      //
      // Factored into a helper so the exact same lookup-failure/constraint-drift
      // resolution can run a second time on the spare pool during backfill,
      // instead of duplicating this block.
      function resolveStage2Detail(
        leanRows: AutoDevListing[],
        fullRows: (AutoDevListing | null)[],
      ): { kept: AutoDevListing[]; anyLookupFailed: boolean; anyConstraintDrift: boolean } {
        const kept: AutoDevListing[] = [];
        let anyLookupFailed = false;
        let anyConstraintDrift = false;

        for (let i = 0; i < leanRows.length; i++) {
          const lean = leanRows[i];
          const full = fullRows[i];

          if (!full) {
            // Case 1: genuine lookup failure. Lean fallback still allowed so
            // a real candidate isn't unnecessarily lost — no new Auto.dev
            // call/retry added here.
            anyLookupFailed = true;
            console.log(
              `[find_matching_vehicle] stage2 detail_lookup_failed vin=${lean.vin} — full-detail fetch returned null, using lean fallback`,
            );
            kept.push(lean);
            continue;
          }

          // Price precedence (confirmed production case, VIN
          // W1N4N5BB1TJ864755): Auto.dev's full-detail endpoint can return a
          // stale/incorrect price for a VIN whose live listing (Edmunds
          // confirmed) matches the stage-1 lean/listings price exactly —
          // the lean price is canonical for price specifically, applied
          // unconditionally whenever present, before constraint checking.
          // This does NOT revert the whole record to lean: every other
          // full-detail field (photo, dealer, location, drivetrain,
          // Carfax, used/new, history, mileage, year, make, model, etc.)
          // stays exactly as returned by the full-detail fetch. If lean
          // price is missing, fall back to the full-detail price
          // (unchanged behavior).
          const leanPrice = lean.retailListing?.price ?? null;
          const fullPrice = full.retailListing?.price ?? null;
          if (leanPrice != null && fullPrice != null && leanPrice !== fullPrice) {
            console.log(
              `[find_matching_vehicle] stage2_price_disagreement vin=${lean.vin} leanPrice=${leanPrice} fullPrice=${fullPrice} chosenPrice=${leanPrice}`,
            );
          }
          const priceResolved: AutoDevListing =
            leanPrice != null && full.retailListing
              ? { ...full, retailListing: { ...full.retailListing, price: leanPrice } }
              : full;

          const violations = verifyAgainstConstraints(priceResolved, effectiveQuery);
          if (violations.length === 0) {
            kept.push(priceResolved);
            continue;
          }

          // Case 2: full-detail lookup succeeded but the resolved record
          // (with the canonical lean price applied, when available) still
          // contradicts a hard constraint already checked by
          // verifyAgainstConstraints() — e.g. year, mileage, make, model,
          // or a price still over budget even at the lean value. The
          // resolved record is authoritative — exclude rather than
          // reverting to the whole lean row, and let the caller backfill.
          anyConstraintDrift = true;
          console.log(
            `[find_matching_vehicle] stage2 full_detail_rejected_due_to_constraint_drift ` +
              `vin=${lean.vin} violations=${JSON.stringify(violations)} ` +
              `leanPrice=${leanPrice} fullPrice=${fullPrice} ` +
              `leanMileage=${lean.retailListing?.miles ?? null} fullMileage=${full.retailListing?.miles ?? null} ` +
              `leanYear=${lean.vehicle?.year ?? null} fullYear=${full.vehicle?.year ?? null} ` +
              `leanMake=${lean.vehicle?.make ?? null} fullMake=${full.vehicle?.make ?? null} ` +
              `leanModel=${lean.vehicle?.model ?? null} fullModel=${full.vehicle?.model ?? null}`,
          );
        }

        return { kept, anyLookupFailed, anyConstraintDrift };
      }

      const {
        kept: shortlistWithPriceCheck,
        anyLookupFailed: detailLookupFailedFromPrimary,
        anyConstraintDrift: priceDriftFromPrimary,
      } = resolveStage2Detail(leanShortlist, fullDetail);
      let priceDriftDetected = priceDriftFromPrimary;
      let detailLookupFailedDetected = detailLookupFailedFromPrimary;

      // Body-style stage-2 re-check (SYS-20260816-052): the SYS-20260816-051
      // exclude filter runs on stage-1 lean data, but confirmed live that
      // lean and stage-2 full-detail data can genuinely disagree on
      // bodyStyle/type for the same VIN — a candidate can pass the lean-data
      // exclude check and still arrive at stage 2 with a body style that
      // doesn't match what was requested. Same root shape as the proven
      // SYS-20260816-004/005 price-drift fix above: stage 1 isn't
      // authoritative, stage 2 is, so re-check there too.
      //
      // Backfill (SYS-20260817-013): previously, any candidate excluded here
      // was just gone — the shortlist arrived short of targetCount with no
      // attempt to replace it, even though real, un-tried candidates were
      // already sitting in `spareLean`. Confirmed live (Volvo V90, Mercedes
      // E-Class): 3 results shown against a 5-result target, real inventory
      // available. Now: excluded slots are backfilled from the spare pool,
      // one bounded round, before ever falling back to showing mismatches.
      // If a genuine match exists in the spares, the user sees a genuine
      // match instead of a "shown anyway, wrong body style" caveat — a
      // strictly better outcome, and consistent with the project's standing
      // preference for a true result over a false one wherever possible.
      //
      // Same never-reduce-a-real-pool-to-zero fallback as stage 1
      // (SYS-20260816-057): only once BOTH the primary shortlist AND the
      // backfill attempt fail to produce any genuine match at all does this
      // fall back to showing the mismatched entries rather than nothing —
      // each still gets its own honest "NOT the requested X" disclosure via
      // qualifier-accounting.ts, never a bare confirmation.
      let bodyStyleDriftDetected = false;
      let bodyStyleFallbackUsed = false;
      // Trim requirement, stage 2 (SYS-20260823): unlike body style, this
      // NEVER falls back to showing a non-matching/still-unresolved trim —
      // trimRequired is an explicit hard requirement, not a data-tagging
      // quirk to route around. If genuinely nothing satisfies it after the
      // primary shortlist and one backfill round, the result is an empty
      // (or partial) shortlist, same as any other hard filter exhausting
      // real inventory — never a silently-included wrong trim.
      let trimDriftDetected = false;
      // Geographic radius verification, stage 2 (SYS-20260827): same
      // architecture as body style/trim above — Auto.dev's own radius
      // filter is not trusted as ground truth. Only fires when the
      // listing's confirmed reported state is provably outside the
      // effective (possibly widened) radius from the search ZIP — see
      // lib/geo-verification.ts for the full "unknown ≠ false, never
      // guess" design. Uses effectiveQuery.radius specifically (not the
      // original baseQuery/input radius) so a legitimately widened search
      // (e.g. 50 -> 100 miles) is verified against the widened radius, not
      // the original one — the same effectiveQuery discipline already
      // established for verifyAgainstConstraints() above.
      let geoDriftDetected = false;
      const applyLocalStage2Filters = (full: AutoDevListing): boolean => {
        let ok = true;
        if (droppedBodyStyle) {
          const matches = bodyStyleMatchFilter(full);
          if (!matches) bodyStyleDriftDetected = true;
          ok = ok && matches;
        }
        if (trimRequired) {
          const matches = trimRequiredFullFilter(full);
          if (!matches) {
            trimDriftDetected = true;
            console.log(
              `[find_matching_vehicle] stage2 trim_required_rejected vin=${full.vin} trimRequired=${trimRequired} reportedTrim=${full.vehicle?.trim ?? null}`,
            );
          }
          ok = ok && matches;
        }
        const confirmedOutsideRadius = isConfirmedOutsideRadius(
          effectiveQuery.zip,
          effectiveQuery.radius,
          full.retailListing?.state,
        );
        if (confirmedOutsideRadius) {
          geoDriftDetected = true;
          console.log(
            `[find_matching_vehicle] stage2 geo_radius_rejected vin=${full.vin} searchZip=${effectiveQuery.zip ?? null} effectiveRadius=${effectiveQuery.radius ?? null} reportedState=${full.retailListing?.state ?? null} reportedCity=${full.retailListing?.city ?? null}`,
          );
        }
        ok = ok && !confirmedOutsideRadius;
        return ok;
      };
      const shortlist = await (async () => {
        // Shortfall can now come from body-style exclusion, from
        // full_detail_rejected_due_to_constraint_drift exclusion above, from
        // a trimRequired exclusion, or from a confirmed-outside-radius
        // exclusion — all four reduce shortlistWithPriceCheck below
        // targetCount, so the backfill below must run for any of these
        // causes, not just when a body style was dropped.
        const primaryMatches = (droppedBodyStyle || trimRequired || effectiveQuery.zip)
          ? shortlistWithPriceCheck.filter(applyLocalStage2Filters)
          : shortlistWithPriceCheck;

        const shortfall = targetCount - primaryMatches.length;
        if (shortfall <= 0 || spareLean.length === 0) {
          if (primaryMatches.length > 0) return primaryMatches;
          if (trimRequired) return []; // hard requirement — never fall back to a non-matching/unresolved trim
          bodyStyleFallbackUsed = shortlistWithPriceCheck.length > 0;
          return shortlistWithPriceCheck;
        }

        // One bounded backfill round: fetch stage-2 detail for the spare
        // pool (already capped to targetCount by construction above), same
        // lookup-failure/constraint-drift resolution as the primary shortlist.
        const spareFullDetail = await Promise.all(
          spareLean.map((lean) => getListingByVin(lean.vin)),
        );
        const {
          kept: spareResolved,
          anyLookupFailed: spareLookupFailed,
          anyConstraintDrift: spareDrift,
        } = resolveStage2Detail(spareLean, spareFullDetail);
        if (spareDrift) priceDriftDetected = true;
        if (spareLookupFailed) detailLookupFailedDetected = true;

        const backfillMatches = ((droppedBodyStyle || trimRequired || effectiveQuery.zip)
          ? spareResolved.filter(applyLocalStage2Filters)
          : spareResolved
        ).slice(0, shortfall);

        const combined = [...primaryMatches, ...backfillMatches];
        if (combined.length > 0) return combined;

        if (trimRequired) return []; // hard requirement — never fall back to a non-matching/unresolved trim
        bodyStyleFallbackUsed = shortlistWithPriceCheck.length > 0;
        return shortlistWithPriceCheck;
      })();

      const intentInput: CardIntentInput = {
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        cylinders: input.cylinders,
        doors: input.doors,
        vehicleType: input.vehicleType,
        used: input.used,
        cpo: input.cpo,
        noAccidents: input.noAccidents,
        oneOwner: input.oneOwner,
        // Resolved value, not raw input — picks up goal-inferred seat needs
        // (e.g. "family car") as well as an explicit seatsMinPreference.
        seatsMinPreference: intent.semantic.seatsMin,
        droppedBodyStyleFilter: droppedBodyStyle,
        trimRequired,
      };

      // Constraint evidence (SYS-20260825): "requested" values come from
      // intent.hardConstraints (the originally-stated, never-widened values
      // — the same object parseIntent() produced once at the top of this
      // handler, untouched by the widening ladder below it, which only
      // mutates the separate effectiveQuery variable) plus the raw input
      // for the fields intent.hardConstraints doesn't carry. relaxedFields
      // is derived only from this handler's own already-known, explicit
      // relaxation state — never inferred by the evidence module itself.
      const relaxedFields = new Set<string>();
      for (const r of relaxations) {
        if (r.step === "price") relaxedFields.add("priceMax");
        if (r.step === "year") {
          relaxedFields.add("yearMin");
          relaxedFields.add("yearMax");
        }
        if (r.step === "mileage") relaxedFields.add("mileageMax");
        // "radius" and the model-name-correction steps don't correspond to
        // any evidence field above — intentionally not mapped.
      }
      if (droppedBodyTypeField) relaxedFields.add("bodyType");
      if (droppedVehicleTypeField) relaxedFields.add("vehicleType");

      const searchEvidenceRequest: ConstraintEvidenceRequest = {
        make: intent.hardConstraints.make,
        model: intent.hardConstraints.model,
        priceMin: intent.hardConstraints.priceMin,
        priceMax: intent.hardConstraints.priceMax,
        yearMin: intent.hardConstraints.yearMin,
        yearMax: intent.hardConstraints.yearMax,
        mileageMax: intent.hardConstraints.mileageMax,
        bodyType: intent.hardConstraints.bodyType,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        vehicleType: input.vehicleType,
        doors: input.doors,
        cylinders: input.cylinders,
        used: input.used,
        state: input.state,
        trimRequired: intent.trimRequired,
      };

      const cards = (
        await Promise.all(
          shortlist.map((listing) =>
            buildResultCard(listing, intent, intentInput, nhtsaByVin.get(listing.vin), searchEvidenceRequest, relaxedFields),
          ),
        )
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      // Match Score ordering is only correct for the default best_for_budget
      // axis, where "best overall fit" is genuinely what the user asked for.
      // For directional axes (cheapest/lowest_mileage/newest), the shortlist
      // already arrives in the correct order — it was fetched from Auto.dev
      // with the matching sort (resolveSort() above: price.asc/miles.asc/
      // year.desc) and that order survives diversity capping and the stage-2
      // detail refetch unchanged, since both preserve array order rather than
      // reordering. Re-sorting by Match Score here silently overwrote that
      // correct order for every search regardless of priorityAxis, which is
      // exactly what caused three separate real, confirmed 50+ second
      // multi-call incidents in live testing (Aug 15 baseline, SYS-20260815-
      // 001/002: cheapest, lowest_mileage, and newest all affected) — the
      // calling LLM had to manually re-verify and narrow the ceiling itself
      // because our own "cheapest"/"newest" results weren't actually ordered
      // that way by the time they reached it.
      if (input.priorityAxis === "cheapest" || input.priorityAxis === "lowest_mileage" || input.priorityAxis === "newest") {
        // Leave cards in their already-correct fetched order — do not re-sort.
      } else if (input.priorityAxis === "lower_risk") {
        // Final-card risk sort (feature/lower-risk-mvp follow-up #2):
        // applyLocalLowerRiskOrdering() already ranked the LEAN candidates
        // by risk tier before stage-2, but that lean pre-ranking was
        // falling into this same Match Score branch below and being
        // silently overwritten, the same class of bug the cheapest/
        // lowest_mileage/newest branch above already exists to prevent.
        // Fixed by re-sorting the FINAL full-detail cards here by their
        // own c.risk.tier via the same riskTierRank() helper
        // applyLocalLowerRiskOrdering() uses — preferable to merely
        // preserving the lean order, since the final card carries the
        // authoritative full-detail risk evidence (lean is necessarily a
        // pre-stage-2 approximation). Stable sort by tier rank ONLY —
        // candidates within the same tier keep whatever relative order
        // diversity/shortlisting already produced, no secondary scoring
        // formula invented on top. Match Score itself is completely
        // untouched by this branch; a higher Match Score amber/red card
        // can never jump above a lower Match Score positive/unknown card.
        cards.sort((a, b) => riskTierRank(a.risk.tier) - riskTierRank(b.risk.tier));
      } else {
        cards.sort((a, b) => b.ranking.matchScore - a.ranking.matchScore);
      }

      const dataNotes: string[] = [];
      if (lowestMileageDefaultedToUsed) {
        dataNotes.push(
          "Searched used vehicles only — \"lowest mileage\" defaults to used, not new or dealer-demo inventory, since a new car's low mileage isn't a meaningful comparison. Ask for new vehicles specifically if that's what you want.",
        );
      }
      if (priceDriftDetected) {
        dataNotes.push(
          "One or more listings had details at the time of the detailed lookup that still didn't match your stated filters even after reconciling a known price discrepancy against the originally verified data (e.g. a genuine year or mileage conflict) — those results were excluded and, where possible, replaced with an alternate match.",
        );
      }
      if (bodyStyleFallbackUsed) {
        dataNotes.push(
          `None of the results could be confirmed as a genuine ${droppedBodyStyle} — Auto.dev's own data appears to mislabel this model's body style. Shown anyway since they're still the correct model, with each result's actual reported body style disclosed individually below.`,
        );
      } else if (bodyStyleDriftDetected) {
        dataNotes.push(
          `One or more listings turned out not to be a genuine ${droppedBodyStyle} at the detailed lookup stage, despite passing the initial search — excluded rather than shown as a mismatch.`,
        );
      }
      if (trimDriftDetected) {
        dataNotes.push(
          `One or more listings turned out not to be a genuine ${trimRequired} at the detailed lookup stage, despite passing the initial search — excluded rather than shown as a mismatch, since ${trimRequired} was a specific requirement, not a preference.`,
        );
      }
      if (geoDriftDetected) {
        dataNotes.push(
          "One or more listings were confirmed to be reported far outside the requested search radius at the detailed lookup stage, despite passing the provider's own radius filter — excluded rather than shown as a mismatch.",
        );
      }
      if (violationRate > 0.2) {
        dataNotes.push(
          "Some results from the underlying data source didn't fully match the stated filters and were excluded — this can happen with the provider's data.",
        );
      }
      if (rawResult.degraded) {
        dataNotes.push(rawResult.degraded);
      }
      if (electrificationShortfall) {
        dataNotes.push(
          `Only ${electrificationShortfall.confirmed} of the usual ${electrificationShortfall.requested} results could be ` +
            `confirmed by NHTSA as matching the required electrification type — fewer results are shown rather than ` +
            `including any vehicle whose electrification status couldn't be verified.`,
        );
      }
      if (scopeNote === "nationwide" && rawZip != null) {
        dataNotes.push("The requested location wasn't recognized, so this search was widened to nationwide.");
      } else if (scopeNote === "nationwide") {
        dataNotes.push("No location was specified, so this search covers listings nationwide rather than a specific area.");
      } else if (scopeNote === "statewide") {
        dataNotes.push(`No specific ZIP or city was given, so this search covers all of ${baseQuery.state} rather than a specific area.`);
      }

      const response = {
        meta: {
          totalCandidatesConsidered: candidates.length,
          totalMatches: typeof total === "number" ? total : null,
          resultsShown: cards.length,
          corpusSizeApprox: getCorpusCountForDescription(),
          relaxations,
          dataNotes,
          scopeNote,
          serviceError: rawResult.error ?? null,
          interpretationNotes: intent.interpretationNotes,
          qualifierAccounting: buildQualifierAccounting(intentInput),
        },
        results: cards,
      } satisfies FindMatchingVehicleOutput;

      // The text content block is what the host model actually reads and
      // reasons over — structuredContent is supplementary, not a substitute.
      // Real testing (Aug 13) showed the model only surfaced a one-line
      // summary and couldn't answer follow-ups about the other results, so
      // every result's key detail now goes directly into this text.
      const totalPhrase = typeof total === "number" ? ` out of ${total} in the area` : "";

      // Honest disclosure prefix — any relaxation or data quality note must
      // reach the model's text, not just structuredContent (SYS-20260812-011
      // #3, redesign doc §5 "CALLING LLM presents results and *honestly
      // narrates* any relaxations").
      const disclosurePrefix =
        relaxations.length > 0 || dataNotes.length > 0
          ? [...relaxations.map((r) => `Note: ${r.detail}`), ...dataNotes].join("\n") + "\n\n"
          : "";

      // A failed request must never be reported as "no cars matched" - that
      // sends the user off changing their perfectly good search criteria when
      // the real problem was that the request never completed.
      const serviceFailureMessage = rawResult.error
        ? `${rawResult.error} Your search criteria look fine — this is worth retrying in a moment.`
        : null;

      // Honest empty-result message (SYS-20260816-030): the old version
      // always suggested widening radius/mileage/year, even when automatic
      // widening had already tried exactly that and genuinely found nothing
      // — a real, confirmed failure mode (André's live testing, Aug 16),
      // where the message contradicted what the tool itself had just done.
      // Now built from what actually happened: if nothing was attempted (no
      // zip/mileageMax/yearMin to widen in the first place), the original
      // generic suggestion still applies. If widening WAS attempted and
      // still found nothing, say so plainly and point at genuinely untried
      // levers instead of repeating ones already exhausted.
      const STEP_LABELS: Record<StepName, string> = {
        radius: "search radius",
        mileage: "mileage ceiling",
        year: "year range",
        price: "price ceiling",
      };
      const uniqueAttemptedSteps = Array.from(new Set(widenAttemptedSteps));

      // Non-geographic ZIP check (SYS-20260817-005): a real, confirmed bug —
      // some valid, real US ZIPs (PO-Box-only downtown ZIPs, federal
      // buildings, some university/military ZIPs) can't be geocoded to a
      // meaningful search radius, and Auto.dev silently returns zero rather
      // than erroring. Without this check, that reads exactly like a
      // genuine inventory gap and gets reported as one — a confidently
      // wrong diagnosis. Live-confirmed: zip 77001 (Houston, PO-Box-only)
      // returns 0 total for ANY make/model, while every neighboring zip
      // (77002/77004/77024/77030) returns ~690.
      //
      // Deliberately NOT a general geocoding solution — André's explicit
      // direction: most users type a real, geographic ZIP; this needs an
      // easy, cheap check with honest feedback, not an attempt to resolve
      // or correct the bad ZIP itself. One extra lightweight call, firing
      // only in the already-rare true-zero-after-widening case, using the
      // same unfiltered-except-location shape and 100mi radius as the
      // widening ladder's own max radius step for consistency. A make/
      // model/price-agnostic control query isolates whether the ZIP itself
      // is the problem, rather than this specific search being genuinely
      // thin.
      let zipLikelyInvalid = false;
      if (cards.length === 0 && !rawResult.error && rawZip) {
        const control = await searchListingsLean({ zip: rawZip, radius: 100, limit: 1 });
        zipLikelyInvalid = !control.error && control.total === 0;
      }

      // When the ladder halted on its budget with steps untried, neither
      // standard message is truthful: claiming "more widening on those
      // dimensions wouldn't help" overstates what was checked, and the
      // nothing-attempted message tells the user to widen when the tool
      // silently declined to. Say plainly that the search was cut short
      // (SYS-20260817-003).
      const noResultsMessage = zipLikelyInvalid
        ? `No vehicles matched these criteria, and a broader check found zero listings of ANY kind near ZIP ${rawZip} — this looks like the ZIP itself may not be resolving to a valid searchable location (for example, some ZIPs are PO-Box-only with no real street addresses nearby) rather than a genuine inventory gap. Double-checking the ZIP, or trying a nearby one, is more likely to help than widening price, year, or model.`
        : widenStoppedEarly
        ? uniqueAttemptedSteps.length > 0
          ? `No vehicles matched these criteria. Automatic widening of the ${uniqueAttemptedSteps
              .map((s) => STEP_LABELS[s])
              .join(", ")} was tried without success, and the search was then cut short before every option could be checked — so this may not be the full picture. Trying again, or searching a different location or broader model list, may surface options.`
          : "No vehicles matched these criteria, and the automatic widening step was cut short before it could run — so this may not be the full picture. Trying again, or widening the price range, location radius, or year range yourself, may surface options."
        : uniqueAttemptedSteps.length > 0
          ? `No vehicles matched these criteria, even after automatically trying to widen the ${uniqueAttemptedSteps
              .map((s) => STEP_LABELS[s])
              .join(", ")} — this looks like a genuine inventory gap for this exact combination, not something more widening on those same dimensions would fix. A different location, a broader model list, or (if the budget allows) some price flexibility may help instead.`
          : "No vehicles matched these criteria. Widening the price range, location radius, or year range would likely surface options.";

      // Partial-success disclosure gap (SYS-20260816-049, real bug found live
      // 2026-08-16): a widening step can be genuinely attempted and fail to
      // help even when the search DID find some results, just fewer than the
      // target — that case previously had no disclosure at all, since the
      // logic above only covers the fully-empty case. `relaxations` already
      // covers every widening step that DID help; this covers the ones that
      // were tried and didn't, so the user isn't left wondering whether more
      // was tried on their behalf.
      const successfulWideningSteps = new Set(
        relaxations
          .map((r) => r.step)
          .filter((s): s is StepName => (["radius", "mileage", "year", "price"] as string[]).includes(s)),
      );
      const unsuccessfulAttemptedSteps = uniqueAttemptedSteps.filter((s) => !successfulWideningSteps.has(s));
      const isThin = cards.length > 0 && cards.length < targetCount;
      const partialWideningNote = !isThin
        ? ""
        : widenStoppedEarly
          ? unsuccessfulAttemptedSteps.length > 0
            ? `Note: Also tried widening the ${unsuccessfulAttemptedSteps
                .map((s) => STEP_LABELS[s])
                .join(", ")} without additional matches, then stopped before every option could be checked — there may be more available than shown here.\n\n`
            : `Note: The automatic widening step was cut short before it could finish, so there may be more available than shown here.\n\n`
          : unsuccessfulAttemptedSteps.length > 0
            ? `Note: Also tried widening the ${unsuccessfulAttemptedSteps
                .map((s) => STEP_LABELS[s])
                .join(", ")}, but that didn't turn up any additional matches.\n\n`
            : "";

      const summary =
        serviceFailureMessage
          ? disclosurePrefix + serviceFailureMessage
          : cards.length === 0
          ? disclosurePrefix + noResultsMessage
          : disclosurePrefix + partialWideningNote + `Found ${cards.length} closely matching vehicle${cards.length === 1 ? "" : "s"}${totalPhrase}:\n\n` +
            cards
              .map((c, i) => {                const id = c.identity;
                const l = c.listing;
                const r = c.ranking;
                const priceAnomalous = c.badges.includes("price-likely-inaccurate");
                const priceStr = l.price != null
                  ? `$${l.price.toLocaleString()}${priceAnomalous ? " ⚠️ price looks like a data error, verify before trusting it" : ""}`
                  : "price unavailable";
                const mileageStr = l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "mileage unknown";
                const dealerStr = l.dealer ? ` — ${l.dealer}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}` : "";
                // (SYS-20260904-002) affiliateUrl (exact-VIN for Used, close
                // trim-specific for New/Carvana) is always the primary
                // user-facing link when present. dealerListingUrl (including
                // Carvana's own VDP) is NEVER routed to as a user-facing
                // destination — it stays available internally via
                // c.links.dealerListingUrl on structuredContent only. When
                // affiliateUrl is null, affiliateFallbackUrl becomes the
                // primary destination instead, labeled explicitly as similar
                // options rather than "this vehicle".
                const similarOptionsLabel = `similar ${id.year ?? ""} ${id.make ?? ""} ${id.model ?? ""}`.replace(/\s+/g, " ").trim();
                const fallbackLinkStr = c.links.affiliateFallbackUrl
                  ? ` · If that Edmunds listing is no longer available, see ${similarOptionsLabel}: ${c.links.affiliateFallbackUrl}`
                  : "";
                const linkStr = c.links.affiliateUrl
                  ? c.links.affiliateUrl + fallbackLinkStr
                  : c.links.affiliateFallbackUrl
                  ? `Similar options on Edmunds (${similarOptionsLabel}): ${c.links.affiliateFallbackUrl}`
                  : "no link available";
                const conditionStr =
                  c.condition.inventoryType === "new"
                    ? "New"
                    : c.condition.inventoryType === "used"
                    ? c.condition.cpo === true
                      ? "Certified Pre-Owned (Used)"
                      : "Used"
                    : null; // "unknown" — omit rather than guess
                const historyLine = c.history.state === "known_issues" ? `\n   ⚠️ ${c.history.note}` : "";
                // Qualifier accounting: only for fields the user actually
                // asked about (c.intentConfirmations is already scoped to
                // that). Skip the history note here if it's already shown
                // via historyLine above, so it isn't repeated twice.
                const confirmedItems = c.intentConfirmations.filter(
                  (x) => !(c.history.state === "known_issues" && x === c.history.note),
                );
                const confirmedLine = confirmedItems.length > 0 ? `\n   Confirmed: ${confirmedItems.join(", ")}` : "";
                const conflictLine = c.dataConflicts.length > 0 ? `\n   ⚠️ ${c.dataConflicts.join(" ")}` : "";
                return `${i + 1}. ${formatVehicleTitle(id)} — VIN ${id.vin} — ${priceStr}, ${mileageStr}${conditionStr ? `, ${conditionStr}` : ""}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}${historyLine}${confirmedLine}${conflictLine}\n   Link: ${linkStr}`;
              })
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: response,
      };
      });
    },
  );


  server.registerTool(
    "resolve_dealer_url",
    {
      description:
        "Resolves a usable link for viewing or purchasing a specific vehicle, given its VIN, make, model, and year. Prefers the Edmunds VIN-specific pricing link; when that's unavailable (including for Carvana-sourced vehicles, which are never on Edmunds by VIN), falls back to affiliateFallbackUrl, a live Edmunds category-search link for the same make/model that never dead-ends. Never returns the dealer's own listing URL (dealerListingUrl) as the resolved link, even for Carvana — that field is still present on structuredContent for internal/diagnostic use, just never the text response.",
      inputSchema: {
        vin: z.string().describe("The vehicle's 17-character VIN."),
        make: z.string().describe("Vehicle manufacturer, e.g. Toyota."),
        model: z.string().describe("Vehicle model name, e.g. Camry."),
        year: z.number().describe("Model year."),
      },
      outputSchema: ResolveDealerUrlOutput,
      annotations: { title: "Resolve Dealer URL", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ vin, make, model, year }) => {
      // No retailListing data available in this call path (only VIN/make/
      // model/year are passed in), so Carvana detection here always
      // evaluates false via isCarvanaListing()'s dealer/vdp checks — moot
      // either way now, since dealerListingUrl is never routed to as the
      // resolved link regardless of Carvana status (see primary below).
      const links = resolveLinks({ vin, vehicle: { make, model, year } } as AutoDevListing);

      if (links.linkStatus === "none-available") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No usable link could be built for this vehicle (missing VIN/make/model/year, or all links unreachable).",
            },
          ],
        };
      }

      // Never route to dealerListingUrl (including Carvana) as the resolved
      // link — affiliateUrl (VIN-specific Edmunds) first, then
      // affiliateFallbackUrl (Edmunds category search) as the fallback
      // destination. dealerListingUrl stays present on structuredContent
      // for internal/diagnostic use, never returned as the text response.
      // A linkStatus of "dealer-only" (dealerListingUrl present, but
      // neither affiliate option is) has no usable destination here per
      // that same policy — report it plainly rather than substituting the
      // dealer URL.
      const primary = links.affiliateUrl ?? links.affiliateFallbackUrl ?? null;
      if (!primary) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No Edmunds link (VIN-specific or category fallback) could be built for this vehicle.",
            },
          ],
          structuredContent: links,
        };
      }
      return {
        content: [{ type: "text" as const, text: primary }],
        structuredContent: links,
      };
    },
  );

}, {
  // Purely diagnostic, invisible to end users: automatically identifies
  // exactly which commit is actually running, checkable only via a raw
  // MCP `initialize` call (never rendered, never part of any screenshot,
  // zero relation to anything submitted to Anthropic or OpenAI -- this
  // is the SAME serverInfo field every MCP server already returns, just
  // populated with real, always-current build identity instead of a
  // static placeholder).
  //
  // Added Aug 31 2026 specifically to stop chasing symptoms that turn
  // out to be stale/cached code rather than real bugs -- a recurring
  // problem this same session (see DECISIONS.md SYS-20260831-001/003/004).
  //
  // Ported 2026-09-03 (SYS-20260903-007) from fix/total-matches-count-bug
  // to this branch (cut from `main`, which never had this fix) -- same
  // mechanism, same field, ported verbatim rather than reinvented: check
  // this FIRST, before trusting any other live-test result on this
  // branch's preview, exactly per the standing practice documented in
  // DECISIONS.md SYS-20260831-005/SYS-20260901-001.
  // VERCEL_GIT_COMMIT_SHA is set automatically by Vercel on every
  // deployment; no manual version-bump step to forget. Falls back to
  // package.json's version for any environment where it's unset (e.g.
  // local dev).
  serverInfo: {
    name: "carclever-find-my-car",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "0.1.0",
  },
});

export { handler as GET, handler as POST, handler as DELETE };
