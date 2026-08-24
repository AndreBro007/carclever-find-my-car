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
    "1c. Verified VIN identity match, no concerns -> positive",
    classifyRiskTier(evidence({ verification: { identityVerificationStatus: "verified_match" } })) === "positive",
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

cardRiskBadgeTests();
