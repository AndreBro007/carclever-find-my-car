/**
 * Known hybrid-only model years (lib/fuel-type.ts) and their use in the electrified search (SYS-20261021-004, T58).
 * The three entries added on 21 Oct 2026 are backed by NHTSA decodes of real catalogue VINs (see the comment in lib/fuel-type.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownHybridOnly, KNOWN_HYBRID_ONLY } from "../lib/fuel-type";
import { knownHybridOnlyFor } from "../lib/electrified-models";

test("entries that existed before 21 Oct 2026 behave exactly as they did", () => {
  assert.equal(isKnownHybridOnly(2022, "Toyota", "Sequoia"), false);
  assert.equal(isKnownHybridOnly(2023, "Toyota", "Sequoia"), true);
  assert.equal(isKnownHybridOnly(1999, "Toyota", "Prius"), true);
  assert.equal(isKnownHybridOnly(2022, "Toyota", "Crown"), false);
  assert.equal(isKnownHybridOnly(2023, "Toyota", "Crown"), true);
  assert.equal(isKnownHybridOnly(2022, "Toyota", "Corolla Cross Hybrid"), false);
  assert.equal(isKnownHybridOnly(2023, "Toyota", "Corolla Cross Hybrid"), true);
  assert.equal(isKnownHybridOnly(2023, "Toyota", "Grand Highlander Hybrid"), false);
  assert.equal(isKnownHybridOnly(2024, "Toyota", "Grand Highlander Hybrid"), true);
  assert.equal(isKnownHybridOnly(2016, "Kia", "Niro"), false);
  assert.equal(isKnownHybridOnly(2017, "Kia", "Niro"), true);
  assert.equal(isKnownHybridOnly(2010, "Honda", "Insight"), true);
  assert.equal(isKnownHybridOnly(2020, "Toyota", "Venza"), false);
  assert.equal(isKnownHybridOnly(2021, "Toyota", "Venza"), true);
  assert.equal(isKnownHybridOnly(2023, "Toyota", "Crown Signia"), false);
  assert.equal(isKnownHybridOnly(2024, "Toyota", "Crown Signia"), true);
  assert.equal(isKnownHybridOnly(2021, "Toyota", "Land Cruiser"), false);
  assert.equal(isKnownHybridOnly(2022, "Toyota", "Land Cruiser"), true);
  assert.equal(isKnownHybridOnly(2021, "Ford", "F-150 PowerBoost"), true);
  assert.equal(isKnownHybridOnly(2024, "Lexus", "ES 300h"), true);
  assert.equal(isKnownHybridOnly(2024, "Lexus", "RX 350h"), true);
  assert.equal(isKnownHybridOnly(2024, "Lexus", "RX 350"), false);
});

test("added 21 Oct 2026: RAV4 from 2026, Camry from 2025, Sienna from 2021 (year-bounded, with controls)", () => {
  assert.equal(isKnownHybridOnly(2026, "Toyota", "RAV4"), true);
  assert.equal(isKnownHybridOnly(2027, "Toyota", "RAV4"), true);
  assert.equal(isKnownHybridOnly(2025, "Toyota", "RAV4"), false); // control: 6 of 6 real 2025 VINs were not electrified
  assert.equal(isKnownHybridOnly(2025, "Toyota", "Camry"), true);
  assert.equal(isKnownHybridOnly(2026, "Toyota", "Camry"), true);
  assert.equal(isKnownHybridOnly(2024, "Toyota", "Camry"), false); // control
  assert.equal(isKnownHybridOnly(2021, "Toyota", "Sienna"), true);
  assert.equal(isKnownHybridOnly(2020, "Toyota", "Sienna"), false);
  assert.equal(isKnownHybridOnly(null, "Toyota", "RAV4"), false); // unknown year is never assumed
});

test("still excluded, and unknown inputs are false", () => {
  assert.equal(isKnownHybridOnly(2026, "Toyota", "Highlander"), false);
  assert.equal(isKnownHybridOnly(2026, "Honda", "CR-V"), false);
  assert.equal(isKnownHybridOnly(2026, "toyota", "rav4"), true); // case does not matter
  assert.equal(isKnownHybridOnly(2026, null, "RAV4"), false);
  assert.equal(isKnownHybridOnly(2026, "Toyota", undefined), false);
});

test("the table has no duplicate make and model", () => {
  const keys = KNOWN_HYBRID_ONLY.map((e) => `${e.make}|${e.model}`.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
});

test("ranking input: only for a hybrid request, only for the asked make", () => {
  const t = knownHybridOnlyFor("Toyota", ["hybrid"]);
  assert.ok(t.some((k) => k.modelKey === "rav4" && k.fromYear === 2026));
  assert.ok(t.some((k) => k.modelKey === "camry" && k.fromYear === 2025));
  assert.ok(t.some((k) => k.modelKey === "sienna" && k.fromYear === 2021));
  assert.ok(t.some((k) => k.modelKey === "prius" && k.fromYear === 0));
  assert.ok(!t.some((k) => k.modelKey === "niro"), "other makes are not included");
  assert.deepEqual(knownHybridOnlyFor("Toyota", ["plug_in_hybrid"]), []);
  assert.deepEqual(knownHybridOnlyFor("Toyota", ["electric"]), []);
  assert.deepEqual(knownHybridOnlyFor(undefined, ["hybrid"]), []);
  assert.ok(knownHybridOnlyFor("toyota", ["hybrid", "plug_in_hybrid"]).length > 0);
  assert.deepEqual(knownHybridOnlyFor("Kia", ["hybrid"]), [{ modelKey: "niro", fromYear: 2017 }]);
});
