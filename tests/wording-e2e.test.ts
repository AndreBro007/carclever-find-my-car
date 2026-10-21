// End-to-end through the real MCP route against a real PostgreSQL: the reply wording (SYS-20261021-018, T65).
// One closing line; the history sentence only when a used car is shown; no "catalog" word in any text the buyer or the AI reads; no per-car repeat of the trim sentence.
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

type C = { model: string; trim: string; year: number; price: number; cond: "new" | "used" };
const CARS: C[] = [];
for (let i = 0; i < 4; i++) CARS.push({ model: "CR-V", trim: "EX-L", year: 2026, price: 36000 + i, cond: "new" });
for (let i = 0; i < 4; i++) CARS.push({ model: "CR-V", trim: "LX", year: 2022, price: 22000 + i, cond: "used" });
for (let i = 0; i < 3; i++) CARS.push({ model: "Civic", trim: "Sport", year: 2025, price: 25000 + i, cond: "new" });
const vin = (n: number) => `2HKRS4H3${String(n).padStart(9, "0")}`;
function line(c: C, n: number): string {
  const id = `wrd${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} Honda ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: vin(n), year: c.year, make: "Honda", model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Honda",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin(n), vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: "Honda", vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: c.cond === "new" ? "5.00" : "40000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
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
const count = (t: string, s: string): number => t.split(s).length - 1;
const NO_CATALOG = /catalog/i;

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  resetNhtsaCacheForTests();
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("one closing line: availability, price and features; the history sentence only when a used car is shown", opts, async () => {
  const withUsed = textOf(await call(10, { make: "Honda", model: "CR-V", zip: "75201" }));
  assert.equal(count(withUsed, "Check each Edmunds listing, then contact the dealer to confirm availability, price, features and safety equipment."), 1);
  assert.match(withUsed, /For a used car, also ask for its history report \(accidents, owners\)\./);
  const newOnly = textOf(await call(11, { make: "Honda", model: "CR-V", used: false, zip: "75201" }));
  assert.equal(count(newOnly, "Check each Edmunds listing, then contact the dealer to confirm availability, price, features and safety equipment."), 1);
  assert.ok(!/history report/.test(newOnly), "a new car gets no history sentence");
});

test("the buyer's stated needs are echoed once, positively, inside the same closing line", opts, async () => {
  const t = textOf(await call(12, { make: "Honda", model: "CR-V", used: false, vehicleNeeds: ["family SUV"], zip: "75201" }));
  assert.match(t, /Also ask the dealer about: family SUV\./);
  assert.equal(count(t, "Check each Edmunds listing"), 1);
});

test("the old lines are gone: no 'Before you buy', no 'not in our data', no per-car trim sentence", opts, async () => {
  const t = textOf(await call(13, { make: "Honda", model: "CR-V", vehicleNeeds: ["family SUV"], zip: "75201" }));
  for (const gone of ["Before you buy", "not in our data", "Confirm which of these come with this trim"]) assert.ok(!t.includes(gone), gone);
});

test("no 'catalog' word in any reply the buyer or the AI reads: normal, no-match, broad, wrong model, thin trim", opts, async () => {
  const replies = [
    textOf(await call(20, { make: "Honda", model: "CR-V", zip: "75201" })),
    textOf(await call(21, { make: "Honda", model: "Zzzmodel", zip: "75201" })),
    textOf(await call(22, { bodyType: "SUV", vehicleType: "Midsize SUV", zip: "75201" })),
    textOf(await call(23, { make: "Honda", model: "Sivic", zip: "75201" })),
    textOf(await call(24, { make: "Honda", model: "CR-V", trimRequired: "Nonexistent", zip: "75201" })),
    textOf(await call(25, { make: "Honda", model: "CR-V", cylinders: 4, zip: "75201" })),
    textOf(await call(26, { make: "Honda", model: "Civic", used: true })),
    textOf(await call(27, { vin: "1HGCV1F39MZ999999" })),
  ];
  replies.forEach((t, i) => assert.ok(!NO_CATALOG.test(t), `reply ${i}: ${(t.match(/.{0,50}catalog.{0,50}/i) ?? [""])[0]}`));
});

test("no 'catalog' word in the published tool description or field texts", opts, async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
  for (const tool of res.result.tools) assert.ok(!NO_CATALOG.test(JSON.stringify(tool)), `${tool.name}: ${(JSON.stringify(tool).match(/.{0,50}catalog.{0,50}/i) ?? [""])[0]}`);
});

test("a no-result reply invites another try and makes no claim about the wider market", opts, async () => {
  const t = textOf(await call(31, { make: "Honda", model: "CR-V", priceMax: 1000, zip: "75201" }));
  assert.match(t, /Nothing was widened or substituted\. Listings change often, so try again soon or adjust the search\./);
  assert.ok(!/wider market/.test(t));
});

test("the pointer to the listing and the dealer is in ONE place of the tool text (rule 8), and the old 'does not establish' sentence is gone", opts, async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 40, method: "tools/list", params: {} });
  const d: string = res.result.tools.find((t: { name: string }) => t.name === "find_matching_vehicle").description;
  assert.equal(count(d, "send the buyer to the Edmunds listing and the dealer"), 1);
  assert.ok(!/does not establish/.test(d));
  assert.ok(!/point the buyer to the Edmunds listing and the dealer/.test(d), "rule 6 no longer repeats it");
});

test("a size or class label is not echoed as something to ask the dealer; a practical need still is", opts, async () => {
  const sizeOnly = textOf(await call(41, { make: "Honda", model: "CR-V", used: false, vehicleNeeds: ["midsize SUV"], zip: "75201" }));
  assert.ok(!/Also ask the dealer about/.test(sizeOnly));
  assert.equal(count(sizeOnly, "Check each Edmunds listing"), 1);
  const practical = textOf(await call(42, { make: "Honda", model: "CR-V", used: false, vehicleNeeds: ["midsize SUV", "towing 3,000 lbs"], zip: "75201" }));
  assert.match(practical, /Also ask the dealer about: towing 3,000 lbs\./);
  assert.ok(!/ask the dealer about: .*midsize/.test(practical));
});

test("'out of N in the area' is said only when nothing narrows the cars afterwards (a required trim does)", opts, async () => {
  const plain = textOf(await call(43, { make: "Honda", model: "CR-V", zip: "75201" }));
  assert.match(plain, /Found \d+ closely matching vehicles? out of \d+ in the area:/);
  const trim = textOf(await call(44, { make: "Honda", model: "CR-V", trimRequired: "EX-L", zip: "75201" }));
  assert.match(trim, /Found \d+ closely matching vehicles?:/);
  assert.ok(!/in the area:/.test(trim));
});
