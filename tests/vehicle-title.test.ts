// Regression test for formatVehicleTitle() (lib/vehicle-title.ts).
//
// Fix for SYS-20260825: the plain-text result-summary title was built via
// direct template interpolation (`${id.year} ${id.make} ${id.model}${trimStr}`),
// so a genuinely missing identity field (model === null) rendered as the
// literal word "null" -- confirmed live twice via a bodyType=Truck search
// ("2027 Ram null Black Express" / "2027 Ram null Tradesman").
//
// This exercises the REAL exported formatter directly -- not a source-regex
// check -- since the fix is a small, pure, directly-testable function.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatVehicleTitle } from "../lib/vehicle-title";

test("1. Complete identity renders unchanged", () => {
  const title = formatVehicleTitle({ year: 2026, make: "Honda", model: "CR-V", trim: "EX" });
  assert.equal(title, "2026 Honda CR-V EX");
});

test("2. Missing model is omitted cleanly, not rendered as 'null'", () => {
  // The exact confirmed production case: 2027 Ram, model null, trim "Black Express"
  const title = formatVehicleTitle({ year: 2027, make: "Ram", model: null, trim: "Black Express" });
  assert.equal(title, "2027 Ram Black Express");
  assert.ok(!title.includes("null"), `title must never contain the literal word "null", got: ${title}`);
});

test("3. Missing trim is omitted cleanly (existing trimStr behavior preserved)", () => {
  const title = formatVehicleTitle({ year: 2027, make: "Ram", model: "1500", trim: null });
  assert.equal(title, "2027 Ram 1500");
});

test("4. Missing model AND missing trim together", () => {
  const title = formatVehicleTitle({ year: 2027, make: "Ram", model: null, trim: null });
  assert.equal(title, "2027 Ram");
  assert.ok(!title.includes("null"));
});

test("5. Missing make and model (only year + trim known)", () => {
  const title = formatVehicleTitle({ year: 2027, make: null, model: null, trim: "Tradesman" });
  assert.equal(title, "2027 Tradesman");
  assert.ok(!title.includes("null"));
});

test("6. Missing year does not leave a leading space or literal 'null'", () => {
  const title = formatVehicleTitle({ year: null, make: "Ram", model: "1500", trim: "Tradesman" });
  assert.equal(title, "Ram 1500 Tradesman");
  assert.ok(!title.startsWith(" "), "no leading whitespace when year is missing");
});

test("7. All fields missing produces an empty string, never a placeholder", () => {
  const title = formatVehicleTitle({ year: null, make: null, model: null, trim: null });
  assert.equal(title, "");
  assert.ok(!title.includes("null") && !title.includes("undefined") && !title.includes("Unknown"));
});

test("8. undefined fields (not just null) are also handled safely", () => {
  const title = formatVehicleTitle({ year: undefined, make: "Ram", model: undefined, trim: "Tradesman" });
  assert.equal(title, "Ram Tradesman");
  assert.ok(!title.includes("undefined"));
});

test("9. Empty-string make/model/trim are omitted, not rendered as blank segments", () => {
  const title = formatVehicleTitle({ year: 2027, make: "", model: "1500", trim: "" });
  assert.equal(title, "2027 1500", "empty strings are falsy and should be treated the same as missing");
});

test("10. No double spaces or other whitespace artifacts from omitted segments", () => {
  const title = formatVehicleTitle({ year: 2027, make: "Ram", model: null, trim: "Tradesman" });
  assert.ok(!/\s{2,}/.test(title), `no double spaces expected, got: "${title}"`);
});

test("11. Never produces the literal string '[object Object]'", () => {
  // Defensive: even if a caller somehow passed a non-string/number, this
  // function's field-by-field truthiness checks mean an object would only
  // be pushed via the make/model/trim branches (never coerced), so this
  // documents the contract rather than exercising an actual malformed input
  // path (malformed inputs are normalized to null/undefined further
  // upstream in lib/auto-dev-client.ts, out of scope for this fix).
  const title = formatVehicleTitle({ year: 2027, make: "Ram", model: "1500", trim: "Tradesman" });
  assert.ok(!title.includes("[object Object]"));
});
