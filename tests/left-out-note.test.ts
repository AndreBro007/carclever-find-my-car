/** The left-out note names models NHTSA shows as another electrified type (T70, SYS-20261021-024). Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { leftOutNote } from "../lib/left-out-note";

test("names an electric model in a hybrid search", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }, { model: "Ioniq 5", state: "electric" }]), "Cars that NHTSA shows as a different type than hybrid were left out: Ioniq 5 (electric).");
});
test("names several models with their types, once each", () => {
  const n = leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }, { model: "Santa Fe Plug-in Hybrid", state: "plug_in_hybrid" }, { model: "Ioniq 5", state: "electric" }]);
  assert.equal(n, "Cars that NHTSA shows as a different type than hybrid were left out: Ioniq 5 (electric), Santa Fe Plug-in Hybrid (plug-in hybrid).");
});
test("plain gasoline cars are not named: the sentence is the old one", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Highlander", state: "not_electrified" }, { model: "RAV4", state: "not_electrified" }]), "Cars that NHTSA shows as a different type than hybrid were left out.");
  assert.equal(leftOutNote("hybrid", []), "Cars that NHTSA shows as a different type than hybrid were left out.");
});
test("electrified types are named and gasoline cars beside them are not", () => {
  assert.equal(leftOutNote("plug-in hybrid", [{ model: "RAV4", state: "not_electrified" }, { model: "RAV4 Hybrid", state: "hybrid" }]), "Cars that NHTSA shows as a different type than plug-in hybrid were left out: RAV4 Hybrid (hybrid).");
});
test("at most five are named, the rest are counted; blank models are skipped", () => {
  const cars = ["A", "B", "C", "D", "E", "F", "G"].map((m) => ({ model: m, state: "electric" }));
  assert.equal(leftOutNote("hybrid", [...cars, { model: " ", state: "electric" }]), "Cars that NHTSA shows as a different type than hybrid were left out: A (electric), B (electric), C (electric), D (electric), E (electric), and 2 more.");
});
