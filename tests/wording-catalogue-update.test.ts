// R4-8 (10 Nov 2026, André: A3a yes): our OWN strings say "in the latest catalogue update", not "current listing" or "current inventory" (the catalogue is a daily snapshot).
// Source-text test over the files that hold those strings. Run: npx tsx --test tests/wording-catalogue-update.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = ["lib/find-matching-vehicle-input.ts", "app/[transport]/route.ts"].map((f) => ({ f, t: readFileSync(f, "utf8") }));
const OLD = ["one current listing", "in current inventory", "matching live listing", "not currently listed", "vehicle's current listing"];

test("none of the old phrases is left in our tool descriptions or reply text", () => {
  for (const { f, t } of files) for (const phrase of OLD) assert.ok(!t.includes(phrase), `${f} still contains "${phrase}"`);
});
test("the new wording is in all five places", () => {
  const all = files.map((x) => x.t).join("\n");
  const count = (s: string) => all.split(s).length - 1;
  assert.equal(count("for one listing in the latest catalogue update"), 2, "both vin input descriptions");
  assert.equal(count("found no matching listing in the latest catalogue update"), 1);
  assert.equal(count("isn't a recognized model name in the latest catalogue update"), 1);
  assert.equal(count('No listing found for this VIN in the latest catalogue update'), 1);
  assert.equal(count("link to the vehicle's listing in the latest catalogue update"), 1);
});
test("the not-listed sentence keeps its meaning: an honest not-listed result, not a claim the car does not exist", () => {
  const t = files.find((x) => x.f.includes("route.ts"))!.t;
  assert.ok(t.includes('an honest \\"not listed here\\" result, not a claim the vehicle doesn\'t exist.'));
});
