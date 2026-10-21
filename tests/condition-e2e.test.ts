// End-to-end through the real MCP route against a real PostgreSQL (SYS-20261021-033, option B): condition new, used and either, a missing condition (lenient), the older used
// boolean, and a value that is not understood. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
process.env.LISTING_SOURCE = "catalog_db";
process.env.DATABASE_URL = DB ?? "postgres://unused";
process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";

import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { setCatalogDbPoolForTests } from "../lib/catalog-db-source";
import { resetNhtsaCacheForTests } from "../lib/nhtsa-client";

type C = { trim: string; year: number; price: number; cond: "new" | "used"; odo: number };
const CARS: C[] = [];
for (let i = 0; i < 4; i++) CARS.push({ trim: "EX-L", year: 2026, price: 36000 + i * 10, cond: "new", odo: 5 });
for (let i = 0; i < 4; i++) CARS.push({ trim: "LX", year: 2023, price: 25000 + i * 10, cond: "used", odo: 30000 });
const vin = (n: number) => `2HKRS4H3${String(n).padStart(9, "0")}`;
function line(c: C, n: number): string {
  const id = `cnd${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} Honda CR-V`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: "Honda", model: "CR-V" }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Honda",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: "Honda", vehicle_model: "CR-V", vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
let id = 100;
type Out = { result?: { content: Array<{ text?: string }>; structuredContent?: { results: Array<{ condition?: { inventoryType?: string } }> } }; error?: { message?: string } };
async function search(args: Record<string, unknown>): Promise<{ kinds: string[]; text: string; out: Out }> {
  const out = (await rpc({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { make: "Honda", model: "CR-V", zip: "75201", ...args } } })) as Out;
  assert.ok(out.result, `a result, not an error: ${out.error?.message ?? ""}`);
  const kinds = (out.result.structuredContent?.results ?? []).map((c) => c.condition?.inventoryType ?? "?");
  return { kinds, text: out.result.content.map((c) => c.text ?? "").join("\n"), out };
}

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  resetNhtsaCacheForTests();
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("condition new: only new cars, each confirmed as new", opts, async () => {
  const { kinds, text } = await search({ condition: "new" });
  assert.equal(kinds.length, 4); assert.ok(kinds.every((k) => k === "new"));
  assert.equal((text.match(/Confirmed: new/g) ?? []).length, 4);
});

test("condition used: only used cars", opts, async () => {
  const { kinds } = await search({ condition: "used" });
  assert.equal(kinds.length, 4); assert.ok(kinds.every((k) => k === "used"));
});

test("condition either: new and used cars both appear", opts, async () => {
  const { kinds } = await search({ condition: "either" });
  assert.ok(kinds.includes("new") && kinds.includes("used"), kinds.join(","));
});

test("no condition at all is accepted (lenient) and means either, with no note about it", opts, async () => {
  const { kinds, text } = await search({});
  assert.ok(kinds.includes("new") && kinds.includes("used"), kinds.join(","));
  assert.ok(!/could not be used and were ignored/.test(text));
});

test("the older used boolean still works for clients that send it", opts, async () => {
  assert.ok((await search({ used: false })).kinds.every((k) => k === "new"));
  assert.ok((await search({ used: true })).kinds.every((k) => k === "used"));
});

test("words are understood: New, pre-owned, certified, brand new", opts, async () => {
  assert.ok((await search({ condition: "New" })).kinds.every((k) => k === "new"));
  assert.ok((await search({ condition: "brand new" })).kinds.every((k) => k === "new"));
  for (const w of ["pre-owned", "certified"]) assert.ok((await search({ condition: w })).kinds.every((k) => k === "used"), w);
});

test("a value that is not understood is reported, and both conditions are searched", opts, async () => {
  const { kinds, text } = await search({ condition: "maybe" });
  assert.ok(kinds.includes("new") && kinds.includes("used"));
  assert.match(text, /these inputs could not be used and were ignored: condition \(value "maybe" not recognised; both new and used were searched\)/);
});
