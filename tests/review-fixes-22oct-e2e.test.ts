// End-to-end through the real MCP route against a real PostgreSQL, NHTSA stubbed per VIN (review of the 22 Oct 2026 golden-master run).
// F1: a broad electric search must reach battery-electric cars that sit behind 400 newer gasoline cars in the ordinary ranking, and must not spend its pool on hybrids.
// Wording rule: an unconfirmed car whose own name shows another type is left out. F2: the reply says when the NHTSA SERVICE did not answer, and one log line counts the failures.
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

type C = { make: string; model: string; trim: string; year: number; price: number; vin: string; kind: "bev" | "hybrid" | "gas" };
const CARS: C[] = [];
const vin = (prefix: string, n: number) => `${prefix}${String(n).padStart(17 - prefix.length, "0")}`;
// 400 newer gasoline cars in the top quarter of a $50,000 budget: the ordinary ranking (newest first) puts all of them in front of everything below.
for (let n = 1; n <= 400; n++) CARS.push({ make: "Honda", model: "Accord", trim: "LX", year: 2025, price: 46000 + (n % 50), vin: vin("1HGCV", n), kind: "gas" });
// Real battery-electric cars, older, in the same price band, with NO electric wording in the model name.
for (let n = 1; n <= 6; n++) CARS.push({ make: "Tesla", model: "Model Y", trim: "Long Range", year: 2022, price: 45000 + n, vin: vin("5YJYG", n), kind: "bev" });
for (let n = 1; n <= 4; n++) CARS.push({ make: "Ford", model: "Mustang Mach-E", trim: "Premium", year: 2022, price: 44000 + n, vin: vin("3FMTK", n), kind: "bev" });
for (let n = 1; n <= 2; n++) CARS.push({ make: "BMW", model: "iX", trim: "xDrive50", year: 2022, price: 49000 + n, vin: vin("WB523", n), kind: "bev" });
// Hybrids, also older and buried by the ordinary ranking, with hybrid wording in the model name.
for (let n = 1; n <= 40; n++) CARS.push({ make: "Toyota", model: "Highlander Hybrid", trim: "XLE", year: 2022, price: 45000 + n, vin: vin("5TDHB", n), kind: "hybrid" });
// A Toyota-only block for the wording rule: three battery-electric bZ4X, two Grand Highlander Hybrids and two plain Camrys that NHTSA will not answer for.
for (let n = 1; n <= 3; n++) CARS.push({ make: "Subaru", model: "Solterra", trim: "Premium", year: 2024, price: 30000 + n, vin: vin("JTMAB", n), kind: "bev" });
for (let n = 1; n <= 2; n++) CARS.push({ make: "Subaru", model: "Grand Outback Hybrid", trim: "XLE", year: 2024, price: 31000 + n, vin: vin("JF2GH", n), kind: "hybrid" });
for (let n = 1; n <= 2; n++) CARS.push({ make: "Subaru", model: "Legacy", trim: "SE", year: 2024, price: 32000 + n, vin: vin("4S3BN", n), kind: "gas" });

function line(c: C, n: number): string {
  const id = `r22${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Beverly Hills", dealer_state: "CA", dealer_zip: "90210", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: "30000.00", vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
let calls = 0;
const kindOf = new Map(CARS.map((c) => [c.vin, c.kind]));
let failing: (vin: string) => boolean = () => false;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
type Out = { result: { content: Array<{ text?: string }>; structuredContent: { results: Array<{ identity: { make: string; model: string; vin: string }; constraintChecks: Array<{ field: string; status: string }> }> } } };
const textOf = (o: Out): string => o.result.content.map((c) => c.text ?? "").join("\n");
const models = (o: Out): string[] => o.result.structuredContent.results.map((r) => `${r.identity.make} ${r.identity.model}`);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    calls++;
    const v = m[1].toUpperCase();
    if (failing(v)) return new Response("busy", { status: 503 });
    const k = kindOf.get(v) ?? "gas";
    const level = k === "bev" ? "BEV (Battery Electric Vehicle)" : k === "hybrid" ? "Strong Hybrid (SHEV)" : "";
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: level, FuelTypePrimary: k === "bev" ? "Electric" : "Gasoline", FuelTypeSecondary: k === "hybrid" ? "Electric" : "", DriveType: "" }] }), { status: 200 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
beforeEach(() => { calls = 0; resetNhtsaCacheForTests(); failing = () => false; });
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("F1: a broad electric search finds the battery-electric cars buried behind 400 newer gasoline cars, and shows no hybrid", opts, async () => {
  const out = (await call(20, { electrificationTypes: ["electric"], electrificationRequirement: "required", priceMax: 50000 })) as Out;
  const found = models(out);
  assert.equal(found.length, 8, `eight cars, got ${found.join(", ")}`);
  assert.ok(found.every((m) => /Tesla Model Y|Ford Mustang Mach-E|BMW iX/.test(m)), `only battery-electric cars: ${found.join(", ")}`);
  assert.ok(!/Hybrid|Accord/.test(textOf(out).split("Found")[1] ?? ""), "no hybrid and no gasoline car in the list");
  assert.ok(out.result.structuredContent.results.every((r) => r.constraintChecks.some((c) => c.field === "electrification" && c.status === "verified")));
  assert.ok(calls <= 16, `the first batch of 8 is enough when the pool is ranked towards electric: ${calls} NHTSA calls`);
});

test("F1: a broad hybrid search finds the hybrids buried behind the same gasoline cars, and shows no battery-electric car", opts, async () => {
  const out = (await call(21, { electrificationTypes: ["hybrid"], electrificationRequirement: "required", priceMax: 50000 })) as Out;
  const found = models(out);
  assert.equal(found.length, 8, found.join(", "));
  assert.ok(found.every((m) => m === "Toyota Highlander Hybrid"), found.join(", "));
  assert.ok(calls <= 16, `${calls} NHTSA calls`);
});

test("F1: an electric search that names a make is unchanged: that make's battery-electric cars", opts, async () => {
  const out = (await call(22, { make: "Tesla", electrificationTypes: ["electric"], electrificationRequirement: "required" })) as Out;
  assert.deepEqual([...new Set(models(out))], ["Tesla Model Y"]);
  assert.equal(models(out).length, 6);
});

test("wording rule: an unconfirmed car named as another type is left out and said so; an unnamed unconfirmed car is kept and marked", opts, async () => {
  const noAnswer = new Set(CARS.filter((c) => c.make === "Subaru" && (c.kind !== "bev")).map((c) => c.vin));
  failing = (v) => noAnswer.has(v);
  const out = (await call(23, { make: "Subaru", electrificationTypes: ["electric"], electrificationRequirement: "required" })) as Out;
  const t = textOf(out); const found = models(out);
  assert.equal(found.filter((m) => m === "Subaru Solterra").length, 3);
  assert.equal(found.filter((m) => m === "Subaru Legacy").length, 2, "unnamed cars NHTSA could not check are kept");
  assert.ok(!found.includes("Subaru Grand Outback Hybrid"), "a car named Hybrid is not offered under an electric requirement");
  assert.match(t, /Cars whose name shows another type than electric were left out because NHTSA could not check them: Grand Outback Hybrid\./);
  assert.match(t, /2 of these could not be confirmed as electric/);
});

test("F2: when the NHTSA service does not answer, the reply says so, and ONE log line counts the failures by class without a VIN", opts, async () => {
  failing = () => true;
  const warned: string[] = []; const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  let out: Out;
  try { out = (await call(24, { make: "Tesla", electrificationTypes: ["electric"], electrificationRequirement: "required" })) as Out; } finally { console.warn = orig; }
  const t = textOf(out);
  assert.match(t, /NHTSA's VIN service did not answer, so 6 of these could not be confirmed as electric and are marked on each listing; ask the dealer to confirm, or try again shortly\./);
  const lineOf = warned.filter((w) => w.startsWith("[nhtsa-failures]"));
  assert.equal(lineOf.length, 1, "exactly one line per search");
  assert.equal(lineOf[0], '[nhtsa-failures] {"http_503":6} breaker=open');
  assert.ok(!/5YJ/.test(lineOf[0]), "no VIN in the log");
});

test("F2: a healthy search writes no failure line", opts, async () => {
  const warned: string[] = []; const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  try { await call(25, { make: "Tesla", electrificationTypes: ["electric"], electrificationRequirement: "required" }); } finally { console.warn = orig; }
  assert.equal(warned.filter((w) => w.startsWith("[nhtsa-failures]")).length, 0);
});

test("F2: a preferred (ranking only) search says when NHTSA did not answer", opts, async () => {
  failing = () => true;
  const orig = console.warn; console.warn = () => {};
  let out: Out;
  try { out = (await call(26, { make: "Tesla", electrificationTypes: ["electric"], electrificationRequirement: "preferred" })) as Out; } finally { console.warn = orig; }
  assert.match(textOf(out), /NHTSA's VIN service did not answer, so your electric preference could not be used to order these results/);
});
