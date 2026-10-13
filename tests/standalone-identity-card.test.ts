// Focused tests for the two real, importable building blocks behind V3.3's
// standalone identity/verification card (buildStandaloneIdentityCard()
// itself lives inline in app/[transport]/route.ts, same as
// buildResultCard() — not independently importable, per the established
// convention documented in tests/risk-tier.test.ts's own header comment):
//
//   1. FindMatchingVehicleOutputSchema's RankingSchema must now accept a
//      null matchScore/matchScoreLabel (the schema widening this feature
//      required) WITHOUT weakening validation for every existing caller,
//      which must still be rejected if it omits the fields or supplies an
//      invalid non-null value.
//   2. resolveLinks() must route a listing with no known condition
//      (retailListing.used forced to false, the mechanism the new card
//      uses) down the New-vehicle close/loose link tier — never attempting
//      an exact-VIN URL it has no listing to justify.
//
// Run: npx tsx tests/standalone-identity-card.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLinks } from "../lib/link-resolution";
import type { AutoDevListing } from "../lib/auto-dev-client";

const baseMeta = {
  totalCandidatesConsidered: 1,
  totalMatches: 1,
  resultsShown: 1,
  corpusSizeApprox: "3,000,000+",
  relaxations: [],
  dataNotes: [],
  scopeNote: "vin_lookup" as const,
  serviceError: null,
  interpretationNotes: [],
  qualifierAccounting: [],
};

const baseResult = {
  canonicalVehicleId: "test:1",
  risk: { tier: "unknown" as const, reasons: [] },
  identity: { vin: "1FMDE6BH4TLA65389", year: 2020, make: "Ford", model: "Bronco", trim: null, series: null, squishVin: null, bodyStyleConfig: null },
  condition: { inventoryType: "unknown" as const, used: null, cpo: null, cpoEvidenceState: "unknown" as const },
  powertrain: { type: "unknown", engine: null, drivetrain: null, transmission: null },
  body: { bodyStyle: null, vehicleType: null, doors: null },
  listing: { price: null, mileage: null, dealer: null, dealerId: null, city: null, state: null, zip: null, rawVdp: null, resolvedDestination: null, destinationClass: null },
  history: { state: "unreported" as const, note: "n/a", ownerNote: null },
  media: { primaryImage: null, cardImageUrl: null, photoUrls: [] },
  verification: { identityVerificationStatus: "potential_match" as const, verifiedAttributes: [], unknownAttributes: [], conflictingAttributes: [] },
  links: { affiliateUrl: null, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "none-available" as const, checkAvailSource: "none" as const },
  detail: { carfaxUrl: null, cpoNote: "n/a", ownerHistoryNote: null, interiorColor: null, exteriorColor: null, cylinders: null, seats: null, seatsNote: "n/a", dataConfidence: null, historyUsageType: null, historyPersonalUse: null, titleStatus: null },
  badges: [],
  intentConfirmations: [],
  dataConflicts: [],
  constraintChecks: [],
  searchConstraintStatus: "not_applicable" as const,
};

test("RankingSchema (V3.3 widening): accepts null matchScore/matchScoreLabel for an identity-only card", async () => {
  const { FindMatchingVehicleOutputSchema } = await import("../lib/find-matching-vehicle-output");

  const withNullRanking = {
    meta: baseMeta,
    results: [
      {
        ...baseResult,
        ranking: { matchScore: null, matchScoreLabel: null, breakdown: { statedCriteriaFit: 0, resolvedCriteriaFit: 0, identityConfidence: 0, penalizedByRelaxation: [] } },
      },
    ],
  };
  assert.doesNotThrow(() => FindMatchingVehicleOutputSchema.parse(withNullRanking), "a null match score/label must be a valid, honest shape for an identity-only card");
});

test("RankingSchema (V3.3 widening): still rejects a genuinely invalid matchScoreLabel value — the widening only added null, not arbitrary strings", async () => {
  const { FindMatchingVehicleOutputSchema } = await import("../lib/find-matching-vehicle-output");

  const withInvalidLabel = {
    meta: baseMeta,
    results: [
      {
        ...baseResult,
        ranking: { matchScore: 91, matchScoreLabel: "Excellent match", breakdown: { statedCriteriaFit: 1, resolvedCriteriaFit: 1, identityConfidence: 1, penalizedByRelaxation: [] } },
      },
    ],
  };
  assert.throws(() => FindMatchingVehicleOutputSchema.parse(withInvalidLabel), "matchScoreLabel must still be restricted to the three real enum values or null — never an arbitrary string");
});

test("RankingSchema (V3.3 widening): every existing real-search shape (non-null matchScore/label) still validates exactly as before", async () => {
  const { FindMatchingVehicleOutputSchema } = await import("../lib/find-matching-vehicle-output");

  const realSearchShape = {
    meta: baseMeta,
    results: [
      {
        ...baseResult,
        ranking: { matchScore: 96, matchScoreLabel: "Strong match" as const, breakdown: { statedCriteriaFit: 0.9, resolvedCriteriaFit: 0.95, identityConfidence: 1, penalizedByRelaxation: [] } },
      },
    ],
  };
  assert.doesNotThrow(() => FindMatchingVehicleOutputSchema.parse(realSearchShape), "the widening must be additive only — every real find_matching_vehicle/check_vehicle-with-listing shape must be unaffected");
});

test("resolveLinks: an identity-only listing (retailListing.used forced false, no vdp/price/vin) still routes to the New-vehicle close/loose tier, never attempts an exact-VIN URL", () => {
  const identityOnlyListing = {
    vin: "",
    vehicle: { make: "Honda", model: "CR-V", year: 2023 },
    retailListing: { used: false },
  } as AutoDevListing;

  const links = resolveLinks(identityOnlyListing);

  assert.equal(links.checkAvailSource, "close", "with no listing to justify an exact-VIN attempt, Check avail. must come from the close (trim/model) category tier, never 'exact'");
  assert.ok(links.affiliateUrl, "a close category URL should be buildable from make/model/year alone");
  assert.ok(links.affiliateFallbackUrl, "a loose (bare make/model) View similar URL should be buildable alongside Check avail.");
  assert.equal(links.dealerListingUrl, null, "no dealer link should ever be invented when there is no real listing");
});

test("resolveLinks: an identity-only listing with no VIN and no make/model produces no usable link, and reports 'none-available' honestly", () => {
  const emptyListing = {
    vin: "",
    vehicle: {},
    retailListing: { used: false },
  } as AutoDevListing;

  const links = resolveLinks(emptyListing);

  assert.equal(links.linkStatus, "none-available", "with nothing to build a destination from, the honest result is 'none-available', not an invented link");
  assert.equal(links.affiliateUrl, null);
  assert.equal(links.affiliateFallbackUrl, null);
});
