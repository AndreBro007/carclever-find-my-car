// Pure checks for the Oct 19 bug-fix batch: VIN check digit, SUV size classes, budget scoring, accounting, Edmunds labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vinCheckDigitFails } from "../lib/vin-anatomy";
import { invalidVinMessage } from "../lib/nhtsa-links";
import { broadBodyTypeHint, unappliedFilterNote } from "../lib/broad-search-hint";
import { applyLocalBestForBudgetOrdering } from "../lib/local-ranking";
import { buildQualifierAccounting } from "../lib/qualifier-accounting";
import { zeroResultsExitLine, closingExitLine } from "../lib/dead-end-links";

test("check digit: the bad VINs fail, a valid VIN and a non-North-American VIN do not", () => {
  assert.equal(vinCheckDigitFails("1C4RJFBG3KC123456"), true);
  assert.equal(vinCheckDigitFails("1HGCV1F3999Z99999"), true);
  assert.equal(vinCheckDigitFails("1HGCV1F39MZ999999"), false);
  assert.equal(vinCheckDigitFails("WVWZZZ1JZXW000001"), false);
  assert.equal(vinCheckDigitFails("not-a-vin"), false);
  assert.match(invalidVinMessage("1C4RJFBG3KC123456"), /^Invalid VIN: 1C4RJFBG3KC123456 .*nhtsa\.gov\/recalls\?vymm=1C4RJFBG3KC123456/);
});

test("broad body-type hint: only for a body type with no model and no make; no tables, the AI does the classifying", () => {
  assert.match(broadBodyTypeHint({ bodyType: "SUV" }), /broad SUV search with no model names.*resend with the real model names for that class in "model": the catalogue has no size data/);
  assert.equal(broadBodyTypeHint({ bodyType: "SUV", model: "Highlander, Pilot" }), "");
  assert.equal(broadBodyTypeHint({ bodyType: "Sedan", make: "Honda" }), "");
  assert.equal(broadBodyTypeHint({}), "");
});

test("not-applied note: names the field, shows what the results are, tells the AI to state only that", () => {
  const cards = [{ detail: { cylinders: 6 } }, { detail: { cylinders: 6 } }, { detail: { cylinders: null } }];
  const n = unappliedFilterNote({ cylinders: 4 }, cards);
  assert.match(n, /^cylinder count could not be applied as a filter because the catalogue has no such field\. Cylinder count in these results: 6-cylinder \(2 of 3\), unknown \(1 of 3\)\. State only what is shown here/);
  const t = unappliedFilterNote({ transmission: "Manual" }, [{ powertrain: { transmission: "Automatic" } }]);
  assert.match(t, /Transmission in these results: Automatic \(1 of 1\)\./);
  assert.match(unappliedFilterNote({ cylinders: 4, transmission: "Manual" }, []), /^cylinder count and transmission could not be applied/);
  assert.equal(unappliedFilterNote({}, cards), "");
});

const car = (vin: string, year: number, miles: number, price: number): any => ({ vin, vehicle: { year, make: "X", model: "Y" }, retailListing: { price, miles } });
test("budget ordering with a ceiling: the best car up to the ceiling wins, not the cheapest; without one the old order holds", () => {
  const same = [car("A", 2025, 10000, 18000), car("B", 2025, 10000, 30000), car("C", 2025, 10000, 34000)];
  assert.equal(applyLocalBestForBudgetOrdering(same, undefined, undefined, 35000)[0].vin, "C");
  assert.equal(applyLocalBestForBudgetOrdering(same, undefined, undefined)[0].vin, "A");
  const yearWins = [car("new-cheap", 2025, 10000, 18000), car("old-dear", 2020, 10000, 34000)];
  assert.equal(applyLocalBestForBudgetOrdering(yearWins, undefined, undefined, 35000)[0].vin, "new-cheap");
});

test("accounting: cylinders and transmission are never reported as filtered in a search; a VIN check still is a check", () => {
  const search = buildQualifierAccounting({ cylinders: 4, transmission: "Manual" } as any);
  assert.deepEqual(search.map((e) => e.tier), ["disclosed_not_filtered", "disclosed_not_filtered"]);
  assert.ok(search.every((e) => /not applied as a filter/.test(e.applied)));
  const vin = buildQualifierAccounting({ vin: "1HGCV1F39MZ999999", cylinders: 6 } as any);
  assert.equal(vin[0].tier, "structural_filter"); assert.match(vin[0].applied, /checked against this listing/);
});

test("Edmunds labels are short and claim nothing about area: all trims, not filtered to the asked trim; no 'near you'", () => {
  const z = zeroResultsExitLine("Mercedes-Benz", "GLA", true, "AMG");
  assert.match(z, /^\n\nSee all used Mercedes-Benz GLA on Edmunds \(all trims, not filtered to AMG; enter your ZIP there for local results\): https:\/\/edmunds\.sjv\.io\//);
  assert.ok(!/near you/.test(z));
  const c = closingExitLine([{ identity: { make: "Honda", model: "Civic" }, condition: { inventoryType: "used" } }]);
  assert.match(c, /on Edmunds \(all trims; enter your ZIP there for local results\): https:/); assert.ok(!/near you/.test(c));
});
