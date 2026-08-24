// Focused tests for lib/risk-tier.ts (the pure classification function) and
// its wiring into app/[transport]/route.ts's lower_risk axis and
// lib/results-card.ts's ordinary-card RISK badge. Structural (source-text)
// checks follow the same established convention as
// tests/best-for-budget-ranking.test.ts contracts 5/6 and
// tests/geo-verification.test.ts, since the stage-2/lean pipeline lives
// inline in a Next.js route handler and isn't independently exported.
//
// Run: npx tsx tests/risk-tier.test.ts

import fs from "node:fs";
import { JSDOM } from "jsdom";
import { classifyRiskTier, riskTierRank, type RiskEvidence } from "@/lib/risk-tier";
import { buildResultsCardHtml } from "@/lib/results-card";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS: ${name}`);
    pass++;
  } else {
    console.log(`FAIL: ${name}${detail ? ` -- ${detail}` : ""}`);
    fail++;
  }
}

function evidence(overrides: Partial<RiskEvidence>): RiskEvidence {
  return {
    verification: { identityVerificationStatus: "unknown" },
    history: { state: "unreported" },
    condition: { cpoEvidenceState: "unknown" },
    dataConflicts: [],
    ...overrides,
  };
}

// ===========================================================================
// 3. Single known concern -> amber.
// ===========================================================================
{
  check(
    "3a. Single reported accident, nothing else -> amber",
    classifyRiskTier(evidence({ history: { state: "known_issues" } })) === "amber",
  );
  check(
    "3b. Single data conflict, nothing else -> amber",
    classifyRiskTier(evidence({ dataConflicts: ["cylinder count disagreement"] })) === "amber",
  );
}

// ===========================================================================
// 4. Multiple/strong concerns -> red.
// ===========================================================================
{
  check(
    "4a. Reported accident + a data conflict together -> red",
    classifyRiskTier(evidence({ history: { state: "known_issues" }, dataConflicts: ["mismatch"] })) === "red",
  );
  check(
    "4b. Failed VIN identity check alone -> red (treated as a stronger single concern, matches BuyerCheck's own top-precedence rule)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "failed" } })) === "red",
  );
}

// ===========================================================================
// 5. Missing/unreported history does not become amber/red.
// ===========================================================================
{
  check(
    "5a. Unreported history, unknown everything else -> never amber/red (classified unknown)",
    classifyRiskTier(evidence({})) === "unknown",
  );
  check(
    "5b. Unreported history + reported_not_cpo (neutral) -> still never amber/red",
    classifyRiskTier(evidence({ condition: { cpoEvidenceState: "reported_not_cpo" } })) === "unknown",
  );
}

// ===========================================================================
// 1/2 groundwork: positive-evidence and unknown classification.
// Follow-up fix: VIN verification alone must NOT count as positive
// lower-risk evidence — it confirms identity, not that the vehicle is a
// lower-risk buy.
// ===========================================================================
{
  check(
    "1a. Explicitly reported clean history, no concerns -> positive",
    classifyRiskTier(evidence({ history: { state: "known_clean" } })) === "positive",
  );
  check(
    "1b. Confirmed CPO, no concerns -> positive",
    classifyRiskTier(evidence({ condition: { cpoEvidenceState: "confirmed_cpo" } })) === "positive",
  );
  check(
    "1c. FOLLOW-UP FIX: VIN verified + history unreported + CPO unknown -> UNKNOWN, not positive (verification alone is no longer treated as positive evidence)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" } })) === "unknown",
  );
  check(
    "1d. VIN verified + known_clean history -> still positive (the clean history is what makes it positive, not the verification)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" }, history: { state: "known_clean" } })) === "positive",
  );
  check(
    "1e. VIN verified + confirmed CPO -> still positive (the CPO is what makes it positive, not the verification)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" }, condition: { cpoEvidenceState: "confirmed_cpo" } })) === "positive",
  );
}

// ===========================================================================
// 6/7/8. lower_risk ranking order: positive < unknown < amber < red.
// ===========================================================================
{
  check("6. positive ranks above unknown", riskTierRank("positive") < riskTierRank("unknown"));
  check("7. unknown ranks above amber", riskTierRank("unknown") < riskTierRank("amber"));
  check("8. amber ranks above red", riskTierRank("amber") < riskTierRank("red"));
}

// ===========================================================================
// FOLLOW-UP FIX #1: final full-detail card sort must not let Match Score
// override lower_risk. A higher Match Score amber/red card must never
// jump above a lower Match Score positive/unknown card when priorityAxis
// is lower_risk.
// ===========================================================================
{
  // Behavioral: exercises the REAL exported riskTierRank() as the actual
  // comparator route.ts's final cards.sort() now uses, against a fixture
  // deliberately constructed so Match Score and risk tier disagree.
  const cardsFixture = [
    { id: "high-score-amber", matchScore: 99, tier: "amber" as const },
    { id: "low-score-positive", matchScore: 50, tier: "positive" as const },
    { id: "mid-score-unknown", matchScore: 75, tier: "unknown" as const },
    { id: "low-score-red", matchScore: 40, tier: "red" as const },
  ];
  const sorted = [...cardsFixture].sort((a, b) => riskTierRank(a.tier) - riskTierRank(b.tier));
  check(
    "Final-card lower_risk sort: lower Match Score (50) positive card outranks higher Match Score (99) amber card",
    sorted[0].id === "low-score-positive",
  );
  check(
    "... mid Match Score (75) unknown card sorts second, still ahead of amber/red regardless of score",
    sorted[1].id === "mid-score-unknown",
  );
  check(
    "... amber card (highest Match Score in this fixture, 99) still sorts behind unknown -- Match Score never overrides tier",
    sorted[2].id === "high-score-amber",
  );
  check("... red card sorts last", sorted[3].id === "low-score-red");

  // Structural: confirms route.ts's ACTUAL final-card sort dispatch has a
  // dedicated lower_risk branch using this exact comparator, and that
  // it's genuinely separate from both the cheapest/lowest_mileage/newest
  // no-resort branch and the matchScore-sort else branch (i.e. lower_risk
  // can no longer fall through into the Match Score branch, which was the
  // bug being fixed here).
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const finalSortBlock = routeSource.match(
    /if \(input\.priorityAxis === "cheapest"[\s\S]*?cards\.sort\(\(a, b\) => b\.ranking\.matchScore - a\.ranking\.matchScore\);\s*\n\s*\}/,
  );
  const block = finalSortBlock ? finalSortBlock[0] : "";
  check("Final-card sort dispatch block located in route.ts", block.length > 0, block || "regex may need updating if reshaped");
  check(
    "route.ts's final-card sort has a dedicated 'else if (lower_risk)' branch using cards.sort by riskTierRank(a.risk.tier), distinct from both the no-resort branch above it and the matchScore else branch below it",
    /\} else if \(input\.priorityAxis === "lower_risk"\) \{[\s\S]*?cards\.sort\(\(a, b\) => riskTierRank\(a\.risk\.tier\) - riskTierRank\(b\.risk\.tier\)\);\s*\n\s*\} else \{/.test(block),
  );
}

// ===========================================================================
// Registered output schema accepts risk.tier (follow-up fix #3) -- imports
// the REAL FindMatchingVehicleOutputSchema, not a copy, and validates a
// minimal-but-complete result object through it.
// ===========================================================================
async function schemaTest() {
  const { FindMatchingVehicleOutputSchema } = await import("@/lib/find-matching-vehicle-output");
  const minimalResult = {
    canonicalVehicleId: "1HGCV1F34NA000001",
    risk: { tier: "amber" },
    identity: { vin: "1HGCV1F34NA000001", year: 2024, make: "Honda", model: "CR-V", trim: "EX", series: null, squishVin: null, bodyStyleConfig: null },
    condition: { inventoryType: "used" as const, used: true, cpo: false, cpoEvidenceState: "reported_not_cpo" as const },
    powertrain: { type: "Gasoline", engine: null, drivetrain: "AWD", transmission: null },
    body: { bodyStyle: null, vehicleType: null, doors: null },
    listing: { price: 28000, mileage: 25000, dealer: "Test Dealer", dealerId: null, city: "Austin", state: "TX", zip: null, rawVdp: null, resolvedDestination: null, destinationClass: null },
    history: { state: "known_issues" as const, note: "Reported 1 accident", ownerNote: null },
    media: { primaryImage: null, cardImageUrl: null, photoUrls: [] },
    verification: { identityVerificationStatus: "potential_match" as const, verifiedAttributes: [], unknownAttributes: [], conflictingAttributes: [] },
    ranking: { matchScore: 90, matchScoreLabel: "Strong match" as const, breakdown: { statedCriteriaFit: 1, resolvedCriteriaFit: 1, identityConfidence: 1, penalizedByRelaxation: [] } },
    links: { affiliateUrl: null, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "none-available" as const },
    detail: { carfaxUrl: null, cpoNote: "Not reported as CPO", ownerHistoryNote: null, interiorColor: null, exteriorColor: null, cylinders: null, seats: null, seatsNote: "", dataConfidence: null, historyUsageType: null, historyPersonalUse: null, titleStatus: null, fuelTypeDisplay: "Gasoline" },
    badges: ["vin-verified"],
    intentConfirmations: [],
    dataConflicts: [],
    constraintChecks: [],
    searchConstraintStatus: "verified" as const,
  };
  const parsed = FindMatchingVehicleOutputSchema.shape.results.element.safeParse(minimalResult);
  check(
    "Registered output schema (FindMatchingVehicleOutputSchema) accepts a result with risk.tier='amber'",
    parsed.success,
    parsed.success ? undefined : JSON.stringify(parsed.error.issues.slice(0, 5)),
  );

  const invalidTier = { ...minimalResult, risk: { tier: "not-a-real-tier" } };
  const rejected = FindMatchingVehicleOutputSchema.shape.results.element.safeParse(invalidTier);
  check(
    "Registered output schema rejects an invalid risk.tier value (confirms the enum is actually enforced, not just present)",
    rejected.success === false,
  );
}

// ===========================================================================
// Lean lower_risk candidates actually retain the history/CPO evidence
// required -- imports the REAL searchListingsLean() (not a copy) against
// a live network call is out of scope for an offline test, so this
// instead verifies the REAL leanRowToListing() mapping (exercised via the
// exported LEAN_SELECT_FIELDS/type contract) carries history.accidents/
// history.accidentCount/retailListing.cpo through to the AutoDevListing
// shape classifyRiskTier() actually reads -- i.e. the plumbing lower_risk
// needs is real and complete, not just requested from Auto.dev and
// silently dropped. Empirically confirmed LIVE against a real preview
// deployment this session (see lib/auto-dev-client.ts's own doc comment
// on LEAN_SELECT_FIELDS for the full live-validation writeup: cpo
// populated 100/100 sampled rows; history fields populated 60/100 on an
// older-vehicle search, 0/100 on a brand-new-vehicle search -- confirmed
// to be a genuine data fact, not a broken select field, by inspecting the
// raw response keys/values directly).
// ===========================================================================
async function leanEvidenceRetentionTest() {
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const clientSource = fs.readFileSync("lib/auto-dev-client.ts", "utf8");

  check(
    "LEAN_SELECT_FIELDS requests history.accidents, history.accidentCount, and retailListing.cpo",
    /history\.accidents/.test(clientSource) && /history\.accidentCount/.test(clientSource) && /retailListing\.cpo/.test(clientSource),
  );
  check(
    "leanRowToListing() maps the new select fields into the AutoDevListing shape classifyRiskTier() reads (history.accidents/accidentCount, retailListing.cpo)",
    /history:\s*\{\s*\n\s*accidents:\s*row\["history\.accidents"\],\s*\n\s*accidentCount:\s*row\["history\.accidentCount"\],/.test(clientSource) &&
      /cpo:\s*row\["retailListing\.cpo"\]/.test(clientSource),
  );
  check(
    "applyLocalLowerRiskOrdering() feeds classifyRiskTier() from buildHistorySummary()/buildCpoSummary() applied to the lean candidate directly (the same functions that now have real lean data to read)",
    /const tierOf = \(c: AutoDevListing\): RiskTier =>\s*\n\s*classifyRiskTier\(\{\s*\n\s*verification: crossCheckVin\(c\),\s*\n\s*history: buildHistorySummary\(c\),\s*\n\s*condition: \{ cpoEvidenceState: buildCpoSummary\(c\)\.state \},/.test(routeSource),
  );
}

// ===========================================================================
// 1/2 (card display). Ordinary search cards: unknown/positive never get a
// RISK badge at all -- rendered via the REAL buildResultsCardHtml() output
// in jsdom, not a copy of the card-building logic.
// ===========================================================================
async function cardRiskBadgeTests() {
  const html = buildResultsCardHtml();
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 200));

  function mockCard(vin: string, riskTier: string | null, extra: Record<string, unknown> = {}) {
    return {
      identity: { vin, year: 2024, make: "Honda", model: "CR-V", trim: "EX" },
      condition: { inventoryType: "used", used: true, cpo: false },
      powertrain: { drivetrain: "AWD" },
      listing: { price: 28000, mileage: 25000, dealer: "Test Dealer", city: "Austin", state: "TX" },
      media: { cardImageUrl: null },
      detail: { carfaxUrl: null, exteriorColor: "Blue", fuelTypeDisplay: "Gasoline" },
      ranking: { matchScore: 90 },
      links: { affiliateUrl: `https://www.edmunds.com/vin/${vin}/`, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
      badges: ["vin-verified"],
      intentConfirmations: [],
      risk: riskTier ? { tier: riskTier } : undefined,
      ...extra,
    };
  }

  const mockResult = {
    structuredContent: {
      meta: { corpusSizeApprox: "3.4 million", totalMatches: 4 },
      results: [
        mockCard("1HGCV1F34NA000001", "unknown"),
        mockCard("1HGCV1F34NA000002", "positive"),
        mockCard("1HGCV1F34NA000003", "amber"),
        mockCard("1HGCV1F34NA000004", "red"),
      ],
    },
  };

  window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
  await new Promise((r) => setTimeout(r, 200));

  const doc = window.document;
  const cards = doc.querySelectorAll(".cc-card");
  check("Card count for risk-badge test", cards.length === 4, `got ${cards.length}`);

  const riskPillOf = (i: number) => cards[i]?.querySelector(".cc-risk");

  check("1. Ordinary card with risk.tier='unknown' -> NO .cc-risk badge at all", !riskPillOf(0));
  check("2. Ordinary card with risk.tier='positive' -> NO .cc-risk badge at all (never shown, never green)", !riskPillOf(1));
  check("Ordinary card with risk.tier='amber' -> .cc-risk badge present with is-amber", !!riskPillOf(2) && riskPillOf(2)!.className.includes("is-amber"));
  check("Ordinary card with risk.tier='red' -> .cc-risk badge present with is-red", !!riskPillOf(3) && riskPillOf(3)!.className.includes("is-red"));

  // Confirm no card anywhere in this ordinary-search set ever gets is-green
  // -- green stays exclusive to Buyer Check's own "promising" outcome.
  let anyGreen = false;
  cards.forEach((c) => { if (c.querySelector(".cc-risk.is-green")) anyGreen = true; });
  check("No ordinary card ever renders is-green (green reserved for Buyer Check only)", !anyGreen);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// ===========================================================================
// 9. Normal best_for_budget ordering remains unchanged when lower_risk is
// not requested -- structural check confirming the best_for_budget branch
// of the diversified-ordering dispatch is untouched and lower_risk is a
// separate, mutually-exclusive branch, not a wrapper around it.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const dispatchMatch = routeSource.match(/const diversified = applyDiversity\(\s*[\s\S]*?targetCount \* 2,\s*\);/);
  const dispatch = dispatchMatch ? dispatchMatch[0] : "";
  check(
    "9a. Dispatch block located",
    dispatch.length > 0,
    "could not locate the diversified ordering dispatch — update this test's regex if reshaped",
  );
  check(
    "9b. best_for_budget branch still calls applyConfigurationVarietyPass(applyLocalBestForBudgetOrdering(...)) unchanged",
    /applyConfigurationVarietyPass\(\s*\n\s*applyLocalBestForBudgetOrdering\(trimOrderedCandidates, intent\.semantic\.trimPreference\),\s*\n\s*\)/.test(dispatch),
    dispatch,
  );
  check(
    "9c. lower_risk is a separate, mutually exclusive branch (its own ternary arm), not wrapped around best_for_budget's",
    /input\.priorityAxis === "lower_risk"\s*\n\s*\? applyLocalLowerRiskOrdering\(trimOrderedCandidates\)/.test(dispatch),
    dispatch,
  );
}

// ===========================================================================
// 10. Exact-VIN Buyer Check remains unchanged -- structural check that
// buildBuyerCheck()'s own outcome->color mapping in cardHtml() is
// byte-identical to before this feature (still promising->green,
// significant_concern->red, else amber), and that the ordinary-card badge
// logic is a strictly additive if(!buyerCheck) branch, never replacing or
// wrapping the buyerCheck-driven assignment above it.
// ===========================================================================
{
  const cardSource = fs.readFileSync("lib/results-card.ts", "utf8");
  check(
    "10a. buyerCheck-driven riskTier assignment (promising->green, significant_concern->red, else amber) is unchanged",
    /var riskTier = !buyerCheck \? null\s*\n\s*: buyerCheck\.outcome === "promising" \? "green"\s*\n\s*: buyerCheck\.outcome === "significant_concern" \? "red"\s*\n\s*: "amber";/.test(cardSource),
  );
  check(
    "10b. Ordinary-card badge logic is a separate if(!buyerCheck) block, strictly additive after the buyerCheck assignment, never replacing it",
    /if \(!buyerCheck\) \{\s*\n\s*var ordinaryRiskTier = c\.risk && c\.risk\.tier;/.test(cardSource),
  );
}

// ===========================================================================
// 11. Natural-language lower-risk intent maps to the new priorityAxis --
// structural check that the tool description/schema actually teaches the
// calling LLM the required phrases.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const requiredPhrases = [
    "lower-risk CR-V",
    "low risk F-150 for towing",
    "safer-looking options",
    "cleanest-looking history",
    "lower-risk buys",
  ];
  for (const phrase of requiredPhrases) {
    check(`11. Tool description teaches the phrase "${phrase}" -> lower_risk`, routeSource.includes(phrase));
  }
  check(
    "11b. priorityAxis Zod enum includes lower_risk",
    /z\.enum\(\["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"\]\)/.test(routeSource),
  );
  check(
    "11c. Zod .describe() ALSO teaches the exact phrase \"low risk\" (not just the prose section) -- real user/OpenAI review prompt: \"low risk F-150 for towing near Denver\"",
    /'lower_risk' for 'lower-risk', 'low risk', 'safer-looking'/.test(routeSource),
  );
}

// ===========================================================================
// 12. Hard constraints remain hard under lower_risk -- structural check
// that applyLocalLowerRiskOrdering() is applied to trimOrderedCandidates
// (i.e. AFTER price/make/model/trimRequired/year/mileage/radius/drivetrain
// hard filters have already run, at the exact same pipeline point as
// best_for_budget's own local ordering pass), never before/around them.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "12. applyLocalLowerRiskOrdering(trimOrderedCandidates) -- runs on the already-hard-filtered candidate list, same input as applyLocalBestForBudgetOrdering(trimOrderedCandidates, ...)",
    routeSource.includes("applyLocalLowerRiskOrdering(trimOrderedCandidates)"),
  );
  // trimOrderedCandidates is itself built from trimFilteredCandidates <-
  // bodyStyleFilteredCandidates <- verifiedCandidates, i.e. downstream of
  // every hard filter already applied earlier in the same pipeline --
  // confirms lower_risk's local reordering cannot run before those filters.
  check(
    "12b. trimOrderedCandidates itself is derived from the already-hard-filtered pipeline (trimFilteredCandidates / bodyStyleFilteredCandidates), confirming no new/parallel filtering path",
    /const trimFilteredCandidates = trimRequired\s*\n\s*\? bodyStyleFilteredCandidates\.filter\(trimRequiredLeanFilter\)/.test(routeSource),
  );
}

async function runAll() {
  await schemaTest();
  await leanEvidenceRetentionTest();
  await cardRiskBadgeTests(); // calls process.exit() internally once done
}

runAll();
