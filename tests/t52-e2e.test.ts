// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed per test (T52 and T60, SYS-20261021-003, -011, -012).
// Batches of 8; early stop; unconfirmed cars kept and marked; cars shown as another type left out; outage costs one batch; a hybrid-named model that is corrected to its
// base model keeps the hybrid requirement. Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
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

type C = { make: string; model: string; trim: string; year: number; price: number; vin: string };
const CARS: C[] = [];
const toyotaVin = (n: number) => `4T1DAC1K${String(n).padStart(9, "0")}`;
const hondaVin = (n: number) => `1HGCV1F3A${String(n).padStart(8, "0")}`;
for (let n = 1; n <= 40; n++) CARS.push({ make: "Toyota", model: "RAV4 Hybrid", trim: "XLE", year: 2025, price: 30000 + n, vin: toyotaVin(n) });
for (let n = 1; n <= 30; n++) CARS.push({ make: "Honda", model: "Accord", trim: "LX", year: 2024, price: 25000 + n, vin: hondaVin(n) });
for (let n = 31; n <= 33; n++) CARS.push({ make: "Honda", model: "Accord", trim: "Sport Hybrid", year: 2024, price: 29000 + n, vin: hondaVin(n) });

function line(c: C, n: number): string {
  const id = `t52${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
let calls = 0;
let behave: (vin: string) => "hybrid" | "gas" | "fail" = () => "hybrid";
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
type Out = { result: { content: Array<{ text?: string }>; structuredContent: { results: Array<{ identity: { model: string; trim: string }; constraintChecks: Array<{ field: string; status: string }> }> } } };
const textOf = (o: Out): string => o.result.content.map((c) => c.text ?? "").join("\n");
const countOf = (t: string, s: string): number => t.split(s).length - 1;

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    calls++;
    const k = behave(m[1].toUpperCase());
    if (k === "fail") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: k === "hybrid" ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: k === "hybrid" ? "Electric" : "" }] }), { status: 200 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
beforeEach(() => { calls = 0; resetNhtsaCacheForTests(); behave = () => "hybrid"; });
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const REQ = { make: "Toyota", model: "RAV4", electrificationTypes: ["hybrid"], electrificationRequirement: "required", priorityAxis: "cheapest" };
const MARK = "Hybrid not confirmed by NHTSA: ask the dealer.";

test("normal: 8 confirmed cars, 8 NHTSA calls (not 45), nothing marked", opts, async () => {
  const out = (await call(10, REQ)) as Out;
  assert.equal(out.result.structuredContent.results.length, 8);
  assert.equal(calls, 8);
  const t = textOf(out);
  assert.equal(countOf(t, MARK), 0); assert.ok(!/could not be confirmed/.test(t)); assert.ok(!/left out/.test(t));
  assert.ok(out.result.structuredContent.results.every((r) => r.constraintChecks.some((c) => c.field === "electrification" && c.status === "verified")));
});

test("cars NHTSA gives no answer for are KEPT and marked, after the confirmed ones; two batches, then the breaker", opts, async () => {
  const keep = new Set([1, 2, 3, 4, 5].map(toyotaVin));
  behave = (v) => (keep.has(v) ? "hybrid" : "fail");
  const out = (await call(11, REQ)) as Out; const t = textOf(out);
  assert.equal(out.result.structuredContent.results.length, 8);
  assert.equal(countOf(t, MARK), 3);
  // The second batch got no answer at all, so the breaker opened: the note says the SERVICE did not answer (review F2, 22 Oct 2026).
  assert.match(t, /NHTSA's VIN service did not answer, so 3 of these could not be confirmed as hybrid and are marked on each listing; ask the dealer to confirm, or try again shortly\./);
  const checks = out.result.structuredContent.results.map((r) => r.constraintChecks.find((c) => c.field === "electrification")?.status);
  assert.equal(checks.filter((x) => x === "verified").length, 5); assert.equal(checks.filter((x) => x === "unknown").length, 3);
  assert.equal(calls, 16, "batch one, batch two (all failed, so the breaker stops it); the cards asked the cache only");
});

test("outage: all 8 of the first batch fail, so one batch only; the 8 cars are shown marked instead of nothing", opts, async () => {
  behave = () => "fail";
  const t0 = Date.now(); const out = await call(12, REQ); const ms = Date.now() - t0; const t = textOf(out);
  assert.equal(out.result.structuredContent.results.length, 8);
  assert.equal(calls, 8, "one batch, and the cards did not ask again");
  assert.equal(countOf(t, MARK), 8);
  assert.match(t, /NHTSA's VIN service did not answer, so 8 of these could not be confirmed as hybrid/);
  assert.ok(ms < 5000);
});

test("some cars get no answer but no whole batch fails: the breaker stays closed and the note keeps the per-car wording", opts, async () => {
  const answer = new Set([1, 9, 17].map(toyotaVin)); // one car answers in each of the three batches of 8
  behave = (v) => (answer.has(v) ? "hybrid" : "fail");
  const out = (await call(17, REQ)) as Out; const t = textOf(out);
  assert.equal(out.result.structuredContent.results.length, 8);
  assert.match(t, /5 of these could not be confirmed as hybrid by NHTSA and are marked on each listing; ask the dealer to confirm\./);
  assert.ok(!/VIN service did not answer/.test(t), "a few missing answers are not an outage");
});

test("cars NHTSA shows as another type are left out, and the reply says so", opts, async () => {
  const wrong = new Set([1, 2, 3, 4].map(toyotaVin));
  behave = (v) => (wrong.has(v) ? "gas" : "hybrid");
  const out = await call(13, REQ); const t = textOf(out);
  assert.equal(out.result.structuredContent.results.length, 8);
  assert.match(t, /Cars that NHTSA shows as a different type than hybrid were left out\./);
  assert.equal(countOf(t, MARK), 0);
});

test("preferred: same batches, nothing excluded, 8 calls", opts, async () => {
  const out = await call(14, { ...REQ, electrificationRequirement: "preferred" });
  assert.equal(out.result.structuredContent.results.length, 8); assert.equal(calls, 8);
});

test("T60: a hybrid-named model corrected to its base model keeps the hybrid requirement", opts, async () => {
  behave = (v) => (new Set([31, 32, 33].map(hondaVin)).has(v) ? "hybrid" : "gas");
  const out = (await call(15, { make: "Honda", model: "Accord Hybrid" })) as Out; const t = textOf(out);
  const cars = out.result.structuredContent.results.map((r) => `${r.identity.model}|${r.identity.trim}`);
  assert.deepEqual(cars, ["Accord|Sport Hybrid", "Accord|Sport Hybrid", "Accord|Sport Hybrid"]);
  assert.match(t, /isn't a recognized model name in current inventory/);
  assert.match(t, /Kept hybrid as a requirement\./);
  assert.match(t, /Only 3 of the results matched your electric or hybrid requirement\./);
});

test("T60: a name without electrification wording that is corrected adds no requirement", opts, async () => {
  const out = await call(16, { make: "Honda", model: "Accord LX Special" }); const t = textOf(out);
  assert.ok(!/Kept .* as a requirement/.test(t));
});
