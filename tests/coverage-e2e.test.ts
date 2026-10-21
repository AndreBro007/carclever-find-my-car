// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed (SYS-20261021-017, option A).
// A request that names several models from different makes: every requested model that has matches must reach the result, and a model that matched but is not shown must be
// named, not reported as having no matches. The seed mirrors André's Dallas test: one dealer with a great many new RX cars near the top of the budget, and cheaper Santa Fe and
// Sorento hybrids that the budget-first ranking puts last. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type C = { make: string; model: string; trim: string; year: number; price: number; odo: number; dealer: number; zip: string };
const CARS: C[] = [];
const add = (n: number, c: Omit<C, "price">, p0: number, step = 1) => { for (let i = 0; i < n; i++) CARS.push({ ...c, price: p0 + i * step }); };
add(320, { make: "Lexus", model: "RX", trim: "350h Premium Plus", year: 2026, odo: 1, dealer: 1, zip: "75201" }, 61000, 10);          // fills a 300-row pool by itself
add(8, { make: "Toyota", model: "Highlander Hybrid", trim: "Platinum", year: 2026, odo: 5, dealer: 2, zip: "75202" }, 56000, 100);
add(8, { make: "Toyota", model: "Grand Highlander Hybrid", trim: "Limited", year: 2026, odo: 5, dealer: 3, zip: "75203" }, 63000, 100);
add(30, { make: "Hyundai", model: "Santa Fe", trim: "SEL Hybrid", year: 2027, odo: 10, dealer: 4, zip: "76102" }, 39000, 50);
add(30, { make: "Kia", model: "Sorento Hybrid", trim: "EX", year: 2026, odo: 12, dealer: 5, zip: "76103" }, 37000, 50);

["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"].forEach((nm, k) => add(6, { make: `Make${k}`, model: `${nm} Hybrid`, trim: "Base", year: 2026, odo: 3, dealer: 10 + k, zip: "75201" }, 45000 + k * 2500, 200));
const vin = (n: number) => `5TDEBRCH${String(n).padStart(9, "0")}`;
function line(c: C, n: number): string {
  const id = `cov${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "new", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: String(c.dealer), dealer_name: `Dealer ${c.dealer}`,
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: c.zip, dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
type Out = { result: { content: Array<{ text?: string }>; structuredContent: { results: Array<{ identity: { model: string } }> } } };
const textOf = (o: Out): string => o.result.content.map((c) => c.text ?? "").join("\n");
const modelsOf = (o: Out): string[] => o.result.structuredContent.results.map((c) => c.identity.model);
const countOf = (a: string[], x: string): number => a.filter((m) => m === x).length;

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: "Strong Hybrid (SHEV)", FuelTypePrimary: "Gasoline", FuelTypeSecondary: "Electric" }] }), { status: 200 });
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
const DALLAS = { bodyType: "SUV", model: "Highlander, Grand Highlander, Sorento, Santa Fe, RX", electrificationTypes: ["hybrid"], electrificationRequirement: "required", priceMax: 70000, priceFlexibility: "strict", vehicleNeeds: ["medium-size SUV"], zip: "75201", priorityAxis: "best_for_budget" };

test("André's Dallas request: every requested model with matches reaches the 8, even though 320 RX lead the ranking", opts, async () => {
  const out = (await call(10, DALLAS)) as Out; const m = modelsOf(out);
  assert.equal(m.length, 8);
  for (const x of ["Highlander Hybrid", "Grand Highlander Hybrid", "Santa Fe", "Sorento Hybrid", "RX"]) assert.ok(m.includes(x), `${x} missing from ${m.join(", ")}`);
  assert.ok(countOf(m, "RX") <= 3, `RX ${countOf(m, "RX")} of 8`);
  assert.ok(!/Also matched but not shown/.test(textOf(out)), "nothing is hidden, so nothing to say");
});

test("a model that matched but is not shown is named with its lowest price, never reported as having no matches", opts, async () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];
  const out = (await call(11, { bodyType: "SUV", model: names.join(", "), electrificationTypes: ["hybrid"], electrificationRequirement: "required", priceMax: 70000, zip: "75201", priorityAxis: "best_for_budget" })) as Out;
  const m = modelsOf(out); const t = textOf(out);
  assert.equal(m.length, 8);
  const shown = new Set(m.map((x) => x.replace(" Hybrid", "")));
  const hidden = names.filter((n) => !shown.has(n));
  assert.equal(hidden.length, 1, `nine models, eight seats: one is not shown (${[...shown].join(", ")})`);
  assert.match(t, new RegExp(`Also matched but not shown above: ${hidden[0]} \\(from \\$[0-9,]+\\)\\. Ask to see more of these\\.`));
  assert.ok(!/returned no matches/i.test(t));
});

test("cheapest (strict): exactly the cheapest cars in order, no spreading across models", opts, async () => {
  const out = (await call(14, { ...DALLAS, priorityAxis: "cheapest" })) as Out; const m = modelsOf(out);
  assert.ok(m.every((x) => x === "Sorento Hybrid"), `got ${m.join(", ")}`);
});

test("one model: nothing changes and there is no note", opts, async () => {
  const out = (await call(12, { ...DALLAS, model: "Sorento" })) as Out;
  assert.ok(modelsOf(out).every((x) => x === "Sorento Hybrid"));
  assert.ok(!/Also matched but not shown/.test(textOf(out)));
});

test("no electrification request, three models: the models are covered too (the quota works without NHTSA)", opts, async () => {
  const { electrificationTypes: _a, electrificationRequirement: _b, ...plain } = DALLAS;
  const m = modelsOf((await call(13, { ...plain, model: "RX, Santa Fe, Sorento Hybrid" })) as Out);
  for (const x of ["RX", "Santa Fe", "Sorento Hybrid"]) assert.ok(m.includes(x), `${x} missing from ${m.join(", ")}`);
});
