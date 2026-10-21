// End-to-end through the real MCP route against a real PostgreSQL: trim rules R1 to R3 and R8 (SYS-20261021-004).
// Synthetic cars only; NHTSA is unavailable (404) so electrification stays unconfirmed. Skipped when TEST_DATABASE_URL is not set.
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

type C = { year: number; make: string; model: string; trim: string; price: number; body: string };
const CARS: C[] = [];
for (let i = 0; i < 320; i++) CARS.push({ year: 2022, make: "Honda", model: "Civic", trim: "LX", price: 15000 + i, body: "Sedan" }); // fills the first 300 rows
for (let i = 0; i < 2; i++) CARS.push({ year: 2020, make: "Honda", model: "Civic", trim: "Type R", price: 40000 + i, body: "Hatchback" }); // rare, older, dearer
for (let i = 0; i < 3; i++) CARS.push({ year: 2022, make: "Mercedes-Benz", model: "GLA-Class", trim: "GLA 250 4MATIC", price: 30000 + i, body: "SUV" });
for (let i = 0; i < 3; i++) CARS.push({ year: 2022, make: "Audi", model: "A4", trim: "2.0T Premium Plus quattro", price: 35000 + i, body: "Sedan" });
for (let i = 0; i < 3; i++) CARS.push({ year: 2025, make: "Honda", model: "CR-V", trim: "Sport-L Hybrid", price: 36000 + i, body: "SUV" });

const vin = (n: number) => `1HGCV1F3A${String(n).padStart(8, "0")}`;
function line(c: C, n: number): string {
  const id = `trk${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Honda Beverly",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: c.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
const trimsOf = (o: { result: { structuredContent: { results: Array<{ identity: { trim: string } }> } } }): string[] => o.result.structuredContent.results.map((c) => c.identity.trim);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("a rare required trim of a popular model is found (it is outside the first 300 rows of the model)", opts, async () => {
  const out = await call(10, { make: "Honda", model: "Civic", trimRequired: "Type R" });
  assert.deepEqual(trimsOf(out), ["Type R", "Type R"]);
  assert.ok(!/close trim match/.test(textOf(out)));
});

test("R2: a request for GLA 250 returns the 4MATIC cars, verified", opts, async () => {
  const out = await call(11, { make: "Mercedes-Benz", model: "GLA-Class", trimRequired: "GLA 250" });
  assert.equal(trimsOf(out).length, 3);
  assert.ok(trimsOf(out).every((t) => t === "GLA 250 4MATIC"));
  assert.ok(!/close trim match/.test(textOf(out)));
});

test("R8: no exact trim, so close matches are shown, labelled, and the trim check says relaxed", opts, async () => {
  const out = await call(12, { make: "Audi", model: "A4", trimRequired: "Premium Plus" });
  assert.deepEqual(trimsOf(out), ["2.0T Premium Plus quattro", "2.0T Premium Plus quattro", "2.0T Premium Plus quattro"]);
  assert.match(textOf(out), /No listing has the exact trim "Premium Plus"\. These are close trim matches: their trim includes those words \(2\.0T Premium Plus quattro\)\./);
  const sc = out.result.structuredContent;
  assert.equal(sc.results[0].searchConstraintStatus ?? sc.searchConstraintStatus, "relaxed");
});

test("R3: with a hybrid preferred, a trim request ignores the hybrid word; without it, the word stays significant", opts, async () => {
  const withHybrid = await call(13, { make: "Honda", model: "CR-V", trimRequired: "Sport-L", electrificationTypes: ["hybrid"], electrificationRequirement: "preferred" });
  assert.deepEqual(trimsOf(withHybrid), ["Sport-L Hybrid", "Sport-L Hybrid", "Sport-L Hybrid"]);
  assert.ok(!/close trim match/.test(textOf(withHybrid)), "exact under R3, not a close match");
  const without = await call(14, { make: "Honda", model: "CR-V", trimRequired: "Sport-L" });
  assert.match(textOf(without), /close trim match/); // no exact trim exists, so the labelled close tier applies
});

test("a trim nobody has: the no-match reply still lists the trims that exist (R7)", opts, async () => {
  const txt = textOf(await call(15, { make: "Honda", model: "Civic", trimRequired: "Nonexistent" }));
  assert.match(txt, /Trims we have for Honda Civic: .*LX \(320\).*Type R \(2\)/);
});

test("R5: a model name the database does not hold gets the list of model names it does hold", opts, async () => {
  const txt = textOf(await call(16, { make: "Honda", model: "Sivic" }));
  assert.match(txt, /Models we have for Honda: .*Civic \(322\).*CR-V \(3\).*If you meant one of these, ask for it by that exact name\./);
  assert.match(txt, /No Honda Sivic listings matched/);
});

test("R5: a model that exists gets no model list, and a model-less search gets none either", opts, async () => {
  assert.ok(!/Models we have for/.test(textOf(await call(17, { make: "Honda", model: "Civic", trimRequired: "Nonexistent" }))));
  assert.ok(!/Models we have for/.test(textOf(await call(18, { make: "Honda", priceMax: 1000 }))));
});
