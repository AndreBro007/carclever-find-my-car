// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed per model (T70, SYS-20261021-024): a hybrid search that asked for an electric model and a plug-in
// model must say which were left out and what NHTSA shows them as. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type Kind = "hybrid" | "electric" | "phev";
type C = { make: string; model: string; trim: string; kind: Kind; price: number };
const CARS: C[] = [];
const add = (n: number, c: Omit<C, "price">, p0: number) => { for (let i = 0; i < n; i++) CARS.push({ ...c, price: p0 + i * 10 }); };
add(10, { make: "Toyota", model: "RAV4 Hybrid", trim: "XLE", kind: "hybrid" }, 36000);
add(5, { make: "Hyundai", model: "Ioniq 5", trim: "SEL", kind: "electric" }, 41000);
add(5, { make: "Hyundai", model: "Santa Fe Plug-in Hybrid", trim: "SEL", kind: "phev" }, 43000);

const KIND = new Map<string, Kind>();
function line(c: C, n: number): string {
  const v17 = `KM8JEDD1${String(n).padStart(9, "0")}`; KIND.set(v17, c.kind);
  const id = `lon${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `2026 ${c.make} ${c.model}`, condition: "new", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: v17, year: 2026, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: v17, vehicle_stock_number: "S", vehicle_year: "2026.00",
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "5.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
const textOf = (o: { result: { content: Array<{ text?: string }> } }): string => o.result.content.map((c) => c.text ?? "").join("\n");

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const k = KIND.get(m[1].toUpperCase());
    const level = k === "hybrid" ? "Strong Hybrid (SHEV)" : k === "electric" ? "Battery Electric Vehicle (BEV)" : "Plug-in Hybrid Electric Vehicle (PHEV)";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: level, FuelTypePrimary: k === "electric" ? "Electric" : "Gasoline", FuelTypeSecondary: k === "hybrid" || k === "phev" ? "Electric" : "" }] }), { status: 200 });
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

test("a hybrid search that asked for an electric and a plug-in model names them and what NHTSA shows", opts, async () => {
  const t = textOf(await call(10, { model: "RAV4, Ioniq 5, Santa Fe Plug-in Hybrid", electrificationTypes: ["hybrid"], electrificationRequirement: "required", zip: "75201" }));
  assert.match(t, /Cars that NHTSA shows as a different type than hybrid were left out: .*Ioniq 5 \(electric\)/);
  assert.match(t, /Santa Fe Plug-in Hybrid \(plug-in hybrid\)/);
  assert.ok(!/RAV4 Hybrid \(/.test(t.split("\n").find((l) => /were left out/.test(l)) ?? ""), "the hybrid that matched is not named as left out");
});

test("an electric search that named a plug-in model names it as left out", opts, async () => {
  const t = textOf(await call(11, { model: "Santa Fe Plug-in Hybrid, Ioniq 5", electrificationTypes: ["electric"], electrificationRequirement: "required", zip: "75201" }));
  assert.match(t, /Cars that NHTSA shows as a different type than electric were left out: Santa Fe Plug-in Hybrid \(plug-in hybrid\)\./);
  assert.ok(!/Ioniq 5 \(/.test(t.split("\n").find((l) => /were left out/.test(l)) ?? ""), "the electric model that matched is not named as left out");
});
