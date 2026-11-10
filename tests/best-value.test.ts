// R4-5 best value (10 Nov 2026): the ranking rules. Run: npx tsx --test tests/best-value.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterOutliers, median, areaLadder, scoreSubject, indexComparables, rankByValue, orderByValue, rankListingsByValue, valueLineFor, unscorableReason, subjectOf, groupsNeeded,
  type Comparable, type ValueSubject, type ValueScore,
} from "../lib/best-value";

const subj = (o: Partial<ValueSubject> = {}): ValueSubject => ({ vin: "S1", makeKey: "honda", modelKey: "crv", year: 2022, trim: "EX", used: true, price: 20000, miles: 50000, distance: 10, ...o });
let n = 0;
const comp = (o: Partial<Comparable> = {}): Comparable => ({ vin: `C${++n}`, makeKey: "honda", modelKey: "crv", year: 2022, trim: "EX", used: true, price: 24000, miles: 50000, distance: 20, ...o });
const comps = (k: number, o: Partial<Comparable> = {}): Comparable[] => Array.from({ length: k }, (_, i) => comp({ price: 24000 + i * 10, ...o }));

test("outlier rule and median are the Deal Score ones", () => {
  assert.deepEqual(filterOutliers([1, 2, 3]), [1, 2, 3], "fewer than four: unchanged");
  assert.deepEqual(filterOutliers([10, 11, 12, 13, 14, 15, 16, 100]), [10, 11, 12, 13, 14, 15, 16], "the far price is dropped");
  assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([5, 1, 3]), 3);
});
test("area ladder: the search area first, then only larger steps, then nationwide", () => {
  assert.deepEqual(areaLadder(50), [50, 100, 200, 500, null]);
  assert.deepEqual(areaLadder(150), [150, 200, 500, null]);
  assert.deepEqual(areaLadder(600), [600, null]);
  assert.deepEqual(areaLadder(0), [50, 100, 200, 500, null], "a bad radius falls back to the default 50");
});
test("a car with eight similar cars is scored: percentage below the median, sample size, area and mileage range", () => {
  const sc = scoreSubject(subj(), indexComparables(comps(10)), 50);
  assert.equal(sc.status, "ranked"); assert.equal(sc.sample, 10); assert.equal(sc.limitedSample, true); assert.equal(sc.areaMiles, 50); assert.equal(sc.mileageBand, 0.2);
  assert.ok(Math.abs((sc.value as number) - (24045 - 20000) / 24045) < 1e-9);
});
test("seven similar cars are not enough: not scored, never guessed; eight are enough", () => {
  assert.deepEqual(scoreSubject(subj(), indexComparables(comps(7)), 50), { vin: "S1", status: "unscored", reason: "too_few_similar" });
  assert.equal(scoreSubject(subj(), indexComparables(comps(8)), 50).status, "ranked");
  assert.equal(scoreSubject(subj(), indexComparables(comps(15)), 50).limitedSample, false, "15 or more: no limited-sample flag");
});
test("the car itself, the same VIN, other years, other trims, other makes and the other condition never count as similar", () => {
  const own = comps(8).map((c, i) => (i === 0 ? { ...c, vin: "S1" } : c));
  assert.equal(scoreSubject(subj(), indexComparables(own), 50).status, "unscored", "own VIN removed: only seven left");
  for (const o of [{ year: 2021 }, { trim: "LX" }, { makeKey: "toyota" }, { modelKey: "rav4" }, { used: false }] as Array<Partial<Comparable>>)
    assert.equal(scoreSubject(subj(), indexComparables(comps(8, o)), 50).status, "unscored", JSON.stringify(o));
});
test("the area widens only when needed, in order, and is named; mileage steps restart at each area", () => {
  const local3 = comps(3, { distance: 20 }), far6 = comps(6, { distance: 150 });
  const sc = scoreSubject(subj(), indexComparables([...local3, ...far6]), 50);
  assert.equal(sc.status, "ranked"); assert.equal(sc.areaMiles, 200); assert.equal(sc.mileageBand, 0.2);
  const nation = scoreSubject(subj(), indexComparables([...local3, ...comps(6, { distance: 1200 })]), 50);
  assert.equal(nation.areaMiles, null, "nationwide is reported as null area");
  assert.equal(scoreSubject(subj(), indexComparables(comps(8, { distance: 20 })), 50).areaMiles, 50, "enough locally: no widening");
});
test("mileage range widens 20, 35, 50 percent before the area does", () => {
  const sc = scoreSubject(subj(), indexComparables(comps(8, { miles: 50000 * 1.3 })), 50);
  assert.equal(sc.mileageBand, 0.35); assert.equal(sc.areaMiles, 50);
  assert.equal(scoreSubject(subj(), indexComparables(comps(8, { miles: 50000 * 1.6 })), 50).status, "unscored", "outside 50 percent everywhere: not scored");
});
test("a car more than 40 percent below typical is not ranked on value (unusually low)", () => {
  const sc = scoreSubject(subj({ price: 10000 }), indexComparables(comps(10)), 50);
  assert.equal(sc.status, "unusually_low"); assert.ok((sc.value as number) > 0.4);
  assert.equal(scoreSubject(subj({ price: 14500 }), indexComparables(comps(10)), 50).status, "ranked", "just under 40 percent is ranked");
});
test("a car above typical gets a negative value and says above", () => {
  const sc = scoreSubject(subj({ price: 30000 }), indexComparables(comps(10)), 50);
  assert.ok((sc.value as number) < 0); assert.match(valueLineFor(sc), /above the typical asking price/);
});
test("new cars: compared with new cars only, no mileage range; used cars under 1,000 miles or with no mileage are not scored", () => {
  const newSub = subj({ used: false, miles: 5 });
  assert.equal(scoreSubject(newSub, indexComparables(comps(8, { used: false, miles: 10 })), 50).status, "ranked");
  assert.equal(scoreSubject(newSub, indexComparables(comps(8, { used: true })), 50).status, "unscored");
  assert.equal(unscorableReason(subj({ miles: 500 })), "mileage_under_1000"); assert.equal(unscorableReason(subj({ miles: null })), "mileage_unknown");
  assert.equal(unscorableReason(subj({ trim: null })), "missing_details"); assert.equal(unscorableReason(subj({ price: 500 })), "missing_details"); assert.equal(unscorableReason(subj()), null);
});
test("order: ranked by value, then unusually low, then not judged (nearest first); ties by lower mileage, newer, lower price, VIN", () => {
  const subjects = [subj({ vin: "A", miles: 60000 }), subj({ vin: "B", miles: 40000 }), subj({ vin: "C" }), subj({ vin: "D", distance: 5 }), subj({ vin: "E", distance: 1 }), subj({ vin: "F" })];
  const sc = (st: ValueScore["status"], value?: number): ValueScore => ({ vin: "", status: st, value });
  const scores = new Map<string, ValueScore>([["A", sc("ranked", 0.1)], ["B", sc("ranked", 0.1)], ["C", sc("ranked", 0.2)], ["D", sc("unscored")], ["E", sc("unscored")], ["F", sc("unusually_low", 0.5)]]);
  assert.deepEqual(orderByValue(subjects, scores), ["C", "B", "A", "F", "E", "D"]);
  const tie = [subj({ vin: "Z" }), subj({ vin: "Y" })]; const s2 = new Map<string, ValueScore>([["Z", sc("ranked", 0.1)], ["Y", sc("ranked", 0.1)]]);
  assert.deepEqual(orderByValue(tie, s2), ["Y", "Z"], "exact tie: the VIN decides");
  assert.deepEqual(orderByValue([...tie].reverse(), s2), ["Y", "Z"], "same answer for any input order");
});
test("rankByValue is the same on every run", () => {
  const subjects = [subj({ vin: "A" }), subj({ vin: "B", price: 21000 })]; const c = comps(10);
  assert.deepEqual(rankByValue(subjects, c, 50).order, rankByValue([...subjects].reverse(), c, 50).order);
});
test("two steps at most: the wide fetch happens only when some car lacks eight similar cars, and only for those groups", async () => {
  const mk = (vin: string, trim: string) => ({ vin, vehicle: { year: 2022, make: "Honda", model: "CR-V", trim }, retailListing: { price: 20000, miles: 50000, used: true }, catalog: { distanceMiles: 3 } }) as never;
  const calls: Array<{ groups: number; radius: number | null }> = [];
  const localEx = comps(8, { trim: "EX", distance: 10 }), localLx = comps(2, { trim: "LX", distance: 10 }), farLx = comps(8, { trim: "LX", distance: 300 });
  const fetcher = async (groups: Array<{ trim: string }>, r: number | null) => { calls.push({ groups: groups.length, radius: r }); return r == null ? [...localLx, ...farLx] : [...localEx, ...localLx]; };
  const out = await rankListingsByValue([mk("V1", "EX"), mk("V2", "LX")], 50, fetcher as never);
  assert.deepEqual(calls, [{ groups: 2, radius: 50 }, { groups: 1, radius: null }]);
  assert.equal(out.widenedFetch, true); assert.equal(out.scores.get("V1")?.areaMiles, 50); assert.equal(out.scores.get("V2")?.areaMiles, 500);
  const calls2: number[] = [];
  const one = await rankListingsByValue([mk("V1", "EX")], 50, (async (g: unknown[], r: number | null) => { calls2.push(g.length); return localEx; }) as never);
  assert.deepEqual(calls2, [1]); assert.equal(one.widenedFetch, false);
});
test("subject and groups are read from a search row; cars that cannot be judged need no comparables", () => {
  const l = { vin: "abc", vehicle: { year: 2020, make: "Honda", model: "CR-V", trim: "EX-L" }, retailListing: { price: 1, miles: 5, used: true }, catalog: { distanceMiles: 7 } } as never;
  const s = subjectOf(l); assert.equal(s.vin, "ABC"); assert.equal(s.modelKey, "crv"); assert.equal(s.distance, 7);
  assert.deepEqual(groupsNeeded([s]), [], "price under the floor: nothing to fetch");
  assert.equal(groupsNeeded([subj(), subj({ vin: "S2" })]).length, 1, "one group for two cars of the same kind");
});
test("the text for one car: percentage, sample, area, mileage range, limited sample, unusually low, not judged", () => {
  assert.equal(valueLineFor({ vin: "x", status: "ranked", value: 0.1234, typical: 1, sample: 21, limitedSample: false, areaMiles: 50, mileageBand: 0.2 }), "Value: 12.3% below the typical asking price (21 similar listings within 50 miles, mileage within 20%).");
  assert.match(valueLineFor({ vin: "x", status: "ranked", value: 0.05, sample: 9, limitedSample: true, areaMiles: null, mileageBand: 0.5 }), /9 similar listings nationwide, mileage within 50%, limited sample/);
  assert.match(valueLineFor({ vin: "x", status: "unusually_low", value: 0.5, sample: 12, limitedSample: true, areaMiles: 100, mileageBand: 0.2 }), /Price looks unusually low: check with the dealer\. Not ranked on value\./);
  assert.match(valueLineFor({ vin: "x", status: "unscored", reason: "too_few_similar" }), /not judged \(fewer than eight similar listings found\)/);
  assert.equal(valueLineFor(undefined), "");
});

// The input cleaner has its own list of allowed priorityAxis values: found on the first preview run (the value was dropped as "not recognised" and the search ran as best_for_budget).
import { readFileSync } from "node:fs";
test("every published priorityAxis value is accepted by the input cleaner and not dropped", () => {
  const src = readFileSync("lib/find-matching-vehicle-input.ts", "utf8");
  const published = (src.match(/priorityAxis: z\.enum\(\[([^\]]*)\]\)/) as RegExpMatchArray)[1].split(",").map((x) => x.trim().replace(/"/g, ""));
  assert.ok(published.includes("best_value"));
  const norm = readFileSync("lib/tool-input-normalizer.ts", "utf8");
  const allowed = (norm.match(/priorityAxis: \[([^\]]*)\]/) as RegExpMatchArray)[1].split(",").map((x) => x.trim().replace(/"/g, ""));
  for (const v of published) assert.ok(allowed.includes(v), `${v} missing from the normalizer list`);
});

test("order among ranked cars: judged inside the search area first, then wider areas; value decides inside each group (André 10 Nov, SYS-20261110-026)", () => {
  const subjects = [subj({ vin: "W1" }), subj({ vin: "L1" }), subj({ vin: "W2" }), subj({ vin: "L2" }), subj({ vin: "LOW" })];
  const sc = (local: boolean, value: number, status: ValueScore["status"] = "ranked"): ValueScore => ({ vin: "", status, value, local });
  const scores = new Map<string, ValueScore>([["W1", sc(false, 0.3)], ["L1", sc(true, 0.05)], ["W2", sc(false, 0.2)], ["L2", sc(true, 0.1)], ["LOW", sc(false, 0.5, "unusually_low")]]);
  assert.deepEqual(orderByValue(subjects, scores), ["L2", "L1", "W1", "W2", "LOW"], "local cars first (even with a smaller value), then wider; unusually low after all ranked");
});
test("scoreSubject marks a car local only when the comparison stayed inside the search area", () => {
  assert.equal(scoreSubject(subj(), indexComparables(comps(8, { distance: 20 })), 50).local, true);
  assert.equal(scoreSubject(subj(), indexComparables([...comps(3, { distance: 20 }), ...comps(6, { distance: 150 })]), 50).local, false);
  assert.equal(scoreSubject(subj(), indexComparables(comps(8, { distance: 120 })), 150).local, true, "a 150-mile search is local up to 150 miles");
});
