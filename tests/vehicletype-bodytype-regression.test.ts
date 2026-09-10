// Regression test: vehicleType must not become a redundant hard filter when it duplicates bodyType.
//
// Background (SYS-20260911): ChatGPT V2 sent both bodyType: "SUV" and vehicleType: "SUV"
// for a simple broad "SUV" request, which reduced the Denver result universe from 13,617
// to 17 matches. Claude V2 and ChatGPT V1 omitted vehicleType and both returned the full
// 13,617-match set. The fix is deterministic: buildListingsParams must not send
// vehicle.type when it would duplicate vehicle.bodyStyle (case-insensitive).

import assert from "node:assert/strict";
import test from "node:test";
import { buildListingsParams } from "../lib/auto-dev-client";

test("vehicleType is omitted when it exactly matches bodyType (case-insensitive)", () => {
  const query = { bodyType: "SUV", vehicleType: "SUV" };
  const params = buildListingsParams(query as any);
  
  assert.equal(params.get("vehicle.bodyStyle"), "SUV", "bodyType must be sent as vehicle.bodyStyle");
  assert.equal(params.get("vehicle.type"), null, "vehicleType must NOT be sent when it duplicates bodyType");
});

test("vehicleType is omitted when it matches bodyType with different casing", () => {
  const query = { bodyType: "SUV", vehicleType: "suv" };
  const params = buildListingsParams(query as any);
  
  assert.equal(params.get("vehicle.bodyStyle"), "SUV", "bodyType must be sent as vehicle.bodyStyle");
  assert.equal(params.get("vehicle.type"), null, "vehicleType must NOT be sent when it duplicates bodyType (case-insensitive)");
});

test("vehicleType is included when it is different from bodyType (finer distinction)", () => {
  const query = { bodyType: "SUV", vehicleType: "Crossover" };
  const params = buildListingsParams(query as any);
  
  assert.equal(params.get("vehicle.bodyStyle"), "SUV", "bodyType must be sent as vehicle.bodyStyle");
  assert.equal(params.get("vehicle.type"), "Crossover", "vehicleType must be sent when it differs from bodyType");
});

test("vehicleType is included when bodyType is absent", () => {
  const query = { vehicleType: "Crossover" };
  const params = buildListingsParams(query as any);
  
  assert.equal(params.get("vehicle.type"), "Crossover", "vehicleType must be sent when bodyType is not present");
  assert.equal(params.get("vehicle.bodyStyle"), null, "bodyType must not be sent when absent");
});

test("neither vehicleType nor bodyType is sent when both are absent", () => {
  const query = {};
  const params = buildListingsParams(query as any);
  
  assert.equal(params.get("vehicle.type"), null, "vehicleType must not be sent when absent");
  assert.equal(params.get("vehicle.bodyStyle"), null, "bodyType must not be sent when absent");
});
