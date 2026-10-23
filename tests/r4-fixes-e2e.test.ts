// Round 4 review fixes (23 Oct 2026) through the real route on a real PostgreSQL: R4-03 strict objectives, R4-06 flagged price in a comparison, R4-01 the request guard.
// Synthetic cars only. Skipped without TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
const DB = process.env.TEST_DATABASE_URL;
process.env.LISTING_SOURCE = "catalog_db"; process.env.DATABASE_URL = DB ?? "postgres://unused"; process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { setCatalogDbPoolForTests, resetStockPhotoCacheForTests } from "../lib/catalog-db-source";
import { resetNhtsaCacheForTests } from "../lib/nhtsa-client";

type C = { vin: string; make: string; model: string; year: number; price: number; odo: number; cond: "new" | "used" };
let CARS: C[] = [];
const line = (c: C, n: number): string => { const id = `r4${String(n).padStart(29, "0")}`; const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: "", link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer", dealer_street: "1 Test St", dealer_city: "Houston", dealer_state: "TX", dealer_zip: "77002", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: c.make, vehicle_model: c.model, vehicle_series: "Base", vehicle_odometer: `${c.odo}.00`, vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" }; return FEED_COLUMNS.map((k) => v[k]).join("\t"); };
async function* lines() { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }
let pool: Pool; const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const post = async (body: string) => { const { POST } = await import("../app/[transport]/route"); return POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body })); };
async function rpc(body: unknown) { const r = await post(JSON.stringify(body)); const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t); }
const call = (id: number, name: string, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const evVins = new Set<string>();
async function load(cars: C[]) { CARS = cars; await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE"); await loadFeed(pool, lines()); setCatalogDbPoolForTests(pool); resetStockPhotoCacheForTests(); resetNhtsaCacheForTests(); }
before(async () => {
  globalThis.fetch = (async (u: string | URL) => { const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (m) { const bev = evVins.has(m[1].toUpperCase()); return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", ElectrificationLevel: bev ? "BEV (Battery Electric Vehicle)" : "", FuelTypePrimary: bev ? "Electric" : "Gasoline", FuelTypeSecondary: "", DriveType: "" }] }), { status: 200 }); }
    return new Response("{}", { status: 404 }); }) as typeof fetch;
  if (DB) pool = new Pool({ connectionString: DB, max: 2 });
});
after(async () => { if (DB) { setCatalogDbPoolForTests(null); await pool.end(); } });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

// ---- R4-03 ----
const niroVins = Array.from({ length: 8 }, (_, i) => `KNDCR${String(i + 1).padStart(12, "0")}`);
async function loadNiroFixture() {
  evVins.clear(); const cars: C[] = [];
  niroVins.forEach((v, i) => { evVins.add(v); cars.push({ vin: v, make: "Kia", model: "Niro EV", year: 2026, price: 20001 + i, odo: 101 + i, cond: "used" }); });
  ([["Tesla", "Model Y"], ["Ford", "Mustang Mach-E"], ["Volkswagen", "ID.4"], ["Hyundai", "IONIQ 5"], ["Chevrolet", "Blazer EV"], ["Chevrolet", "Equinox EV"], ["Cadillac", "LYRIQ"]] as const).forEach(([mk, md], i) => { const v = `7SAYG${String(i + 1).padStart(12, "0")}`; evVins.add(v); cars.push({ vin: v, make: mk, model: md, year: 2025, price: 30001 + i, odo: 10001 + i, cond: "used" }); });
  await load(cars);
}
const vinsOf = (o: any): string[] => o.result.structuredContent.results.map((r: any) => r.identity.vin);
for (const axis of ["cheapest", "newest", "lowest_mileage"]) {
  test(`R4-03: a broad required-electric search with the strict objective '${axis}' returns the 8 cars that objective ranks first (not one car per model)`, opts, async () => {
    await loadNiroFixture();
    const got = vinsOf(await call(10, "find_matching_vehicle", { electrificationTypes: ["electric"], electrificationRequirement: "required", priorityAxis: axis }));
    assert.deepEqual([...got].sort(), [...niroVins].sort(), `${axis}: ${got.join(",")}`);
  });
}
test("R4-03: the default objective keeps the F8 variety (several models), and a named model is unaffected", opts, async () => {
  await loadNiroFixture();
  const o: any = await call(11, "find_matching_vehicle", { electrificationTypes: ["electric"], electrificationRequirement: "required", priceMax: 40000 });
  const models = new Set(o.result.structuredContent.results.map((r: any) => r.identity.model)); assert.ok(models.size >= 4, [...models].join(", "));
  const named = vinsOf(await call(12, "find_matching_vehicle", { make: "Kia", model: "Niro EV", electrificationTypes: ["electric"], electrificationRequirement: "required", priorityAxis: "cheapest" }));
  assert.deepEqual([...named].sort(), [...niroVins].sort());
});

// ---- R4-06 ----
test("R4-06: comparing a $35,000 car with a $85 car whose price is flagged: the warning is in the text and the $85 is not the best price", opts, async () => {
  evVins.clear();
  await load([{ vin: "1FTEW1EP0TFA00001", make: "Ford", model: "Maverick", year: 2027, price: 35000, odo: 5, cond: "new" }, { vin: "1FTEW1EP0TFA00002", make: "Ford", model: "Maverick", year: 2027, price: 85, odo: 5, cond: "new" }]);
  const o: any = await call(20, "compare_vehicles", { vins: ["1FTEW1EP0TFA00001", "1FTEW1EP0TFA00002"] });
  const t: string = o.result.content.map((c: any) => c.text ?? "").join("\n");
  assert.match(t, /\$85 ⚠️ price looks like a data error, verify before trusting it/);
  assert.ok(!/\*\*\$85\*\*/.test(t), "the $85 is not in bold (best)"); assert.ok(!/\*\*\$35,000\*\*/.test(t), "and with only one counted price nothing is marked best");
  assert.match(t, /#2 looks like a data error and is not counted/);
});

// ---- R4-01 ----
test("R4-01: a body over 64 KB is refused with 413 at once, and a 2.9 MB request with 1.5 million wrong-typed elements no longer costs 15 s and 1.5 GB", opts, async () => {
  const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_matching_vehicle","arguments":{"vehicleNeeds":[${new Array(1_500_000).fill("1").join(",")}]}}}`;
  const before = process.memoryUsage().rss, t = Date.now();
  const r = await post(body);
  assert.equal(r.status, 413); const j: any = await r.json(); assert.equal(j.error.code, -32600); assert.match(j.error.message, /Request too large/);
  assert.ok(Date.now() - t < 2000, `refused in ${Date.now() - t} ms`); assert.ok(process.memoryUsage().rss - before < 150 * 1024 * 1024, "no large allocation");
});
test("R4-01: a small request with too many values never reaches the validator: 400 with a reason, keeping the caller's id", opts, async () => {
  const r = await post(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { vehicleNeeds: new Array(5000).fill(1) } } }));
  assert.equal(r.status, 400); const j: any = await r.json(); assert.equal(j.id, 77); assert.equal(j.error.code, -32602); assert.match(j.error.message, /list of more than 200 items/);
  const b = await post(JSON.stringify(new Array(21).fill({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_matching_vehicle", arguments: {} } })));
  assert.equal(b.status, 400); assert.match(((await b.json()) as any).error.message, /more than 20 messages/);
});
test("R4-01: ordinary requests are unaffected: initialize, tools/list and a real search", opts, async () => {
  evVins.clear(); await load([{ vin: "1FTEW1EP0TFA00001", make: "Ford", model: "Maverick", year: 2027, price: 35000, odo: 5, cond: "new" }]);
  const init: any = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }); assert.ok(init.result.serverInfo);
  const list: any = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }); assert.equal(list.result.tools.length, 4);
  const s: any = await call(3, "find_matching_vehicle", { make: "Ford", model: "Maverick", vehicleNeeds: ["commuter car", "work truck"], electrificationTypes: ["hybrid", "plug_in_hybrid"] });
  assert.ok(s.result.structuredContent.results.length >= 0 && !s.error);
});
