// End-to-end: the real MCP route with the real wiring (per-request context, tool instrumentation, listen counter) against a real PostgreSQL with synthetic cars.
// Proves: events are written for the TEST host only, hold only the allowed fields, never alter a tool answer, and the live host writes nothing. Skipped when TEST_DATABASE_URL is not set. NO real partner data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
process.env.LISTING_SOURCE = "catalog_db";
process.env.DATABASE_URL = DB ?? "postgres://unused";
process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";
delete process.env.USAGE_EVENTS_ENABLED;

import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { setCatalogDbPoolForTests } from "../lib/catalog-db-source";
import { flushUsageForTests } from "../lib/usage-events";
import { assertDisposableDatabase } from "./helpers/disposable-db";

const TEST_HOST = "carclever-db-test.getcarwise.app"; const LIVE_HOST = "carclever-db.getcarwise.app";
const DEALER = ["Test Honda Beverly", "Beverly Hills", "CA", "90210"];
const vinFor = (n: number) => `1HGCV1F3${String(n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
const CARS = [{ n: 1, year: 2022, trim: "EX-L", price: 24000, odo: 32000 }, { n: 2, year: 2023, trim: "Sport", price: 22500, odo: 28000 }, { n: 3, year: 2021, trim: "LX", price: 19000, odo: 51000 }];
function line(c: typeof CARS[number]): string {
  const vin = vinFor(c.n); const id = `e2e${String(c.n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} Honda Civic`, condition: "used", description: "d", price: c.price.toFixed(2), image_link: "https://img.example.test/a.jpg",
    link: buildTrackingUrl({ id, vin, year: c.year, make: "Honda", model: "Civic" }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: DEALER[0],
    dealer_city: DEALER[1], dealer_state: DEALER[2], dealer_zip: DEALER[3], dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: "Honda", vehicle_model: "Civic",
    vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: "Sedan", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k] ?? "").join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); for (const c of CARS) yield line(c); }

let pool: Pool; let vpicCalls = 0; let guardPassed = false;
const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(host: string, ua: string | null, body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: { ...base, host, ...(ua ? { "user-agent": ua } : {}) }, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const tool = (host: string, ua: string | null, name: string, args: Record<string, unknown>) => rpc(host, ua, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => { if (String(u).includes("vpic.nhtsa.dot.gov")) { vpicCalls++; return new Response("forbidden", { status: 403 }); } return new Response("{}", { status: 404 }); }) as typeof fetch; // NHTSA refuses (403), everything else unavailable: must not break anything
  pool = new Pool({ connectionString: DB, max: 3 });
  try { await assertDisposableDatabase(pool, DB); } catch (e) { await pool.end().catch(() => undefined); throw e; } // refused: close the pool and stop; nothing destructive runs here or in after()
  guardPassed = true;
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta, usage_event, usage_counter, usage_daily_summary CASCADE");
  await loadFeed(pool, lines()); setCatalogDbPoolForTests(pool);
  await rpc(TEST_HOST, "Claude-User", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!guardPassed) return; await pool.query("DROP TABLE IF EXISTS usage_event, usage_counter, usage_daily_summary"); await pool.end(); }); // after a refusal this does nothing

test("route level: the test host records one event per tool call with only allowed fields; the live host records nothing", { skip: !DB }, async () => {
  const s = await tool(TEST_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", model: "Civic", condition: "used", priceMax: 30000, zip: "90210", vehicleNeeds: ["best value, secret detail"] });
  assert.equal(s.result.structuredContent.results.length, 3, "the search answer is unchanged by the logging");
  const vin = s.result.structuredContent.results[0].identity.vin;
  const vin2 = s.result.structuredContent.results[1].identity.vin;
  await tool(TEST_HOST, "Claude-User", "check_vehicle", { vin: "1234" });
  await tool(TEST_HOST, "openai-mcp/1.0.0", "compare_vehicles", { vins: [vin, vin2] });
  await tool(TEST_HOST, null, "get_edmunds_vehicle_link", { vin, make: "Honda", model: "Civic", year: 2022 });
  await tool(LIVE_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", model: "Civic", zip: "90210" });
  await rpc(TEST_HOST, "Claude-User", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  await flushUsageForTests();
  const rows = (await pool.query("SELECT tool, outcome, env, caller_class, found, shown, intent_label, label_version, body_style, price_band, condition, make_given, model_given FROM usage_event ORDER BY time_utc")).rows;
  assert.equal(rows.length, 4, "exactly the four test-host tool calls; the live-host call and tools/list wrote nothing");
  const by = (t: string) => rows.find((r) => r.tool === t);
  assert.deepEqual(by("search"), { tool: "search", outcome: "results", env: "test", caller_class: "claude", found: 3, shown: 3, intent_label: "value", label_version: 1, body_style: null, price_band: "25k to 40k", condition: "used", make_given: true, model_given: true });
  assert.equal(by("check").outcome, "not_decoded"); assert.equal(by("check").caller_class, "claude");
  assert.equal(by("compare").outcome, "produced"); assert.equal(by("compare").caller_class, "chatgpt");
  assert.equal(by("link").outcome, "generated"); assert.equal(by("link").caller_class, "unknown");
  const all = JSON.stringify((await pool.query("SELECT * FROM usage_event")).rows);
  for (const bad of [vin, vin2, "90210", "secret detail", "Claude-User", "openai-mcp", "1234"]) assert.ok(!all.includes(bad), `no trace of ${bad}`);
});

const countRows = async (where = "true") => Number((await pool.query(`SELECT count(*) FROM usage_event WHERE ${where}`)).rows[0].count);
const listenCount = async (kind: string) => Number((await pool.query("SELECT COALESCE(sum(n),0) AS n FROM usage_counter WHERE kind=$1 AND env='test'", [kind])).rows[0].n);
const ENVELOPE = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const listenCall = (host: string, bodyObj: unknown): Promise<number | undefined> => import("../app/[transport]/route").then(({ POST }) => Promise.race([
  POST(new Request("http://localhost/mcp", { method: "POST", headers: { ...base, host, "user-agent": "Claude-User", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" }, body: JSON.stringify(bodyObj) })).then((r) => r.status),
  new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500)),
]));
const LISTEN_OK = { jsonrpc: "2.0", id: 9, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE } };
const LISTEN_BAD = { jsonrpc: "2.0", id: 10, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } }; // missing the per-request envelope: the server refuses it

test("route level: accepted listen requests count as listen_accepted, refused ones as listen_rejected, the live host and a mere mention count nothing", { skip: !DB }, async () => {
  const ok0 = await listenCount("listen_accepted"); const bad0 = await listenCount("listen_rejected");
  const okStatus = await listenCall(TEST_HOST, LISTEN_OK); const badStatus = await listenCall(TEST_HOST, LISTEN_BAD);
  assert.ok(okStatus !== undefined && okStatus >= 200 && okStatus < 300, `the well-formed listen request is accepted (status ${okStatus})`);
  assert.ok(badStatus !== undefined && badStatus >= 400, `the malformed one is refused (status ${badStatus})`);
  await listenCall(LIVE_HOST, LISTEN_OK);
  await tool(TEST_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", model: "Civic", zip: "90210", vehicleNeeds: ["subscriptions/listen"] });
  await flushUsageForTests();
  assert.equal((await listenCount("listen_accepted")) - ok0, 1); assert.equal((await listenCount("listen_rejected")) - bad0, 1);
});

test("route level: calls the SDK rejects for invalid input are recorded as invalid_input; a repaired input is a normal event; an unknown tool and the live host write nothing", { skip: !DB }, async () => {
  const before = await countRows("outcome='invalid_input'"); const total = await countRows();
  const a = await tool(TEST_HOST, "Claude-User", "compare_vehicles", { vins: ["ONLYONEVIN"] });
  assert.match(JSON.stringify(a), /Input validation error/);
  const five = ["1HGCV1F30LA000001", "1HGCV1F30LA000002", "1HGCV1F30LA000003", "1HGCV1F30LA000004", "1HGCV1F30LA000005"];
  const b = await tool(TEST_HOST, "openai-mcp/1.0.0", "compare_vehicles", { vins: five });
  assert.match(JSON.stringify(b), /Input validation error/);
  await tool(TEST_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", priceMax: "not a number" }); // the route repairs this one, so the tool runs and it is an ordinary search event
  await tool(TEST_HOST, "Claude-User", "no_such_tool", {});
  await tool(LIVE_HOST, "Claude-User", "compare_vehicles", { vins: ["ONLYONEVIN"] });
  await flushUsageForTests();
  assert.equal((await countRows("outcome='invalid_input'")) - before, 2, "two test-host rejections recorded; the live host and the unknown tool wrote nothing");
  assert.equal((await countRows()) - total, 3, "the two rejections plus the repaired search");
  const rows = (await pool.query("SELECT tool, outcome, caller_class, nhtsa_failures FROM usage_event ORDER BY time_utc DESC LIMIT 3")).rows;
  const inv = rows.filter((r) => r.outcome === "invalid_input").map((r) => [r.tool, r.caller_class, r.nhtsa_failures]).sort();
  assert.deepEqual(inv, [["compare", "chatgpt", null], ["compare", "claude", null]]);
  assert.equal(rows.filter((r) => r.outcome !== "invalid_input").length, 1, "the repaired search is not counted as invalid input");
});

test("route level: NHTSA failures are counted on the search that had them and left empty on tools that do not track them", { skip: !DB }, async () => {
  const total = await countRows(); const calls0 = vpicCalls;
  const s = await tool(TEST_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", model: "Civic", condition: "used", zip: "90210", electrificationTypes: ["hybrid"], electrificationRequirement: "required" });
  assert.ok(s.result, "the search still answers while NHTSA refuses");
  const vin = (await pool.query("SELECT vin FROM listing LIMIT 1")).rows[0].vin; const vin2 = (await pool.query("SELECT vin FROM listing OFFSET 1 LIMIT 1")).rows[0].vin;
  await tool(TEST_HOST, "Claude-User", "compare_vehicles", { vins: [vin, vin2] });
  await flushUsageForTests();
  const asked = vpicCalls - calls0; assert.ok(asked > 0, "the search asked NHTSA");
  const rows = (await pool.query("SELECT tool, nhtsa_failures FROM usage_event ORDER BY time_utc DESC LIMIT 2")).rows;
  const search = rows.find((r) => r.tool === "search")!; const compare = rows.find((r) => r.tool === "compare")!;
  assert.ok(search.nhtsa_failures > 0 && search.nhtsa_failures <= asked, `search carries its failures (${search.nhtsa_failures} of ${asked} refused lookups)`);
  assert.equal(compare.nhtsa_failures, null, "compare does not track NHTSA failures: empty, not 0");
  assert.equal((await countRows()) - total, 2);
});

const rpcRaw = async (host: string, ua: string, body: unknown) => {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: { ...base, host, "user-agent": ua }, body: JSON.stringify(body) })); return { status: r.status, text: await r.text() };
};
test("route level: a batch with two listen messages is ONE counted request", { skip: !DB }, async () => {
  const total = async () => (await listenCount("listen_accepted")) + (await listenCount("listen_rejected"));
  const before = await total();
  await listenCall(TEST_HOST, [LISTEN_OK, { ...LISTEN_OK, id: 11 }]); await flushUsageForTests();
  assert.equal((await total()) - before, 1);
});

test("route level: batch coverage. Tool calls inside a batch are recorded; a validation rejection inside a batch is NOT (documented limit)", { skip: !DB }, async () => {
  const sv = await tool(TEST_HOST, "Claude-User", "find_matching_vehicle", { make: "Honda", model: "Civic", condition: "used", zip: "90210" });
  const v1 = sv.result.structuredContent.results[0].identity.vin, v2 = sv.result.structuredContent.results[1].identity.vin;
  await flushUsageForTests();
  const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const n0 = await countRows(); const inv0 = await countRows("outcome='invalid_input'");
  const ok = await rpcRaw(TEST_HOST, "Claude-User", [call(1, "find_matching_vehicle", { make: "Honda", model: "Civic", zip: "90210" }), call(2, "compare_vehicles", { vins: [v1, v2] })]);
  await flushUsageForTests();
  assert.equal(ok.status, 200); assert.equal((ok.text.match(/"id":/g) ?? []).length, 2, "both answers came back");
  assert.equal((await countRows()) - n0, 2, "both valid calls in the batch were recorded");
  const n1 = await countRows();
  const mixed = await rpcRaw(TEST_HOST, "Claude-User", [call(3, "compare_vehicles", { vins: ["ONLYONE"] }), call(4, "find_matching_vehicle", { make: "Honda", zip: "90210" })]);
  await flushUsageForTests();
  assert.equal(mixed.status, 200); assert.match(mixed.text, /Input validation error/);
  assert.equal((await countRows()) - n1, 1, "only the valid call in the mixed batch was recorded");
  assert.equal((await countRows("outcome='invalid_input'")) - inv0, 0, "the rejection inside the batch is not recorded");
});

test("route level: rejected and accepted inputs carrying caller text leave no trace in any event", { skip: !DB }, async () => {
  const canary = "CANARY-77c1 jane.doe@example.com 0455 111 222 9 High Street";
  const bad = { make: canary, model: [canary], bodyType: { x: canary }, condition: canary, zip: canary, vin: canary, vehicleNeeds: [canary, 7], exteriorColor: canary, drivetrain: canary, priceMax: canary, seatsMinPreference: canary };
  for (const [name, args] of [["find_matching_vehicle", bad], ["compare_vehicles", { vins: [canary] }], ["check_vehicle", { vin: canary }], ["get_edmunds_vehicle_link", { vin: canary, make: canary, model: canary, year: canary }],
    ["find_matching_vehicle", { make: "Honda", bodyType: canary, vehicleNeeds: [canary], zip: "90210" }]] as const) await tool(TEST_HOST, `Claude-User ${canary}`, name, args as Record<string, unknown>);
  await flushUsageForTests();
  const rows = (await pool.query("SELECT * FROM usage_event ORDER BY time_utc DESC LIMIT 5")).rows;
  assert.ok(rows.length >= 4);
  const all = JSON.stringify((await pool.query("SELECT * FROM usage_event")).rows) + JSON.stringify((await pool.query("SELECT * FROM usage_counter")).rows);
  assert.ok(!/CANARY|jane\.doe|example\.com|High Street|0455/i.test(all), "no caller text anywhere in the stored events");
  const styles = (await pool.query("SELECT DISTINCT body_style FROM usage_event WHERE body_style IS NOT NULL")).rows.map((r) => r.body_style);
  assert.ok(styles.every((s) => ["suv", "truck", "sedan", "coupe", "hatchback", "wagon", "van", "minivan", "convertible", "other"].includes(s)), `body styles stay in the fixed list: ${styles}`);
});
