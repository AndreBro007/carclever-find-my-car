// Group 2, item 2 (9 Nov 2026): the VIN as the final tiebreak (SQL, strict objectives, local ranking) and the one-line tie statement. Run: npx tsx --test tests/tie-order.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { strictAxisOrder } from "../lib/explicit-axis-order";
import { applyLocalBestForBudgetOrdering } from "../lib/local-ranking";
import { tieNote, type TieCard } from "../lib/tie-note";
import { searchRows, type Queryable } from "../lib/catalog-db/search";

const L = (vin: string, price: number, miles: number, year: number): any => ({ vin, retailListing: { price, miles }, vehicle: { year } });
const shuffled = <T,>(a: T[], seed: number): T[] => { const r = [...a]; let s = seed; for (let i = r.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const VINS = ["1HGCM82633A004357", "1HGCM82633A004352", "1HGCM82633A004359", "1HGCM82633A004353", "1HGCM82633A004355", "1HGCM82633A004351"];

test("strict objectives: cars equal on every earlier key come out in VIN order whatever the input order", () => {
  for (const axis of ["cheapest", "newest", "lowest_mileage"] as const) {
    const cars = VINS.map((v) => L(v, 26584, 9734, 2025));
    const expected = [...VINS].sort();
    for (let seed = 1; seed <= 25; seed++) assert.deepEqual(strictAxisOrder(shuffled(cars, seed), axis, 6).map((c: any) => c.vin), expected, `${axis} seed ${seed}`);
  }
});
test("strict objectives: the earlier keys still decide first (the VIN only breaks real ties)", () => {
  const cars = [L("ZZZ", 20000, 5, 2025), L("AAA", 20000, 50, 2025), L("MMM", 19000, 900, 2020)];
  assert.deepEqual(strictAxisOrder(cars, "cheapest", 3).map((c: any) => c.vin), ["MMM", "ZZZ", "AAA"]);
  assert.deepEqual(strictAxisOrder(cars, "lowest_mileage", 3).map((c: any) => c.vin), ["ZZZ", "AAA", "MMM"]);
});
test("local best-for-budget ranking: identical cars keep one order whatever the input order", () => {
  const cars = VINS.map((v) => L(v, 26584, 9734, 2025));
  const expected = [...VINS].sort();
  for (let seed = 1; seed <= 25; seed++) assert.deepEqual(applyLocalBestForBudgetOrdering(shuffled(cars, seed), undefined, undefined, 45000).map((c: any) => c.vin), expected, `seed ${seed}`);
});
test("every ordering the database search can use ends with the VIN and then the listing id", async () => {
  for (const sort of [undefined, "price.asc", "price.desc", "year.desc", "mileage.asc"]) {
    for (const priceMax of [undefined, 45000]) {
      const sqls: string[] = [];
      const db: Queryable = { query: async (sql: string) => { sqls.push(String(sql)); return { rows: [] } as any; } } as any;
      await searchRows(db, { make: "Honda", model: "CR-V", sort, priceMax, limit: 8 } as any, null);
      const ordered = sqls.filter((q) => /ORDER BY .*LIMIT/s.test(q) && /FROM listing/.test(q));
      assert.ok(ordered.length > 0, "a candidate query ran");
      for (const q of ordered) assert.match(q, /l\.vin ASC, l\.id ASC/, `sort ${sort} ceiling ${priceMax}: ${q.slice(0, 160)}`);
    }
  }
});
const C = (year: number, price: number, miles: number): TieCard => ({ identity: { year }, listing: { price, mileage: miles } });
test("tie statement: says how many tie, on what, and the real secondary order of that objective", () => {
  const all = Array.from({ length: 8 }, () => C(2027, 30000, 3));
  assert.equal(tieNote(all, "newest"), "All 8 cars tie on model year 2027; within the tie they are listed by mileage, then price, then VIN.");
  assert.equal(tieNote([C(2027, 1, 1), C(2027, 2, 2), C(2027, 3, 3), C(2026, 4, 4)], "newest"), "3 of these 4 cars tie on model year 2027; within the tie they are listed by mileage, then price, then VIN.");
  assert.equal(tieNote([C(2025, 26584, 10), C(2025, 26584, 20), C(2024, 27000, 5)], "cheapest"), "2 of these 3 cars tie on price $26,584; within the tie they are listed by mileage, then newer year, then VIN.");
  assert.equal(tieNote([C(2025, 20000, 12), C(2024, 21000, 12)], "lowest_mileage"), "All 2 cars tie on mileage 12 mi; within the tie they are listed by price, then newer year, then VIN.");
});
test("tie statement: nothing is said without a real tie, for other objectives, for one car or for missing values", () => {
  assert.equal(tieNote([C(2027, 1, 1), C(2026, 2, 2)], "newest"), null);
  assert.equal(tieNote(Array.from({ length: 4 }, () => C(2027, 1, 1)), "best_for_budget"), null);
  assert.equal(tieNote(Array.from({ length: 4 }, () => C(2027, 1, 1)), undefined), null);
  assert.equal(tieNote([C(2027, 1, 1)], "newest"), null);
  assert.equal(tieNote([{ identity: { year: null }, listing: {} }, { identity: { year: null }, listing: {} }], "newest"), null);
  assert.equal(tieNote([C(2026, 2, 2), C(2027, 1, 1), C(2027, 1, 1)], "newest"), null, "ties lower down the list are not announced; only the top car's tie is");
});
