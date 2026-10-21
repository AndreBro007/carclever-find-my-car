// End-to-end through the real MCP route against a real PostgreSQL: awkward inputs must never crash, never leak "undefined" or "NaN", never touch the data, and never mention "catalog".
// (Pre-freeze review, SYS-20261021-025.) Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type C = { make: string; model: string; trim: string; hybrid: boolean; price: number };
const CARS: C[] = [];
for (let i = 0; i < 6; i++) CARS.push({ make: "Toyota", model: "RAV4 Hybrid", trim: "XLE", hybrid: true, price: 36000 + i });
for (let i = 0; i < 6; i++) CARS.push({ make: "Toyota", model: "Highlander", trim: "XLE", hybrid: false, price: 42000 + i });
for (let i = 0; i < 4; i++) CARS.push({ make: "Hyundai", model: "Santa Fe", trim: "SEL Hybrid", hybrid: true, price: 40000 + i });
const KIND = new Map<string, boolean>();
function line(c: C, n: number): string {
  const vin = `JTMRWRFV${String(n).padStart(9, "0")}`; KIND.set(vin, c.hybrid);
  const id = `rob${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `2026 ${c.make} ${c.model}`, condition: "new", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: 2026, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: "2026.00",
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "5.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown): Promise<{ status: number; json: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } } }> {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return { status: r.status, json: JSON.parse(m ? m[1] : t) };
}
let id = 100;
async function safe(args: Record<string, unknown>): Promise<string> {
  const { status, json } = await rpc({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
  assert.ok(status < 500, `HTTP ${status} for ${JSON.stringify(args).slice(0, 120)}`);
  const text = json.result ? (json.result.content ?? []).map((c) => c.text ?? "").join("\n") : String(json.error?.message ?? "");
  assert.ok(json.result || json.error, "a JSON-RPC result or a JSON-RPC error, never nothing");
  for (const bad of ["undefined", "NaN", "[object Object]", "null null"]) assert.ok(!text.includes(bad), `"${bad}" leaked for ${JSON.stringify(args).slice(0, 100)}: ${(text.match(new RegExp(`.{0,40}${bad.replace(/[[\]]/g, "\\$&")}.{0,40}`)) ?? [""])[0]}`);
  assert.ok(!/catalog/i.test(text), `"catalog" in reply for ${JSON.stringify(args).slice(0, 100)}`);
  return text;
}
const rowCount = async (): Promise<number> => Number((await pool.query("SELECT count(*) AS n FROM listing")).rows[0].n);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const h = KIND.get(m[1].toUpperCase());
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: h ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: h ? "Electric" : "" }] }), { status: 200 });
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
const HYB = { electrificationTypes: ["hybrid"], electrificationRequirement: "required", zip: "75201" };

test("forty models, blanks and duplicates", opts, async () => {
  const forty = Array.from({ length: 40 }, (_, i) => `Model${i}`).concat(["RAV4", "Santa Fe"]).join(", ");
  assert.match(await safe({ ...HYB, model: forty }), /RAV4 Hybrid|Santa Fe/);
  assert.match(await safe({ ...HYB, model: " , ,Highlander,, highlander ,RAV4 ,, " }), /RAV4 Hybrid/);
  await safe({ ...HYB, model: "" }); await safe({ ...HYB, model: "," }); await safe({ ...HYB, model: "   " });
});

test("SQL-looking, unicode, emoji and very long text change nothing in the data", opts, async () => {
  const before = await rowCount();
  for (const s of ["'; DROP TABLE listing; --", "x' OR '1'='1", "RAV4\"; SELECT pg_sleep(5); --", "Hïghlander 🚗", "\u0000", "%", "_", "\\", "a".repeat(5000), "RAV4, " + "b".repeat(3000)]) {
    await safe({ ...HYB, model: s }); await safe({ make: s, model: "RAV4" }); await safe({ trimRequired: s, make: "Toyota", model: "RAV4" });
  }
  assert.equal(await rowCount(), before);
});

test("odd numbers, ZIPs and flags are handled without a crash", opts, async () => {
  for (const a of [{ priceMax: 1 }, { priceMax: 0 }, { priceMax: 10_000_000 }, { radiusMiles: 1 }, { radiusMiles: 5000 }, { zip: "00000" }, { zip: "ABCDE" }, { zip: "7520" }, { yearMin: 2100 }, { yearMax: 1900 }, { mileageMax: 0 }]) {
    await safe({ model: "RAV4, Santa Fe", ...HYB, ...a } as Record<string, unknown>);
  }
});

test("all three electrified types, required and preferred, with and without a make", opts, async () => {
  for (const req of ["required", "preferred"]) for (const types of [["hybrid", "plug_in_hybrid", "electric"], ["electric"], ["plug_in_hybrid"]]) {
    await safe({ model: "RAV4, Santa Fe, Highlander", electrificationTypes: types, electrificationRequirement: req, zip: "75201" });
    await safe({ make: "Toyota", model: "RAV4", electrificationTypes: types, electrificationRequirement: req });
  }
});

test("empty, minimal and odd shapes", opts, async () => {
  await safe({}); await safe({ vehicleNeeds: ["", "  ", "SUV", "midsize SUV"] }); await safe({ vehicleNeeds: Array.from({ length: 60 }, (_, i) => `need ${i}`), model: "RAV4, Santa Fe" });
  await safe({ vin: "not a vin" }); await safe({ vin: "" }); await safe({ trimRequired: "A, B, , C", model: "RAV4, Santa Fe", make: "Toyota" }); await safe({ priorityAxis: "cheapest", model: "RAV4, Santa Fe, Highlander", ...HYB });
});

test("a plain request still returns cars and the usual closing line", opts, async () => {
  const t = await safe({ ...HYB, model: "RAV4, Santa Fe" });
  assert.match(t, /Found \d+ closely matching vehicles?/);
  assert.match(t, /Check each Edmunds listing/);
});
