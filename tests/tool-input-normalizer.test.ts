import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolArguments } from "../lib/tool-input-normalizer";

test("tool input is repaired, not rejected: null dropped, text numbers fixed, lists and text swapped, unknown fields dropped", () => {
  const r = normalizeToolArguments("find_matching_vehicle", { bodyType: "SUV", zip: null, priceMax: "$45,000", yearMin: "2020", used: "true", model: ["Telluride", "Palisade"], vehicleNeeds: "family SUV", electrificationTypes: "hybrid, electric", minSeats: 7, radiusMiles: "50" });
  assert.deepEqual(r.args, { bodyType: "SUV", priceMax: 45000, yearMin: 2020, used: true, model: "Telluride, Palisade", vehicleNeeds: ["family SUV"], electrificationTypes: ["hybrid", "electric"], radiusMiles: 50 });
  assert.ok(r.changes.some((c) => c.includes("dropped unknown field minSeats")) && r.changes.some((c) => c.includes("dropped empty zip")));
  assert.equal(normalizeToolArguments("find_matching_vehicle", { priceMax: "45k" }).args.priceMax, 45000);
  assert.equal(normalizeToolArguments("find_matching_vehicle", { zip: 9622 }).args.zip, "09622");
  assert.equal(normalizeToolArguments("find_matching_vehicle", { priceMax: "cheap" }).args.priceMax, "cheap");
  assert.deepEqual(normalizeToolArguments("resolve_dealer_url", { vin: "1HGCM82633A004352", year: "2014", extra: 1 }).args, { vin: "1HGCM82633A004352", year: 2014 });
  assert.deepEqual(normalizeToolArguments("compare_vehicles", { vins: "AAA BBB, CCC" }).args, { vins: ["AAA", "BBB", "CCC"] });
  const untouched = { anything: null };
  assert.deepEqual(normalizeToolArguments("some_other_tool", untouched).args, untouched);
  assert.deepEqual(normalizeToolArguments("find_matching_vehicle", { make: "Honda", model: "Civic", priceMax: 30000 }).changes, []);
});
