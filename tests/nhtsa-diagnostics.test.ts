// Group 1, design 3 (9 Nov 2026), steps A and B. Run: npx tsx --test tests/nhtsa-diagnostics.test.ts
// Needs no network: global fetch is replaced. Step B: the honest identity header only when NHTSA_SEND_HEADERS=1. Step A: four new fields at the END of the failure line,
// the original text of the line unchanged, no VIN, a bad or missing caller reads "unknown", cache hits are not counted as requests to NHTSA.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeNhtsaElectrification, decodePoolInBatches, runWithNhtsaLedger, resetNhtsaCacheForTests, setNhtsaCallerProvider, resetNhtsaDiagnosticsForTests, NHTSA_USER_AGENT } from "../lib/nhtsa-client";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const lines: string[] = [];
let calls: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
const VINS = ["1HGCM82633A004352", "1HGCM82633A004353", "1HGCM82633A004354", "1HGCM82633A004355", "1HGCM82633A004356", "1HGCM82633A004357", "1HGCM82633A004358", "1HGCM82633A004359"];
const healthy = () => new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", EngineCylinders: "4", FuelTypePrimary: "Gasoline", FuelTypeSecondary: "", ElectrificationLevel: "", Series: "" }] }), { status: 200 });
let respond: () => Response = () => new Response("", { status: 403 });

beforeEach(() => {
  lines.length = 0; calls = []; respond = () => new Response("", { status: 403 });
  resetNhtsaCacheForTests(); resetNhtsaDiagnosticsForTests(); delete process.env.NHTSA_SEND_HEADERS;
  globalThis.fetch = (async (url: unknown, init?: Record<string, unknown>) => { calls.push({ url: String(url), init }); return respond(); }) as typeof fetch;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
});
afterEach(() => { globalThis.fetch = realFetch; console.warn = realWarn; delete process.env.NHTSA_SEND_HEADERS; setNhtsaCallerProvider(null); });

const pool = () => VINS.map((vin) => ({ vin, vehicle: { make: "Honda", model: "Accord", cylinders: 4 } }));

test("step B: with the switch off the request is exactly as before (a signal, no headers at all)", async () => {
  await decodeNhtsaElectrification(VINS[0], "Honda", "Accord", 4);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/"));
  assert.ok(calls[0].init && "signal" in calls[0].init);
  assert.ok(!("headers" in (calls[0].init as object)), "no headers key when the switch is off");
});

test("step B: with NHTSA_SEND_HEADERS=1 the request names this service honestly and asks for JSON", async () => {
  process.env.NHTSA_SEND_HEADERS = "1";
  await decodeNhtsaElectrification(VINS[0], "Honda", "Accord", 4);
  assert.deepEqual(calls[0].init!.headers, { "User-Agent": "CarClever/1.0 (+https://getcarwise.app)", Accept: "application/json" });
  assert.equal(NHTSA_USER_AGENT, "CarClever/1.0 (+https://getcarwise.app)");
  assert.ok(!/mozilla|chrome|safari|applewebkit/i.test(NHTSA_USER_AGENT), "never imitates a browser");
  assert.ok("signal" in calls[0].init!, "the timeout signal is still there");
});

test("step B: any value other than 1 keeps the switch off", async () => {
  for (const v of ["0", "true", "yes", ""]) { process.env.NHTSA_SEND_HEADERS = v; calls = []; resetNhtsaCacheForTests(); await decodeNhtsaElectrification(VINS[0], "Honda", "Accord", 4); assert.ok(!("headers" in (calls[0].init as object)), `value "${v}" must not switch it on`); }
});

test("step A: the failure line keeps its original text and appends caller, asked, span_ms and since_prev", async () => {
  setNhtsaCallerProvider(() => "chatgpt");
  await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
  assert.equal(lines.length, 1, "one line per request");
  assert.ok(lines[0].startsWith('[nhtsa-failures] {"http_403":8} breaker=open'), "the original text is first and unchanged");
  assert.match(lines[0], /^\[nhtsa-failures\] \{"http_403":8\} breaker=open caller=chatgpt asked=8 span_ms=\d+ since_prev=first$/);
  for (const v of VINS) assert.ok(!lines[0].includes(v), "no VIN in the line");
});

test("step A: the second failing request reports seconds since the previous one", async () => {
  await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
  resetNhtsaCacheForTests(); lines.length = 0;
  await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
  assert.match(lines[0], / since_prev=\d+s$/);
});

test("step A: a missing, odd or throwing caller provider reads unknown", async () => {
  for (const provider of [null, () => "evil caller; DROP TABLE", () => 42 as unknown as string, () => { throw new Error("boom"); }, () => null]) {
    setNhtsaCallerProvider(provider as never); resetNhtsaCacheForTests(); resetNhtsaDiagnosticsForTests(); setNhtsaCallerProvider(provider as never); lines.length = 0;
    await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
    assert.match(lines[0], / caller=unknown /, "anything outside the five known classes is written as unknown");
  }
  for (const known of ["claude", "chatgpt", "grok", "other"]) {
    setNhtsaCallerProvider(() => known); resetNhtsaCacheForTests(); lines.length = 0;
    await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
    assert.match(lines[0], new RegExp(` caller=${known} `));
  }
});

test("step A: cache hits are not counted as requests to NHTSA", async () => {
  respond = healthy;
  await decodeNhtsaElectrification(VINS[0], "Honda", "Accord", 4);
  assert.equal(calls.length, 1, "the first decode asks NHTSA and caches the answer");
  respond = () => new Response("", { status: 403 }); calls = []; lines.length = 0;
  await runWithNhtsaLedger(async () => { await Promise.all([VINS[0], VINS[1], VINS[2]].map((v) => decodeNhtsaElectrification(v, "Honda", "Accord", 4))); });
  assert.equal(calls.length, 2, "the cached VIN is not sent again");
  assert.match(lines[0], /^\[nhtsa-failures\] \{"http_403":2\} caller=unknown asked=2 span_ms=\d+ since_prev=first$/);
});

test("step A: a healthy request writes no failure line at all", async () => {
  respond = healthy;
  await runWithNhtsaLedger(async () => { await Promise.all(VINS.slice(0, 4).map((v) => decodeNhtsaElectrification(v, "Honda", "Accord", 4))); });
  assert.equal(lines.filter((l) => l.startsWith("[nhtsa-failures]")).length, 0);
});

test("step A: a timeout is still classed as a timeout and counted as asked", async () => {
  globalThis.fetch = (async (url: unknown, init?: Record<string, unknown>) => { calls.push({ url: String(url), init }); throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }) as typeof fetch;
  await runWithNhtsaLedger(async () => { await decodePoolInBatches(pool(), () => false); });
  assert.match(lines[0], /^\[nhtsa-failures\] \{"timeout":8\} breaker=open caller=unknown asked=8 span_ms=\d+ since_prev=first$/);
});
