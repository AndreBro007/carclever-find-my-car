// End-to-end for the 19 Oct code review fixes (findings 3 to 7), against the REAL MCP route and a real PostgreSQL loaded with synthetic cars.
// Skipped when TEST_DATABASE_URL is not set. No real partner data. NHTSA is stubbed (never the real service).
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

const DEALERS: Record<number, [string, string, string, string]> = { 1: ["Test Honda Beverly", "Beverly Hills", "CA", "90210"], 2: ["Test Auto LA", "Los Angeles", "CA", "90001"], 3: ["Test Auto Dallas", "Dallas", "TX", "75201"] };
const vinFor = (n: number) => `1HGCV1F3${String(n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
type C = { n: number; year: number; make: string; model: string; trim: string; cond: "new" | "used"; price: number; odo: number; body: string; dealer: number; override?: boolean };
const CARS: C[] = [];
let n = 0;
// 6 cheap older Civics, 6 dear newer low-mileage RAV4s (the mixed-model pool of review finding 4), all in California
for (let i = 0; i < 6; i++) CARS.push({ n: ++n, year: 2015 + i, make: "Honda", model: "Civic", trim: "LX", cond: "used", price: 5000 + i * 1000, odo: 90000 - i * 5000, body: "Sedan", dealer: 1 + (i % 2) });
for (let i = 0; i < 6; i++) CARS.push({ n: ++n, year: 2023 + (i % 4), make: "Toyota", model: "RAV4", trim: "LE", cond: "used", price: 30000 + i * 1000, odo: 100 + i * 50, body: "SUV", dealer: 1 + (i % 2) });
const OVERRIDE_N = ++n; CARS.push({ n: OVERRIDE_N, year: 2022, make: "Mazda", model: "CX-5", trim: "Sport", cond: "used", price: 24000, odo: 20000, body: "SUV", dealer: 1, override: true });
const PLAIN_N = ++n; CARS.push({ n: PLAIN_N, year: 2021, make: "Subaru", model: "Outback", trim: "Base", cond: "used", price: 23000, odo: 25000, body: "Wagon", dealer: 2 });
const idFor = (c: C) => `rf${String(c.n).padStart(30, "0")}`;
function line(c: C): string {
  const d = DEALERS[c.dealer]; const vin = vinFor(c.n); const id = idFor(c);
  const track = buildTrackingUrl({ id, vin, year: c.year, make: c.make, model: c.model });
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${c.n}.jpg`,
    link: c.override ? track + "&custom=exception" : track, availability: "InStock", identifier_exists: "no", dealer_id: String(c.dealer), dealer_name: d[0], dealer_street: "1 Test St",
    dealer_city: d[1], dealer_state: d[2], dealer_zip: d[3], dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: c.make, vehicle_model: c.model,
    vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: c.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); for (const c of CARS) yield line(c); }

let pool: Pool;
let decodeMode: "off" | "late" = "off"; const decodeCalls = new Map<string, number>();
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
let rid = 100;
const tool = (name: string, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } });
const find = (args: Record<string, unknown>) => tool("find_matching_vehicle", args);
const textOf = (out: { result: { content: Array<{ text?: string }> } }) => out.result.content.map((c) => c.text ?? "").join("\n");

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    if (s.includes("api.auto.dev")) throw new Error("AUTO.DEV MUST NOT BE CALLED");
    const m = s.match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (m && decodeMode === "late") {
      // review finding 3: the first read of every VIN fails, the second succeeds and shows FWD (odd VIN) or AWD (even VIN)
      const vin = m[1].toUpperCase(); const k = (decodeCalls.get(vin) ?? 0) + 1; decodeCalls.set(vin, k);
      if (k === 1) throw new Error("timeout");
      const awd = Number(vin.slice(-1)) % 2 === 0;
      return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Civic", ModelYear: "2020", DriveType: awd ? "AWD/All-Wheel Drive" : "FWD/Front-Wheel Drive", FuelTypePrimary: "Gasoline", EngineCylinders: "4" }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines(), { minRows: 1 });
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("finding 4: cheapest, newest and lowest mileage are strict across several models", opts, async () => {
  const get = async (axis: string) => (await find({ model: "Civic, RAV4", used: true, priorityAxis: axis, zip: "90210" })).result.structuredContent.results as Array<{ listing: { price: number; mileage: number }; identity: { year: number; model: string } }>;
  const cheap = await get("cheapest"); const prices = cheap.map((c) => c.listing.price);
  assert.ok(cheap.length >= 4);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "ascending price");
  assert.deepEqual(prices.slice(0, 6), [5000, 6000, 7000, 8000, 9000, 10000], "the six globally cheapest cars come first, none left out for variety");
  assert.ok(prices.slice(6).every((p) => p > 10000), "the remaining shortlist places are priced above the six cheapest");
  assert.ok(cheap.slice(0, 6).every((c) => c.identity.model === "Civic"), "the six cheapest are Civics: no RAV4 slipped in ahead of a cheaper Civic");
  const newest = (await get("newest")).map((c) => c.identity.year);
  assert.deepEqual(newest, [...newest].sort((a, b) => b - a), "newest first");
  assert.equal(newest[0], 2026);
  const low = (await get("lowest_mileage")).map((c) => c.listing.mileage);
  assert.deepEqual(low, [...low].sort((a, b) => a - b), "lowest mileage first");
  assert.ok(low[0] <= 150);
});

test("finding 5: a five-digit ZIP that is not in the ZIP table is reported as nationwide, on both search paths", opts, async () => {
  for (const args of [{ model: "Civic", used: true, zip: "00123" }, { model: "Civic", zip: "00123" }]) {
    const sc = (await find(args)).result.structuredContent;
    assert.equal(sc.meta.scopeNote, "nationwide", JSON.stringify(args));
    assert.ok(sc.meta.dataNotes.some((x: string) => /wasn't recognized/.test(x)), "says the location was not recognised");
  }
  const ok = (await find({ model: "Civic", used: true, zip: "90210" })).result.structuredContent;
  assert.equal(ok.meta.scopeNote, "local", "a real ZIP is still local");
});

test("finding 6: the link tool gives a listed VIN the same link as its card, even when the caller supplies the wrong model and year", opts, async () => {
  for (const [n, model] of [[OVERRIDE_N, "CX-5"], [PLAIN_N, "Outback"]] as Array<[number, string]>) {
    const card = (await find({ model, zip: "90210" })).result.structuredContent.results.find((r: { identity: { vin: string } }) => r.identity.vin === vinFor(n));
    assert.ok(card, "the card is found");
    const out = await tool("get_edmunds_vehicle_link", { vin: vinFor(n), make: "Wrong", model: "Abbreviated", year: 1999 });
    assert.equal(textOf(out).trim(), card.links.affiliateUrl, "same destination as the card");
  }
  const card = (await find({ model: "CX-5", zip: "90210" })).result.structuredContent.results.find((r: { identity: { vin: string } }) => r.identity.vin === vinFor(OVERRIDE_N));
  assert.ok(/custom(=|%3D)exception/.test(card.links.affiliateUrl), "the feed's exceptional link is kept");
  // a VIN the catalogue does not list still falls back to the caller's details
  const unlisted = textOf(await tool("get_edmunds_vehicle_link", { vin: "2HKRM4H58EH656914", make: "Honda", model: "CR-V", year: 2014 }));
  assert.match(unlisted, /edmunds\.sjv\.io/);
});

test("finding 7: a database failure is a retryable service message, never 'not listed'", opts, async () => {
  const broken = { query: async () => { throw new Error("connection terminated"); }, end: async () => {} } as unknown as Pool;
  setCatalogDbPoolForTests(broken);
  try {
    const f = await find({ vin: vinFor(1) });
    assert.equal(f.result.structuredContent.meta.scopeNote, "vin_lookup");
    assert.match(String(f.result.structuredContent.meta.serviceError), /coffee break/);
    assert.ok(!/No listing found|not listed/i.test(textOf(f)), textOf(f));
    const c = textOf(await tool("check_vehicle", { vin: "1C4RJFBG3KC123456" })); // fails its check digit, but the lookup failed: no "Invalid VIN" claim either
    assert.match(c, /coffee break/); assert.ok(!/No listing found|not currently listed|Invalid VIN/i.test(c), c);
    const cmp = textOf(await tool("compare_vehicles", { vins: [vinFor(1), vinFor(2)] }));
    assert.match(cmp, /coffee break/); assert.ok(!/Not found|nothing to compare/i.test(cmp), cmp);
  } finally { setCatalogDbPoolForTests(pool); }
  // with the database back, genuine absence is still reported as absence
  assert.match(textOf(await find({ vin: "2HKRM4H58EH656914" })), /No listing found/);
  assert.match(textOf(await tool("check_vehicle", { vin: "1C4RJFBG3KC123456" })), /Invalid VIN/);
  assert.match(textOf(await tool("compare_vehicles", { vins: [vinFor(1), "2HKRM4H58EH656914"] })), /Only 1 of the 2 VINs/);
});

test("finding 3: a drivetrain shown only by the later read is honoured: opposite-drive cars are removed, the note and the order agree", opts, async () => {
  decodeMode = "late"; decodeCalls.clear();
  try {
    const out = await find({ model: "Civic", drivetrain: "AWD", used: true, zip: "90210" });
    const sc = out.result.structuredContent; const rs = sc.results as Array<{ identity: { vin: string }; powertrain: { drivetrain: string | null } }>;
    assert.ok(rs.length >= 1, "some cars remain");
    for (const r of rs) assert.notEqual(String(r.powertrain.drivetrain).toUpperCase(), "FWD", `a front-wheel-drive car was shown: ${r.identity.vin}`);
    const t = textOf(out);
    assert.ok(!/Front-Wheel|FWD/.test(t.split("\n").filter((l: string) => /Drivetrain|Confirmed/.test(l)).join(" ")) , "no line presents a front-wheel-drive car as a match");
    assert.match(t, /Cars the VIN decode shows with a different drivetrain were left out/);
    const flags = rs.map((r) => !!r.powertrain.drivetrain);
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)), "confirmed cars are listed first");
  } finally { decodeMode = "off"; }
});
