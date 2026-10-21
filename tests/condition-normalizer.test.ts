/** The call repair for the database-based input (SYS-20261021-047): condition words, the older used, vehicleType, the retired inputs. Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolArguments } from "../lib/tool-input-normalizer";

const norm = (args: Record<string, unknown>) => normalizeToolArguments("find_matching_vehicle", args);

test("a valid condition passes through untouched; nothing is added when it is missing", () => {
  for (const c of ["new", "used"]) { const r = norm({ condition: c }); assert.deepEqual(r.args, { condition: c }); assert.deepEqual(r.changes, []); }
  assert.deepEqual(norm({ make: "Honda" }).args, { make: "Honda" });
  assert.deepEqual(norm({}).args, {});
});

test("words an AI may use are understood", () => {
  for (const [w, c] of [["New", "new"], ["brand new", "new"], ["new only", "new"], ["Pre-owned", "used"], ["preowned", "used"], ["certified", "used"], ["CPO", "used"], ["used only", "used"]] as const) {
    const r = norm({ condition: w }); assert.equal(r.args.condition, c, w); assert.deepEqual(r.ignored, [], w);
  }
});

test("a value that means both is the same as leaving the field out, with no note", () => {
  for (const w of ["either", "any", "both", "neither", "new or used", "no preference", "not stated"]) {
    const r = norm({ condition: w, make: "Honda" }); assert.deepEqual(r.args, { make: "Honda" }, w); assert.deepEqual(r.ignored, [], w);
  }
});

test("an unrecognised value is set aside and reported", () => {
  const r = norm({ condition: "maybe" });
  assert.equal(r.args.condition, undefined);
  assert.ok(r.ignored.some((x) => x.startsWith('condition (value "maybe" not recognised')));
});

test("the older boolean used becomes condition and is never passed on; an explicit condition wins; every removal is recorded", () => {
  assert.deepEqual(norm({ used: false }).args, { condition: "new" });
  assert.deepEqual(norm({ used: true }).args, { condition: "used" });
  assert.deepEqual(norm({ used: "true" }).args, { condition: "used" });
  assert.deepEqual(norm({ used: "no" }).args, { condition: "new" });
  const both = norm({ condition: "new", used: true });
  assert.deepEqual(both.args, { condition: "new" });
  assert.ok(both.changes.length > 0, "a removal with no recorded change would leave the original call in place and fail validation");
});

test("vehicleType is the same database column as bodyType: it becomes bodyType, or is set aside when bodyType is given; every removal is recorded", () => {
  assert.deepEqual(norm({ vehicleType: "Hatchback" }).args, { bodyType: "Hatchback" });
  const both = norm({ bodyType: "SUV", vehicleType: "Crossover" });
  assert.deepEqual(both.args, { bodyType: "SUV" });
  assert.ok(both.changes.length > 0);
});

test("the retired inputs are set aside and the reply says so; a price flexibility of strict is simply true", () => {
  const t = norm({ transmission: "Manual", cylinders: 4, priceFlexibility: "flexible", make: "Honda" });
  assert.deepEqual(t.args, { make: "Honda" });
  assert.deepEqual(t.ignored, ["transmission (not a filter; each result shows it when known)", "cylinders (not a filter; each result shows its engine when known)", "priceFlexibility (the price ceiling is always strict)"]);
  const s = norm({ priceFlexibility: "Strict", make: "Honda" });
  assert.deepEqual(s.args, { make: "Honda" }); assert.deepEqual(s.ignored, []); assert.ok(s.changes.length > 0);
});

test("only find_matching_vehicle is touched", () => {
  assert.deepEqual(normalizeToolArguments("check_vehicle", { vin: "1HGCM82633A004352" }).args, { vin: "1HGCM82633A004352" });
  assert.deepEqual(normalizeToolArguments("compare_vehicles", { vins: ["A", "B"] }).args, { vins: ["A", "B"] });
});
