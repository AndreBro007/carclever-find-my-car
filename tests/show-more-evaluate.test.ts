// R4-6 step 4a (11 Nov 2026): checking one reserve car at expansion. Run: npx tsx --test tests/show-more-evaluate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReserveCar, constraintsQuery, type EvalDeps } from "../lib/show-more/evaluate";
import { bodyStyleMatches } from "../lib/stage2-rules";
import type { ReserveEntry } from "../lib/show-more/slate";
import type { Requirements } from "../lib/show-more/requirements";

const entry: ReserveEntry = { vin: "R1", drive: "confirmed", fuel: "na", attempts: 0, pending: false };
const car = (o: Record<string, unknown> = {}) => ({ vin: "R1", vehicle: { year: 2022, make: "Honda", model: "CR-V", trim: "EX-L", bodyStyle: "SUV", ...((o.vehicle as object) ?? {}) }, retailListing: { price: 24499.6, miles: 30000, used: true, ...((o.retailListing as object) ?? {}) } }) as never;
const deps = (listing: unknown, rating: number | undefined = 5): EvalDeps => ({ lookup: async () => ({ status: "found", listing: listing as never }), rate: async () => rating });
const req: Requirements = { make: "Honda", models: ["CR-V"], priceMax: 30000, yearMin: 2020, mileageMax: 60000, condition: "used" };

test("a car that still fits becomes a slot: whole-dollar price now, stars, and the drive and fuel states decided at the first search", async () => {
  const o = await evaluateReserveCar(entry, req, deps(car()));
  assert.deepEqual(o, { kind: "pass", slot: { vin: "R1", price: 24500, drive: "confirmed", fuel: "na", stars: 5 } });
});
test("a read that FAILS is pending (never excluded); a thrown read too; a car gone from the catalogue is removed", async () => {
  assert.deepEqual(await evaluateReserveCar(entry, req, { lookup: async () => ({ status: "error" }), rate: async () => 5 }), { kind: "pending" });
  assert.deepEqual(await evaluateReserveCar(entry, req, { lookup: async () => { throw new Error("down"); }, rate: async () => 5 }), { kind: "pending" });
  assert.deepEqual(await evaluateReserveCar(entry, req, { lookup: async () => ({ status: "absent" }), rate: async () => 5 }), { kind: "exclude", reason: "removed" });
});
test("a car that now breaks a hard limit is excluded as limit_break: price, year, mileage, make, model", async () => {
  for (const bad of [{ retailListing: { price: 31000 } }, { vehicle: { year: 2019 } }, { retailListing: { miles: 61000 } }, { vehicle: { make: "Toyota" } }, { vehicle: { model: "Civic" } }])
    assert.deepEqual(await evaluateReserveCar(entry, req, deps(car(bad))), { kind: "exclude", reason: "limit_break" }, JSON.stringify(bad));
});
test("verified evidence against the search (condition, body style, required trim) is a contradicted filter; missing evidence never excludes", async () => {
  assert.deepEqual(await evaluateReserveCar(entry, req, deps(car({ retailListing: { used: false } }))), { kind: "exclude", reason: "contradicted_filter" });
  assert.deepEqual(await evaluateReserveCar(entry, { ...req, bodyType: "Sedan" }, deps(car())), { kind: "exclude", reason: "contradicted_filter" });
  assert.equal((await evaluateReserveCar(entry, { ...req, bodyType: "SUV" }, deps(car()))).kind, "pass");
  assert.equal((await evaluateReserveCar(entry, { ...req, bodyType: "Sedan" }, deps(car({ vehicle: { bodyStyle: null, type: null } })))).kind, "pass", "no body style reported: unknown is never a mismatch");
  assert.deepEqual(await evaluateReserveCar(entry, { ...req, trimRequired: ["Sport"] }, deps(car())), { kind: "exclude", reason: "contradicted_filter" });
  assert.equal((await evaluateReserveCar(entry, { ...req, trimRequired: ["EX-L"] }, deps(car()))).kind, "pass");
  assert.equal((await evaluateReserveCar(entry, { ...req, condition: undefined }, deps(car({ retailListing: { used: null } })))).kind, "pass");
});
test("no usable price means nothing to freeze: removed", async () => {
  assert.deepEqual(await evaluateReserveCar(entry, req, deps(car({ retailListing: { price: null } }))), { kind: "exclude", reason: "removed" });
});
test("stars: the rating when there is one, none when NHTSA has none or cannot be reached; a failing rating never fails the car", async () => {
  assert.equal(((await evaluateReserveCar(entry, req, deps(car(), 4))) as { slot: { stars: unknown } }).slot.stars, 4);
  assert.equal(((await evaluateReserveCar(entry, req, { lookup: async () => ({ status: "found", listing: car() }), rate: async () => undefined })) as { slot: { stars: unknown } }).slot.stars, "none");
  const o = await evaluateReserveCar(entry, req, { lookup: async () => ({ status: "found", listing: car() }), rate: async () => { throw new Error("nhtsa"); } });
  assert.equal(o.kind, "pass");
});
test("the limits are passed to the search's own check in its own shape; the body-style rule is the shared one", () => {
  assert.deepEqual(constraintsQuery(req), { make: "Honda", model: "CR-V", priceMin: undefined, priceMax: 30000, yearMin: 2020, yearMax: undefined, mileageMax: 60000 });
  assert.equal(bodyStyleMatches("suv", car()), true); assert.equal(bodyStyleMatches("Sedan", car()), false);
});
