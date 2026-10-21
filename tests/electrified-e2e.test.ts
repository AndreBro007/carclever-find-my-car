// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed with a decode that follows the VIN's own marker (SYS-20261021-004, R4).
// The AI passes the BASE model ("RAV4", "CR-V") plus the electrification field; the feed names hybrids "RAV4 Hybrid" (model) and "Sport-L Hybrid" (trim).
// Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type C = { year: number; make: string; model: string; trim: string; price: number; kind: "gas" | "hybrid" | "phev" };
const CARS: C[] = [];
for (let i = 0; i < 320; i++) CARS.push({ year: 2023, make: "Toyota", model: "RAV4", trim: "XLE", price: 20000 + i, kind: "gas" }); // fills the 300 candidate rows
for (let i = 0; i < 3; i++) CARS.push({ year: 2020, make: "Toyota", model: "RAV4 Hybrid", trim: "XLE", price: 33000 + i, kind: "hybrid" });
for (let i = 0; i < 2; i++) CARS.push({ year: 2021, make: "Toyota", model: "RAV4 Prime", trim: "SE", price: 41000 + i, kind: "phev" });
for (let i = 0; i < 320; i++) CARS.push({ year: 2024, make: "Honda", model: "CR-V", trim: "EX-L", price: 28000 + i, kind: "gas" });
for (let i = 0; i < 3; i++) CARS.push({ year: 2021, make: "Honda", model: "CR-V", trim: "Sport-L Hybrid", price: 38000 + i, kind: "hybrid" }); // wording in the trim; older than the plain cars, so only the ranking brings them into the 300 rows

const vin = (n: number) => `1HGCV1F3A${String(n).padStart(8, "0")}`;
const KIND_BY_VIN = new Map<string, C["kind"]>();
function line(c: C, n: number): string {
  const id = `ele${String(n).padStart(29, "0")}`; KIND_BY_VIN.set(vin(n), c.kind);
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
type Out = { result: { content: Array<{ text?: string }>; structuredContent: { results: Array<{ identity: { model: string; trim: string } }> } } };
const textOf = (o: Out): string => o.result.content.map((c) => c.text ?? "").join("\n");
const carsOf = (o: Out): string[] => o.result.structuredContent.results.map((c) => `${c.identity.model}|${c.identity.trim}`);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    const m = s.match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const kind = KIND_BY_VIN.get(m[1].toUpperCase()) ?? "gas";
    const level = kind === "hybrid" ? "Strong Hybrid (SHEV)" : kind === "phev" ? "Plug-in Hybrid (PHEV)" : "";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: level, FuelTypePrimary: "Gasoline", FuelTypeSecondary: kind === "gas" ? "" : "Electric" }] }), { status: 200 });
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

test("required hybrid with the BASE model: the RAV4 Hybrid cars are found (the plain RAV4s fill the pool, so they were missed before)", opts, async () => {
  const out = await call(10, { make: "Toyota", model: "RAV4", electrificationTypes: ["hybrid"], electrificationRequirement: "required" });
  const cars = carsOf(out);
  assert.equal(cars.length, 3);
  assert.ok(cars.every((c) => c === "RAV4 Hybrid|XLE"), `got ${cars.join(", ")}`);
});

test("required plug-in hybrid with the base model: both spellings of the family are searched, the plain RAV4s are not shown", opts, async () => {
  const out = await call(11, { make: "Toyota", model: "RAV4", electrificationTypes: ["plug_in_hybrid"], electrificationRequirement: "required" });
  assert.deepEqual(carsOf(out), ["RAV4 Prime|SE", "RAV4 Prime|SE"]);
});

test("required hybrid, wording in the TRIM: base model CR-V finds the Sport-L Hybrid cars", opts, async () => {
  const out = await call(12, { make: "Honda", model: "CR-V", electrificationTypes: ["hybrid"], electrificationRequirement: "required" });
  assert.deepEqual(carsOf(out), ["CR-V|Sport-L Hybrid", "CR-V|Sport-L Hybrid", "CR-V|Sport-L Hybrid"]);
});

test("required hybrid with the trim Sport-L (R3 with the trim lookup): the hybrid word in the car's trim does not get in the way", opts, async () => {
  const out = await call(13, { make: "Honda", model: "CR-V", trimRequired: "Sport-L", electrificationTypes: ["hybrid"], electrificationRequirement: "required" });
  assert.equal(carsOf(out).length, 3);
  assert.ok(!/close trim match/.test(textOf(out)));
});

test("no electrified request: nothing changes, the plain RAV4s are returned", opts, async () => {
  const out = await call(14, { make: "Toyota", model: "RAV4" });
  assert.ok(carsOf(out).every((c) => c === "RAV4|XLE"));
});
