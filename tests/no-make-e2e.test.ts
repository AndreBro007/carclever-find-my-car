// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed to follow the VIN's marker.
// The usual request names models from SEVERAL makes and passes no make ("Highlander, Santa Fe, Sorento, RX"). The electrified expansion (variant model names, wording and
// letter-suffix ranking, known hybrid-only years) must work from the model names alone; it used to be skipped without a make (found in André's real-AI test, 21 Oct).
// Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after, beforeEach } from "node:test";
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

type Kind = "gas" | "hybrid";
type C = { make: string; model: string; trim: string; year: number; price: number; kind: Kind };
const CARS: C[] = [];
const add = (n: number, c: Omit<C, "price">, p0: number) => { for (let i = 0; i < n; i++) CARS.push({ ...c, price: p0 + i }); };
add(320, { make: "Toyota", model: "Highlander", trim: "XLE", year: 2026, kind: "gas" }, 42000);            // plain Highlander, gas, newer and fills the 300 rows
add(2, { make: "Toyota", model: "Highlander Hybrid", trim: "Limited", year: 2025, kind: "hybrid" }, 52000); // the hybrid is a separate model name
add(2, { make: "Hyundai", model: "Santa Fe", trim: "SEL Hybrid", year: 2027, kind: "hybrid" }, 41000);      // wording in the trim
add(320, { make: "Kia", model: "Sorento", trim: "EX", year: 2026, kind: "gas" }, 38000);
add(2, { make: "Kia", model: "Sorento Hybrid", trim: "SX", year: 2025, kind: "hybrid" }, 45000);
add(2, { make: "Lexus", model: "RX", trim: "350h Premium", year: 2026, kind: "hybrid" }, 61000);           // letter suffix

const KIND = new Map<string, Kind>();
function line(c: C, n: number): string {
  const vin = `5TDDK3EH${String(n).padStart(9, "0")}`; KIND.set(vin, c.kind);
  const id = `nmk${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
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
const modelsOf = (o: Out): string[] => o.result.structuredContent.results.map((c) => c.identity.model);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const hybrid = KIND.get(m[1].toUpperCase()) === "hybrid";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: hybrid ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: hybrid ? "Electric" : "" }] }), { status: 200 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
beforeEach(() => { resetNhtsaCacheForTests(); });
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const REQ = { electrificationTypes: ["hybrid"], electrificationRequirement: "required" };

test("no make, one base model: its hybrid variant is found (this returned 0 cars before the fix)", opts, async () => {
  assert.deepEqual(modelsOf(await call(10, { ...REQ, model: "Highlander" })).sort(), ["Highlander Hybrid", "Highlander Hybrid"]);
});

test("no make, several makes' models: hybrids of all of them are found, wording in the model, the trim and a letter suffix", opts, async () => {
  const out = await call(11, { ...REQ, model: "Highlander, Santa Fe, Sorento, RX", priceMax: 70000, priorityAxis: "best_for_budget" });
  const m = new Set(modelsOf(out));
  assert.ok(m.has("Highlander Hybrid"), [...m].join(", "));
  assert.ok(m.has("Santa Fe"), [...m].join(", "));
  assert.ok(m.has("Sorento Hybrid"), [...m].join(", "));
  assert.ok(m.has("RX"), [...m].join(", "));
  assert.ok(!m.has("Sorento") && !m.has("Highlander"), "the gas models are not shown for a required hybrid");
});

test("no make: a model name that exists in no make adds nothing and does not break", opts, async () => {
  const out = await call(12, { ...REQ, model: "Zzzmodel" });
  assert.equal(modelsOf(out).length, 0);
});

test("no make, no electrification request: nothing changes", opts, async () => {
  const out = await call(13, { model: "Highlander, Sorento" });
  assert.ok(modelsOf(out).every((x) => x === "Highlander" || x === "Sorento"));
});
