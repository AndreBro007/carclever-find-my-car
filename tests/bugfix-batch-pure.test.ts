// Pure checks for the Oct 19 bug-fix batch: VIN check digit, SUV size classes, budget scoring, accounting, Edmunds labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vinCheckDigitFails } from "../lib/vin-anatomy";
import { invalidVinMessage } from "../lib/nhtsa-links";
import { inferClassHint, classModels, classSizeNote } from "../lib/vehicle-class";
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

test("SUV size classes: midsize and compact map to different model lists; a named model wins; other body styles get an honest note", () => {
  assert.equal(inferClassHint({ bodyType: "SUV", vehicleNeeds: ["midsize SUV"] }), "midsize_suv");
  assert.equal(inferClassHint({ bodyType: "SUV", vehicleNeeds: ["compact crossover"] }), "compact_suv");
  assert.equal(inferClassHint({ bodyType: "SUV", vehicleNeeds: ["subcompact SUV"] }), "subcompact_suv");
  assert.equal(inferClassHint({ bodyType: "SUV", vehicleNeeds: ["large family SUV"] }), "large_suv_3row");
  assert.equal(inferClassHint({ bodyType: "SUV" }), undefined);
  assert.equal(inferClassHint({ model: "RAV4", bodyType: "SUV", vehicleNeeds: ["midsize"] }), undefined);
  const mid = classModels("midsize_suv"), compact = classModels("compact_suv");
  assert.ok(mid.includes("Highlander") && mid.includes("Santa Fe") && !mid.includes("Escape") && !mid.includes("Equinox"));
  assert.ok(compact.includes("Escape") && compact.includes("Equinox") && !compact.includes("Highlander"));
  assert.ok(classModels("large_suv_3row").includes("Tahoe"));
  assert.match(classSizeNote({ bodyType: "SUV", vehicleNeeds: ["midsize SUV"] }), /matched against a list of models.*no size field/);
  assert.match(classSizeNote({ bodyType: "Sedan", vehicleNeeds: ["midsize sedan"] }), /no size field.*could not be applied/);
  assert.equal(classSizeNote({ bodyType: "SUV" }), "");
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

test("Edmunds labels say what the page is: not filtered to area, price or trim; no 'near you'", () => {
  const z = zeroResultsExitLine("Mercedes-Benz", "GLA", true, "AMG");
  assert.match(z, /^\n\nSee all used Mercedes-Benz GLA on Edmunds \(this page is not filtered to your area, price or AMG trim\): https:\/\/edmunds\.sjv\.io\//);
  assert.ok(!/near you/.test(z));
  const c = closingExitLine([{ identity: { make: "Honda", model: "Civic" }, condition: { inventoryType: "used" } }]);
  assert.match(c, /on Edmunds \(this page is not filtered to your area or price\)/); assert.ok(!/near you/.test(c));
});
