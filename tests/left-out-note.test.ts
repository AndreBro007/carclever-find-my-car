/** The left-out note names models NHTSA shows as another electrified type (T70, SYS-20261021-024). Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { leftOutNote } from "../lib/left-out-note";

test("names an electric model in a hybrid search", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }, { model: "Ioniq 5", state: "electric" }]), "2 cars that NHTSA shows as a different type than hybrid were left out: Ioniq 5 (electric).");
});
test("names several models with their types, once each", () => {
  const n = leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }, { model: "Santa Fe Plug-in Hybrid", state: "plug_in_hybrid" }, { model: "Ioniq 5", state: "electric" }]);
  assert.equal(n, "3 cars that NHTSA shows as a different type than hybrid were left out: Ioniq 5 (electric), Santa Fe Plug-in Hybrid (plug-in hybrid).");
});
test("plain gasoline cars are not named: the sentence is the old one", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Highlander", state: "not_electrified" }, { model: "RAV4", state: "not_electrified" }]), "2 cars that NHTSA shows as a different type than hybrid were left out.");
  assert.equal(leftOutNote("hybrid", []), "Cars that NHTSA shows as a different type than hybrid were left out.");
});
test("electrified types are named and gasoline cars beside them are not", () => {
  assert.equal(leftOutNote("plug-in hybrid", [{ model: "RAV4", state: "not_electrified" }, { model: "RAV4 Hybrid", state: "hybrid" }]), "2 cars that NHTSA shows as a different type than plug-in hybrid were left out: RAV4 Hybrid (hybrid).");
});
test("at most five are named, the rest are counted; blank models are skipped", () => {
  const cars = ["A", "B", "C", "D", "E", "F", "G"].map((m) => ({ model: m, state: "electric" }));
  assert.equal(leftOutNote("hybrid", [...cars, { model: " ", state: "electric" }]), "8 cars that NHTSA shows as a different type than hybrid were left out: A (electric), B (electric), C (electric), D (electric), E (electric), and 2 more.");
});
test("group 2 item 1B: the sentence leads with the number of cars; one car is singular; cars named only by their wording are not in that number", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }]), "1 car that NHTSA shows as a different type than hybrid was left out: Ioniq 5 (electric).");
  const mixed = leftOutNote("electric", [{ model: "Telluride Hybrid", state: "hybrid" }, { model: "Grand Highlander Hybrid", state: "wording" }, { model: "Grand Highlander Hybrid", state: "wording" }]);
  assert.ok(mixed.startsWith("1 car that NHTSA shows as a different type than electric was left out: Telluride Hybrid (hybrid)."), mixed);
  assert.equal(leftOutNote("hybrid", [{ model: "Grand Highlander", state: "wording" }]), "Cars whose name shows another type than hybrid were left out because NHTSA could not check them: Grand Highlander.");
  assert.equal(leftOutNote("hybrid", []), "Cars that NHTSA shows as a different type than hybrid were left out.", "no car at all: the original wording, no invented number");
  assert.ok(!/\d+ cars? .*[A-HJ-NPR-Z0-9]{17}/.test(leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }])), "no VIN");
});
