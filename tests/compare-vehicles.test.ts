// compare_vehicles: pure comparison logic (differences only, unknown stays unknown), distance helper, and the tool wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildComparison, comparisonText, comparisonTable, zipDistanceMiles, type CompareItem } from "../lib/compare";

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

test("extra rows: transmission, body style, doors, seats, colours and dealer appear only when at least one vehicle has the value; numeric rows state lowest and highest", () => {
  const x = { vin: "A".repeat(17), bodyStyle: "Sedan", doors: 4, seats: 5, exteriorColor: "Black", dealer: "One Motors, Inglewood CA" };
  const y = { vin: "B".repeat(17), bodyStyle: "SUV", doors: 4, seats: 7, exteriorColor: "Blue", interiorColor: "Gray", dealer: "Two Motors, Gardena CA", transmission: "Automatic" };
  const rows = buildComparison([x, y]);
  const r = (l: string) => rows.find((q) => q.label === l);
  assert.deepEqual(r("Body style")!.values, ["Sedan", "SUV"]); assert.deepEqual(r("Seats (NHTSA)")!.values, ["5", "7"]); assert.match(r("Seats (NHTSA)")!.note!, /lowest #1; highest #2/);
  assert.match(r("Doors")!.note!, /^same door count/); assert.deepEqual(r("Interior color")!.values, [null, "Gray"]); assert.deepEqual(r("Transmission")!.values, [null, "Automatic"]);
  assert.deepEqual(r("Dealer")!.values, ["One Motors, Inglewood CA", "Two Motors, Gardena CA"]);
  const none = buildComparison([{ vin: "A".repeat(17) }, { vin: "B".repeat(17) }]).map((q) => q.label);
  for (const l of ["Transmission", "Body style", "Doors", "Seats (NHTSA)", "Exterior color", "Interior color", "Dealer"]) assert.ok(!none.includes(l), `${l} is left out when nothing is known`);
});

test("comparisonTable: header, Vehicle and VIN rows, the best value in bold only for price, mileage, year and distance, ties all bold, equal values and other rows plain, pipes escaped", () => {
  const x: CompareItem = { vin: "A".repeat(17), year: 2023, make: "Toyota", model: "Camry", trim: "LE | Plus", price: 20000, mileage: 30000, dealerZip: "90210", rating: 5, recallCampaigns: 2, fuel: "Hybrid" };
  const y: CompareItem = { vin: "B".repeat(17), year: 2026, make: "Toyota", model: "Camry", trim: null, price: 20000, mileage: 10000, dealerZip: "92101", rating: 4, recallCampaigns: 5, fuel: "Hybrid" };
  const z: CompareItem = { vin: "C".repeat(17), year: 2026, make: "Toyota", model: "Camry", price: 25000, mileage: null, dealerZip: "90210", fuel: "Hybrid" };
  const rows = buildComparison([x, y, z], "90210"); const t = comparisonTable([x, y, z], rows); const L = t.split("\n");
  assert.equal(L[0], "| | #1 | #2 | #3 |"); assert.equal(L[1], "|---|---|---|---|");
  assert.match(L[2], /^\| Vehicle \| 2023 Toyota Camry LE \/ Plus \| 2026 Toyota Camry \| 2026 Toyota Camry \|$/); assert.match(L[3], /^\| VIN \| A{17} \| B{17} \| C{17} \|$/);
  const r = (l: string) => L.find((q) => q.startsWith(`| ${l} |`))!;
  assert.equal(r("Price"), "| Price | **$20,000** | **$20,000** | $25,000 |", "a tie for lowest: both bold");
  assert.equal(r("Mileage"), "| Mileage | 30,000 mi | **10,000 mi** | unknown |");
  assert.equal(r("Year"), "| Year | 2023 | **2026** | **2026** |", "newest year: the tie is bold");
  assert.match(r("Distance from 90210"), /^\| Distance from 90210 \| \*\*0 mi\*\* \| \d+ mi \| \*\*0 mi\*\* \|$/);
  assert.ok(!/\*\*/.test(r("Fuel")) && !/\*\*/.test(r("NHTSA overall rating (model year)")) && !/\*\*/.test(r("NHTSA recall campaigns (model year, not this car)")), "fuel, safety rating and recalls are never marked");
  assert.equal(comparisonTable([x], rows), ""); assert.equal(comparisonTable([x, y], []), "");
  const same = comparisonTable([{ vin: "A".repeat(17), price: 100 }, { vin: "B".repeat(17), price: 100 }], buildComparison([{ vin: "A".repeat(17), price: 100 }, { vin: "B".repeat(17), price: 100 }]));
  assert.ok(!/\*\*/.test(same), "equal values are not marked");
  assert.ok(!/\b(best|better|worse|winner)\b/i.test(comparisonText(rows)), "the Differences block itself still ranks nothing");
});
