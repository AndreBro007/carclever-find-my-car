// End-to-end: the real MCP route in catalogue-DATABASE mode, against a real PostgreSQL loaded with synthetic cars.
// Proves (1) zero Auto.dev requests, (2) output passes the registered outputSchema, (3) the feed's own new/used flag and
// the stored tracking links come through, (4) distance scope, VIN lookup and the VIN-not-found wording, (5) a database
// outage becomes the quiet service error. Skipped when TEST_DATABASE_URL is not set. NO real partner data.
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

const DEALERS: Record<number, [string, string, string, string]> = { 1: ["Test Honda Beverly", "Beverly Hills", "CA", "90210"], 2: ["Test Auto LA", "Los Angeles", "CA", "90001"], 3: ["Test Motors Austin", "Austin", "TX", "78701"] };
const vinFor = (n: number) => `1HGCV1F3${String(n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
type C = { n: number; year: number; make: string; model: string; trim: string; cond: "new" | "used"; price: number; odo: number; body: string; dealer: number };
const CARS: C[] = [
  { n: 1, year: 2022, make: "Honda", model: "Civic", trim: "EX-L", cond: "used", price: 24000, odo: 32000, body: "Hatchback", dealer: 1 },
  { n: 2, year: 2026, make: "Honda", model: "Civic", trim: "Sport", cond: "new", price: 28000, odo: 5, body: "Sedan", dealer: 1 },
  { n: 3, year: 2021, make: "Honda", model: "Civic", trim: "LX", cond: "used", price: 19000, odo: 51000, body: "4dr Car", dealer: 2 },
  { n: 4, year: 2023, make: "Honda", model: "Civic", trim: "Sport", cond: "used", price: 22500, odo: 28000, body: "Sedan", dealer: 2 },
  { n: 5, year: 2020, make: "Honda", model: "Civic", trim: "LX", cond: "used", price: 17000, odo: 61000, body: "Sedan", dealer: 3 },
  { n: 6, year: 2024, make: "Toyota", model: "RAV4", trim: "LE", cond: "used", price: 29000, odo: 15000, body: "SUV", dealer: 3 },
];
function line(c: C): string {
  const d = DEALERS[c.dealer]; const vin = vinFor(c.n); const id = `e2e${String(c.n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${c.n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: String(c.dealer), dealer_name: d[0], dealer_street: "1 Test St",
    dealer_city: d[1], dealer_state: d[2], dealer_zip: d[3], dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: c.make, vehicle_model: c.model,
    vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: c.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); for (const c of CARS) yield line(c); }

let pool: Pool; let autoDev = 0;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    if (s.includes("api.auto.dev")) { autoDev++; throw new Error("AUTO.DEV MUST NOT BE CALLED"); }
    return new Response("{}", { status: 404 }); // NHTSA etc. unavailable: must not break anything
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });

const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("database mode: local search returns schema-valid cards with real new/used and both buttons, zero Auto.dev calls", opts, async () => {
  const out = await call(2, { make: "Honda", model: "Civic", zip: "90210", radiusMiles: 50 });
  assert.equal(out.error, undefined); assert.notEqual(out.result.isError, true);
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.serviceError, null);
  assert.equal(sc.meta.scopeNote, "local");
  assert.ok(sc.results.length >= 3, "at least the four California Civics are candidates");
  assert.ok(sc.results.every((c: { listing: { state: string } }) => c.listing.state === "CA"), "no Texas dealer within 50 miles of Beverly Hills");
  for (const c of sc.results) { assert.ok(["new", "used"].includes(c.condition.inventoryType), `known condition, got ${c.condition.inventoryType}`); assert.ok(c.links.affiliateUrl, "tracking link present"); }
  assert.ok(sc.results.some((c: { condition: { inventoryType: string } }) => c.condition.inventoryType === "new"), "the new 2026 Civic is shown as new");
  assert.equal(autoDev, 0);
});

test("database mode: a state without a ZIP is labelled statewide and filtered in the database", opts, async () => {
  const out = await call(3, { make: "Honda", model: "Civic", state: "TX" });
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.scopeNote, "statewide");
  assert.ok(sc.results.length >= 1 && sc.results.every((c: { listing: { state: string } }) => c.listing.state === "TX"));
  assert.equal(autoDev, 0);
});

test("database mode: a VIN lookup finds the car; an unknown VIN gets the catalogue wording and no substitution", opts, async () => {
  const found = await call(4, { vin: vinFor(6) });
  assert.notEqual(found.result.isError, true);
  assert.ok(JSON.stringify(found.result).includes(vinFor(6)), "the requested VIN is in the answer");
  const missing = await call(5, { vin: "1HGCV1F3999Z99999" });
  const txt = JSON.stringify(missing.result);
  assert.ok(/No listing found for VIN/.test(txt));
  assert.ok(!/current live inventory/.test(txt), "uses the catalogue wording, not the Auto.dev wording");
  assert.equal(autoDev, 0);
});

test("database mode: a database outage becomes the quiet service error, never a crash", opts, async () => {
  const broken = new Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
  setCatalogDbPoolForTests(broken);
  const out = await call(6, { make: "Honda", model: "Civic", zip: "90210" });
  assert.equal(out.error, undefined);
  const sc = out.result.structuredContent;
  assert.ok(sc.meta.serviceError, "the service error is reported");
  setCatalogDbPoolForTests(pool); await broken.end().catch(() => {});
  assert.equal(autoDev, 0);
});
