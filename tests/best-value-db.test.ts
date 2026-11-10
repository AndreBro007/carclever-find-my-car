// R4-5 best value: the comparables query and the nearest-first pool (10 Nov 2026). Run: npx tsx --test tests/best-value-db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueComparables, localSortFor, VALUE_COMPARABLE_ROW_CAP } from "../lib/catalog-db/search";

const fake = (rows: Record<string, unknown>[] = []) => { const calls: Array<{ sql: string; params: unknown[] }> = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return { rows }; } }; };
const G = [{ makeKey: "honda", modelKey: "crv", year: 2022, trim: "EX", used: true }, { makeKey: "honda", modelKey: "crv", year: 2023, trim: "LX", used: false }];

test("no groups or an unknown ZIP: no query at all", async () => {
  const db = fake(); assert.deepEqual(await valueComparables(db, "90210", [], 50), []); assert.deepEqual(await valueComparables(db, "00000", G, 50), []); assert.equal(db.calls.length, 0);
});
test("the groups go in as parallel arrays; the price CEILING is not in the query; one row per VIN; one statement", async () => {
  const db = fake([{ vin: "1abc", make_key: "honda", model_key: "crv", year: 2022, trim: "EX", condition: "u", price: 24000, odometer: 50000, distance: 12.5 }, { vin: "2ABC", make_key: "honda", model_key: "crv", year: 2023, trim: "LX", condition: "n", price: 30000, odometer: null, distance: 3 }]);
  const out = await valueComparables(db, "90210", G, 50);
  assert.equal(db.calls.length, 1); const { sql, params } = db.calls[0];
  assert.deepEqual(params.slice(0, 5), [["honda", "honda"], ["crv", "crv"], [2022, 2023], ["EX", "LX"], ["u", "n"]]);
  assert.match(sql, /DISTINCT ON \(l\.vin\)/); assert.match(sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::int\[\], \$4::text\[\], \$5::text\[\]\)/);
  assert.ok(!/l\.price <=/.test(sql) && !/priceMax/.test(sql), "no price ceiling");
  assert.match(sql, new RegExp(`LIMIT ${VALUE_COMPARABLE_ROW_CAP}`));
  assert.deepEqual(out, [
    { vin: "1ABC", makeKey: "honda", modelKey: "crv", year: 2022, trim: "EX", used: true, price: 24000, miles: 50000, distance: 12.5 },
    { vin: "2ABC", makeKey: "honda", modelKey: "crv", year: 2023, trim: "LX", used: false, price: 30000, miles: null, distance: 3 },
  ]);
});
test("a radius adds the box and the distance limit; nationwide (null) adds neither", async () => {
  const a = fake(); await valueComparables(a, "90210", G, 50); assert.match(a.calls[0].sql, /l\.lat BETWEEN/); assert.match(a.calls[0].sql, /x\.distance <= /);
  const b = fake(); await valueComparables(b, "90210", G, null); assert.ok(!/BETWEEN/.test(b.calls[0].sql) && !/x\.distance <=/.test(b.calls[0].sql));
  const c = fake(); await valueComparables(c, "90210", G, 5000); assert.ok(c.calls[0].params.includes(1000), "the radius is capped at 1,000 like every other search");
});
test("the nearest-first order adds nothing before the distance; other orders are unchanged", () => {
  assert.equal(localSortFor("distance.asc", 30000), "");
  assert.equal(localSortFor("price.asc"), "(x.odometer IS NULL) ASC, x.price ASC NULLS LAST, ");
  assert.match(localSortFor(undefined, 30000), /x\.price >= 22500/, "the default ordering still uses the ceiling rule");
});
