// NHTSA decode improvements (database app): richer specs from the call we already make, a 24h cache, hybrid-first pool ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDriveType, normalizeTransmission, specsFromRow, withNhtsaSpecs, fuelFor } from "../lib/nhtsa-specs";
import { decodeNhtsaElectrification, prioritizeElectrificationCandidates, resetNhtsaCacheForTests, ELECTRIFICATION_POOL_SIZE } from "../lib/nhtsa-client";

test("drive type: AWD/4WD/FWD/RWD are mapped; NHTSA's 4x2 stays unknown (front or rear is not stated)", () => {
  assert.equal(normalizeDriveType("AWD/All-Wheel Drive"), "AWD");
  assert.equal(normalizeDriveType("4WD/4-Wheel Drive/4x4"), "4WD");
  assert.equal(normalizeDriveType("FWD/Front-Wheel Drive"), "FWD");
  assert.equal(normalizeDriveType("RWD/Rear-Wheel Drive"), "RWD");
  assert.equal(normalizeDriveType("4x2"), null);
  assert.equal(normalizeDriveType(""), null);
  assert.equal(normalizeDriveType(undefined), null);
});
test("transmission: only plain Automatic/Manual are filled (CVT etc. stay unknown, so no false mismatch)", () => {
  assert.equal(normalizeTransmission("Automatic"), "Automatic");
  assert.equal(normalizeTransmission("Manual/Standard"), "Manual");
  assert.equal(normalizeTransmission("Continuously Variable Transmission (CVT)"), null);
  assert.equal(normalizeTransmission(""), null);
});
const row = { DriveType: "AWD/All-Wheel Drive", TransmissionStyle: "Automatic", EngineCylinders: "4", DisplacementL: "2.5", EngineHP: "203.0", Turbo: "", Seats: "5",
  CIB: "Standard", ForwardCollisionWarning: "Standard", LaneDepartureWarning: "Standard", BlindSpotMon: "Optional", RearVisibilitySystem: "Standard", ESC: "Standard", ABS: "Standard", ErrorCode: "0" };
test("specsFromRow: engine summary, seats, and only STANDARD safety tech (optional and universal items excluded)", () => {
  const sp = specsFromRow(row);
  assert.equal(sp.driveType, "AWD"); assert.equal(sp.transmission, "Automatic"); assert.equal(sp.cylinders, 4); assert.equal(sp.seats, 5);
  assert.equal(sp.engine, "2.5L 4-cyl 203 hp");
  assert.deepEqual(sp.safetyTech, ["Automatic emergency braking", "Forward collision warning", "Lane departure warning", "Rear camera"]);
  assert.equal(specsFromRow({ ...row, Turbo: "Yes" }).engine, "2.5L 4-cyl 203 hp turbo");
  assert.deepEqual(specsFromRow({}), { driveType: null, transmission: null, cylinders: null, engine: null, seats: null, fuel: null, safetyTech: [] });
});
test("withNhtsaSpecs fills blanks only and never overrides a value the listing has", () => {
  const sp = specsFromRow(row);
  const out: any = withNhtsaSpecs({ vehicle: { drivetrain: null, transmission: "manual", engine: undefined, cylinders: null, seats: 7 } }, { specs: sp });
  assert.equal(out.vehicle.drivetrain, "AWD"); assert.equal(out.vehicle.transmission, "manual"); assert.equal(out.vehicle.engine, "2.5L 4-cyl 203 hp");
  assert.equal(out.vehicle.cylinders, 4); assert.equal(out.vehicle.seats, 7);
  const same = { vehicle: { drivetrain: "FWD", transmission: "automatic", engine: "x", cylinders: 6, seats: 5 } };
  assert.equal(withNhtsaSpecs(same, { specs: sp }), same); // nothing to fill -> the same object comes back
  assert.equal(withNhtsaSpecs(same, null), same);
});
test("hybrid-first ordering is stable and the pool is 24", () => {
  const c = (model: string, trim = "") => ({ vehicle: { make: "X", model, trim } });
  const list = [c("Camry"), c("RAV4", "XLE Hybrid"), c("Civic"), c("Model Y"), c("Prius Prime"), c("F-150", "Lariat")];
  assert.deepEqual(prioritizeElectrificationCandidates(list).map((x) => x.vehicle.model), ["RAV4", "Model Y", "Prius Prime", "Camry", "Civic", "F-150"]);
  assert.equal(ELECTRIFICATION_POOL_SIZE, 24); // T52: three batches of 8, not one burst of 45
});
test("decode cache: the same VIN is fetched once, a failed decode is not cached, specs ride along", async () => {
  resetNhtsaCacheForTests();
  const realFetch = globalThis.fetch; let calls = 0; let mode: "ok" | "bad" = "ok";
  globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ Results: [mode === "ok" ? { ...row, Make: "TOYOTA", Model: "RAV4", ModelYear: "2025", ErrorCode: "0" } : { ErrorCode: "7" }] }) }; }) as any;
  try {
    const a = await decodeNhtsaElectrification("2T3H1RFV0SC353653", "Toyota", "RAV4", null);
    const b = await decodeNhtsaElectrification("2t3h1rfv0sc353653", "Toyota", "RAV4", null); // case-insensitive key
    assert.equal(calls, 1); assert.equal(a?.specs?.driveType, "AWD"); assert.equal(b?.specs?.engine, "2.5L 4-cyl 203 hp");
    mode = "bad"; resetNhtsaCacheForTests(); calls = 0;
    assert.equal(await decodeNhtsaElectrification("1HGCM82633A004352", "Honda", "Accord", null), null);
    assert.equal(await decodeNhtsaElectrification("1HGCM82633A004352", "Honda", "Accord", null), null);
    assert.equal(calls, 2); // failures are retried, not cached
  } finally { globalThis.fetch = realFetch; resetNhtsaCacheForTests(); }
});

test("fuel from the electrification state: hybrid/PHEV/electric are named, plain gasoline/diesel come from NHTSA's primary fuel, anything unclear stays blank", () => {
  assert.equal(fuelFor("electric", "Electric"), "Electric");
  assert.equal(fuelFor("plug_in_hybrid", "Gasoline"), "Plug-In Hybrid");
  assert.equal(fuelFor("hybrid", "Gasoline"), "Hybrid");
  assert.equal(fuelFor("mild_hybrid", "Gasoline"), "Hybrid");
  assert.equal(fuelFor("not_electrified", "Gasoline"), "Gasoline");
  assert.equal(fuelFor("not_electrified", "Diesel"), "Diesel");
  assert.equal(fuelFor("not_electrified", "Flexible Fuel Vehicle (FFV)"), null);
  assert.equal(fuelFor("ambiguous", "Gasoline"), null);
  assert.equal(fuelFor("unknown", "Gasoline"), null);
  const filled: any = withNhtsaSpecs({ vehicle: { fuel: null } }, { specs: { ...specsFromRow({}), fuel: "Hybrid" } });
  assert.equal(filled.vehicle.fuel, "Hybrid");
  const kept: any = withNhtsaSpecs({ vehicle: { fuel: "Gasoline" } }, { specs: { ...specsFromRow({}), fuel: "Hybrid" } });
  assert.equal(kept.vehicle.fuel, "Gasoline"); // the listing's own value is never replaced
});
test("decode of a hybrid and an electric VIN carries the fuel in specs", async () => {
  resetNhtsaCacheForTests();
  const rows: Record<string, any> = {
    HYB: { ErrorCode: "0", Make: "TOYOTA", Model: "Camry", ModelYear: "2026", ElectrificationLevel: "HEV (Hybrid Electric Vehicle)", FuelTypePrimary: "Gasoline", FuelTypeSecondary: "Electric" },
    BEV: { ErrorCode: "0", Make: "TESLA", Model: "Model Y", ModelYear: "2026", ElectrificationLevel: "BEV (Battery Electric Vehicle)", FuelTypePrimary: "Electric" },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => ({ ok: true, json: async () => ({ Results: [String(u).includes("HYBVIN") ? rows.HYB : rows.BEV] }) })) as any;
  try {
    assert.equal((await decodeNhtsaElectrification("HYBVIN00000000001", "Toyota", "Camry", null))?.specs?.fuel, "Hybrid");
    assert.equal((await decodeNhtsaElectrification("BEVVIN00000000001", "Tesla", "Model Y", null))?.specs?.fuel, "Electric");
  } finally { globalThis.fetch = realFetch; resetNhtsaCacheForTests(); }
});
