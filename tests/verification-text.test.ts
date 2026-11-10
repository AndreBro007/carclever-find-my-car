// R4-9 (10 Nov 2026, André: R4-9 yes): the identity sentence is built from what was really verified; the NHTSA decode confirms make as it already did model and trim; status, conflicts and score untouched.
// The A01 case: VIN 19XFC2F51GE044879 (a Carvana 2016 Honda Civic LX): Honda's 19X prefix is not in the local maker-code table, so make was "unknown" while the text said make matched.
// Run: npx tsx --test tests/verification-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBuyerCheck, identityGoodSign } from "../lib/buyer-check";
import { confirmFromDecode, crossCheckVin, makesAgree, type VerificationResult } from "../lib/vin-cross-check";

const v = (o: Partial<VerificationResult>): VerificationResult => ({ identityVerificationStatus: "verified_match", verifiedAttributes: [], unknownAttributes: [], conflictingAttributes: [], ...o });
const card = (verification: VerificationResult) => ({ verification, history: { state: "unreported" as const, note: "", ownerNote: null }, condition: { cpoEvidenceState: "unknown" as const }, detail: { carfaxUrl: null }, dataConflicts: [] as string[] });

test("the identity sentence names exactly the verified attributes, in a fixed order, with the right verb", () => {
  assert.equal(identityGoodSign(["year"]), "VIN identity confirmed — the reported year matches what the VIN data shows.");
  assert.equal(identityGoodSign(["year", "make"]), "VIN identity confirmed — the reported year and make match what the VIN data shows.");
  assert.equal(identityGoodSign(["trim", "model", "year"]), "VIN identity confirmed — the reported year, model and trim match what the VIN data shows.");
  assert.equal(identityGoodSign(["make", "trim", "year", "model"]), "VIN identity confirmed — the reported year, make, model and trim match what the VIN data shows.");
  assert.equal(identityGoodSign([]), "VIN identity confirmed.");
  assert.ok(!/year and make match what's encoded/.test(identityGoodSign(["year", "model", "trim"])), "never the old fixed claim when make was not verified");
});
test("A01 before the fix: year, model and trim verified, make unknown: the sentence no longer claims make", () => {
  const bc = buildBuyerCheck(card(v({ verifiedAttributes: ["year", "model", "trim"], unknownAttributes: ["make"] })));
  assert.ok(bc.goodSigns.includes("VIN identity confirmed — the reported year, model and trim match what the VIN data shows."), JSON.stringify(bc.goodSigns));
  assert.ok(bc.needsVerification.some((x) => /^make cannot be confirmed/.test(x)), "make is still honestly listed as unconfirmed when it is");
});
test("A01 after the fix: the decode confirms make, the lists and the sentence agree, nothing left unconfirmed", () => {
  const merged = confirmFromDecode(v({ verifiedAttributes: ["year"], unknownAttributes: ["make", "model", "trim"] }), ["make", "model", "trim"]);
  assert.deepEqual(merged.verifiedAttributes, ["year", "make", "model", "trim"]); assert.deepEqual(merged.unknownAttributes, []);
  const bc = buildBuyerCheck(card(merged));
  assert.ok(bc.goodSigns.includes("VIN identity confirmed — the reported year, make, model and trim match what the VIN data shows."));
  assert.ok(!bc.needsVerification.some((x) => /cannot be confirmed from the VIN alone/.test(x)));
});
test("the merge never changes status, conflicts or integrity note, never duplicates, never overrides a conflict, and an empty list returns the same object", () => {
  const base = v({ verifiedAttributes: ["year", "make"], unknownAttributes: ["model", "trim"], vinIntegrityNote: "note" });
  const m = confirmFromDecode(base, ["make", "model"]);
  assert.deepEqual(m.verifiedAttributes, ["year", "make", "model"]); assert.deepEqual(m.unknownAttributes, ["trim"]);
  assert.equal(m.identityVerificationStatus, "verified_match"); assert.equal(m.vinIntegrityNote, "note"); assert.deepEqual(m.conflictingAttributes, []);
  assert.equal(confirmFromDecode(base, []), base);
  const conflict = v({ identityVerificationStatus: "failed", verifiedAttributes: ["year"], unknownAttributes: ["model"], conflictingAttributes: ["make"] });
  const c = confirmFromDecode(conflict, ["make", "model"]);
  assert.deepEqual(c.conflictingAttributes, ["make"]); assert.ok(!c.verifiedAttributes.includes("make"), "a conflicting make is not overridden"); assert.equal(c.identityVerificationStatus, "failed");
  assert.deepEqual(c.verifiedAttributes, ["year", "model"]);
});
test("the A01 VIN: the local table does not know the 19X prefix (so the decode step is what confirms make); a known Honda prefix still verifies make locally", () => {
  const a01: any = { vin: "19XFC2F51GE044879", vehicle: { year: 2016, make: "Honda", model: "Civic", trim: "LX" } };
  const r = crossCheckVin(a01);
  assert.ok(r.verifiedAttributes.includes("year") && r.unknownAttributes.includes("make"), JSON.stringify(r));
  assert.equal(makesAgree("Honda", "HONDA"), true); assert.equal(makesAgree("Honda", "Toyota"), false); assert.equal(makesAgree("Honda", null), null);
});
test("the old fixed sentence is gone from the source", () => {
  assert.ok(!readFileSync("lib/buyer-check.ts", "utf8").includes("year and make match what's encoded in the VIN itself"));
});
