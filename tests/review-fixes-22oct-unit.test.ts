// Unit tests for the fixes after the golden-master run of 22 Oct 2026 (F1 type-aware hint and known battery-electric list, wording rule, F6 body class, F7 Searched line).
// Offline, no database. Each test names what the code did before.
import test from "node:test";
import assert from "node:assert/strict";
import { prioritizeElectrificationCandidates } from "../lib/nhtsa-client";
import { KNOWN_BEV_MAKES, KNOWN_BEV_ONLY, KNOWN_HYBRID_ONLY, isKnownBevOnly } from "../lib/fuel-type";
import { knownBevFor, knownHybridOnlyFor } from "../lib/electrified-models";
import { leftOutNote } from "../lib/left-out-note";
import { buildConstraintChecks } from "../lib/constraint-evidence";
import { appliedFiltersLine } from "../lib/applied-filters";

type Car = { vehicle: { make: string; model: string; trim: string; year: number } };
const car = (make: string, model: string, trim = "Base", year = 2024): Car => ({ vehicle: { make, model, trim, year } });
const names = (cs: Car[]) => cs.map((c) => `${c.vehicle.make} ${c.vehicle.model}`);

// A pool shaped like the failing search: hybrids and known hybrid-only models in front, real battery-electric cars with no electric wording behind them.
const pool: Car[] = [
  car("Honda", "Accord", "LX"),
  car("Toyota", "Highlander Hybrid", "XLE"),
  car("Toyota", "RAV4", "XLE", 2026), // hybrid-only from 2026, no wording
  car("Kia", "Telluride Hybrid", "EX"),
  car("Toyota", "Camry", "SE", 2025),
  car("Tesla", "Model Y", "Long Range"),
  car("BMW", "iX", "xDrive50"),
  car("Ford", "Mustang Mach-E", "Premium"),
  car("Volkswagen", "ID.4", "Pro"),
  car("Chevrolet", "Blazer EV", "RS"),
  car("Honda", "Civic", "Sport"),
];

test("F1: an electric request hints the battery-electric cars, not the hybrids (the old hint ranked hybrids and hybrid-only models first)", () => {
  const out = names(prioritizeElectrificationCandidates(pool, ["electric"]));
  const firstSix = out.slice(0, 5);
  for (const n of ["Tesla Model Y", "BMW iX", "Ford Mustang Mach-E", "Volkswagen ID.4", "Chevrolet Blazer EV"]) assert.ok(firstSix.includes(n), `${n} is in the first five`);
  for (const n of ["Toyota Highlander Hybrid", "Toyota RAV4", "Kia Telluride Hybrid", "Toyota Camry"]) assert.ok(!firstSix.includes(n), `${n} is not hinted for an electric request`);
});

test("F1: a hybrid request hints hybrids and known hybrid-only models, not battery-electric cars", () => {
  const out = names(prioritizeElectrificationCandidates(pool, ["hybrid"]));
  const first = out.slice(0, 4);
  for (const n of ["Toyota Highlander Hybrid", "Toyota RAV4", "Kia Telluride Hybrid", "Toyota Camry"]) assert.ok(first.includes(n), `${n} is hinted`);
  for (const n of ["Tesla Model Y", "BMW iX", "Ford Mustang Mach-E"]) assert.ok(!first.includes(n), `${n} is not hinted for a hybrid request`);
});

test("F1: both types hint both; no type keeps the old any-electrified hint; order inside each group is stable", () => {
  const both = names(prioritizeElectrificationCandidates(pool, ["hybrid", "electric"]));
  assert.ok(!both.slice(0, 9).includes("Honda Accord") && !both.slice(0, 9).includes("Honda Civic"));
  const legacy = names(prioritizeElectrificationCandidates(pool));
  assert.ok(legacy.slice(0, 9).includes("Tesla Model Y") && legacy.slice(0, 9).includes("Toyota Highlander Hybrid"));
  assert.deepEqual(names(prioritizeElectrificationCandidates(pool, ["electric"])).slice(0, 5), ["Tesla Model Y", "BMW iX", "Ford Mustang Mach-E", "Volkswagen ID.4", "Chevrolet Blazer EV"]);
});

test("F1: models sold in several forms (Ioniq, Niro, Recharge) hint for any requested type; a plug-in request does not hint plain hybrids", () => {
  const p = [car("Hyundai", "IONIQ 5"), car("Kia", "Niro", "EX"), car("Toyota", "Highlander Hybrid"), car("Honda", "Accord")];
  assert.deepEqual(names(prioritizeElectrificationCandidates(p, ["electric"])).slice(0, 2), ["Hyundai IONIQ 5", "Kia Niro"]);
  assert.ok(!names(prioritizeElectrificationCandidates(p, ["plug_in_hybrid"])).slice(0, 2).includes("Honda Accord"));
});

test("known battery-electric list: integrity, no overlap with the hybrid list, no bare model collisions", () => {
  const keys = KNOWN_BEV_ONLY.map((e) => `${e.make}|${e.model}`.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, "no duplicate");
  assert.ok(KNOWN_BEV_ONLY.every((e) => e.make && e.model));
  const hybrid = new Set(KNOWN_HYBRID_ONLY.map((e) => `${e.make}|${e.model}`.toLowerCase()));
  assert.ok(keys.every((k) => !hybrid.has(k)), "a model is never both battery-electric-only and hybrid-only");
  // Left out on purpose (the evidence did not support them): they are not on the list.
  for (const [mk, md] of [["BMW", "i3"], ["Lexus", "UX"], ["Audi", "A6"], ["Mercedes-Benz", "G-Class"]]) assert.equal(isKnownBevOnly(mk, md), false);
});

test("known battery-electric lookup is by make, or by make and model; a bare model name never matches", () => {
  assert.equal(isKnownBevOnly("Tesla", "Anything"), true, "Tesla sells only battery-electric cars");
  assert.equal(isKnownBevOnly("Polestar", "2"), true);
  assert.equal(isKnownBevOnly("BMW", "iX"), true);
  assert.equal(isKnownBevOnly("BMW", "3 Series"), false);
  assert.equal(isKnownBevOnly("Mazda", "3"), false, "Mazda's model 3 is not Polestar's");
  assert.equal(isKnownBevOnly("Hyundai", "Ioniq 5"), true, "case and punctuation do not matter");
  assert.equal(isKnownBevOnly("Chevrolet", "Bolt EUV"), true);
  assert.equal(isKnownBevOnly(null, "iX"), false);
});

test("knownBevFor: only for a request that includes the electric type; narrowed by make when one is given", () => {
  assert.deepEqual(knownBevFor(undefined, ["hybrid"]), { bevMakes: [], knownBevOnly: [] });
  assert.deepEqual(knownBevFor("Tesla", ["plug_in_hybrid"]), { bevMakes: [], knownBevOnly: [] });
  const all = knownBevFor(undefined, ["electric"]);
  assert.equal(all.bevMakes.length, KNOWN_BEV_MAKES.length); assert.equal(all.knownBevOnly.length, KNOWN_BEV_ONLY.length);
  const ford = knownBevFor("Ford", ["electric"]);
  assert.deepEqual(ford.bevMakes, []);
  assert.deepEqual(ford.knownBevOnly, [{ makeKey: "ford", modelKey: "mustangmache" }, { makeKey: "ford", modelKey: "f150lightning" }]);
  assert.deepEqual(knownBevFor("Tesla", ["electric"]).bevMakes, ["tesla"]);
  assert.deepEqual(knownHybridOnlyFor("Tesla", ["electric"]), []);
});

test("left-out note: cars named as another type are said separately from cars NHTSA showed as another type", () => {
  assert.equal(leftOutNote("hybrid", [{ model: "Ioniq 5", state: "electric" }]), "Cars that NHTSA shows as a different type than hybrid were left out: Ioniq 5 (electric).");
  assert.equal(leftOutNote("electric", [{ model: "Grand Highlander Hybrid", state: "wording" }]), "Cars whose name shows another type than electric were left out because NHTSA could not check them: Grand Highlander Hybrid.");
  const mixed = leftOutNote("electric", [{ model: "Telluride Hybrid", state: "hybrid" }, { model: "Grand Highlander Hybrid", state: "wording" }]);
  assert.match(mixed, /^Cars that NHTSA shows as a different type than electric were left out: Telluride Hybrid \(hybrid\)\. Cars whose name shows another type than electric were also left out because NHTSA could not check them: Grand Highlander Hybrid\.$/);
  assert.equal(leftOutNote("hybrid", [{ model: "Accord", state: "not_electrified" }]), "Cars that NHTSA shows as a different type than hybrid were left out.");
});

const none = new Set<string>();
const body = (requested: string, actual: { bodyStyle?: string | null; vehicleType?: string | null }) =>
  buildConstraintChecks({ bodyType: requested } as never, actual as never, none).find((c) => c.field === "bodyType")?.status;

test("F6: the body type check compares body classes like the search does (a Truck search showed mismatch on every Pickup)", () => {
  assert.equal(body("Truck", { bodyStyle: "Pickup" }), "verified");
  assert.equal(body("Pickup", { bodyStyle: "Pickup" }), "verified");
  assert.equal(body("pickup truck", { bodyStyle: "Pickup" }), "verified");
  assert.equal(body("Crossover", { bodyStyle: "SUV" }), "verified");
  assert.equal(body("Sport Utility", { bodyStyle: "SUV" }), "verified");
  assert.equal(body("SUV", { bodyStyle: "SUV" }), "verified");
  assert.equal(body("SUV, Truck", { bodyStyle: "Pickup" }), "verified");
  assert.equal(body("SUV, Truck", { bodyStyle: "SUV" }), "verified");
  assert.equal(body("Roadster", { bodyStyle: "Convertible" }), "verified");
  assert.equal(body("Van", { bodyStyle: "Minivan" }), "verified", "a Van search accepts minivans, as the search does");
  assert.equal(body("Van", { bodyStyle: "Van" }), "verified");
  assert.equal(body("Wagon", { bodyStyle: "Wagon" }), "verified");
});

test("F6: real mismatches and missing data are unchanged", () => {
  assert.equal(body("Sedan", { bodyStyle: "SUV" }), "mismatch");
  assert.equal(body("Truck", { bodyStyle: "SUV" }), "mismatch");
  assert.equal(body("Minivan", { bodyStyle: "Van" }), "mismatch", "a Minivan search does not accept a plain van");
  assert.equal(body("SUV", { bodyStyle: null, vehicleType: null }), "unknown");
  assert.equal(body("SUV", { bodyStyle: "Sedan", vehicleType: "SUV" }), "verified", "either field may agree, as before");
  assert.equal(body("Hovercraft", { bodyStyle: "Hovercraft" }), "verified", "an unknown word falls back to equality, as before");
  assert.equal(body("Hovercraft", { bodyStyle: "SUV" }), "mismatch");
});

test("F7: the Searched line does not present an unrecognised drivetrain as applied", () => {
  assert.match(appliedFiltersLine({ make: "Honda", model: "CR-V", drivetrain: "banana" }), /drivetrain banana \(not applied: not a drivetrain this tool can check\)/);
  assert.match(appliedFiltersLine({ make: "Honda", model: "CR-V", drivetrain: "AWD" }), /drivetrain AWD[;.]/);
  assert.ok(!/not applied/.test(appliedFiltersLine({ make: "Honda", model: "CR-V", drivetrain: "AWD, FWD" })));
  assert.ok(!/not applied/.test(appliedFiltersLine({ make: "Honda", model: "CR-V", drivetrain: "4WD" })));
});
