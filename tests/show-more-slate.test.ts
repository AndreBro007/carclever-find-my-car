// R4-6 step 2 (11 Nov 2026): the stored list rules. Run: npx tsx --test tests/show-more-slate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { newSlate, expandSlate, viewSlots, slateCounts, isExpired, SLATE_CAP, type Slot, type Outcome, type ReserveEntry } from "../lib/show-more/slate";

const slot = (vin: string, price = 20000): Slot => ({ vin, price, drive: "na", fuel: "na", stars: 5 });
const res = (vin: string) => ({ vin, drive: "na" as const, fuel: "na" as const });
const eight = Array.from({ length: 8 }, (_, i) => slot(`S${i + 1}`));
const spares = (n: number, from = 1) => Array.from({ length: n }, (_, i) => res(`R${from + i}`));
const passAll = async (e: ReserveEntry): Promise<Outcome> => ({ kind: "pass", slot: slot(e.vin, 21000) });

test("a new list: slots as shown, reserve in order, first-shown count, cap 16 respected", () => {
  const s = newSlate(eight, spares(12));
  assert.equal(s.firstShown, 8); assert.equal(s.slots.length, 8); assert.equal(s.reserve.length, 8, "16 minus 8 shown");
  assert.deepEqual(s.reserve.map((r) => r.vin), ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
  const withEx = newSlate(eight, spares(12), [{ vin: "X1", reason: "outside_radius" }]);
  assert.equal(withEx.reserve.length, 7, "reserve = 16 - shown - excluded");
  assert.throws(() => newSlate([slot("A"), slot("A")], []), /duplicate VIN/);
});
test("expansion appends after the last slot, in reserve order; earlier numbers and cars never change", async () => {
  const s = newSlate(eight, spares(8));
  const { slate, changed, addedNow } = await expandSlate(s, 12, passAll);
  assert.equal(changed, true); assert.equal(addedNow, 4); assert.equal(slate.slots.length, 12);
  assert.deepEqual(slate.slots.slice(0, 8), s.slots, "slots 1 to 8 untouched");
  assert.deepEqual(slate.slots.slice(8).map((x) => x.vin), ["R1", "R2", "R3", "R4"]);
  assert.equal(slate.version, s.version + 1); assert.equal(slate.reserve.length, 4);
});
test("show 8 after 16 returns the same first 8; asking for the same total twice changes nothing", async () => {
  const s = newSlate(eight, spares(8));
  const { slate } = await expandSlate(s, 16, passAll);
  assert.equal(slate.slots.length, 16);
  assert.deepEqual(viewSlots(slate, 8), s.slots);
  const again = await expandSlate(slate, 16, passAll);
  assert.equal(again.changed, false); assert.equal(again.slate, slate, "same object, same version");
  assert.equal(slateCounts(slate, 12).added, 4, "12 shown on a list whose first reply showed 8: 4 added");
});
test("a total above 16 is capped; a total at or below what is shown does nothing", async () => {
  const s = newSlate(eight, spares(8));
  const big = await expandSlate(s, 99, passAll); assert.equal(big.slate.slots.length, SLATE_CAP);
  assert.equal((await expandSlate(s, 5, passAll)).changed, false);
});
test("a car with verified evidence against the search is excluded with its reason and the next reserve car fills the slot", async () => {
  const s = newSlate(eight, spares(8));
  const ev = async (e: ReserveEntry): Promise<Outcome> => (e.vin === "R1" ? { kind: "exclude", reason: "contradicted_filter" } : { kind: "pass", slot: slot(e.vin) });
  const { slate } = await expandSlate(s, 10, ev);
  assert.deepEqual(slate.slots.slice(8).map((x) => x.vin), ["R2", "R3"]);
  assert.deepEqual(slate.excluded, [{ vin: "R1", reason: "contradicted_filter" }]);
  assert.equal(slateCounts(slate).leftOut.contradicted_filter, 1);
});
test("a car that cannot be checked is pending: kept in place, no number, one attempt per request, final after three", async () => {
  let s = newSlate(eight, spares(2));
  const ev = async (e: ReserveEntry): Promise<Outcome> => (e.vin === "R1" ? { kind: "pending" } : { kind: "pass", slot: slot(e.vin) });
  let r = await expandSlate(s, 10, ev);
  assert.deepEqual(r.slate.slots.slice(8).map((x) => x.vin), ["R2"], "R1 uses no number");
  assert.deepEqual(r.slate.reserve.map((x) => [x.vin, x.attempts, x.pending]), [["R1", 1, true]]);
  assert.equal(slateCounts(r.slate).state, "pending_retry");
  r = await expandSlate(r.slate, 10, ev); assert.equal(r.slate.reserve[0].attempts, 2);
  r = await expandSlate(r.slate, 10, ev);
  assert.deepEqual(r.slate.couldNotCheck, ["R1"]); assert.equal(r.slate.reserve.length, 0);
  assert.equal(slateCounts(r.slate).state, "only_could_not_check");
  const again = await expandSlate(r.slate, 10, ev); assert.equal(again.changed, false, "final: never retried");
});
test("a retried car that now passes is appended after the last slot, never inserted before a slot", async () => {
  let s = newSlate(eight, spares(3));
  let fail = true;
  const ev = async (e: ReserveEntry): Promise<Outcome> => (e.vin === "R1" && fail ? { kind: "pending" } : { kind: "pass", slot: slot(e.vin) });
  let r = await expandSlate(s, 10, ev); // R1 pending, R2 and R3 added
  assert.deepEqual(r.slate.slots.slice(8).map((x) => x.vin), ["R2", "R3"]);
  fail = false;
  r = await expandSlate(r.slate, 11, ev);
  assert.deepEqual(r.slate.slots.slice(8).map((x) => x.vin), ["R2", "R3", "R1"], "R1 arrives last, numbers 9 and 10 unchanged");
});
test("an evaluator that throws counts as pending, never as an exclusion", async () => {
  const s = newSlate(eight, spares(2));
  const { slate } = await expandSlate(s, 9, async (e) => { if (e.vin === "R1") throw new Error("db down"); return { kind: "pass", slot: slot(e.vin) }; });
  assert.deepEqual(slate.slots.slice(8).map((x) => x.vin), ["R2"]); assert.equal(slate.excluded.length, 0); assert.equal(slate.reserve[0].attempts, 1);
});
test("the three end states are kept apart; counts come from the arrays", async () => {
  const s = newSlate(eight, spares(1));
  assert.equal(slateCounts(s).state, "more_available");
  const done = (await expandSlate(s, 9, passAll)).slate;
  assert.equal(slateCounts(done).state, "none_left");
  assert.deepEqual(slateCounts(done), { shown: 9, added: 1, leftOut: { contradicted_filter: 0, outside_radius: 0, removed: 0, limit_break: 0 }, leftOutTotal: 0, pending: 0, couldNotCheck: 0, reserveLeft: 0, canAdd: 0, state: "none_left" });
});
test("expiry is decided by the stored time, never by the row being gone", () => {
  assert.equal(isExpired(1000, 999), false); assert.equal(isExpired(1000, 1000), true); assert.equal(isExpired(1000, 5000), true);
});

test("cars already in the list but not asked for this time count as available (show 12 on a list that holds 16)", async () => {
  const full = (await expandSlate(newSlate(eight, spares(8)), 16, passAll)).slate;
  const c = slateCounts(full, 12);
  assert.equal(c.shown, 12); assert.equal(c.canAdd, 4); assert.equal(c.state, "more_available");
  assert.equal(slateCounts(full, 16).state, "none_left");
});
