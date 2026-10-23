// Round 4 review fixes (23 Oct 2026), offline: request limits (R4-01), the star rating for one car (R4-02), shared in-flight lookups (R4-09), flagged prices in comparisons (R4-06).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readBodyCapped, argumentLimitProblem, requestLimitProblem, MAX_REQUEST_BODY_BYTES, ARGUMENT_LIMITS, ENVELOPE_LIMITS } from "../lib/request-limits";
import { lookupModelYearSafety, attachNhtsaRatings, resetNhtsaRatingCacheForTests } from "../lib/nhtsa-ratings";
import { buildComparison } from "../lib/compare";

// ---------------- R4-01 ----------------
const req = (body: string | Uint8Array | null, headers: Record<string, string> = {}) => new Request("http://localhost/mcp", { method: "POST", body: body as BodyInit | null, headers });
test("R4-01: a body within the limit is read; empty is empty", async () => {
  assert.equal(await readBodyCapped(req('{"a":1}')), '{"a":1}'); assert.equal(await readBodyCapped(req(null)), "");
  assert.equal(await readBodyCapped(req("é".repeat(1000))), "é".repeat(1000), "multi-byte text survives");
});
test("R4-01: a body over the limit is refused, whether content-length says so or is missing or lies", async () => {
  const big = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
  assert.equal(await readBodyCapped(req(big)), null, "actual size over the cap");
  assert.equal(await readBodyCapped(req("small", { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) })), null, "declared size over the cap, without reading");
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 70; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
  assert.equal(await readBodyCapped(new Request("http://localhost/mcp", { method: "POST", body: stream, duplex: "half" } as RequestInit)), null, "a stream with no content-length is cut off at the cap");
  assert.equal(await readBodyCapped(req("x".repeat(MAX_REQUEST_BODY_BYTES))), "x".repeat(MAX_REQUEST_BODY_BYTES), "exactly the limit is allowed");
});
const call = (args: unknown, meta?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_matching_vehicle", arguments: args, ...(meta !== undefined ? { _meta: meta } : {}) } });
const probArgs = (args: unknown, meta?: unknown) => requestLimitProblem(call(args, meta));
test("R4-01: ordinary tool calls are far inside the limits", () => {
  assert.equal(probArgs(({ make: "Toyota", model: Array.from({ length: 30 }, (_, i) => `Model ${i}`).join(", "), electrificationTypes: ["hybrid", "plug_in_hybrid", "electric"], vehicleNeeds: ["large family SUV", "commuter car"], priceMax: 40000, zip: "90210" })), null);
  assert.equal(probArgs(({ vins: ["1HGCV1F3XJA000001", "1HGCV1F3XJA000002", "1HGCV1F3XJA000003", "1HGCV1F3XJA000004"] })), null);
  assert.equal(requestLimitProblem(call({})), null, "an empty call");
});
test("R4-01: too many values, too long a list, too deep, too long a text, too many fields are all refused with a reason", () => {
  const L = ARGUMENT_LIMITS;
  assert.match(probArgs(({ vehicleNeeds: new Array(L.maxArrayLength + 1).fill("a") }))!, /list of more than 200 items/);
  assert.equal(probArgs(({ vehicleNeeds: new Array(L.maxArrayLength).fill("a") })), null, "exactly the list limit is allowed");
  assert.match(probArgs(({ a: Array.from({ length: 10 }, () => new Array(190).fill(1)) }))!, /more than 1500 values/);
  assert.match(probArgs(({ a: [[[[[[1]]]]]] }))!, /nesting deeper than 6 levels/);
  assert.match(probArgs(({ model: "x".repeat(L.maxStringLength + 1) }))!, /text value longer than 4000/);
  assert.match(probArgs((Object.fromEntries(Array.from({ length: L.maxObjectKeys + 1 }, (_, i) => [`k${i}`, 1]))))!, /more than 100 fields/);
});
test("R4-01: a value nested 20,000 levels deep is refused without overflowing the stack, and a million-element list is refused at once", () => {
  let deep: unknown = 1; for (let i = 0; i < 20000; i++) deep = [deep];
  const t = Date.now(); assert.match(argumentLimitProblem(deep)!, /nesting deeper/);
  assert.match(probArgs(({ vehicleNeeds: new Array(1_000_000).fill(1) }))!, /list of more than 200 items/);
  assert.ok(Date.now() - t < 500, "refusal is immediate");
});

test("R4-01: the SDK is a patched version (2.3.0 or later) in package.json and in the lockfile, and the route sets the SDK's own input guard", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")), lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const ver = (v: string): number[] => v.replace(/^[^0-9]*/, "").split(".").map(Number);
  const atLeast = (a: number[], b: number[]): boolean => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]);
  assert.ok(atLeast(ver(pkg.dependencies["@modelcontextprotocol/server"]), [2, 3, 0]), "the range must not allow a vulnerable version");
  assert.ok(atLeast(ver(lock.packages["node_modules/@modelcontextprotocol/server"].version), [2, 3, 0]), "the locked version is patched");
  assert.match(readFileSync("app/[transport]/route.ts", "utf8"), /maxToolInputElements: 200/, "upgrading alone changes nothing: the guard is an option that is off unless set");
});

// ---------------- R4-02 and R4-09: mocked NHTSA ----------------
type Route = (url: string) => unknown | null;
function mockNhtsa(route: Route, delayMs = 0) {
  const real = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (url: string) => { calls.push(String(url)); if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); const r = route(String(url)); return r == null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r }; }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; resetNhtsaRatingCacheForTests(); } };
}
const variants = (model: string, vs: Array<[number, string, string]>): Route => (u) => {
  if (u.includes("/modelyear/")) return { Count: vs.length, Results: vs.map(([id, d]) => ({ VehicleId: id, VehicleDescription: d })) };
  const hit = vs.find(([id]) => u.includes(`/VehicleId/${id}?`)); return hit ? { Count: 1, Results: [{ VehicleId: hit[0], VehicleDescription: hit[1], OverallRating: hit[2], RecallsCount: 3 }] } : null;
};
test("R4-02: an FWD car whose own variant is 'Not Rated' is NOT given the AWD variant's 5 stars (the real Grand Highlander data shape)", async () => {
  const m = mockNhtsa(variants("GH", [[20286, "2025 Toyota Grand Highlander SUV FWD", "Not Rated"], [20287, "2025 Toyota Grand Highlander SUV AWD", "5"]]));
  try {
    assert.deepEqual(await lookupModelYearSafety(2025, "TOYOTA", "GRAND HIGHLANDER", "FWD"), { overall: null, recallCampaigns: 3 }, "unrated stays unknown; the recall count is still reported");
    assert.deepEqual(await lookupModelYearSafety(2025, "TOYOTA", "GRAND HIGHLANDER", "AWD"), { overall: 5, recallCampaigns: 3 }, "the AWD car keeps its own 5 stars");
    assert.deepEqual(await lookupModelYearSafety(2025, "TOYOTA", "GRAND HIGHLANDER", null), { overall: null, recallCampaigns: 3 }, "drive type unknown, rated and unrated variants: unknown");
  } finally { m.restore(); }
});
test("R4-02: the rules that did not change: all rated and agreeing, matching variants narrow the answer, disagreement is unknown, no drive match falls back to all", async () => {
  const run = async (vs: Array<[number, string, string]>, drive: string | null) => { const m = mockNhtsa(variants("X", vs)); try { return (await lookupModelYearSafety(2024, "FORD", "TESTMODEL" + vs.length + drive, drive))?.overall ?? null; } finally { m.restore(); } };
  assert.equal(await run([[1, "2024 Ford T SUV FWD", "5"], [2, "2024 Ford T SUV AWD", "5"]], null), 5, "all rated, all agree");
  assert.equal(await run([[1, "2024 Ford T SUV FWD", "4"], [2, "2024 Ford T SUV AWD", "5"]], "AWD"), 5, "the AWD variant answers for an AWD car");
  assert.equal(await run([[1, "2024 Ford T SUV FWD", "4"], [2, "2024 Ford T SUV AWD", "5"]], "FWD"), 4, "the FWD variant answers for an FWD car");
  assert.equal(await run([[1, "2024 Ford T SUV FWD", "4"], [2, "2024 Ford T SUV AWD", "5"]], null), null, "they disagree and the drive type is unknown");
  assert.equal(await run([[1, "2024 Ford T SUV", "5"], [2, "2024 Ford T Coupe", "5"]], "AWD"), 5, "no variant names a drive type: all of them apply, and they agree");
  assert.equal(await run([[1, "2024 Ford T SUV", "5"], [2, "2024 Ford T Coupe", "Not Rated"]], "AWD"), null, "no drive match, and one of the applicable variants is unrated: unknown");
  assert.equal(await run([[1, "2024 Ford T SUV FWD", "Not Rated"], [2, "2024 Ford T SUV AWD", "Not Rated"]], "FWD"), null, "wholly unrated");
  assert.equal(await run([[1, "2024 Ford T SUV 4WD", "3"], [2, "2024 Ford T SUV FWD", "Not Rated"]], "4WD"), 3, "4WD matches 4X4 wording too, and the unrated FWD does not apply to a 4WD car");
});
test("R4-09: eight cars of the same model year share ONE lookup (a list and each variant once), and a warm repeat makes none", async () => {
  const m = mockNhtsa(variants("S", [[501, "2025 Honda ShareTest SUV FWD", "5"], [502, "2025 Honda ShareTest SUV AWD", "5"]]), 15);
  try {
    const eight = Array.from({ length: 8 }, () => ({ modelYear: "2025", make: "HONDA", model: "SHARETEST", specs: { driveType: "AWD" } }));
    const out = await attachNhtsaRatings(eight as never[]);
    assert.equal(m.calls.length, 3, `1 list + 2 variants, got ${m.calls.length}: ${m.calls.join(" | ")}`); assert.equal(new Set(m.calls).size, 3);
    assert.ok(out.every((r: any) => r?.rating?.overall === 5), "every car still gets its rating");
    m.calls.length = 0; await attachNhtsaRatings(eight as never[]); assert.equal(m.calls.length, 0, "the finished result is cached as before");
  } finally { m.restore(); }
});
test("R4-09: each car still picks its OWN drive type from the shared lookup", async () => {
  const m = mockNhtsa(variants("S", [[601, "2025 Honda OwnDrive SUV FWD", "4"], [602, "2025 Honda OwnDrive SUV AWD", "5"]]), 10);
  try {
    const cars = ["FWD", "AWD", "FWD", "AWD"].map((d) => ({ modelYear: "2025", make: "HONDA", model: "OWNDRIVE", specs: { driveType: d } }));
    const out: any[] = await attachNhtsaRatings(cars as never[]); assert.deepEqual(out.map((r) => r.rating.overall), [4, 5, 4, 5]); assert.equal(m.calls.length, 3);
  } finally { m.restore(); }
});
test("R4-09: a failed lookup is shared by the cars asking at that moment but is not remembered: the next request tries again", async () => {
  let fail = true;
  const m = mockNhtsa((u) => (fail ? null : variants("S", [[701, "2025 Honda Retry SUV AWD", "5"]])(u)), 10);
  try {
    const cars = Array.from({ length: 5 }, () => ({ modelYear: "2025", make: "HONDA", model: "RETRY", specs: { driveType: "AWD" } }));
    const first: any[] = await attachNhtsaRatings(cars as never[]); assert.ok(first.every((r) => r.rating == null)); assert.equal(m.calls.length, 1, "one failed list request, shared");
    fail = false; m.calls.length = 0;
    const second: any[] = await attachNhtsaRatings(cars as never[]); assert.ok(second.every((r) => r.rating?.overall === 5), "the failure was not cached"); assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

// ---------------- R4-06 ----------------
const price = (rows: ReturnType<typeof buildComparison>) => rows.find((r) => r.label === "Price")!;
test("R4-06: a flagged price is shown but is never the best, the lowest or the highest, and the row says so", () => {
  const r = price(buildComparison([{ vin: "A", price: 35000 }, { vin: "B", price: 85, priceLikelyInaccurate: true }, { vin: "C", price: 38000 }]));
  assert.deepEqual(r.values, ["$35,000", "$85", "$38,000"]); assert.deepEqual(r.best, [0]);
  assert.equal(r.note, "lowest #1; highest #3; spread $3,000; #2 looks like a data error and is not counted");
});
test("R4-06: without a flag nothing changes; with only one unflagged price there is no best", () => {
  assert.deepEqual(price(buildComparison([{ vin: "A", price: 35000 }, { vin: "B", price: 85 }])).best, [1], "a real $85 car (no flag) is still the best price, as before");
  const r = price(buildComparison([{ vin: "A", price: 35000 }, { vin: "B", price: 85, priceLikelyInaccurate: true }]));
  assert.equal(r.best, undefined); assert.equal(r.note, "#2 looks like a data error and is not counted");
  const both = price(buildComparison([{ vin: "A", price: 90, priceLikelyInaccurate: true }, { vin: "B", price: 85, priceLikelyInaccurate: true }]));
  assert.equal(both.best, undefined); assert.equal(both.note, "#1, #2 look like a data error and are not counted");
});

// ---- the fix of 23 Oct 2026: ChatGPT's request has nested metadata around the tool arguments ----
const chatgptMeta = () => ({
  "openai/userLocation": { city: "Brisbane", region: "Queensland", country: "AU", timezone: "Australia/Brisbane", longitude: 153.02, latitude: -27.47 },
  "openai/locale": "en-AU", "openai/userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "openai/subject": "v1/abcdef0123456789", "openai/session": "v1/0123456789abcdef", progressToken: 7,
  "openai/widgetSession": { id: "w1", state: { view: { panel: { section: { item: { leaf: { value: 1 } } } } } } }, // nested 9 levels below the message
});
test("the fix: a request whose METADATA is nested deeper than 6 levels is accepted when the tool arguments are ordinary (this is what ChatGPT sends)", () => {
  assert.equal(probArgs({ make: "Honda", model: "CR-V", used: false, zip: "90210", electrificationTypes: ["hybrid"] }, chatgptMeta()), null);
  assert.equal(probArgs({}, { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }), null, "eight levels of metadata");
  assert.equal(requestLimitProblem({ jsonrpc: "2.0", id: "x", method: "tools/list", params: { _meta: chatgptMeta() } }), null, "a message with no arguments at all");
});
test("the fix: the strict limits still apply to the tool arguments, whatever the metadata looks like", () => {
  assert.match(probArgs({ a: [[[[[[1]]]]]] }, chatgptMeta())!, /nesting deeper than 6 levels/);
  assert.match(probArgs({ vehicleNeeds: new Array(ARGUMENT_LIMITS.maxArrayLength + 1).fill("a") }, chatgptMeta())!, /list of more than 200 items/);
  assert.match(probArgs({ model: "x".repeat(ARGUMENT_LIMITS.maxStringLength + 1) })!, /text value longer than 4000/);
});
test("the fix: the metadata is still bounded (a hostile caller cannot hide cost there): depth, size, list length and text length", () => {
  let deep: unknown = 1; for (let i = 0; i < ENVELOPE_LIMITS.maxDepth + 2; i++) deep = { n: deep };
  assert.match(probArgs({}, deep)!, /^the request's own metadata has nesting deeper than 32 levels$/);
  assert.match(probArgs({}, { list: new Array(ENVELOPE_LIMITS.maxArrayLength + 1).fill(1) })!, /metadata has a list of more than 1000 items/);
  assert.match(probArgs({}, Array.from({ length: 5 }, () => new Array(900).fill(1)))!, /metadata has more than 4000 values/);
  assert.match(probArgs({}, { s: "x".repeat(ENVELOPE_LIMITS.maxStringLength + 1) })!, /metadata has a text value longer than 32000/);
  assert.match(requestLimitProblem({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" }, extra: new Array(5000).fill(1) })!, /metadata has a list of more than 1000 items/, "an oversized field outside params too");
});
test("the fix: a deeply nested metadata value does not overflow the stack", () => {
  let deep: unknown = 1; for (let i = 0; i < 20000; i++) deep = [deep];
  assert.match(probArgs({}, deep)!, /metadata has nesting deeper/);
});
