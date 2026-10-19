import test from "node:test";
import assert from "node:assert/strict";
import { isStrictAxis, strictAxisOrder } from "../lib/explicit-axis-order";
import { applyDiversity } from "../lib/diversity";
import type { VehicleListing } from "../lib/listing-types";

let n = 0;
const vin = () => `1HGCV1F3${String(++n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
const car = (model: string, price: number, year = 2022, miles = 30000, v = vin()): VehicleListing => ({ vin: v, vehicle: { make: "X", model, year }, retailListing: { price, miles } });

test("the axis names are recognised, best_for_budget and unset are not explicit", () => {
  for (const a of ["cheapest", "newest", "lowest_mileage"]) assert.equal(isStrictAxis(a), true);
  for (const a of ["best_for_budget", undefined, null, "", "lower_risk"]) assert.equal(isStrictAxis(a), false);
});

test("ChatGPT's counterexample: ten cheap model-A cars then ten model-B cars, the first eight are the eight cheapest, in order", () => {
  const pool = [...Array.from({ length: 10 }, (_, i) => car("A", 10000 + i * 1000)), ...Array.from({ length: 10 }, (_, i) => car("B", 30000 + i * 1000))];
  const strict = strictAxisOrder(pool, "cheapest", 16).slice(0, 8).map((c) => c.retailListing!.price as number);
  assert.deepEqual(strict, [10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000]);
  // what the variety rule did to the same pool (the defect): a $30k car ahead of a $12k car
  const old = applyDiversity(pool, 16).slice(0, 8).map((c) => c.retailListing!.price as number);
  assert.ok(old.some((p, i) => i > 0 && p < old[i - 1]), "the old behaviour is out of order");
});

test("newest and lowest mileage are strict across models too", () => {
  const pool = [car("A", 20000, 2024, 9000), car("A", 21000, 2024, 8000), car("A", 22000, 2024, 7000), car("A", 23000, 2024, 6000), car("B", 24000, 2027, 100), car("B", 25000, 2027, 50), car("B", 26000, 2026, 10)];
  assert.deepEqual(strictAxisOrder(pool, "newest", 5).map((c) => [c.vehicle!.year, c.retailListing!.miles]), [[2027, 50], [2027, 100], [2026, 10], [2024, 6000], [2024, 7000]]);
  assert.deepEqual(strictAxisOrder(pool, "lowest_mileage", 4).map((c) => c.retailListing!.miles), [10, 50, 100, 6000]);
});

test("cars with no value for the sorted field go last; ties fall to the next field; the same VIN counts once; input is not mutated", () => {
  const dup = vin();
  const pool = [car("A", 5000, 2020, 100, dup), car("A", 5000, 2020, 100, dup), { vin: vin(), vehicle: { year: 2020 }, retailListing: {} } as VehicleListing, car("B", 5000, 2021, 50), car("C", 4000)];
  const before = pool.map((c) => c.vin).join();
  const out = strictAxisOrder(pool, "cheapest", 10);
  assert.deepEqual(out.map((c) => c.retailListing?.price), [4000, 5000, 5000, undefined]);
  assert.equal(out[1].retailListing!.miles, 50); // tie on price: lower mileage first
  assert.equal(out.filter((c) => c.vin === dup).length, 1);
  assert.equal(pool.map((c) => c.vin).join(), before);
  assert.equal(strictAxisOrder(pool, "cheapest", 2).length, 2);
});
