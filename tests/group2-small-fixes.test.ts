// Group 2, item 6 (9 Nov 2026): the recall applicability line and the US-only sentence. Run: npx tsx --test tests/group2-small-fixes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { recallApplicabilityLine } from "../lib/recall-note";
import { LOCATION_NOT_RECOGNISED_NOTE } from "../lib/location-note";
import { checkOutcome } from "../lib/usage-events";

test("the recall line names the car, says model year not this car, and is null when anything is missing", () => {
  assert.equal(recallApplicabilityLine(2022, "Toyota", "Camry"), "These campaigns are listed by NHTSA for the 2022 Toyota Camry (model year, not this specific car).");
  assert.equal(recallApplicabilityLine("2003", " Honda ", " Accord "), "These campaigns are listed by NHTSA for the 2003 Honda Accord (model year, not this specific car).");
  for (const bad of [[null, "Toyota", "Camry"], [2022, "", "Camry"], [2022, "Toyota", undefined], [undefined, undefined, undefined], ["", " ", ""]]) assert.equal(recallApplicabilityLine(...(bad as [unknown, unknown, unknown])), null);
});

test("the recall line carries no VIN or buyer data", () => {
  const l = recallApplicabilityLine(2022, "Toyota", "Camry")!;
  assert.ok(!/[A-HJ-NPR-Z0-9]{17}/.test(l));
});

test("usage events still classify a check as recall-known when the new line follows the Recall details line", () => {
  const ident = { make: "Ford", model: "Explorer", year: 2026 };
  const text = "Recall details (NHTSA, 14 total): 22V123000 — Fuel System: Some models may fail. | 22V456000 — Brakes: List of models, Camry...\nThese campaigns are listed by NHTSA for the 2026 Ford Explorer (model year, not this specific car).\nNHTSA source: https://example.invalid";
  assert.equal(checkOutcome({ content: [{ text }], structuredContent: { meta: {}, results: [{ identity: ident }] } }), "decoded_recall_known");
});

test("the location note keeps its original first sentence and adds the US-only sentence", () => {
  assert.ok(LOCATION_NOT_RECOGNISED_NOTE.startsWith("The requested location wasn't recognized, so this search was widened to nationwide."));
  assert.ok(LOCATION_NOT_RECOGNISED_NOTE.endsWith(" The listings are from US dealers only."));
  assert.match(LOCATION_NOT_RECOGNISED_NOTE, /wasn't recognized/, "the older test's pattern still matches");
});
