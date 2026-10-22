// Regression tests for ChatGPT's second review (22 Oct 2026, findings BA22-01, 02, 03, 04, 06, 07, 10), each first reproduced by Claude on the real route against a real PostgreSQL,
// then fixed (SYS-20261022-056). Synthetic cars only; NHTSA is stubbed per VIN and per call. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const DB = process.env.TEST_DATABASE_URL;
process.env.LISTING_SOURCE = "catalog_db"; process.env.DATABASE_URL = DB ?? "postgres://unused"; process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { setCatalogDbPoolForTests } from "../lib/catalog-db-source";
import { resetNhtsaCacheForTests } from "../lib/nhtsa-client";
import { readFileSync } from "node:fs";
import { FindMatchingVehicleInputCatalog } from "../lib/find-matching-vehicle-input";

type R = { make: string; model: string; trim: string; year: number; price: number; vin: string; cond: "new" | "used"; odo: number; zip?: string; dz?: string; st?: string; city?: string };
const ROWS: R[] = []; let seq = 0;
const vin = (p: string) => `${p}${String(++seq).padStart(17 - p.length, "0")}`;
const add = (n: number, f: (i: number) => Partial<R> & Pick<R, "make" | "model" | "price">) => { for (let i = 0; i < n; i++) { const p = f(i); ROWS.push({ trim: "Base", year: 2026, vin: vin("1HGRZ"), cond: "new", odo: 10, ...p } as R); } };
// BA22-01: two Pilots; BA22-03: Highlander confirmed old vs unconfirmed new; BA22-04: six dense families; BA22-06/07: CR-V; BA22-10: RAV4
const PILOT_A = vin("1HGPA"), PILOT_B = vin("1HGPB"); ROWS.push({ make: "Honda", model: "Pilot", trim: "Base", year: 2026, price: 40000, vin: PILOT_A, cond: "new", odo: 10 }, { make: "Honda", model: "Pilot", trim: "Base", year: 2026, price: 41000, vin: PILOT_B, cond: "new", odo: 10 });
const HIGH_C = vin("5TDHC"), HIGH_U = vin("5TDHU"); ROWS.push({ make: "Toyota", model: "Highlander", trim: "Base", year: 2023, price: 45000, vin: HIGH_C, cond: "new", odo: 10 }, { make: "Toyota", model: "Highlander", trim: "Base", year: 2026, price: 35000, vin: HIGH_U, cond: "new", odo: 10 });
for (let m = 1; m <= 6; m++) add(65, (i) => ({ make: "Acme", model: `Fox${m}`, price: 65000 - (m - 1) * 5000 + i, vin: vin("1ACM") }));
add(10, (i) => ({ make: "Honda", model: "CR-V", price: 30000 + i * 100, cond: i % 2 ? "used" : "new", odo: i % 2 ? 30000 + i : 10, vin: vin("2HKRS") }));
const RAV_1 = vin("2T3R1"), RAV_2 = vin("2T3R2"); ROWS.push({ make: "Toyota", model: "RAV4", trim: "Base", year: 2026, price: 31000, vin: RAV_1, cond: "new", odo: 10 }, { make: "Toyota", model: "RAV4", trim: "Base", year: 2026, price: 32000, vin: RAV_2, cond: "new", odo: 10 });

const SPORT_HYB = vin("1WRSH"); ROWS.push({ make: "Wex", model: "Wren", trim: "Sport Hybrid", year: 2026, price: 30000, vin: SPORT_HYB, cond: "new", odo: 10 }); // R2-05b / R2-04: a trim with Hybrid wording
// R2-01: three new cars, one confirmed at once, one never answered, one answered only at a later read; R2-02: two models, one of which turns out gasoline at the later read
const T_A = vin("1ZA"), T_B = vin("1ZB"), T_C = vin("1ZC");
ROWS.push({ make: "Zed", model: "Zeta", trim: "Base", year: 2023, price: 45000, vin: T_A, cond: "new", odo: 10 }, { make: "Zed", model: "Zeta", trim: "Base", year: 2026, price: 35000, vin: T_B, cond: "new", odo: 10 }, { make: "Zed", model: "Zeta", trim: "Base", year: 2025, price: 40000, vin: T_C, cond: "new", odo: 10 });
const Q_HYB = vin("1QA"), Q_GAS = vin("1QB");
ROWS.push({ make: "Qua", model: "Quill", trim: "Base", year: 2026, price: 35000, vin: Q_HYB, cond: "new", odo: 10 }, { make: "Qua", model: "Quest", trim: "Base", year: 2026, price: 36000, vin: Q_GAS, cond: "new", odo: 10 });

// Round 3 (ChatGPT, 22 Oct): R3-02 used cars for the objective order; R3-01 two Dallas models whose second car drifts at the detail read; drivetrain removal
const O_A = vin("1OA"), O_B = vin("1OB"), O_C = vin("1OC");
ROWS.push({ make: "Ord", model: "Orb", trim: "Base", year: 2023, price: 45000, vin: O_A, cond: "used", odo: 10000 }, { make: "Ord", model: "Orb", trim: "Base", year: 2026, price: 35000, vin: O_B, cond: "used", odo: 1000 }, { make: "Ord", model: "Orb", trim: "Base", year: 2025, price: 40000, vin: O_C, cond: "used", odo: 5000 });
const DAL = { dz: "75201", st: "TX", city: "Dallas" };
const D1_OK = vin("1PA"), D1_DRIFT = vin("1PB"), D2_OK = vin("1PC"), D2_DRIFT = vin("1PD");
ROWS.push({ make: "Ptr", model: "Plot", trim: "EX", year: 2026, price: 35000, vin: D1_OK, cond: "new", odo: 10, ...DAL }, { make: "Ptr", model: "Pass", trim: "EX", year: 2026, price: 36000, vin: D1_DRIFT, cond: "new", odo: 10, ...DAL },
  { make: "Pt2", model: "Plot", trim: "EX", year: 2026, price: 35000, vin: D2_OK, cond: "new", odo: 10, ...DAL }, { make: "Pt2", model: "Pass", trim: "EX", year: 2026, price: 36000, vin: D2_DRIFT, cond: "new", odo: 10, ...DAL });
const DR_A = vin("1DA"), DR_B = vin("1DB");
ROWS.push({ make: "Drv", model: "Drv1", trim: "Base", year: 2026, price: 30000, vin: DR_A, cond: "new", odo: 10 }, { make: "Drv", model: "Drv2", trim: "Base", year: 2026, price: 31000, vin: DR_B, cond: "new", odo: 10 });

function line(c: R, n: number): string {
  const id = `zzr${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer", dealer_street: "1 Test St",
    dealer_city: c.city ?? "Beverly Hills", dealer_state: c.st ?? "CA", dealer_zip: c.dz ?? "90210", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: c.make,
    vehicle_model: c.model, vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: "SUV", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of ROWS) yield line(c, n++); }

let pool: Pool; const seen = new Map<string, number>(); let plan: (vinCode: string, nth: number) => "hybrid" | "gas" | "fail" = () => "hybrid"; let driveOf: (vinCode: string, nth: number) => string = () => "";
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) { const { POST } = await import("../app/[transport]/route"); const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) })); const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t); }
let rid = 100; const call = (args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id: rid++, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });
const textOf = (o: any): string => o.result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
const cards = (o: any): any[] => o.result.structuredContent?.results ?? [];
before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i); if (!m) return new Response("{}", { status: 404 });
    const v = m[1].toUpperCase(); const nth = (seen.get(v) ?? 0) + 1; seen.set(v, nth); const k = plan(v, nth);
    if (k === "fail") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: k === "hybrid" ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: k === "hybrid" ? "Electric" : "", DriveType: driveOf(v, nth) }] }), { status: 200 });
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 }); await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE"); await loadFeed(pool, lines()); setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
beforeEach(() => { seen.clear(); resetNhtsaCacheForTests(); plan = () => "hybrid"; driveOf = () => ""; });
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const HYB = { electrificationTypes: ["hybrid"], electrificationRequirement: "required" };
const elec = (c: any) => (c.constraintChecks ?? []).filter((k: any) => k.field === "electrification");

test("BA22-01: a car whose first decode failed and whose later decode shows gasoline is removed and counted as left out, not shown as a match", opts, async () => {
  plan = (v, nth) => (v === PILOT_A ? "hybrid" : nth === 1 ? "fail" : "gas");
  const o = await call({ make: "Honda", model: "Pilot", zip: "90210", ...HYB }); const t = textOf(o);
  assert.deepEqual(cards(o).map((c) => c.identity.vin), [PILOT_A], "only the confirmed hybrid is shown");
  assert.ok(cards(o).every((c) => elec(c).every((k: any) => k.status !== "mismatch")), "no card shows an electrification mismatch");
  assert.match(t, /Cars that NHTSA shows as a different type than hybrid were left out\./);
  assert.match(t, /Only 1 of the results matched your electric or hybrid requirement\./);
});

test("BA22-01: a car NHTSA never answers for is kept, marked, and counted as unconfirmed, never as a match", opts, async () => {
  plan = (v) => (v === PILOT_A ? "hybrid" : "fail");
  const o = await call({ make: "Honda", model: "Pilot", zip: "90210", ...HYB }); const t = textOf(o);
  assert.equal(cards(o).length, 2);
  assert.deepEqual(cards(o).map((c) => elec(c)[0]?.status), ["verified", "unknown"], "confirmed first, then the unconfirmed one");
  assert.match(t, /1 of these could not be confirmed as hybrid by NHTSA and are marked on each listing; ask the dealer to confirm\./);
  assert.match(t, /Only 1 of the results matched your electric or hybrid requirement\./);
  assert.ok(!/Only 2 of the results matched/.test(t), "the unconfirmed car is not counted as a match");
});

test("BA22-02: electrification types without a requirement are applied as required, and the Searched line says it was assumed", opts, async () => {
  plan = () => "gas";
  const o = await call({ make: "Honda", model: "CR-V", zip: "90210", condition: "new", electrificationTypes: ["electric"] });
  assert.match(textOf(o).split("\n")[0], /electric required \(assumed: no requirement was given\)/);
  assert.equal(cards(o).length, 0, "required means gasoline cars are not returned");
  const explicit = textOf(await call({ make: "Honda", model: "CR-V", zip: "90210", condition: "new", electrificationTypes: ["electric"], electrificationRequirement: "required" })).split("\n")[0];
  assert.match(explicit, /electric required;/); assert.ok(!/assumed/.test(explicit), "an explicit requirement is not called assumed");
  plan = () => "gas";
  const pref = textOf(await call({ make: "Honda", model: "CR-V", zip: "90210", condition: "new", electrificationTypes: ["hybrid"], electrificationRequirement: "preferred" })).split("\n")[0];
  assert.match(pref, /hybrid preferred;/);
});

test("BA22-03: confirmed cars come before unconfirmed ones whatever the objective, even when the unconfirmed car is cheaper and newer", opts, async () => {
  for (const axis of [undefined, "cheapest", "newest"]) {
    seen.clear(); resetNhtsaCacheForTests(); plan = (v) => (v === HIGH_C ? "hybrid" : "fail");
    const o = await call({ make: "Toyota", model: "Highlander", zip: "90210", condition: "new", priceMax: 50000, ...HYB, ...(axis ? { priorityAxis: axis } : {}) });
    assert.deepEqual(cards(o).map((c) => c.identity.vin), [HIGH_C, HIGH_U], `axis ${axis ?? "default"}: the confirmed 2023 car first`);
  }
});

test("BA22-04: six dense model families with 65 cars each: every family reaches the shortlist pool", opts, async () => {
  const o = await call({ make: "Acme", model: "Fox1, Fox2, Fox3, Fox4, Fox5, Fox6", zip: "90210", condition: "new", priceMax: 70000 });
  assert.deepEqual([...new Set(cards(o).map((c) => c.identity.model))].sort(), ["Fox1", "Fox2", "Fox3", "Fox4", "Fox5", "Fox6"]);
});

test("BA22-06: the Searched line states what ran: lowest mileage means used, the radius is capped at 1,000", opts, async () => {
  const a = await call({ make: "Honda", model: "CR-V", zip: "90210", priorityAxis: "lowest_mileage" });
  assert.match(textOf(a).split("\n")[0], /^Searched: used cars;/); assert.ok(cards(a).every((c) => c.condition?.inventoryType === "used"));
  assert.match(textOf(await call({ make: "Honda", model: "CR-V", zip: "90210", radiusMiles: 5000 })).split("\n")[0], /within 1000 miles of ZIP 90210/);
  assert.match(textOf(await call({ make: "Honda", model: "CR-V", zip: "90210", condition: "used", priorityAxis: "lowest_mileage" })).split("\n")[0], /^Searched: used cars;/);
});

test("BA22-07: an exact VIN with a required electrification type is assessed, shown anyway, and the reply says so", opts, async () => {
  const v = ROWS.find((r) => r.model === "CR-V")!.vin; plan = () => "gas";
  const o = await call({ vin: v, electrificationTypes: ["electric"], electrificationRequirement: "required" }); const c = cards(o)[0];
  assert.equal(c.identity.vin, v, "the exact VIN is returned, never replaced");
  assert.deepEqual(elec(c).map((k: any) => k.status), ["mismatch"]);
  assert.match(textOf(o), /Not electric according to NHTSA \(it shows as not electrified\) \u2014 this is the exact VIN requested, not a different vehicle\./);
  plan = () => "fail"; seen.clear(); resetNhtsaCacheForTests();
  const u = await call({ vin: v, electrificationTypes: ["electric"] }); assert.match(textOf(u), /NHTSA could not confirm electric: ask the dealer\./);
  plan = () => "hybrid"; seen.clear(); resetNhtsaCacheForTests();
  const ok = await call({ vin: v, electrificationTypes: ["hybrid"], electrificationRequirement: "required" }); assert.ok(!/Not hybrid|could not confirm/.test(textOf(ok)));
});

test("BA22-10: required hybrid plus AWD while NHTSA is down: each car is decoded once, not once per stage", opts, async () => {
  plan = () => "fail";
  await call({ make: "Toyota", model: "RAV4", zip: "90210", condition: "new", drivetrain: "AWD", ...HYB });
  assert.deepEqual([...seen.values()], [1, 1], "one decode per VIN");
});

test("BA22-11: the node:test suites, which include the database suites, run one file at a time", () => {
  const script = JSON.parse(readFileSync("package.json", "utf-8")).scripts.test as string;
  assert.match(script, /npx tsx --test --test-concurrency=1 /);
});

test("the field texts say what the code does: trimRequired close matches, seats reported only, radius cap, requirement default", () => {
  const sh = FindMatchingVehicleInputCatalog.shape; const d = (k: keyof typeof sh) => String(sh[k].description);
  assert.match(d("trimRequired"), /Exact matches come first; when none exists, close trims .*\(for example EX-L for EX\).* marked as close matches/);
  assert.match(d("seatsMinPreference"), /it does not filter or change the order/); assert.ok(!/ranks/i.test(d("seatsMinPreference")));
  assert.match(d("radiusMiles"), /50 when omitted, 1,000 at most/);
  assert.match(d("electrificationRequirement"), /required when omitted/);
});

// ---- ChatGPT round 3 report on bd635fc (R2-05): one normalized radius in every paragraph ----
import { normalizeRadiusMiles } from "../lib/applied-filters";
import { MAX_RADIUS, DEFAULT_RADIUS_MILES } from "../lib/catalog-db/search";
test("R2-05: the radius is decided once: omitted stays omitted, positive is capped at 1,000, zero, negative and non-numeric mean the default (same rule as the SQL)", () => {
  assert.equal(MAX_RADIUS, 1000); assert.equal(DEFAULT_RADIUS_MILES, 50);
  assert.equal(normalizeRadiusMiles(undefined), undefined); assert.equal(normalizeRadiusMiles(null), undefined);
  assert.equal(normalizeRadiusMiles(25), 25); assert.equal(normalizeRadiusMiles(5000), 1000); assert.equal(normalizeRadiusMiles(1000), 1000);
  for (const bad of [0, -5, NaN, Infinity, "far" as unknown]) assert.equal(normalizeRadiusMiles(bad), DEFAULT_RADIUS_MILES, String(bad));
});

test("R2-05: an oversized, zero or negative radius never appears in any paragraph of the reply, thin-result text included", opts, async () => {
  for (const [radius, applied] of [[5000, 1000], [0, 50], [-5, 50]] as const) {
    const t = textOf(await call({ make: "Honda", model: "Pilot", zip: "90210", radiusMiles: radius })); const first = t.split("\n")[0];
    assert.match(first, new RegExp(`within ${applied} miles of ZIP 90210`), `radius ${radius}: first line`);
    assert.match(t, new RegExp(`Only 2 within ${applied} miles of 90210`), `radius ${radius}: thin-result paragraph`);
    assert.ok(!new RegExp(`(?<![0-9])${radius} miles`).test(t), `radius ${radius} must not appear anywhere in the reply`);
  }
});

test("R2-04: the same car and the same trim and electrification request give the same trim verdict from a search and from an exact-VIN lookup", opts, async () => {
  const trimOf = (o: any) => (cards(o)[0]?.constraintChecks ?? []).find((k: any) => k.field === "trimRequired");
  const s = await call({ make: "Wex", model: "Wren", condition: "new", trimRequired: "Sport", ...HYB });
  assert.equal(cards(s)[0].identity.vin, SPORT_HYB); assert.equal(trimOf(s)?.status, "verified");
  seen.clear(); resetNhtsaCacheForTests();
  const v = await call({ vin: SPORT_HYB, trimRequired: "Sport", ...HYB });
  assert.equal(cards(v)[0].identity.vin, SPORT_HYB, "the exact VIN is returned");
  assert.equal(trimOf(v)?.status, "verified", "the VIN lookup agrees with the search"); assert.deepEqual(elec(cards(v)[0]).map((k: any) => k.status), ["verified"]);
  // without an electrified request the Hybrid word is not neutral: Sport still does not match Sport Hybrid, in the search and in the lookup alike
  seen.clear(); resetNhtsaCacheForTests();
  const plain = await call({ vin: SPORT_HYB, trimRequired: "Sport" }); assert.equal(trimOf(plain)?.status, "mismatch");
});

test("R2-01: a car that fails its first decode and confirms at a later read is placed with the confirmed cars, ahead of a car that never answers", opts, async () => {
  plan = (v, nth) => (v === T_A ? "hybrid" : v === T_B ? "fail" : nth === 1 ? "fail" : "hybrid");
  const o = await call({ make: "Zed", model: "Zeta", condition: "new", priceMax: 50000, ...HYB });
  assert.deepEqual(cards(o).map((c) => elec(c)[0]?.status), ["verified", "verified", "unknown"], "confirmed, confirmed, unconfirmed");
  assert.equal(cards(o)[2].identity.vin, T_B, "the car NHTSA never answered for is last");
  assert.match(textOf(o), /Only 2 of the results matched your electric or hybrid requirement\./);
});

test("R2-01: the confirmation tier holds for cheapest and newest as well", opts, async () => {
  for (const axis of ["cheapest", "newest"]) {
    seen.clear(); resetNhtsaCacheForTests(); plan = (v, nth) => (v === T_A ? "hybrid" : v === T_B ? "fail" : nth === 1 ? "fail" : "hybrid");
    const o = await call({ make: "Zed", model: "Zeta", condition: "new", priceMax: 50000, priorityAxis: axis, ...HYB });
    assert.equal(cards(o)[2].identity.vin, T_B, `axis ${axis}: the unanswered car is last`);
  }
});

test("R2-02: a model whose only car was removed at the later read is not advertised as 'also matched but not shown'", opts, async () => {
  plan = (v, nth) => (v === Q_HYB ? "hybrid" : nth === 1 ? "fail" : "gas");
  const o = await call({ make: "Qua", model: "Quill, Quest", condition: "new", priceMax: 50000, ...HYB }); const t = textOf(o);
  assert.deepEqual(cards(o).map((c) => c.identity.model), ["Quill"], "only Quill is shown");
  assert.match(t, /Cars that NHTSA shows as a different type than hybrid were left out\./);
  assert.ok(!/Also matched but not shown/.test(t), "Quest was rejected as gasoline and is not offered as a match");
  assert.ok(!/Quest \(for example/.test(t), "no example price for the removed model");
});

// ---- ChatGPT round 3 on 8c1d056 (R3-01, R3-02) ----
async function withDrift(vinTarget: string, sql: string, undo: string, fn: () => Promise<void>) {
  let done = false;
  const proxy: any = new Proxy(pool, { get(t: any, k: string) { if (k !== "query") { const v = t[k]; return typeof v === "function" ? v.bind(t) : v; }
    return async (text: any, params: any) => { const q = typeof text === "string" ? text : text.text; if (!done && /vin\s*=\s*\$1/i.test(q) && params?.[0] === vinTarget) { done = true; await pool.query(sql, [vinTarget]); } return pool.query(text, params); }; } });
  setCatalogDbPoolForTests(proxy);
  try { await fn(); assert.ok(done, "the drift was applied at the detail read"); } finally { setCatalogDbPoolForTests(pool); await pool.query(undo, [vinTarget]); }
}

test("R3-02: a car confirmed only at a later read takes its place by the explicit objective inside the confirmed tier (cheapest, newest, lowest mileage)", opts, async () => {
  for (const axis of ["cheapest", "newest", "lowest_mileage"]) {
    seen.clear(); resetNhtsaCacheForTests(); plan = (v, nth) => (v === O_A ? "hybrid" : v === O_B ? "fail" : nth === 1 ? "fail" : "hybrid");
    const o = await call({ make: "Ord", model: "Orb", condition: "used", priceMax: 50000, priorityAxis: axis, ...HYB });
    assert.deepEqual(cards(o).map((c) => c.identity.vin), [O_C, O_A, O_B], `axis ${axis}: C (cheaper, newer, fewer miles) before A, the unanswered car last`);
    assert.deepEqual(cards(o).map((c) => elec(c)[0]?.status), ["verified", "verified", "unknown"]);
  }
});

test("R3-02 control: with every car confirmed at once the explicit objective order is unchanged", opts, async () => {
  plan = () => "hybrid";
  const o = await call({ make: "Ord", model: "Orb", condition: "used", priceMax: 50000, priorityAxis: "cheapest", ...HYB });
  assert.deepEqual(cards(o).map((c) => c.identity.vin), [O_B, O_C, O_A]);
});

test("R3-01: a model whose car was rejected at the detail stage for a changed trim is not advertised as 'also matched but not shown'", opts, async () => {
  await withDrift(D1_DRIFT, "UPDATE listing SET trim = 'LX' WHERE vin = $1", "UPDATE listing SET trim = 'EX' WHERE vin = $1", async () => {
    const o = await call({ make: "Ptr", model: "Plot, Pass", condition: "new", trimRequired: "EX", zip: "75201", priceMax: 50000 }); const t = textOf(o);
    assert.deepEqual(cards(o).map((c) => c.identity.model), ["Plot"]);
    assert.ok(!/Also matched but not shown/.test(t) && !/Pass \(for example/.test(t), "Pass was rejected and is not offered as a match");
  });
});

test("R3-01: a model whose car was rejected at the detail stage for a changed location is not advertised either, and the exclusion is still reported", opts, async () => {
  await withDrift(D2_DRIFT, "UPDATE listing SET state = 'CA' WHERE vin = $1", "UPDATE listing SET state = 'TX' WHERE vin = $1", async () => {
    const o = await call({ make: "Pt2", model: "Plot, Pass", condition: "new", zip: "75201", radiusMiles: 50, priceMax: 50000 }); const t = textOf(o);
    assert.deepEqual(cards(o).map((c) => c.identity.model), ["Plot"]);
    assert.match(t, /far outside the requested search radius at the detailed lookup stage/);
    assert.ok(!/Also matched but not shown/.test(t), "Pass was rejected and is not offered as a match");
  });
});

test("R3-01 drivetrain: a car whose later read shows another drivetrain is removed and not offered in the 'also matched' note", opts, async () => {
  plan = (v, nth) => (v === DR_B && nth === 1 ? "fail" : "gas"); driveOf = (v) => (v === DR_A ? "AWD/All-Wheel Drive" : "FWD/Front-Wheel Drive");
  const o = await call({ make: "Drv", model: "Drv1, Drv2", condition: "new", drivetrain: "AWD", priceMax: 50000 }); const t = textOf(o);
  assert.deepEqual(cards(o).map((c) => c.identity.model), ["Drv1"]);
  assert.ok(!/Also matched but not shown/.test(t) && !/Drv2 \(for example/.test(t), "Drv2 was removed as FWD and is not offered");
});
