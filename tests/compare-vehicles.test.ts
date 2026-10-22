// compare_vehicles: pure comparison logic (differences only, unknown stays unknown), distance helper, and the tool wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildComparison, comparisonText, zipDistanceMiles, type CompareItem } from "../lib/compare";

const a: CompareItem = { vin: "A", year: 2024, make: "Toyota", model: "RAV4", trim: "XLE", price: 31990, mileage: 12300, condition: "used", fuel: "Hybrid", drive: "AWD", engine: "2.5L 4-cyl 219 hp", rating: 5, recallCampaigns: 3, dealerZip: "90210" };
const b: CompareItem = { vin: "B", year: 2023, make: "Toyota", model: "RAV4", trim: "LE", price: 28500, mileage: 30100, condition: "used", fuel: "Gasoline", drive: "AWD", engine: "2.5L 4-cyl 203 hp", rating: 4, recallCampaigns: 3, dealerZip: "92101" };
const row = (rows: ReturnType<typeof buildComparison>, label: string) => rows.find((r) => r.label.startsWith(label));

test("price, mileage and year rows state the extremes and the spread, per vehicle number", () => {
  const rows = buildComparison([a, b]);
  assert.deepEqual(row(rows, "Price")!.values, ["$31,990", "$28,500"]); assert.equal(row(rows, "Price")!.note, "lowest #2; highest #1; spread $3,490");
  assert.deepEqual(row(rows, "Mileage")!.values, ["12,300 mi", "30,100 mi"]); assert.match(row(rows, "Mileage")!.note!, /lowest #1; highest #2/);
  assert.equal(row(rows, "Year")!.note, "lowest #2; highest #1; spread 1");
});
test("identical values are reported as the same, differing text is listed per vehicle, and no row ranks or judges", () => {
  const rows = buildComparison([a, b]);
  assert.equal(row(rows, "Drive")!.note, "the same on every vehicle"); assert.equal(row(rows, "Trim")!.note, undefined); assert.deepEqual(row(rows, "Fuel")!.values, ["Hybrid", "Gasoline"]);
  assert.equal(row(rows, "NHTSA recall")!.note, "same count on every vehicle that reports one");
  const txt = comparisonText(rows); assert.match(txt, /^Differences \(stated, not ranked\):/); assert.ok(!/\b(best|better|worse|winner|safer|recommend)\b/i.test(txt));
});
test("unknown data stays unknown: a missing value shows as unknown, a row with no data at all is left out, three vehicles work", () => {
  const c: CompareItem = { vin: "C", price: 30000 };
  const rows = buildComparison([a, b, c]);
  assert.deepEqual(row(rows, "Price")!.values, ["$31,990", "$28,500", "$30,000"]); assert.match(row(rows, "Price")!.note!, /lowest #2; highest #1/);
  assert.deepEqual(row(rows, "Mileage")!.values, ["12,300 mi", "30,100 mi", null]); assert.match(comparisonText(rows), /#3 unknown/);
  const bare = buildComparison([{ vin: "X", price: 1 }, { vin: "Y", price: 2 }]); assert.deepEqual(bare.map((r) => r.label), ["Price"]); assert.equal(comparisonText([]), "");
});
test("distance rows appear only when a ZIP is given; the helper returns null for unknown ZIPs", () => {
  assert.equal(row(buildComparison([a, b]), "Distance"), undefined);
  const r = row(buildComparison([a, b], "90210"), "Distance from 90210")!; assert.equal(r.values[0], "0 mi"); assert.match(r.values[1]!, /^\d+ mi$/);
  const d = zipDistanceMiles("90210", "92101")!; assert.ok(d > 100 && d < 130, `Beverly Hills to San Diego is about 110 miles, got ${d}`);
  assert.equal(zipDistanceMiles("00000", "90210"), null); assert.equal(zipDistanceMiles(null, "90210"), null);
});
test("tool wiring: compare_vehicles is registered with a title, 2 to 4 VINs, boundaries to the other tools, and no widget (text reply only)", () => {
  const src = readFileSync("app/[transport]/route.ts", "utf8"); const i = src.indexOf('"compare_vehicles",\n    {'); assert.ok(i > 0, "tool must be registered");
  const block = src.slice(i, i + 3500);
  assert.match(block, /title: "Compare Vehicles"/); assert.match(block, /vins: z\.array\(z\.string\(\)\)\.min\(2\)\.max\(4\)/);
  assert.match(block, /use find_matching_vehicle/); assert.match(block, /use check_vehicle/); assert.ok(!/RESULTS_CARD_RESOURCE_URI|openai\/outputTemplate/.test(block), "compare_vehicles declares no widget");
  assert.ok(!/carfax|accident-free|risk tier/i.test(block));
});
