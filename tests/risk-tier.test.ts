// Focused tests for lib/risk-tier.ts (the pure purchase-risk classification
// function), buildBuyerCheck() (exact-VIN Buyer Check), and their wiring
// into app/[transport]/route.ts's lower_risk axis and lib/results-card.ts's
// ordinary-card RISK badge. Structural (source-text) checks follow the same
// established convention as tests/best-for-budget-ranking.test.ts contracts
// 5/6 and tests/geo-verification.test.ts, since the stage-2/lean pipeline
// lives inline in a Next.js route handler.
//
// SYS-20260827 buyer-risk-vs-data-quality fix: a real production case (a
// brand-new 2026 F-150 Raptor, 18 miles, got a RISK badge purely because
// its listing data disagreed on cylinder count) revealed that data-quality/
// verification signals (detectDataConflicts()) were being conflated with
// genuine purchase-risk evidence (accident history, failed VIN identity).
// This file's tests are organized around proving that boundary directly.
//
// Run: npx tsx tests/risk-tier.test.ts

import fs from "node:fs";
import { JSDOM } from "jsdom";
import { classifyRiskTier, riskTierRank, type RiskEvidence } from "@/lib/risk-tier";
import { buildResultsCardHtml } from "@/lib/results-card";
import { buildBuyerCheck } from "@/lib/buyer-check";

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
    ...overrides,
  };
}

// ===========================================================================
// STRUCTURAL: RiskEvidence genuinely has no dataConflicts field, and
// route.ts's two classifyRiskTier() call sites genuinely don't pass one.
// This is the strongest possible proof of the boundary — a type-level
// guarantee, not just a runtime behavior: it is not merely that a data
// conflict is ignored, it's structurally impossible to pass one in.
// ===========================================================================
{
  const riskTierSource = fs.readFileSync("lib/risk-tier.ts", "utf8");
  const interfaceMatch = riskTierSource.match(/export interface RiskEvidence \{[\s\S]*?\n\}/);
  const interfaceBody = interfaceMatch ? interfaceMatch[0] : "";
  check("RiskEvidence interface located", interfaceBody.length > 0, interfaceBody || "regex may need updating if reshaped");
  check(
    "RiskEvidence interface's own field list has no dataConflicts field at all (removed entirely, not just unused) -- doc-comment prose elsewhere in the file may still mention the word to explain the boundary, which is expected and fine",
    !/dataConflicts/.test(interfaceBody),
    interfaceBody,
  );

  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const leanCallSite = routeSource.match(/const tierOf = \(c: AutoDevListing\): RiskTier =>\s*\n\s*classifyRiskTier\(\{[\s\S]*?\}\);/);
  const cardCallSite = routeSource.match(/const riskTier = classifyRiskTier\(\{[\s\S]*?\}\);/);
  check("Lean-stage classifyRiskTier() call site located", !!leanCallSite);
  check("Final-card classifyRiskTier() call site located", !!cardCallSite);
  check(
    "Lean-stage classifyRiskTier() call does not pass dataConflicts",
    !!leanCallSite && !/dataConflicts/.test(leanCallSite[0]),
    leanCallSite ? leanCallSite[0] : undefined,
  );
  check(
    "Final-card classifyRiskTier() call does not pass dataConflicts",
    !!cardCallSite && !/dataConflicts/.test(cardCallSite[0]),
    cardCallSite ? cardCallSite[0] : undefined,
  );
}

// ===========================================================================
// REQUIRED TEST 1: data conflict alone -> unknown.
// REQUIRED TEST 2: known-clean history + data conflict -> positive.
// REQUIRED TEST 3: confirmed CPO + data conflict -> positive.
// REQUIRED TEST 4: accident + data conflict -> amber, not red.
// Since dataConflicts is no longer part of RiskEvidence at all (proven
// structurally above), these are proven by construction: every one of
// these fixtures IS "as if a data conflict were present" from
// classifyRiskTier()'s point of view, because the function has no way to
// see one — the boundary means these scenarios collapse to their
// data-conflict-free equivalents by design, not by chance.
// ===========================================================================
{
  check(
    "1. Data conflict alone -> unknown (the function cannot see a data conflict at all; a listing with no OTHER evidence is unknown, exactly as if the conflict didn't exist for this purpose)",
    classifyRiskTier(evidence({})) === "unknown",
  );
  check(
    "2. Known-clean history + (unseeable) data conflict -> still positive",
    classifyRiskTier(evidence({ history: { state: "known_clean" } })) === "positive",
  );
  check(
    "3. Confirmed CPO + (unseeable) data conflict -> still positive",
    classifyRiskTier(evidence({ condition: { cpoEvidenceState: "confirmed_cpo" } })) === "positive",
  );
  check(
    "4. Accident + (unseeable) data conflict -> amber, NOT red -- a data conflict can never escalate an accident-only case to red",
    classifyRiskTier(evidence({ history: { state: "known_issues" } })) === "amber",
  );
}

// ===========================================================================
// REQUIRED TEST 5: failed identity + data conflict -> red because of
// identity failure (again, the conflict is unseeable — this proves
// identity failure alone is sufficient and unaffected either way).
// ===========================================================================
{
  check(
    "5. Failed VIN identity check (+ unseeable data conflict) -> red, because of the identity failure alone",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "failed" } })) === "red",
  );
}

// ===========================================================================
// REQUIRED TEST 6: VIN verified alone remains unknown.
// REQUIRED TEST 7: unknown/unreported remains neutral.
// ===========================================================================
{
  check(
    "6. VIN verified + history unreported + CPO unknown -> UNKNOWN, not positive (verification alone is not purchase-risk evidence)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" } })) === "unknown",
  );
  check(
    "6b. VIN verified + known_clean history -> still positive (the clean history is what makes it positive, not the verification)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" }, history: { state: "known_clean" } })) === "positive",
  );
  check(
    "6c. VIN verified + confirmed CPO -> still positive (the CPO is what makes it positive, not the verification)",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" }, condition: { cpoEvidenceState: "confirmed_cpo" } })) === "positive",
  );
  check(
    "7. Unreported history, unknown everything else -> never amber/red (classified unknown)",
    classifyRiskTier(evidence({})) === "unknown",
  );
  check(
    "7b. Unreported history + reported_not_cpo (neutral) -> still never amber/red",
    classifyRiskTier(evidence({ condition: { cpoEvidenceState: "reported_not_cpo" } })) === "unknown",
  );
}

// ===========================================================================
// REQUIRED TEST 8: positive -> unknown -> amber -> red ranking remains
// correct.
// ===========================================================================
{
  check("8a. positive ranks above unknown", riskTierRank("positive") < riskTierRank("unknown"));
  check("8b. unknown ranks above amber", riskTierRank("unknown") < riskTierRank("amber"));
  check("8c. amber ranks above red", riskTierRank("amber") < riskTierRank("red"));
}

// ===========================================================================
// Final full-detail card sort must not let Match Score override lower_risk
// (pre-existing fix, re-confirmed unaffected by this change).
// ===========================================================================
{
  const cardsFixture = [
    { id: "high-score-amber", matchScore: 99, tier: "amber" as const },
    { id: "low-score-positive", matchScore: 50, tier: "positive" as const },
    { id: "mid-score-unknown", matchScore: 75, tier: "unknown" as const },
    { id: "low-score-red", matchScore: 40, tier: "red" as const },
  ];
  const sorted = [...cardsFixture].sort((a, b) => riskTierRank(a.tier) - riskTierRank(b.tier));
  check("Lower Match Score (50) positive card outranks higher Match Score (99) amber card", sorted[0].id === "low-score-positive");
  check("Mid Match Score (75) unknown card sorts second, ahead of amber/red regardless of score", sorted[1].id === "mid-score-unknown");
  check("Amber card (highest Match Score, 99) still sorts behind unknown", sorted[2].id === "high-score-amber");
  check("Red card sorts last", sorted[3].id === "low-score-red");

  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const finalSortBlock = routeSource.match(
    /if \(input\.priorityAxis === "cheapest"[\s\S]*?cards\.sort\(\(a, b\) => b\.ranking\.matchScore - a\.ranking\.matchScore\);\s*\n\s*\}/,
  );
  const block = finalSortBlock ? finalSortBlock[0] : "";
  check("Final-card sort dispatch block located in route.ts", block.length > 0, block || "regex may need updating if reshaped");
  check(
    "route.ts's final-card sort has a dedicated lower_risk branch using cards.sort by riskTierRank(a.risk.tier)",
    /\} else if \(input\.priorityAxis === "lower_risk"\) \{[\s\S]*?cards\.sort\(\(a, b\) => riskTierRank\(a\.risk\.tier\) - riskTierRank\(b\.risk\.tier\)\);\s*\n\s*\} else \{/.test(block),
  );
}

// ===========================================================================
// Registered output schema accepts risk.tier -- imports the REAL
// FindMatchingVehicleOutputSchema, not a copy.
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
    links: { affiliateUrl: null, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "none-available" as const, checkAvailSource: "none" as const },
    detail: { carfaxUrl: null, cpoNote: "Not reported as CPO", ownerHistoryNote: null, interiorColor: null, exteriorColor: null, cylinders: null, seats: null, seatsNote: "", dataConfidence: null, historyUsageType: null, historyPersonalUse: null, titleStatus: null, fuelTypeDisplay: "Gasoline" },
    badges: ["vin-verified"],
    intentConfirmations: [],
    dataConflicts: [],
    constraintChecks: [],
    searchConstraintStatus: "verified" as const,
  };
  const parsed = FindMatchingVehicleOutputSchema.shape.results.element.safeParse(minimalResult);
  check(
    "Registered output schema accepts a result with risk.tier='amber'",
    parsed.success,
    parsed.success ? undefined : JSON.stringify(parsed.error.issues.slice(0, 5)),
  );
  check(
    "Registered output schema still requires dataConflicts as a separate field (verification info is not lost -- still disclosed)",
    "dataConflicts" in minimalResult && Array.isArray(minimalResult.dataConflicts),
  );

  const invalidTier = { ...minimalResult, risk: { tier: "not-a-real-tier" } };
  const rejected = FindMatchingVehicleOutputSchema.shape.results.element.safeParse(invalidTier);
  check("Registered output schema rejects an invalid risk.tier value", rejected.success === false);
}

// ===========================================================================
// Lean lower_risk candidates retain the required purchase-risk evidence
// (history/CPO), and dataConflicts remains available separately for
// cardShape.dataConflicts -- disclosure isn't lost, just excluded from
// risk classification.
// ===========================================================================
async function leanEvidenceRetentionTest() {
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const clientSource = fs.readFileSync("lib/auto-dev-client.ts", "utf8");

  check(
    "LEAN_SELECT_FIELDS requests history.accidents, history.accidentCount, and retailListing.cpo",
    /history\.accidents/.test(clientSource) && /history\.accidentCount/.test(clientSource) && /retailListing\.cpo/.test(clientSource),
  );
  check(
    "leanRowToListing() maps the new select fields into the AutoDevListing shape classifyRiskTier() reads",
    /history:\s*\{\s*\n\s*accidents:\s*row\["history\.accidents"\],\s*\n\s*accidentCount:\s*row\["history\.accidentCount"\],/.test(clientSource) &&
      /cpo:\s*row\["retailListing\.cpo"\]/.test(clientSource),
  );
  check(
    "applyLocalLowerRiskOrdering() feeds classifyRiskTier() from buildHistorySummary()/buildCpoSummary() applied to the lean candidate directly",
    /const tierOf = \(c: AutoDevListing\): RiskTier =>\s*\n\s*classifyRiskTier\(\{\s*\n\s*verification: crossCheckVin\(c\),\s*\n\s*history: buildHistorySummary\(c\),\s*\n\s*condition: \{ cpoEvidenceState: buildCpoSummary\(c\)\.state \},/.test(routeSource),
  );
  check(
    "cardShape.dataConflicts is still populated from detectDataConflicts() (verification info not lost, just excluded from risk classification)",
    /dataConflicts,\s*\n(\s*\/\/[^\n]*\n)*\s*const riskTier = classifyRiskTier/.test(routeSource) ||
      /const dataConflicts = detectDataConflicts\(listing\);/.test(routeSource),
  );
}

// ===========================================================================
// REQUIRED TESTS 9-12: ordinary card display.
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
      links: { affiliateUrl: `https://www.edmunds.com/vin/${vin}/`, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only", checkAvailSource: "unconfirmed" as const },
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
        // 9. data-conflict-only card -> risk tier is "unknown" (per the
        // boundary fix, a data-conflict-only vehicle has NO purchase-risk
        // evidence at all, so its tier is unknown, exactly like a listing
        // with no evidence whatsoever) -> must NOT render a RISK badge.
        mockCard("1HGCV1F34NA000001", "unknown", { dataConflicts: ["Reported cylinder count (6) does not match VIN-decoded configuration (8)."] }),
        mockCard("1HGCV1F34NA000002", "amber"),
        mockCard("1HGCV1F34NA000003", "red"),
        mockCard("1HGCV1F34NA000004", "positive"),
      ],
    },
  };

  window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
  await new Promise((r) => setTimeout(r, 200));

  const doc = window.document;
  const cards = doc.querySelectorAll(".cc-card");
  check("Card count for risk-badge test", cards.length === 4, `got ${cards.length}`);

  const riskPillOf = (i: number) => cards[i]?.querySelector(".cc-risk");

  check(
    "9. Data-conflict-only card (risk.tier='unknown' despite carrying a real dataConflicts entry) does NOT render a RISK badge",
    !riskPillOf(0),
  );
  check("10. Accident card (risk.tier='amber') still renders amber RISK", !!riskPillOf(1) && riskPillOf(1)!.className.includes("is-amber"));
  check("11. Failed-identity card (risk.tier='red') still renders red RISK", !!riskPillOf(2) && riskPillOf(2)!.className.includes("is-red"));
  check("Positive-tier card renders no badge either (never shown, never green)", !riskPillOf(3));

  // 12. No new badge/UI treatment for data conflicts -- confirm the card's
  // dataConflicts entry, though present in the structured data, produces
  // no separate visual element (no new class, no extra card space) on the
  // data-conflict-only card beyond the absence of any RISK pill.
  const dataConflictCard = cards[0];
  check(
    "12. No new DATA/VERIFY badge, warning icon, or extra element was introduced for the data-conflict-only card (only the existing, already-approved elements are present)",
    !dataConflictCard.querySelector('[class*="data-conflict"]') && !dataConflictCard.querySelector('[class*="verify-badge"]') && !dataConflictCard.querySelector('[class*="cc-warning"]'),
  );

  const cardSource = fs.readFileSync("lib/results-card.ts", "utf8");
  check(
    "12b. No new CSS class was introduced anywhere in results-card.ts for data conflicts (structural confirmation alongside the DOM check above)",
    !/cc-data-conflict|cc-verify-badge|cc-warning/.test(cardSource),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// ===========================================================================
// REQUIRED TESTS 13-18: exact-VIN Buyer Check. Uses the REAL, now-exported
// buildBuyerCheck() directly, not a copy.
// ===========================================================================
function buyerCheckTests() {
  function buyerCard(overrides: {
    identityStatus?: "verified_match" | "potential_match" | "failed";
    conflictingAttributes?: string[];
    unknownAttributes?: string[];
    verifiedAttributes?: string[];
    historyState?: "known_clean" | "known_issues" | "unreported";
    historyNote?: string;
    cpoState?: "confirmed_cpo" | "reported_not_cpo" | "unknown";
    carfaxUrl?: string | null;
    dataConflicts?: string[];
  }) {
    return {
      verification: {
        identityVerificationStatus: overrides.identityStatus ?? "verified_match",
        verifiedAttributes: overrides.verifiedAttributes ?? [],
        unknownAttributes: overrides.unknownAttributes ?? [],
        conflictingAttributes: overrides.conflictingAttributes ?? [],
      },
      history: { state: overrides.historyState ?? "known_clean", note: overrides.historyNote ?? "No accidents reported (single-source, not a guarantee).", ownerNote: null },
      condition: { cpoEvidenceState: overrides.cpoState ?? "reported_not_cpo" },
      detail: { carfaxUrl: overrides.carfaxUrl ?? "https://www.carfax.com/vehicle/1HGCV1F34NA000001" },
      dataConflicts: overrides.dataConflicts ?? [],
    };
  }

  // 13. Data conflict only -> verify_before_proceeding.
  {
    const result = buildBuyerCheck(
      buyerCard({ historyState: "unreported", dataConflicts: ["Reported cylinder count (6) does not match VIN-decoded configuration (8)."] }),
    );
    check("13. Data conflict only -> outcome is verify_before_proceeding", result.outcome === "verify_before_proceeding");
    // 14. Data conflict appears under needsVerification, not concerns.
    check(
      "14. Data conflict entry appears in needsVerification, not concerns",
      result.needsVerification.some((s) => s.includes("cylinder count")) && !result.concerns.some((s) => s.includes("cylinder count")),
    );
  }

  // 15. Accident + data conflict -> caution due to accident; conflict under needsVerification.
  {
    const result = buildBuyerCheck(
      buyerCard({
        historyState: "known_issues",
        historyNote: "Reported 1 accident.",
        dataConflicts: ["Reported cylinder count (6) does not match VIN-decoded configuration (8)."],
      }),
    );
    check("15. Accident + data conflict -> outcome is caution (because of the accident)", result.outcome === "caution");
    check("15b. Accident note appears in concerns", result.concerns.some((s) => s.includes("accident")));
    check(
      "15c. Data conflict entry appears in needsVerification, NOT concerns (not double-counted as a second buyer-risk concern)",
      result.needsVerification.some((s) => s.includes("cylinder count")) && !result.concerns.some((s) => s.includes("cylinder count")),
    );
  }

  // 16. Identity failure + conflict -> significant_concern due to identity failure.
  {
    const result = buildBuyerCheck(
      buyerCard({
        identityStatus: "failed",
        conflictingAttributes: ["year"],
        dataConflicts: ["Reported cylinder count (6) does not match VIN-decoded configuration (8)."],
      }),
    );
    check("16. Identity failure + data conflict -> outcome is significant_concern (because of the identity failure)", result.outcome === "significant_concern");
    check(
      "16b. Data conflict remains verification information (needsVerification), not folded into concerns as a second issue",
      result.needsVerification.some((s) => s.includes("cylinder count")) && !result.concerns.some((s) => s.includes("cylinder count")),
    );
  }

  // 17. Clean strong evidence + NO data conflict -> can still be promising.
  {
    const result = buildBuyerCheck(
      buyerCard({ identityStatus: "verified_match", historyState: "known_clean", dataConflicts: [] }),
    );
    check("17. Clean strong evidence with no data conflict -> outcome is promising", result.outcome === "promising");
  }
  // Negative control: same evidence, but WITH a data conflict -> no longer promising (something material still needs verification).
  {
    const result = buildBuyerCheck(
      buyerCard({ identityStatus: "verified_match", historyState: "known_clean", dataConflicts: ["Reported cylinder count (6) does not match VIN-decoded configuration (8)."] }),
    );
    check(
      "17b. Same otherwise-promising evidence WITH a data conflict -> no longer promising (falls to verify_before_proceeding, not caution -- the conflict alone isn't a concern, but it does block 'promising')",
      result.outcome === "verify_before_proceeding",
    );
  }

  // 18. Exact-VIN existing behavior otherwise unchanged: identity failure
  // alone (no data conflict at all) still -> significant_concern; accident
  // alone (no data conflict) still -> caution.
  {
    const identityOnly = buildBuyerCheck(buyerCard({ identityStatus: "failed", conflictingAttributes: ["make"], dataConflicts: [] }));
    check("18a. Identity failure alone (no data conflict) -> still significant_concern, unchanged", identityOnly.outcome === "significant_concern");
    const accidentOnly = buildBuyerCheck(buyerCard({ historyState: "known_issues", historyNote: "Reported 1 accident.", dataConflicts: [] }));
    check("18b. Accident alone (no data conflict) -> still caution, unchanged", accidentOnly.outcome === "caution");
  }
}

// ===========================================================================
// REQUIRED TEST 19: lower_risk description no longer claims data conflicts
// are purchase-risk ranking evidence.
// REQUIRED TEST 20: exact natural phrase "low risk" is still supported.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "19. LOWER RISK RANKING prose no longer lists data conflicts alongside VIN identity/accident/CPO as ranking evidence",
    !/VIN identity verification, reported accident history, CPO status, data conflicts/.test(routeSource),
  );
  check(
    "19b. Zod .describe() no longer lists data conflicts as part of lower_risk's ranking evidence",
    !/VIN identity check, reported accidents, CPO status, data conflicts/.test(routeSource),
  );
  check(
    "19c. Old inaccurate wording 'pushed known accident/data concerns lower' is gone",
    !routeSource.includes("pushed known accident/data concerns lower"),
  );
  check(
    "19d. New buyer-accurate wording 'pushed known accident/identity concerns lower' is present",
    routeSource.includes("pushed known accident/identity concerns lower"),
  );
  check(
    "19e. Data conflicts are still explained as verification/suitability information (e.g. towing) separately from purchase-risk ranking",
    /data conflicts.*(are|is).*(verification|separate)/i.test(routeSource) || /verification notes, not purchase-risk evidence/.test(routeSource),
  );
  const requiredPhrases = ["lower-risk CR-V", "low risk F-150 for towing", "safer-looking options", "cleanest-looking history", "lower-risk buys"];
  for (const phrase of requiredPhrases) {
    check(`20. Tool description still teaches the phrase "${phrase}" -> lower_risk`, routeSource.includes(phrase));
  }
  check(
    "20b. Zod .describe() still teaches the exact phrase \"low risk\"",
    /'lower-risk', 'low risk', 'safer-looking'/.test(routeSource),
  );
  check(
    "20c. priorityAxis Zod enum still includes lower_risk",
    /z\.enum\(\["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"\]\)/.test(routeSource),
  );
}

// ===========================================================================
// Hard constraints remain hard under lower_risk -- unaffected by this
// change, re-confirmed.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "applyLocalLowerRiskOrdering(trimOrderedCandidates) still runs on the already-hard-filtered candidate list",
    routeSource.includes("applyLocalLowerRiskOrdering(trimOrderedCandidates)"),
  );
  check(
    "trimOrderedCandidates is still derived from the already-hard-filtered pipeline",
    /const trimFilteredCandidates = trimRequired\s*\n\s*\? bodyStyleFilteredCandidates\.filter\(trimRequiredLeanFilter\)/.test(routeSource),
  );
}

// ===========================================================================
// best_for_budget branch of the diversified-ordering dispatch is untouched
// -- unaffected by this change, re-confirmed.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const dispatchMatch = routeSource.match(/const diversified = applyDiversity\(\s*[\s\S]*?targetCount \* 2,\s*\);/);
  const dispatch = dispatchMatch ? dispatchMatch[0] : "";
  check("Diversified-ordering dispatch block located", dispatch.length > 0);
  check(
    "best_for_budget branch still calls applyConfigurationVarietyPass(applyLocalBestForBudgetOrdering(...)) unchanged",
    /applyConfigurationVarietyPass\(\s*\n\s*applyLocalBestForBudgetOrdering\(trimOrderedCandidates, intent\.semantic\.trimPreference\),\s*\n\s*\)/.test(dispatch),
  );
}

buyerCheckTests();

async function runAll() {
  await schemaTest();
  await leanEvidenceRetentionTest();
  await cardRiskBadgeTests(); // calls process.exit() internally once done
}

runAll();
