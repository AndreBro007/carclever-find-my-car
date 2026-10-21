// End-to-end: the real MCP route in catalogue-DATABASE mode, against a real PostgreSQL loaded with synthetic cars.
// Proves (1) zero Auto.dev requests, (2) output passes the registered outputSchema, (3) the feed's own new/used flag and
// the stored tracking links come through, (4) distance scope, VIN lookup and the VIN-not-found wording, (5) a database
// outage becomes the quiet service error. Skipped when TEST_DATABASE_URL is not set. NO real partner data.
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

const DEALERS: Record<number, [string, string, string, string]> = { 1: ["Test Honda Beverly", "Beverly Hills", "CA", "90210"], 2: ["Test Auto LA", "Los Angeles", "CA", "90001"], 3: ["Test Motors Austin", "Austin", "TX", "78701"] };
const vinFor = (n: number) => `1HGCV1F3${String(n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
type C = { n: number; year: number; make: string; model: string; trim: string; cond: "new" | "used"; price: number; odo: number; body: string; dealer: number };
const CARS: C[] = [
  { n: 1, year: 2022, make: "Honda", model: "Civic", trim: "EX-L", cond: "used", price: 24000, odo: 32000, body: "Hatchback", dealer: 1 },
  { n: 2, year: 2026, make: "Honda", model: "Civic", trim: "Sport", cond: "new", price: 28000, odo: 5, body: "Sedan", dealer: 1 },
  { n: 3, year: 2021, make: "Honda", model: "Civic", trim: "LX", cond: "used", price: 19000, odo: 51000, body: "4dr Car", dealer: 2 },
  { n: 4, year: 2023, make: "Honda", model: "Civic", trim: "Sport", cond: "used", price: 22500, odo: 28000, body: "Sedan", dealer: 2 },
  { n: 5, year: 2020, make: "Honda", model: "Civic", trim: "LX", cond: "used", price: 17000, odo: 61000, body: "Sedan", dealer: 3 },
  { n: 6, year: 2024, make: "Toyota", model: "RAV4", trim: "LE", cond: "used", price: 29000, odo: 15000, body: "SUV", dealer: 3 },
];
function line(c: C): string {
  const d = DEALERS[c.dealer]; const vin = vinFor(c.n); const id = `e2e${String(c.n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: `https://img.example.com/${c.n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: String(c.dealer), dealer_name: d[0], dealer_street: "1 Test St",
    dealer_city: d[1], dealer_state: d[2], dealer_zip: d[3], dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`, vehicle_make: c.make, vehicle_model: c.model,
    vehicle_series: c.trim, vehicle_odometer: `${c.odo}.00`, vehicle_body: c.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); for (const c of CARS) yield line(c); }

let pool: Pool; let autoDev = 0;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args } });

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    if (s.includes("api.auto.dev")) { autoDev++; throw new Error("AUTO.DEV MUST NOT BE CALLED"); }
    return new Response("{}", { status: 404 }); // NHTSA etc. unavailable: must not break anything
  }) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });

const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("database mode: local search returns schema-valid cards with real new/used and both buttons, zero Auto.dev calls", opts, async () => {
  const out = await call(2, { make: "Honda", model: "Civic", zip: "90210", radiusMiles: 50 });
  assert.equal(out.error, undefined); assert.notEqual(out.result.isError, true);
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.serviceError, null);
  assert.equal(sc.meta.scopeNote, "local");
  assert.ok(sc.results.length >= 3, "at least the four California Civics are candidates");
  assert.ok(sc.results.every((c: { listing: { state: string } }) => c.listing.state === "CA"), "no Texas dealer within 50 miles of Beverly Hills");
  for (const c of sc.results) { assert.ok(["new", "used"].includes(c.condition.inventoryType), `known condition, got ${c.condition.inventoryType}`); assert.ok(c.links.affiliateUrl, "tracking link present"); }
  assert.ok(sc.results.some((c: { condition: { inventoryType: string } }) => c.condition.inventoryType === "new"), "the new 2026 Civic is shown as new");
  assert.equal(autoDev, 0);
});

test("database mode: a state without a ZIP is labelled statewide and filtered in the database", opts, async () => {
  const out = await call(3, { make: "Honda", model: "Civic", state: "TX" });
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.scopeNote, "statewide");
  assert.ok(sc.results.length >= 1 && sc.results.every((c: { listing: { state: string } }) => c.listing.state === "TX"));
  assert.equal(autoDev, 0);
});

test("database mode: a VIN lookup finds the car; an unknown VIN gets the catalogue wording and no substitution", opts, async () => {
  const found = await call(4, { vin: vinFor(6) });
  assert.notEqual(found.result.isError, true);
  assert.ok(JSON.stringify(found.result).includes(vinFor(6)), "the requested VIN is in the answer");
  const missing = await call(5, { vin: "1HGCV1F39MZ999999" }); // a valid VIN that is simply not in the catalogue
  const txt = JSON.stringify(missing.result);
  assert.ok(/No listing found for VIN/.test(txt));
  assert.ok(!/current live inventory/.test(txt), "uses the catalogue wording, not the Auto.dev wording");
  assert.equal(autoDev, 0);
});

test("database mode: a database outage becomes the quiet service error, never a crash", opts, async () => {
  const broken = new Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
  setCatalogDbPoolForTests(broken);
  const out = await call(6, { make: "Honda", model: "Civic", zip: "90210" });
  assert.equal(out.error, undefined);
  const sc = out.result.structuredContent;
  assert.ok(sc.meta.serviceError, "the service error is reported");
  setCatalogDbPoolForTests(pool); await broken.end().catch(() => {});
  assert.equal(autoDev, 0);
});

const callTool = (id: number, name: string, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const textOf = (out: { result: { content: Array<{ text: string }> } }): string => out.result.content.map((c) => c.text).join("\n");

test("a VIN that is not listed and fails its check digit gets an Invalid VIN message with an NHTSA link and no card, in both tools", opts, async () => {
  const bad = "1HGCV1F3999Z99999";
  for (const name of ["find_matching_vehicle", "check_vehicle"]) {
    const out = await callTool(20, name, { vin: bad });
    const txt = textOf(out);
    assert.match(txt, /Invalid VIN/);
    assert.ok(txt.includes(`nhtsa.gov/recalls?vymm=${bad}`), "NHTSA recall link");
    assert.equal((out.result.structuredContent?.results ?? []).length, 0, `${name}: no card`);
    if (name === "find_matching_vehicle") assert.equal(out.result.structuredContent.meta.scopeNote, "vin_invalid");
  }
  const listed = await call(21, { vin: vinFor(6) }); // a listed car stays findable even if its VIN data is odd
  assert.ok(JSON.stringify(listed.result).includes(vinFor(6)));
});

test("no results: the closest options over budget are listed with links; nothing is added to the result list", opts, async () => {
  const txt = textOf(await call(22, { make: "Honda", model: "Civic", priceMax: 1000, zip: "90210" }));
  assert.match(txt, /No vehicles matched Honda Civic at up to \$1,000 within 50 miles of 90210/);
  assert.match(txt, /Closest Honda Civic options near ZIP 90210, lowest price first\. These are over your budget:/);
  assert.ok((txt.match(/https:\/\/edmunds\.sjv\.io/g) ?? []).length >= 2, "alternatives carry links");
  assert.ok(!/would likely surface options/.test(txt));
  const out = await call(22, { make: "Honda", model: "Civic", priceMax: 1000, zip: "90210" });
  assert.equal(out.result.structuredContent.results.length, 0);
});

test("no results: a model with no listings gets other models from the same make", opts, async () => {
  const txt = textOf(await call(23, { make: "Toyota", model: "Supra" }));
  assert.match(txt, /Other Toyota models inside your filters:/);
  assert.match(txt, /RAV4/);
});

test("a thin local result puts the offer to search wider at the top, not at the end", opts, async () => {
  const txt = textOf(await call(24, { make: "Honda", model: "Civic", zip: "90210", radiusMiles: 50 }));
  assert.ok(txt.indexOf("Want me to search wider?") !== -1 && txt.indexOf("Want me to search wider?") < txt.indexOf("Found "), "offer comes before the list");
  assert.ok(!txt.includes("Ask me to widen"));
});

test("cylinders and transmission are no longer inputs: an older caller that sends them is told they were set aside, and nothing is filtered on them", opts, async () => {
  const out = await call(25, { make: "Honda", model: "Civic", cylinders: 4, transmission: "Manual", zip: "90210" });
  const text = out.result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  assert.match(text, /these inputs could not be used and were ignored: cylinders \(not a filter; each result shows its engine when known\); transmission \(not a filter; each result shows it when known\)/);
  const acc = (out.result.structuredContent.meta.qualifierAccounting ?? []) as Array<{ applied: string }>;
  assert.ok(!acc.some((x) => /filtered on (cylinder|transmission)/.test(x.applied)));
});

test("no results: none in the asked condition, so the same model in the other condition is shown and labelled", opts, async () => {
  const txt = textOf(await call(27, { make: "Toyota", model: "RAV4", used: false, priceMax: 5000 }));
  assert.match(txt, /No new Toyota RAV4 listings found\. Used ones in Edmunds listings, lowest price first:/);
  assert.match(txt, /2024 Toyota RAV4 LE - \$29,000/);
  assert.ok(/https:\/\/edmunds\.sjv\.io/.test(txt));
});

test("no results because of the trim: the alternatives say so, and are never called over budget when they are not", opts, async () => {
  const txt = textOf(await call(28, { make: "Honda", model: "Civic", trimRequired: "Type R", priceMax: 90000, zip: "90210" }));
  assert.match(txt, /No vehicles matched Honda Civic Type R at up to \$90,000/);
  assert.match(txt, /None has the exact trim name "Type R":/);
  assert.ok(!/over your budget/.test(txt), "all of them cost less than the limit");
  assert.match(txt, /on Edmunds \(all trims, not filtered to Type R; enter your ZIP there for local results\)/);
});

test("a retired input in the reply note is worded for the buyer, and a price flexibility of strict is simply accepted", opts, async () => {
  const txt = textOf(await call(29, { make: "Honda", model: "Civic", transmission: "Manual", priceFlexibility: "strict", zip: "90210" }));
  assert.match(txt, /ignored: transmission \(not a filter; each result shows it when known\)\./);
  assert.ok(!/priceFlexibility/.test(txt), "strict is true, so nothing is said about it");
  assert.match(textOf(await call(30, { make: "Honda", model: "Civic", priceFlexibility: "flexible", zip: "90210" })), /ignored: priceFlexibility \(the price ceiling is always strict\)/);
});

test("a broad body-type search gets the hint on how to ask for a class; a search with model names does not", opts, async () => {
  const broad = textOf(await call(30, { bodyType: "SUV", priceMax: 40000 }));
  assert.match(broad, /broad SUV search with no model names, so the results span all sizes/);
  const named = textOf(await call(31, { model: "RAV4", bodyType: "SUV", priceMax: 40000 }));
  assert.ok(!/broad SUV search/.test(named));
});

test("a car's cylinders and transmission still appear on its card when known (shown, never filtered on)", opts, async () => {
  const out = await call(32, { make: "Honda", model: "Civic", zip: "90210" });
  const first = out.result.structuredContent.results[0];
  assert.ok("cylinders" in first.detail && "transmission" in first.powertrain);
});

test("when a search behind the alternatives fails, the reply says so instead of silently showing nothing", opts, async () => {
  const broken = new Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
  const { buildNoResultsAlternatives } = await import("../lib/no-results-alternatives");
  const out = await buildNoResultsAlternatives({ make: "Honda", model: "Civic" }, async () => ({ data: [], error: "boom" }));
  assert.match(out, /Similar-vehicle options could not be loaded just now/);
  await broken.end().catch(() => {});
});

test("no results: the reply says listings change often and invites another try, with no claim about the wider market", opts, async () => {
  const txt = textOf(await call(33, { make: "Honda", model: "Civic", priceMax: 1000, zip: "90210" }));
  assert.match(txt, /Nothing was widened or substituted\. Listings change often, so try again soon or adjust the search\./);
});

test("a trim that matches nothing: the reply lists the trims that do exist, with counts", opts, async () => {
  const txt = textOf(await call(34, { make: "Honda", model: "Civic", trimRequired: "Type R", zip: "90210" }));
  assert.match(txt, /Trims we have for Honda Civic: .*Sport \(2\).*If you meant one of these, ask for it by that exact name\./);
});

test("several required trims, comma-separated, are all accepted", opts, async () => {
  const out = await call(35, { make: "Honda", model: "Civic", trimRequired: "Sport, EX-L", zip: "90210" });
  const trims = new Set((out.result.structuredContent.results as Array<{ identity: { trim: string } }>).map((c) => c.identity.trim));
  assert.ok(trims.size >= 1 && [...trims].every((t) => t === "Sport" || t === "EX-L"), `got ${[...trims].join(", ")}`);
  assert.ok(trims.has("Sport"));
});

test("no ZIP: the reply says it searched nationwide and asks for a ZIP for local results", opts, async () => {
  const txt = textOf(await call(36, { make: "Honda", model: "Civic" }));
  assert.match(txt, /No location was specified, so this search covers listings nationwide rather than a specific area\. Tell me a ZIP code for local results\./);
});

test("vehicleType is no longer an input: an older caller's value becomes the body style when none is given, and bodyType wins when both are sent", opts, async () => {
  const b = textOf(await call(38, { vehicleType: "Hatchback" }));
  assert.match(b, /^Searched: [^\n]*body style Hatchback/);
  const a = textOf(await call(37, { bodyType: "SUV", vehicleType: "Hatchback", priceMax: 50000 }));
  assert.match(a, /^Searched: [^\n]*body style SUV/);
  assert.ok(!/Hatchback/.test(a.split("\n")[0]));
});

test("the link tool is listed under its new name only; the old name still works as a hidden alias", opts, async () => {
  const list = await rpc({ jsonrpc: "2.0", id: 40, method: "tools/list" });
  const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("get_edmunds_vehicle_link"), `listed: ${names.join(", ")}`);
  assert.ok(!names.includes("resolve_dealer_url"), "the old name must not be listed");
  const args = { vin: vinFor(1), make: "Honda", model: "Civic", year: 2022 };
  for (const [id, name] of [[41, "get_edmunds_vehicle_link"], [42, "resolve_dealer_url"]] as Array<[number, string]>) {
    const out = await callTool(id, name, args);
    assert.notEqual(out.result.isError, true, `${name} must work`);
    assert.match(textOf(out), /https:\/\/edmunds\.sjv\.io\//, `${name} returns a link`);
  }
});

test("the 'search wider' offer never uses the word nationwide (Lite reads it as the search scope)", opts, async () => {
  const txt = textOf(await call(43, { make: "Honda", model: "Civic", zip: "90210", radiusMiles: 100 }));
  assert.match(txt, /Want me to search wider\? Ask for the whole state or the whole country/);
  assert.ok(!/nationwide/i.test(txt));
});

test("slips an AI makes are repaired instead of returning an error (null, text numbers, list for text, text for list, unknown field)", opts, async () => {
  const shapes: Array<[number, Record<string, unknown>]> = [
    [50, { make: "Honda", model: "Civic", zip: null, priceMax: 90000 }],
    [51, { make: "Honda", model: "Civic", priceMax: "90000" }],
    [52, { make: "Honda", model: ["Civic", "Accord"], priceMax: 90000 }],
    [53, { make: "Honda", model: "Civic", vehicleNeeds: "commuter car" }],
    [54, { make: "Honda", model: "Civic", minSeats: 5 }],
    [55, { make: "Honda", model: "Civic", used: "true", yearMin: "2018" }],
  ];
  for (const [id, args] of shapes) {
    const out = await call(id, args);
    assert.notEqual(out.result.isError, true, `shape ${JSON.stringify(args)} must not error: ${textOf(out).slice(0, 120)}`);
    assert.match(textOf(out), /Found \d+ closely matching|No vehicles matched|No location was specified/, `shape ${JSON.stringify(args)} gives a normal answer`);
  }
});

test("inputs that cannot be used are set aside and the reply says so; fixed-choice slips are repaired or reported", opts, async () => {
  const cases: Array<[number, Record<string, unknown>, RegExp | null]> = [
    [60, { make: "Honda", model: "Civic", priorityAxis: "", priceFlexibility: "", transmission: "", electrificationRequirement: "" }, null],
    [61, { make: "Honda", model: "Civic", priorityAxis: "Best for budget", priceFlexibility: "Strict" }, null],
    [62, { make: "Honda", model: "Civic", priorityAxis: "best_value" }, /^Note: these inputs could not be used and were ignored: priorityAxis/],
    [63, { make: "Honda", model: "Civic", radiusMiles: "Any", zip: "90210" }, /^Note: these inputs could not be used and were ignored: radiusMiles/],
    [64, { make: "Honda", model: "Civic", electrificationRequirement: "preferred" }, /electrificationRequirement/],
    [65, { make: "Honda", model: "Civic", priorityAxis: "lower_risk" }, /^Note: these inputs could not be used and were ignored: priorityAxis \(value not accepted\)/], // accepted by the repair, rejected by this tool, set aside by the retry
  ];
  for (const [id, args, note] of cases) {
    const out = await call(id, args);
    assert.notEqual(out.result.isError, true, `${JSON.stringify(args)} must not error: ${textOf(out).slice(0, 140)}`);
    const txt = textOf(out);
    assert.match(txt, /Found \d+ closely matching|No vehicles matched|No location was specified/, `${JSON.stringify(args)} gives a normal answer`);
    if (note) assert.match(txt, note, `${JSON.stringify(args)} says what was ignored`); else assert.ok(!/^Note: these inputs/.test(txt), `${JSON.stringify(args)} needs no note`);
  }
});

// Published-schema conformance: the Anthropic API's MCP connector rejects a reply whose structuredContent has a field the published
// outputSchema does not declare ("Tool output schema validation failed ('additionalProperties')"). This walks a real reply against the
// published JSON schema and lists every undeclared field.
function extraProps(schema: any, value: any, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const alts = schema.anyOf ?? schema.oneOf;
  if (alts) { const r = alts.map((a: any) => extraProps(a, value, path)); return r.some((x: string[]) => x.length === 0) ? [] : r[0]; }
  if (Array.isArray(value)) return schema.items ? value.flatMap((v: any, i: number) => extraProps(schema.items, v, `${path}[${i}]`)) : [];
  if (value && typeof value === "object") {
    const props = schema.properties ?? {}; const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...extraProps(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}`);
    }
    return out;
  }
  return [];
}

test("every reply's structured data matches the published output schema (no undeclared fields)", opts, async () => {
  const list: any = await rpc({ jsonrpc: "2.0", id: 70, method: "tools/list" });
  const schema = list.result.tools.find((t: any) => t.name === "find_matching_vehicle").outputSchema;
  assert.ok(schema, "find_matching_vehicle publishes an output schema");
  const scenarios: Array<Record<string, unknown>> = [
    { make: "Honda", model: "Civic", zip: "90210" },
    { make: "Honda", model: "Civic" },
    { make: "Honda", model: "Civic", priceMax: 1000, zip: "90210" },
    { vin: vinFor(1) },
    { vin: "1C4RJFBG3KC123456" },
    { bodyType: "SUV", priceMax: 90000 },
  ];
  let id = 71;
  for (const args of scenarios) {
    const out: any = await call(id++, args);
    const sc = out.result.structuredContent;
    if (!sc) continue;
    const extra = extraProps(schema, sc);
    assert.deepEqual(extra, [], `${JSON.stringify(args)} has fields the published schema does not declare: ${[...new Set(extra.map((e) => e.replace(/\[\d+\]/g, "[]")))].join(", ")}`);
  }
});
