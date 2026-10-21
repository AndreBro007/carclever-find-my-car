// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed to follow the VIN's marker (SYS-20261021-004, R9).
// Luxury makes put a letter suffix in the trim ("350h Premium", "xDrive50e") or the model ("NX 300h"). The older or rarer electrified cars here are fewer than
// the 300 candidate rows of the plain cars, so only the wording-first ranking brings them in. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type Kind = "gas" | "hybrid" | "phev";
type C = { year: number; make: string; model: string; trim: string; price: number; kind: Kind };
const CARS: C[] = [];
const add = (n: number, c: Omit<C, "price">, p0: number) => { for (let i = 0; i < n; i++) CARS.push({ ...c, price: p0 + i }); };
add(320, { year: 2025, make: "Lexus", model: "RX", trim: "350 Premium", kind: "gas" }, 50000);
add(3, { year: 2022, make: "Lexus", model: "RX", trim: "350h Premium", kind: "hybrid" }, 58000);
add(2, { year: 2022, make: "Lexus", model: "RX", trim: "450h+ Luxury", kind: "phev" }, 70000);
add(320, { year: 2025, make: "Lexus", model: "NX", trim: "350 Premium", kind: "gas" }, 42000);
add(3, { year: 2017, make: "Lexus", model: "NX 300h", trim: "Base", kind: "hybrid" }, 24000);
add(320, { year: 2025, make: "BMW", model: "X5", trim: "xDrive40i", kind: "gas" }, 65000);
add(3, { year: 2023, make: "BMW", model: "X5", trim: "xDrive50e", kind: "phev" }, 62000);

const vin = (n: number) => `JTJBZ1BA${String(n).padStart(9, "0")}`;
const KIND = new Map<string, Kind>();
function line(c: C, n: number): string {
  const id = `lsf${String(n).padStart(29, "0")}`; KIND.set(vin(n), c.kind);
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
type Out = { result: { structuredContent: { results: Array<{ identity: { model: string; trim: string } }> } } };
const carsOf = (o: Out): string[] => o.result.structuredContent.results.map((c) => `${c.identity.model}|${c.identity.trim}`);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const k = KIND.get(m[1].toUpperCase());
    const level = k === "hybrid" ? "Strong Hybrid (SHEV)" : k === "phev" ? "Plug-in Hybrid (PHEV)" : "";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: level, FuelTypePrimary: "Gasoline", FuelTypeSecondary: k === "gas" ? "" : "Electric" }] }), { status: 200 });
  }) as typeof fetch;
  resetNhtsaCacheForTests();
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const ask = (id: number, make: string, model: string, type: string) => call(id, { make, model, electrificationTypes: [type], electrificationRequirement: "required" });

test("Lexus RX, hybrid required: the 350h cars are found among 320 plain 350s; the 450h+ plug-ins are not shown for a hybrid request", opts, async () => {
  assert.deepEqual(carsOf(await ask(10, "Lexus", "RX", "hybrid")), ["RX|350h Premium", "RX|350h Premium", "RX|350h Premium"]);
});

test("Lexus RX, plug-in hybrid required: the 450h+ cars", opts, async () => {
  assert.deepEqual(carsOf(await ask(11, "Lexus", "RX", "plug_in_hybrid")), ["RX|450h+ Luxury", "RX|450h+ Luxury"]);
});

test("Lexus NX, hybrid required: the older cars whose MODEL carries the suffix (NX 300h) are searched with the base model", opts, async () => {
  assert.deepEqual(carsOf(await ask(12, "Lexus", "NX", "hybrid")), ["NX 300h|Base", "NX 300h|Base", "NX 300h|Base"]);
});

test("BMW X5, plug-in hybrid required: xDrive50e found among 320 xDrive40i", opts, async () => {
  assert.deepEqual(carsOf(await ask(13, "BMW", "X5", "plug_in_hybrid")), ["X5|xDrive50e", "X5|xDrive50e", "X5|xDrive50e"]);
});

test("no electrified request: nothing changes, the plain cars are returned", opts, async () => {
  assert.ok(carsOf(await call(14, { make: "Lexus", model: "RX" })).every((c) => c === "RX|350 Premium"));
});
