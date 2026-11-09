// Group 2, item 4 (9 Nov 2026): the seating wording and the Seats line. Run: npx tsx --test tests/seats-summary.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeatsSummary, isSeatsNote } from "../lib/seats-summary";

const car = (seats?: number | null) => ({ vehicle: { seats } });

test("all four states keep their meaning; the number is attributed to NHTSA series data; nothing says confirmed", () => {
  assert.deepEqual(buildSeatsSummary(car(8), undefined), { state: "reported", note: "8 seats (NHTSA series data; cab or trim can differ)." });
  assert.deepEqual(buildSeatsSummary(car(8), 7), { state: "meets_or_exceeds", note: "8 seats (NHTSA series data; cab or trim can differ), meets the requested 7+." });
  assert.deepEqual(buildSeatsSummary(car(5), 7), { state: "below_requested", note: "5 seats (NHTSA series data; cab or trim can differ), below the requested 7+. Shown anyway: seats are a preference, not a filter." });
  assert.deepEqual(buildSeatsSummary(car(null), 7), { state: "unknown", note: "Seating capacity not reported by this listing — can't confirm it meets the requested 7+ seats." });
  assert.deepEqual(buildSeatsSummary(car(undefined), undefined), { state: "unknown", note: "Seating capacity not reported by this listing." });
  assert.deepEqual(buildSeatsSummary({}, 7).state, "unknown");
  for (const n of [buildSeatsSummary(car(8), 7).note, buildSeatsSummary(car(5), 7).note, buildSeatsSummary(car(8), undefined).note]) assert.ok(!/confirm/i.test(n), `no 'confirm' in: ${n}`);
});
test("equal to the minimum meets it; one seat is singular; a seat preference never excludes (the state only informs)", () => {
  assert.equal(buildSeatsSummary(car(7), 7).state, "meets_or_exceeds");
  assert.match(buildSeatsSummary(car(1), undefined).note, /^1 seat \(NHTSA/);
  assert.equal(buildSeatsSummary(car(2), 7).state, "below_requested");
});
test("isSeatsNote recognises exactly the seating statements, so they leave the Confirmed list", () => {
  for (const note of [buildSeatsSummary(car(8), 7).note, buildSeatsSummary(car(5), 7).note, buildSeatsSummary(car(8), undefined).note, buildSeatsSummary(car(null), 7).note, buildSeatsSummary(car(null), undefined).note]) assert.ok(isSeatsNote(note), note);
  for (const other of ["used", "new", "SUV", "Certified Pre-Owned (Used)", "AWD", "5 stars", "8 passengers"]) assert.ok(!isSeatsNote(other), other);
});
