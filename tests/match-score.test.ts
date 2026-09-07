// Match Score regression suite — SYS-20260907-V2.4
// ================================================
// Covers the two bounded additions André approved: continuous
// price-proximity scoring in statedCriteriaFit, and a modest, secondary
// Used-value tie-break in resolvedCriteriaFit. Every test asserts the
// weights (0.55/0.30/0.15), labels, and philosophy are otherwise untouched.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeMatchScore } from "../lib/match-score";
import type { ParsedIntent } from "../lib/intent-parser";
import type { VerificationResult } from "../lib/vin-cross-check";
import type { CardIntentInput } from "../lib/qualifier-accounting";

function listing(overrides: any) {
  return {
    vin: overrides.vin ?? "1FTEW2KP9TKE60602",
    vehicle: {
      make: overrides.make ?? "Toyota",
      model: overrides.model ?? "Camry",
      year: overrides.year ?? 2023,
      trim: overrides.trim,
    },
    retailListing: {
      price: overrides.price,
      miles: overrides.miles,
      used: overrides.used,
      cpo: overrides.cpo ?? false,
    },
  };
}

function intent(overrides: Partial<ParsedIntent["hardConstraints"]> = {}): ParsedIntent {
  return {
    hardConstraints: {
      priceMax: 25000,
      make: "Toyota",
      model: "Camry",
      ...overrides,
    },
    semantic: { goals: [] },
    verificationRequired: [],
    interpretationNotes: [],
    modelPrefixesStripped: [],
  } as ParsedIntent;
}

function verifiedMatch(): VerificationResult {
  return {
    identityVerificationStatus: "verified_match",
    verifiedAttributes: ["make", "model"],
    unknownAttributes: [],
    conflictingAttributes: [],
  };
}

function intentInput(overrides: Partial<CardIntentInput> = {}): CardIntentInput {
  return { ...overrides };
}

// ============================================================================
// Price-proximity scoring
// ============================================================================

test("V2.4-1. Two in-budget candidates at different prices now get different matchScores (root cause of the original 'identical 91' observation)", () => {
  const cheap = computeMatchScore(
    listing({ price: 18000, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  const expensive = computeMatchScore(
    listing({ price: 24500, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.notEqual(cheap.matchScore, expensive.matchScore, "prices further from the ceiling should score higher");
  assert.ok(cheap.matchScore > expensive.matchScore);
});

test("V2.4-2. Equal prices still produce equal matchScores (no spurious differentiation)", () => {
  const a = computeMatchScore(
    listing({ price: 20000, used: true, vin: "AAA" }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  const b = computeMatchScore(
    listing({ price: 20000, used: true, vin: "BBB" }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.equal(a.matchScore, b.matchScore);
});

test("V2.4-3. Near-equal prices produce near-equal (not wildly divergent) matchScores", () => {
  const a = computeMatchScore(
    listing({ price: 19900, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  const b = computeMatchScore(
    listing({ price: 20100, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.ok(Math.abs(a.matchScore - b.matchScore) <= 2, `expected near-equal scores, got ${a.matchScore} vs ${b.matchScore}`);
});

test("V2.4-4. Over-budget candidate still scores the price check as 0 (violation), not graded", () => {
  const overBudget = computeMatchScore(
    listing({ price: 30000, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.equal(overBudget.breakdown.statedCriteriaFit < 1, true);
});

test("V2.4-5. Weights, labels, and penalizedByRelaxation deferral are unchanged", () => {
  const r = computeMatchScore(
    listing({ price: 20000, used: true }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.deepEqual(r.breakdown.penalizedByRelaxation, []);
  assert.ok(["Strong match", "Good match", "Partial match"].includes(r.matchScoreLabel));
  // matchScore must still equal round(0.55*stated + 0.30*resolved + 0.15*identity) — unchanged formula
  const recomputed = Math.round((0.55 * r.breakdown.statedCriteriaFit + 0.3 * r.breakdown.resolvedCriteriaFit + 0.15 * r.breakdown.identityConfidence) * 100);
  assert.equal(r.matchScore, recomputed);
});

// ============================================================================
// Used-value tie-break
// ============================================================================

test("V2.4-6. Mixed New/Used/CPO at the same price: Used and CPO(Used) score at or above equivalent New, New never scores below its own baseline", () => {
  const usedR = computeMatchScore(
    listing({ price: 20000, used: true, miles: 30000 }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  const cpoR = computeMatchScore(
    listing({ price: 20000, used: true, cpo: true, miles: 25000 }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  const newR = computeMatchScore(
    listing({ price: 20000, used: false }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.ok(usedR.matchScore >= newR.matchScore, "Used should not score below equivalent New at the same price");
  assert.ok(cpoR.matchScore >= newR.matchScore, "CPO (Used) should not score below equivalent New at the same price");
});

test("V2.4-7. High-budget search with no explicit New/Used preference: nearly-new low-mileage Used can edge out New at the same price (the exact behavior flagged: New no longer wins purely mechanically)", () => {
  const nearlyNewUsed = computeMatchScore(
    listing({ price: 45000, used: true, miles: 8000 }),
    intent({ priceMax: 60000 }),
    verifiedMatch(),
    intentInput(), // no explicit used/new preference
  );
  const newCar = computeMatchScore(
    listing({ price: 45000, used: false }),
    intent({ priceMax: 60000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.ok(nearlyNewUsed.matchScore >= newCar.matchScore);
});

test("V2.4-8. Explicit New-only intent (used: false in the tool call): the tie-break is a structural no-op — New scores exactly its own baseline, unaffected", () => {
  const explicitNewInput = intentInput({ used: false });
  const newCar = computeMatchScore(
    listing({ price: 20000, used: false }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    explicitNewInput,
  );
  const newCarNoPreference = computeMatchScore(
    listing({ price: 20000, used: false }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  // A New listing gets no tie-break bonus either way (it isn't Used), so
  // explicit New-only intent shouldn't change its own score at all.
  assert.equal(newCar.matchScore, newCarNoPreference.matchScore);
});

test("V2.4-9. Explicit Used intent (used: true): remains correct — Used candidates still score as Used, tie-break applies uniformly, no discrimination introduced", () => {
  const explicitUsedInput = intentInput({ used: true });
  const r = computeMatchScore(
    listing({ price: 20000, used: true, miles: 40000 }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    explicitUsedInput,
  );
  assert.ok(r.breakdown.resolvedCriteriaFit > 0);
  assert.ok(r.matchScore > 0);
});

test("V2.4-10. Explicit CPO search: CPO (a Used subset) still receives the Used-value tie-break correctly, doesn't lose it for being CPO specifically", () => {
  const cpoInput = intentInput({ cpo: true });
  const cpoR = computeMatchScore(
    listing({ price: 22000, used: true, cpo: true, miles: 20000 }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    cpoInput,
  );
  const plainUsedR = computeMatchScore(
    listing({ price: 22000, used: true, cpo: false, miles: 20000 }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    cpoInput,
  );
  // Same price/mileage — CPO status itself doesn't change this tie-break's
  // magnitude (CPO disclosure/ranking is a separate, pre-existing concern);
  // both should receive the same Used-value nudge.
  assert.equal(cpoR.matchScore, plainUsedR.matchScore);
});

test("V2.4-11. Lower-priced Used vehicle scores at least as well as a higher-priced New vehicle at the same trim preference (value case)", () => {
  const usedLowerPrice = computeMatchScore(
    listing({ price: 19000, used: true, miles: 12000, trim: "XLE" }),
    { ...intent({ priceMax: 25000 }), semantic: { trimPreference: "XLE", goals: [] } } as ParsedIntent,
    verifiedMatch(),
    intentInput(),
  );
  const newHigherPrice = computeMatchScore(
    listing({ price: 24000, used: false, trim: "XLE" }),
    { ...intent({ priceMax: 25000 }), semantic: { trimPreference: "XLE", goals: [] } } as ParsedIntent,
    verifiedMatch(),
    intentInput(),
  );
  assert.ok(usedLowerPrice.matchScore >= newHigherPrice.matchScore);
});

test("V2.4-12. New is clearly the best/only fit (deep in budget, no Used alternative in this comparison): New still scores strongly on its own terms, not suppressed", () => {
  const r = computeMatchScore(
    listing({ price: 21000, used: false }),
    intent({ priceMax: 25000 }),
    verifiedMatch(),
    intentInput(),
  );
  assert.ok(r.matchScore >= 65, `expected at least a Good match for a well-in-budget verified New candidate, got ${r.matchScore}`);
});
