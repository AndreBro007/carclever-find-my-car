import { test } from "node:test";
import assert from "node:assert/strict";
import { isSizeClassOnly, needsWorthAsking } from "../lib/needs-note";

test("size and class labels alone are recognised", () => {
  for (const n of ["midsize SUV", "medium-size SUV", "medium size SUV", "Mid-size sedan", "compact car", "family SUV", "midsize family SUV", "Family", "full-size truck", "small crossover", "large SUV", "subcompact", "SUV"]) assert.equal(isSizeClassOnly(n), true, n);
});
test("practical needs are kept", () => {
  for (const n of ["towing 5,000 lbs", "good in snow", "three-row SUV with seven seats", "commuter car", "city driving", "off-road ready"]) assert.equal(isSizeClassOnly(n), false, n);
});
test("needsWorthAsking drops labels, trims, and tolerates bad input", () => {
  assert.deepEqual(needsWorthAsking(["midsize SUV", " towing 3,000 lbs ", "", "compact car"]), ["towing 3,000 lbs"]);
  assert.deepEqual(needsWorthAsking(undefined), []);
  assert.deepEqual(needsWorthAsking("midsize SUV"), []);
  assert.deepEqual(needsWorthAsking([null, 5 as unknown as string]), ["5"]);
});
