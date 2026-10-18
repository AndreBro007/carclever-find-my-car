// Database mode leaves out fields the Edmunds feed can never fill (history, risk, Carfax, CPO, owner, title, VDP, extra photos)
// so the calling model is not shown empty fields or "not reported" warnings. Synthetic car, no real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindMatchingVehicleOutputSchema, CatalogDbOutputSchema } from "../lib/find-matching-vehicle-output";
import { shapeCardForCatalog, shapeCardsForSource, shapeBuyerCheckForCatalog, nhtsaTextLines, nhtsaTextFootnote } from "../lib/catalog-output";

const HIST = "Accident history was not reported for this listing. No Carfax link was available.";
const card = () => ({
  canonicalVehicleId: "VIN123",
  risk: { tier: "unknown", reasons: [] as string[] },
  identity: { vin: "1HGCM82633A004352", year: 2024, make: "Honda", model: "Accord", trim: "EX", series: null, squishVin: null, bodyStyleConfig: null },
  condition: { inventoryType: "used", used: true, cpo: null, cpoEvidenceState: "unknown" },
  powertrain: { type: "unknown", engine: null, drivetrain: null, transmission: null },
  body: { bodyStyle: "Sedan", vehicleType: null, doors: 4 },
  listing: { price: 25000, mileage: 12000, dealer: "Test Motors", dealerId: "1", city: "Austin", state: "TX", zip: "73301", rawVdp: null, resolvedDestination: null, destinationClass: null },
  history: { state: "unreported", note: HIST, ownerNote: null },
  media: { primaryImage: "https://example.com/a.jpg", cardImageUrl: "https://example.com/b.jpg", photoUrls: [] as string[] },
  verification: { identityVerificationStatus: "verified_match", verifiedAttributes: ["year"], unknownAttributes: ["trim"], conflictingAttributes: [] as string[] },
  ranking: { matchScore: 90, matchScoreLabel: "Strong match", breakdown: { statedCriteriaFit: 1, resolvedCriteriaFit: 1, identityConfidence: 1, penalizedByRelaxation: [] as string[] } },
  links: { affiliateUrl: "https://edmunds.sjv.io/x", affiliateFallbackUrl: "https://edmunds.sjv.io/y", dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only", checkAvailSource: "exact" },
  detail: { carfaxUrl: null, cpoNote: "CPO status not reported for this listing.", ownerHistoryNote: null, interiorColor: "Black", exteriorColor: "Blue", cylinders: null, seats: null, seatsNote: "Seating capacity not reported by this listing.", dataConfidence: null, historyUsageType: null, historyPersonalUse: null, titleStatus: null },
  badges: ["vin-verified"], intentConfirmations: [] as string[], dataConflicts: [] as string[], constraintChecks: [] as unknown[], searchConstraintStatus: "verified",
});
const meta = { totalCandidatesConsidered: 1, totalMatches: 1, resultsShown: 1, corpusSizeApprox: "about 1.4 million", relaxations: [] as unknown[], dataNotes: [] as string[], scopeNote: "local", serviceError: null, interpretationNotes: [] as string[], qualifierAccounting: [] as unknown[] };

test("the full card is valid for the standard schema (fixture sanity)", () => {
  const r = FindMatchingVehicleOutputSchema.safeParse({ meta, results: [card()] });
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 3)));
});
test("shaped card: unavailable fields are gone, useful ones stay", () => {
  const s: any = shapeCardForCatalog(card());
  for (const k of ["risk", "history"]) assert.ok(!(k in s), k);
  for (const k of ["series", "squishVin", "bodyStyleConfig"]) assert.ok(!(k in s.identity), k);
  for (const k of ["cpo", "cpoEvidenceState"]) assert.ok(!(k in s.condition), k);
  assert.ok(!("vehicleType" in s.body) && !("photoUrls" in s.media) && !("dealerListingUrl" in s.links));
  for (const k of ["rawVdp", "resolvedDestination", "destinationClass"]) assert.ok(!(k in s.listing), k);
  for (const k of ["carfaxUrl", "cpoNote", "ownerHistoryNote", "seatsNote", "dataConfidence", "historyUsageType", "historyPersonalUse", "titleStatus"]) assert.ok(!(k in s.detail), k);
  assert.equal(s.listing.price, 25000); assert.equal(s.detail.exteriorColor, "Blue"); assert.equal(s.links.affiliateUrl, "https://edmunds.sjv.io/x");
  assert.ok("powertrain" in s && "cylinders" in s.detail && "seats" in s.detail); // can be filled later from the VIN decoder
  assert.ok(JSON.stringify(s).indexOf("not reported") === -1 && JSON.stringify(s).indexOf("Carfax") === -1);
});
test("the database schema accepts the shaped card; the standard schema rightly does not", () => {
  const out = { meta, results: [shapeCardForCatalog(card())] };
  assert.ok(CatalogDbOutputSchema.safeParse(out).success);
  assert.ok(!FindMatchingVehicleOutputSchema.safeParse(out).success);
  assert.ok(CatalogDbOutputSchema.safeParse({ meta, results: [card()] }).success); // a full card is still valid too
});
test("shapeCardsForSource shapes cards for the database app", () => {
  const prev = process.env.LISTING_SOURCE;
  try {
    process.env.LISTING_SOURCE = "catalog_db";
    assert.ok(!("history" in (shapeCardsForSource([card()])[0] as any)));
  } finally { if (prev === undefined) delete process.env.LISTING_SOURCE; else process.env.LISTING_SOURCE = prev; }
});
test("buyer check on a VIN lookup loses the 'history not reported' line but keeps its other lines", () => {
  const c: any = { ...card(), buyerCheck: { outcome: "verify_before_proceeding", goodSigns: ["VIN verified"], concerns: [], needsVerification: [HIST, "Confirm price with the dealer"], nextSteps: ["Call the dealer"] } };
  const s: any = shapeCardForCatalog(c);
  assert.deepEqual(s.buyerCheck.needsVerification, ["Confirm price with the dealer"]);
  assert.deepEqual(s.buyerCheck.goodSigns, ["VIN verified"]);
});

test("buyer check built for the text the model reads: history, Carfax and CPO 'missing' lines are dropped in database mode only", () => {
  const bc = {
    outcome: "verify_before_proceeding", goodSigns: ["VIN verified"], concerns: [] as string[],
    needsVerification: [
      "model and trim cannot be confirmed from the VIN alone - confirm independently.",
      "Accident history was not reported for this listing - this is common.",
      "CPO status was not reported for this listing - ask the dealer if certification matters to you.",
      "No Carfax link was available on this listing - request an independent vehicle history report before purchase.",
    ],
    nextSteps: ["Have a pre-purchase inspection done by an independent mechanic.", "Independently verify the items listed above — via Carfax, a trusted mechanic, or the dealer — before finalizing a purchase."],
  };
  const prev = process.env.LISTING_SOURCE;
  try {
    process.env.LISTING_SOURCE = "catalog_db";
    const s = shapeBuyerCheckForCatalog(bc);
    assert.deepEqual(s.needsVerification, []); // the VIN-alone caveat is dropped on purpose: the NHTSA decode confirms model and trim (verification-consistency bundle, Oct 2026)
    assert.equal(s.nextSteps[0], bc.nextSteps[0]);
    assert.equal(s.nextSteps[1], "Independently verify the items listed above — via a vehicle history report, a trusted mechanic, or the dealer — before finalizing a purchase.");
    assert.ok(!JSON.stringify(s).toLowerCase().includes("carfax")); assert.deepEqual(s.goodSigns, ["VIN verified"]);
  } finally { if (prev === undefined) delete process.env.LISTING_SOURCE; else process.env.LISTING_SOURCE = prev; }
});

test("text the AI reads: details line and safety line appear in database mode only, recall count gets one footnote", () => {
  const c: any = { powertrain: { drivetrain: "AWD", engine: "2.5L 4-cyl 203 hp" }, detail: { fuelTypeDisplay: "Hybrid", seats: 5, nhtsaOverallRating: 5, nhtsaRecallCampaigns: 3, standardSafetyTech: ["Automatic emergency braking", "Forward collision warning", "Lane departure warning", "Rear camera", "Blind spot monitoring", "Adaptive cruise control"] } };
  const t = nhtsaTextLines(c, true);
  assert.ok(t.startsWith("\n   Hybrid · AWD · 2.5L 4-cyl 203 hp · 5 seats\n   NHTSA 5★ overall · 3 recall campaigns for this model year · NHTSA model-year data (may vary by trim): Automatic emergency braking, Forward collision warning, Lane departure warning, Rear camera +2 more"), t); // equipment is labelled model-year data on purpose (Oct 2026)
  assert.equal(nhtsaTextLines(c, false), ""); assert.equal(nhtsaTextLines({ powertrain: {}, detail: {} }, true), ""); assert.equal(nhtsaTextLines(null, true), "");
  assert.equal(nhtsaTextLines({ powertrain: {}, detail: { nhtsaRecallCampaigns: 1 } }, true), "\n   1 recall campaign for this model year");
  assert.match(nhtsaTextFootnote([c, c], true), /^\n\nNote: recall counts are for the model year/); assert.equal(nhtsaTextFootnote([c], false), ""); assert.equal(nhtsaTextFootnote([{ detail: {} }], true), "");
  assert.equal((nhtsaTextFootnote([c, c], true).match(/Note:/g) ?? []).length, 1);
});
