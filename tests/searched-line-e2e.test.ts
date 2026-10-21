// End-to-end through the real MCP route against a real PostgreSQL: the "Searched:" first line of every reply (SYS-20261021-036, kept simple in SYS-20261021-039).
// It states what the call used, so the AI can check it against the buyer's request. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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
  const id = `sln${String(n).padStart(29, "0")}`;
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
async function search(args: Record<string, unknown>): Promise<{ kinds: string[]; text: string }> {
  const out = await rpc({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { make: "Honda", model: "CR-V", zip: "75201", ...args } } });
  assert.ok(out.result, `a result, not an error: ${out.error?.message ?? ""}`);
  const kinds = (out.result.structuredContent?.results ?? []).map((c: { condition?: { inventoryType?: string } }) => c.condition?.inventoryType ?? "?");
  return { kinds, text: out.result.content.map((c: { text?: string }) => c.text ?? "").join("\n") };
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

test("used false: only new cars, and the reply starts by saying new cars", opts, async () => {
  const { kinds, text } = await search({ used: false, priceMax: 40000, radiusMiles: 100 });
  assert.ok(kinds.length > 0 && kinds.every((k) => k === "new"));
  assert.match(text, /^Searched: new cars; Honda, models CR-V; up to \$40,000; within 100 miles of ZIP 75201\.\n\n/);
});

test("used true: only used cars, and the line says used cars", opts, async () => {
  const { kinds, text } = await search({ used: true });
  assert.ok(kinds.length > 0 && kinds.every((k) => k === "used"));
  assert.match(text, /^Searched: used cars; Honda, models CR-V; within 50 miles of ZIP 75201\./);
});

test("no condition: new and used both, the line says so and has no correction sentence", opts, async () => {
  const { kinds, text } = await search({});
  assert.ok(kinds.includes("new") && kinds.includes("used"), kinds.join(","));
  assert.match(text, /^Searched: new and used; Honda, models CR-V; within 50 miles of ZIP 75201\.\n\n/);
  assert.ok(!/search again|either/.test(text.split("\n")[0]));
});

test("the line comes before any notes, and a no-match reply carries it too", opts, async () => {
  const t = await search({ used: true, trimRequired: "Nonexistent" });
  assert.match(t.text, /^Searched: used cars; Honda, models CR-V; trim Nonexistent \(required\); within 50 miles of ZIP 75201\./);
  assert.ok(t.text.indexOf("Searched:") < t.text.search(/No vehicles matched|Found \d+/));
});

test("the tool text is the simple version: an optional used field, no condition field, rule 1 says how to pass new and used", opts, async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} });
  const tool = res.result.tools.find((t: { name: string }) => t.name === "find_matching_vehicle");
  assert.equal(tool.inputSchema.properties.condition, undefined);
  assert.equal(tool.inputSchema.properties.used.type, "boolean");
  assert.ok(!(tool.inputSchema.required ?? []).includes("used"), "used is optional");
  assert.match(tool.inputSchema.properties.used.description, /^false for new only, true for used or pre-owned only; omit when the buyer says neither\.$/);
  assert.match(tool.description, /1\. Pass only what the buyer stated or clearly implied\. New means used: false; used or pre-owned means used: true\. Check the reply's Searched line against the request and search again if they differ\./);
  assert.ok(tool.description.length <= 3000, `${tool.description.length} characters`);
});
