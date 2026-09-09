// Focused regression tests: electrificationRequirement requires a non-empty
// electrificationTypes, enforced through the REAL MCP tool-registration path
// -- not just by calling FindMatchingVehicleInput.safeParse() directly on
// the exported schema in isolation.
//
// WHY THIS DISTINCTION MATTERS (real bug found and fixed this session):
// route.ts registers the tool with `inputSchema: FindMatchingVehicleInput`
// (previously `FindMatchingVehicleInput.shape` -- see the fix in the same
// commit as this test file). @modelcontextprotocol/server's
// McpServer.registerTool() does NOT use whatever schema object you hand it
// as-is; it runs it through an internal `normalizeRawShapeSchema()` first:
//   - if given a raw Zod SHAPE ({ field: z.string(), ... }), it wraps it in
//     a FRESH `z.object(shape)` -- plain, non-strict, with none of the
//     original schema's `.strict()`/`.superRefine()` chain attached;
//   - if given an already-built Zod schema object (anything satisfying the
//     Standard Schema interface -- `"~standard" in schema` with a
//     `.validate` function), it detects that and passes it through
//     UNCHANGED.
//
// Before this session's fix, route.ts passed `FindMatchingVehicleInput.shape`
// (a raw shape) -- meaning the REAL registered/enforced schema was a fresh,
// non-strict `z.object(shape)` that silently accepted legacy `goals` (Zod's
// default behavior strips unknown keys rather than rejecting them) and had
// no cross-field validation at all, DESPITE `FindMatchingVehicleInput` itself
// having `.strict()` and (after this session) `.superRefine()` attached.
// Every prior test asserting goals-rejection or cross-field validation
// called `FindMatchingVehicleInput.safeParse()` directly -- which correctly
// exercises `.strict()`, but does NOT prove anything about what the actual
// running MCP server enforces on a real tool call, since the server never
// used that object directly at all.
//
// These tests close that gap by importing and calling the ACTUAL internal
// SDK function (`normalizeRawShapeSchema`, exported from the bundle as `r`)
// via a direct relative filesystem import -- bypassing the package's public
// `exports` map (which does not list this internal file), the same way one
// would inspect any other installed dependency's real behavior directly
// rather than assume it from documentation or a hand-copied replica. This
// is the same function route.ts's `server.registerTool(...)` call invokes
// internally on `config.inputSchema`, confirmed by reading
// node_modules/@modelcontextprotocol/server/dist/mcp-*.mjs's own
// `registerTool` implementation this session.
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line import/no-relative-packages -- deliberate: see
// header comment above for why this bypasses the package's public exports.
// @ts-expect-error -- deep internal import has no .d.ts; verified working
// at runtime this session (see header comment), TS can't type it.
import { r as normalizeRawShapeSchema } from "../node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs";
import { FindMatchingVehicleInput } from "../lib/find-matching-vehicle-input";

// Exactly what route.ts's `server.registerTool("find_matching_vehicle", {
// inputSchema: FindMatchingVehicleInput, ... })` produces as the schema
// actually used for every real incoming tool call.
const realRegisteredSchema = normalizeRawShapeSchema(FindMatchingVehicleInput) as typeof FindMatchingVehicleInput;

test("normalizeRawShapeSchema passes FindMatchingVehicleInput through UNCHANGED (proves it is treated as a Standard Schema, not re-wrapped as a raw shape)", () => {
  assert.equal(
    realRegisteredSchema,
    FindMatchingVehicleInput,
    "the real SDK function must return the exact same object reference -- if it doesn't, .strict()/.superRefine() are silently lost, same as the pre-fix bug",
  );
});

test("required without electrificationTypes is rejected through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "required" });
  assert.equal(result.success, false, "electrificationRequirement: 'required' with no electrificationTypes must be rejected");
});

test("preferred without electrificationTypes is rejected through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "preferred" });
  assert.equal(result.success, false, "electrificationRequirement: 'preferred' with no electrificationTypes must be rejected");
});

test("preferred with an empty electrificationTypes array is rejected through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "preferred", electrificationTypes: [] });
  assert.equal(result.success, false, "an empty electrificationTypes array must be treated the same as a missing one");
});

test("required with an empty electrificationTypes array is rejected through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "required", electrificationTypes: [] });
  assert.equal(result.success, false);
});

test("required + hybrid is accepted through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "required", electrificationTypes: ["hybrid"] });
  assert.equal(result.success, true);
});

test("required + plug_in_hybrid is accepted through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "required", electrificationTypes: ["plug_in_hybrid"] });
  assert.equal(result.success, true);
});

test("preferred + electric is accepted through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ electrificationRequirement: "preferred", electrificationTypes: ["electric"] });
  assert.equal(result.success, true);
});

test("electrificationTypes present without electrificationRequirement is accepted (requirement, not types, is what triggers the check)", () => {
  const result = realRegisteredSchema.safeParse({ electrificationTypes: ["hybrid"] });
  assert.equal(result.success, true);
});

test("neither field present is accepted (both fully optional)", () => {
  const result = realRegisteredSchema.safeParse({});
  assert.equal(result.success, true);
});

test("public electrificationTypes enum remains exactly hybrid | plug_in_hybrid | electric -- mild_hybrid is rejected as a caller-supplied value", () => {
  const result = realRegisteredSchema.safeParse({ electrificationTypes: ["mild_hybrid"] });
  assert.equal(result.success, false, "mild_hybrid must remain an internal-only classification, never a caller-selectable value");
});

test("legacy goals remains rejected through the real registration path, not just via FindMatchingVehicleInput.safeParse() in isolation", () => {
  const result = realRegisteredSchema.safeParse({ goals: ["family", "reliability"] });
  assert.equal(result.success, false, "goals must be hard-rejected as an unrecognized key through the same schema object the real server validates against");
});

test("legacy goals + vehicleNeeds together still fails (no dual-acceptance) through the real registration path", () => {
  const result = realRegisteredSchema.safeParse({ goals: ["family"], vehicleNeeds: ["family"] });
  assert.equal(result.success, false);
});
