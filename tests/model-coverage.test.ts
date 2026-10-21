/** Model coverage helpers (SYS-20261021-017, option A). Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestedGroups, groupKeyOf, interleaveByGroup, coverageReached, applyModelCoverage, modelsNotShown } from "../lib/model-coverage";

type Car = { vin: string; vehicle: { model: string }; retailListing?: { price: number } };
const car = (vin: string, model: string, price = 40000): Car => ({ vin, vehicle: { model }, retailListing: { price } });
const G = requestedGroups("Highlander, Grand Highlander, Sorento, Santa Fe, RX");
const keyOf = (c: Car) => groupKeyOf(c.vehicle.model, G);

test("groups: one per family, hybrid variants join their base model, Grand Highlander is its own", () => {
  assert.deepEqual(G.map((g) => g.name), ["Highlander", "Grand Highlander", "Sorento", "Santa Fe", "RX"]);
  assert.equal(keyOf(car("a", "Highlander Hybrid")), keyOf(car("b", "Highlander")));
  assert.notEqual(keyOf(car("a", "Highlander Hybrid")), keyOf(car("b", "Grand Highlander Hybrid")));
  assert.equal(keyOf(car("a", "RX 450h")), keyOf(car("b", "RX")));
  assert.equal(keyOf(car("a", "Pilot")), null);
  assert.equal(requestedGroups("Highlander, Highlander Hybrid").length, 1);
  assert.equal(requestedGroups(undefined).length, 0);
});

test("fewer than two models: everything is inert", () => {
  const one = requestedGroups("RX"); const pool = [car("a", "RX"), car("b", "RX")];
  assert.deepEqual(interleaveByGroup(pool, (c) => groupKeyOf(c.vehicle.model, one), one), pool);
  assert.deepEqual(applyModelCoverage(pool, one, 1), pool);
  assert.equal(coverageReached(pool, [], () => null, () => true, one), true);
  assert.deepEqual(modelsNotShown(pool, [], one), []);
});

test("interleave: models in turn, order inside a model kept, unrequested cars last", () => {
  const pool = [car("r1", "RX"), car("r2", "RX"), car("r3", "RX"), car("h1", "Highlander Hybrid"), car("s1", "Sorento Hybrid"), car("h2", "Highlander Hybrid"), car("x1", "Pilot")];
  assert.deepEqual(interleaveByGroup(pool, keyOf, G).map((c) => c.vin), ["r1", "h1", "s1", "r2", "h2", "r3", "x1"]);
});

test("coverageReached: a model needs one confirmed car, or two tried without one, or all its cars tried", () => {
  const pool = [car("r1", "RX"), car("h1", "Highlander Hybrid"), car("r2", "RX"), car("h2", "Highlander Hybrid"), car("h3", "Highlander Hybrid")];
  const ok = (r: unknown) => r === "yes";
  const two = requestedGroups("RX, Highlander");
  assert.equal(coverageReached(pool, ["yes", "no"], keyOf, ok, two), false, "Highlander tried once, none confirmed");
  assert.equal(coverageReached(pool, ["yes", "yes"], keyOf, ok, two), true);
  assert.equal(coverageReached(pool, ["yes", "no", "yes", "no"], keyOf, ok, two), true, "Highlander tried twice without one: enough");
  assert.equal(coverageReached(pool, ["no", "yes"], keyOf, ok, two), false, "RX tried once, none confirmed");
});

test("reserved seats: every requested model with a car gets one, replacing a duplicate, never the only car of a model", () => {
  const ranked = [car("r1", "RX"), car("r2", "RX"), car("h1", "Highlander Hybrid"), car("h2", "Highlander Hybrid"), car("g1", "Grand Highlander Hybrid"), car("g2", "Grand Highlander Hybrid"), car("r3", "RX"), car("r4", "RX"),
    car("s1", "Sorento Hybrid"), car("f1", "Santa Fe")];
  const out = applyModelCoverage(ranked, G, 8).slice(0, 8).map((c) => c.vin);
  assert.ok(out.includes("s1") && out.includes("f1"), out.join(","));
  assert.ok(out.includes("r1") && out.includes("h1") && out.includes("g1"), "the best car of each model that was already shown stays");
  assert.equal(out.length, 8);
});

test("reserved seats: at most four are changed, and a model never loses its only car", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"]; const g9 = requestedGroups(names.join(", "));
  const ranked = [...names.flatMap((n) => [car(`${n}1`, n), car(`${n}2`, n)])];
  const out = applyModelCoverage(ranked, g9, 8, 4).slice(0, 8);
  const models = new Set(out.map((c) => c.vehicle.model));
  assert.equal(out.length, 8); assert.equal(models.size, 8, "four seats changed: eight models of nine");
  assert.deepEqual(modelsNotShown(ranked, out.map((c) => ({ model: c.vehicle.model })), g9).map((m) => m.name).length, 1);
});

test("not shown: names the requested model with the lowest price among the cars checked (an example, not the model's lowest); nothing when all are shown", () => {
  const cands = [car("a", "Santa Fe", 41000), car("b", "Santa Fe", 39064), car("c", "Sorento Hybrid", 37424), car("d", "RX", 61704)];
  const r = modelsNotShown(cands, [{ model: "RX" }], G);
  assert.deepEqual(r, [{ name: "Sorento", examplePrice: 37424 }, { name: "Santa Fe", examplePrice: 39064 }]);
  assert.deepEqual(modelsNotShown(cands, [{ model: "RX" }, { model: "Santa Fe" }, { model: "Sorento Hybrid" }], G), []);
  assert.deepEqual(modelsNotShown([car("e", "Pilot")], [], G), [], "a model with no candidate is not claimed");
});
