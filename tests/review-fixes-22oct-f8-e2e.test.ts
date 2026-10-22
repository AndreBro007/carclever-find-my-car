// End-to-end (review F8 and the Model Y gap, 22 Oct 2026): a broad electric SUV search must reach the Tesla Model Ys even though 40 cheaper, newer Kia Niro EVs come first in the
// ordinary pool. NHTSA is stubbed per VIN. Synthetic cars only. Skipped without TEST_DATABASE_URL.
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

type C = { make: string; model: string; trim: string; year: number; price: number; vin: string };
const CARS: C[] = [];
const vin = (prefix: string, n: number) => `${prefix}${String(n).padStart(17 - prefix.length, "0")}`;
// 40 Kia Niro EVs: cheaper and newer, so they sort first in the ordinary pool for a $40,000 cap.
for (let n = 1; n <= 40; n++) CARS.push({ make: "Kia", model: "Niro EV", trim: "Wind", year: 2025, price: 30000 + n, vin: vin("KNDCR", n) });
// 6 Tesla Model Ys in the same price band, a year older.
for (let n = 1; n <= 6; n++) CARS.push({ make: "Tesla", model: "Model Y", trim: "Long Range", year: 2023, price: 36000 + n, vin: vin("7SAYG", n) });

function line(c: C, n: number): string {
  const id = `f8${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
const kindOf = new Map(CARS.map((c) => [c.vin, "bev"]));
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
type Out = { result: { structuredContent: { results: Array<{ identity: { make: string; model: string; vin: string } }> } } };

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    const v = m[1].toUpperCase(); const k = kindOf.get(v) ?? "gas";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: k === "bev" ? "BEV (Battery Electric Vehicle)" : "", FuelTypePrimary: k === "bev" ? "Electric" : "Gasoline", FuelTypeSecondary: "", DriveType: "" }] }), { status: 200 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("F8 / Model Y gap: a broad electric SUV search reaches the Tesla Model Ys behind 40 cheaper Kia Niro EVs", opts, async () => {
  resetNhtsaCacheForTests();
  const out = (await call(30, { electrificationTypes: ["electric"], electrificationRequirement: "required", priceMax: 40000, bodyType: "SUV" })) as Out;
  const models = out.result.structuredContent.results.map((r) => `${r.identity.make} ${r.identity.model}`);
  assert.ok(models.includes("Tesla Model Y"), `a Model Y is in the results: ${models.join(", ")}`);
  assert.ok(new Set(models).size >= 2, `more than one model: ${[...new Set(models)].join(", ")}`);
});

test("F8: a broad electric search with a ZIP also shows more than one model", opts, async () => {
  resetNhtsaCacheForTests();
  const out = (await call(31, { electrificationTypes: ["electric"], electrificationRequirement: "required", priceMax: 40000, zip: "90210" })) as Out;
  const models = out.result.structuredContent.results.map((r) => `${r.identity.make} ${r.identity.model}`);
  assert.ok(new Set(models).size >= 2, models.join(", "));
});

// ---- Summary line and Option A (22 Oct 2026) ----
function textOf(o: unknown): string { return ((o as { result: { content: Array<{ text?: string }> } }).result.content).map((c) => c.text ?? "").join("\n"); }

test("Summary line: sits between the Found line and card 1, and every number in it is true for the cars returned", opts, async () => {
  resetNhtsaCacheForTests();
  const out = (await call(40, { electrificationTypes: ["electric"], electrificationRequirement: "required", priceMax: 40000, bodyType: "SUV" })) as Out & { result: { content: Array<{ text?: string }> } };
  const t = textOf(out);
  const iFound = t.indexOf("Found "), iSum = t.indexOf("Summary (calculated"), iCard1 = t.search(/\n1\. /);
  assert.ok(iFound >= 0 && iFound < iSum && iSum < iCard1, `order Found < Summary < card 1 (${iFound}, ${iSum}, ${iCard1})`);
  const sc = (out.result as unknown as { structuredContent: { results: Array<{ identity: { make: string; model: string }; listing: { price: number } }> } }).structuredContent.results;
  const prices = sc.map((r) => r.listing.price);
  const line = t.slice(iSum, t.indexOf("\n", iSum));
  assert.ok(line.includes(`$${Math.min(...prices).toLocaleString("en-US")}`), "cheapest price is the true minimum");
  assert.ok(line.startsWith(`Summary (calculated by the server from the cars listed below; quote it as it is): ${sc.length} cars`));
  for (const m of new Set(sc.map((r) => `${r.identity.make} ${r.identity.model}`))) assert.ok(line.includes(m), `${m} named in the summary`);
});

test("Option A: a required electric search for a model with no electric version says so plainly and gives a next step, and shows no car as electric", opts, async () => {
  resetNhtsaCacheForTests();
  const out = await call(41, { make: "Kia", model: "Niro EV", electrificationTypes: ["hybrid"], electrificationRequirement: "required" });
  const t = textOf(out);
  assert.match(t, /No hybrid Kia Niro EV was found: the cars NHTSA's VIN decode could check show as a different type, so none is listed as hybrid\. Next step: tell the buyer plainly that no hybrid Kia Niro EV turned up in this search, and offer to search hybrid cars in the same budget without naming this model\./);
  assert.ok(!/Found \d+ closely matching/.test(t), "no list of cars presented as matches");
});

test("Option A: when the search finds cars, the note is absent", opts, async () => {
  resetNhtsaCacheForTests();
  const t = textOf(await call(42, { make: "Tesla", electrificationTypes: ["electric"], electrificationRequirement: "required" }));
  assert.ok(!/was found: the cars NHTSA's VIN decode could check/.test(t));
});
