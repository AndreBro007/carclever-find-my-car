// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed to follow the VIN's marker (SYS-20261021-004, T58).
// The feed names the 2026 RAV4 and the 2025 Camry with no hybrid wording; 320 worded hybrids of the same family would fill the candidate rows if only wording
// were used. The searches ask for the newest, so the hybrid-only year must reach the shortlist. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type C = { year: number; model: string; trim: string; price: number; kind: "gas" | "hybrid" };
const CARS: C[] = [];
for (let i = 0; i < 320; i++) CARS.push({ year: 2025, model: "RAV4 Hybrid", trim: "XLE", price: 30000 + i, kind: "hybrid" }); // worded, fills the 300 rows
for (let i = 0; i < 50; i++) CARS.push({ year: 2025, model: "RAV4", trim: "LE", price: 25000 + i, kind: "gas" });
for (let i = 0; i < 3; i++) CARS.push({ year: 2026, model: "RAV4", trim: "LE", price: 34000 + i, kind: "hybrid" }); // hybrid-only year, no wording
for (let i = 0; i < 320; i++) CARS.push({ year: 2023, model: "Camry Hybrid", trim: "SE", price: 26000 + i, kind: "hybrid" });
for (let i = 0; i < 40; i++) CARS.push({ year: 2024, model: "Camry", trim: "LE", price: 22000 + i, kind: "gas" });
for (let i = 0; i < 3; i++) CARS.push({ year: 2025, model: "Camry", trim: "XSE", price: 31000 + i, kind: "hybrid" });

const vin = (n: number) => `4T1DAC1K${String(n).padStart(9, "0")}`;
const KIND_BY_VIN = new Map<string, C["kind"]>();
function line(c: C, n: number): string {
  const id = `khy${String(n).padStart(29, "0")}`; KIND_BY_VIN.set(vin(n), c.kind);
  const v: Record<string, string> = { id, title: `${c.year} Toyota ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: "Toyota", model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: "Toyota", vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
type Out = { result: { structuredContent: { results: Array<{ identity: { model: string; trim: string; year: number } }> } } };
const carsOf = (o: Out): string[] => o.result.structuredContent.results.map((c) => `${c.identity.year} ${c.identity.model}|${c.identity.trim}`);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const hybrid = KIND_BY_VIN.get(m[1].toUpperCase()) === "hybrid";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: hybrid ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: hybrid ? "Electric" : "" }] }), { status: 200 });
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

test("required hybrid, base model RAV4: the unworded 2026 RAV4 hybrids are found next to the worded RAV4 Hybrid cars", opts, async () => {
  const cars = carsOf(await call(10, { make: "Toyota", model: "RAV4", electrificationTypes: ["hybrid"], electrificationRequirement: "required", priorityAxis: "newest" }));
  assert.ok(cars.some((c) => c.startsWith("2026 RAV4|")), `got ${cars.join(", ")}`);
  assert.ok(!cars.some((c) => c.startsWith("2025 RAV4|")), "the 2025 plain RAV4s are gas and are not shown");
});

test("required hybrid, base model Camry: the unworded 2025 Camry hybrids are found; the 2024 gas Camrys are not shown", opts, async () => {
  const cars = carsOf(await call(11, { make: "Toyota", model: "Camry", electrificationTypes: ["hybrid"], electrificationRequirement: "required", priorityAxis: "newest" }));
  assert.ok(cars.some((c) => c.startsWith("2025 Camry|")), `got ${cars.join(", ")}`);
  assert.ok(!cars.some((c) => c.startsWith("2024 Camry|")));
});

test("a plug-in request does not get the hybrid-only years listed first", opts, async () => {
  const out = await call(12, { make: "Toyota", model: "RAV4", electrificationTypes: ["plug_in_hybrid"], electrificationRequirement: "required" });
  assert.deepEqual(carsOf(out), []);
});
