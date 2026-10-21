/** The call repair for condition (SYS-20261021-033): words understood, the older used boolean accepted, either filled in. Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolArguments } from "../lib/tool-input-normalizer";

const norm = (args: Record<string, unknown>) => normalizeToolArguments("find_matching_vehicle", args);

test("a valid condition passes through untouched", () => {
  for (const c of ["new", "used", "either"]) assert.equal(norm({ condition: c }).args.condition, c);
  assert.deepEqual(norm({ condition: "new" }).changes, []);
});

test("words an AI may use are understood", () => {
  for (const [w, c] of [["New", "new"], ["brand new", "new"], ["new only", "new"], ["Pre-owned", "used"], ["preowned", "used"], ["certified", "used"], ["CPO", "used"], ["used only", "used"], ["any", "either"], ["both", "either"], ["New or used", "either"], ["no preference", "either"]] as const) {
    const r = norm({ condition: w });
    assert.equal(r.args.condition, c, w); assert.deepEqual(r.ignored, [], w);
  }
});

test("an unrecognised value is set aside, reported, and treated as either", () => {
  const r = norm({ condition: "maybe" });
  assert.equal(r.args.condition, "either");
  assert.ok(r.ignored.some((x) => x.startsWith('condition (value "maybe" not recognised')));
});

test("the older boolean used still works: false is new, true is used, text too; it is never passed on", () => {
  assert.deepEqual(norm({ used: false }).args, { condition: "new" });
  assert.deepEqual(norm({ used: true }).args, { condition: "used" });
  assert.deepEqual(norm({ used: "true" }).args, { condition: "used" });
  assert.deepEqual(norm({ used: "no" }).args, { condition: "new" });
  assert.equal("used" in norm({ used: false, make: "Honda" }).args, false);
});

test("an explicit condition wins over the older used; both missing means either, without a note", () => {
  assert.equal(norm({ condition: "new", used: true }).args.condition, "new");
  const none = norm({ make: "Honda" });
  assert.equal(none.args.condition, "either"); assert.deepEqual(none.ignored, []);
  assert.equal(norm({}).args.condition, "either");
  assert.equal(norm({ condition: null, used: null }).args.condition, "either");
  assert.equal(norm({ condition: "", make: "Honda" }).args.condition, "either");
});

test("only find_matching_vehicle gets a condition", () => {
  assert.equal("condition" in normalizeToolArguments("check_vehicle", { vin: "1HGCM82633A004352" }).args, false);
  assert.equal("condition" in normalizeToolArguments("compare_vehicles", { vins: ["A", "B"] }).args, false);
});
