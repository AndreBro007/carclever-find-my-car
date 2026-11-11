import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  callerClass, envFromHost, usageEnabled, intentLabel, usageAttributes, searchOutcome, checkOutcome, compareOutcome, linkOutcome,
  instrumentTools, runWithUsageContext, noteListenMessages, noteListenOutcome, countListenMessages, noteToolValidationFailure, usageDiagnostics, sanitizeUsageEvent, bodyStyleOf, BODY_STYLES, INTENT_LABELS, OUTCOMES, _resetDiagnosticsForTests, DIAG_WARN_INTERVAL_MS,
  flushUsageForTests, _setPoolForTests, ensureUsageTables, runUsageRetention, USAGE_LABEL_VERSION,
} from "../lib/usage-events";
import { runWithNhtsaLedger, decodeNhtsaElectrification, resetNhtsaCacheForTests } from "../lib/nhtsa-client";
import { assertDisposableDatabase, disposableUrlProblem, withDisposableDatabase, type PoolLike } from "./helpers/disposable-db";

const req = (host: string, ua: string | null) => new Request("https://x.test/mcp", { method: "POST", headers: { host, ...(ua ? { "user-agent": ua } : {}) } });
const TEST_HOST = "carclever-db-test.getcarwise.app";
interface Call { sql: string; params?: unknown[] }
function fakePool(failFirst = 0) {
  const calls: Call[] = []; let n = 0;
  return { calls, query: async (sql: string, params?: unknown[]) => { n++; if (n <= failFirst) throw new Error("db down"); calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
}
const inserts = (p: { calls: Call[] }) => p.calls.filter((c) => c.sql.includes("INSERT INTO usage_event"));
const searchResult = (cards: number, total: number | null = 221) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { meta: { totalMatches: total, serviceError: null }, results: Array.from({ length: cards }, () => ({})) } });

test("caller class and host mapping (recognised, unverified; unknown is the fallback)", () => {
  assert.equal(callerClass("Claude-User"), "claude");
  assert.equal(callerClass("openai-mcp/1.0.0 (Codex)"), "chatgpt");
  assert.equal(callerClass("grok-connectors-manager/0.1.0"), "grok");
  assert.equal(callerClass("node"), "other");
  assert.equal(callerClass(""), "unknown"); assert.equal(callerClass(null), "unknown");
  assert.equal(envFromHost("carclever-db-test.getcarwise.app"), "test");
  assert.equal(envFromHost("carclever-db.getcarwise.app:443"), "live");
  assert.equal(envFromHost("somewhere.else"), "unknown"); assert.equal(envFromHost(null), "unknown");
});

test("events are on for the test host only unless USAGE_EVENTS_ENABLED=1", () => {
  const prev = process.env.USAGE_EVENTS_ENABLED; delete process.env.USAGE_EVENTS_ENABLED;
  assert.equal(usageEnabled("test"), true); assert.equal(usageEnabled("live"), false); assert.equal(usageEnabled("unknown"), false);
  process.env.USAGE_EVENTS_ENABLED = "1"; assert.equal(usageEnabled("live"), true);
  if (prev === undefined) delete process.env.USAGE_EVENTS_ENABLED; else process.env.USAGE_EVENTS_ENABLED = prev;
});

test("intent label: an explicit value request always wins; SUV is not family; low budget is not commute", () => {
  assert.equal(intentLabel({ vehicleNeeds: ["family SUV, best value"] }), "value");
  assert.equal(intentLabel({ seatsMinPreference: 7, vehicleNeeds: ["good value three-row"] }), "value");
  assert.equal(intentLabel({ vehicleNeeds: "most for my money" }), "value");
  assert.equal(intentLabel({ vehicleNeeds: ["value"] }), "value");
  assert.equal(intentLabel({ seatsMinPreference: 7 }), "three_row");
  assert.equal(intentLabel({ vehicleNeeds: ["seven-seat family"] }), "three_row");
  assert.equal(intentLabel({ bodyType: "Truck" }), "truck");
  assert.equal(intentLabel({ vehicleNeeds: ["towing a boat"] }), "truck");
  assert.equal(intentLabel({ electrificationTypes: ["electric"] }), "electric");
  assert.equal(intentLabel({ electrificationTypes: ["hybrid"] }), "hybrid");
  assert.equal(intentLabel({ vehicleNeeds: ["family car for the kids"] }), "family");
  assert.equal(intentLabel({ vehicleNeeds: ["daily commute"] }), "commute");
  assert.equal(intentLabel({ vehicleNeeds: ["luxury sedan"] }), "luxury");
  assert.equal(intentLabel({ bodyType: "SUV" }), "unknown");
  assert.equal(intentLabel({}), "unknown");
});

test("attributes carry no VIN, ZIP, raw need text or caller string", () => {
  const a = usageAttributes({ make: "Honda", model: "CR-V", bodyType: "SUV", condition: "used", priceMax: 30000, zip: "90210", vin: "2HKRS4H24SH442431", vehicleNeeds: ["secret family detail"], seatsMinPreference: 7, priceMin: 5000 });
  assert.deepEqual(a, { body_style: "suv", price_band: "25k to 40k", condition: "used", make_given: true, model_given: true, filter_count: 3 });
  const j = JSON.stringify(a); assert.ok(!j.includes("90210") && !j.includes("2HKRS") && !j.includes("secret") && !j.includes("Honda") && !j.includes("CR-V"));
});

test("outcomes follow the P2 definitions per tool", () => {
  assert.deepEqual(searchOutcome(searchResult(8)), { outcome: "results", found: 221, shown: 8 });
  assert.deepEqual(searchOutcome(searchResult(0, 0)), { outcome: "none", found: 0, shown: 0 });
  assert.deepEqual(searchOutcome(searchResult(8, null)), { outcome: "results", found: null, shown: 8 });
  assert.equal(searchOutcome({ isError: true, content: [] }).outcome, "error");
  const ident = { make: "Ford", model: "Explorer", year: 2026 };
  assert.equal(checkOutcome({ structuredContent: { meta: {}, results: [{ identity: ident, buyerCheck: { recall: { state: "routine" } } }] } }), "decoded_recall_known");
  assert.equal(checkOutcome({ structuredContent: { meta: {}, results: [{ identity: ident, buyerCheck: { recall: { state: "unavailable" } } }] } }), "decoded_recall_unknown");
  assert.equal(checkOutcome({ content: [{ text: "Recall details (NHTSA, 14 total): ..." }], structuredContent: { meta: {}, results: [{ identity: ident }] } }), "decoded_recall_known");
  assert.equal(checkOutcome({ structuredContent: { meta: {}, results: [{ identity: ident }] } }), "decoded_recall_unknown");
  assert.equal(checkOutcome({ structuredContent: { meta: {}, results: [{ identity: { vin: "x" } }] } }), "not_decoded");
  assert.equal(checkOutcome({ content: [{ text: "not a valid VIN" }] }), "not_decoded");
  assert.equal(checkOutcome({ isError: true }), "error");
  assert.equal(compareOutcome({ structuredContent: { meta: {}, results: [{}, {}] } }), "produced");
  assert.equal(compareOutcome({ isError: true }), "error");
  assert.equal(linkOutcome({ structuredContent: { affiliateUrl: "https://e.test/x" } }), "generated");
  assert.equal(linkOutcome({ structuredContent: {} }), "error");
});

test("a wrapped tool returns the very same result and records one event after the answer", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  const registered: Record<string, (...a: any[]) => Promise<unknown>> = {};
  const server = { registerTool: (name: string, _c: unknown, cb: (...a: any[]) => Promise<unknown>) => { registered[name] = cb; return { name }; } };
  instrumentTools(server);
  const result = searchResult(8);
  server.registerTool("find_matching_vehicle", {}, async () => result);
  server.registerTool("other_tool", {}, async () => "untouched");
  const out = await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => registered["find_matching_vehicle"]({ make: "Honda", model: "CR-V", zip: "90210", priceMax: 30000, vehicleNeeds: ["best value"] }));
  assert.equal(out, result);
  await flushUsageForTests();
  const ins = inserts(pool); assert.equal(ins.length, 1);
  const p = ins[0].params as unknown[];
  assert.deepEqual([p[0], p[1], p[2], p[3], p[4], p[5]], ["search", "results", "test", "claude", 221, 8]);
  assert.equal(p[12], "value"); assert.equal(p[13], USAGE_LABEL_VERSION);
  const text = JSON.stringify(p); assert.ok(!text.includes("90210") && !text.includes("Claude-User") && !text.includes("best value"));
  assert.equal(await registered["other_tool"]({}), "untouched");
  _setPoolForTests(null);
});

test("nothing is written for the live host or an unknown host by default", async () => {
  delete process.env.USAGE_EVENTS_ENABLED;
  const pool = fakePool(); _setPoolForTests(pool);
  const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
  server.registerTool("check_vehicle", {}, async () => ({ content: [] }));
  await runWithUsageContext(req("carclever-db.getcarwise.app", "Claude-User"), () => reg["check_vehicle"]({}));
  await runWithUsageContext(req("elsewhere.test", null), () => reg["check_vehicle"]({}));
  await flushUsageForTests(); assert.equal(pool.calls.length, 0);
  _setPoolForTests(null);
});

test("failure injection: a database failure never changes or breaks the tool answer, and logging recovers on the next call", async () => {
  const pool = fakePool(1); _setPoolForTests(pool); // the first query (table setup) fails
  const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
  const result = { content: [{ type: "text", text: "answer" }], structuredContent: { affiliateUrl: "https://e.test/x" } };
  server.registerTool("get_edmunds_vehicle_link", {}, async () => result);
  const a = await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg["get_edmunds_vehicle_link"]({}));
  assert.equal(a, result); await flushUsageForTests(); assert.equal(inserts(pool).length, 0);
  const b = await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg["get_edmunds_vehicle_link"]({}));
  assert.equal(b, result); await flushUsageForTests();
  assert.equal(inserts(pool).length, 1, "the table setup is retried after a failure, so the second call is recorded");
  _setPoolForTests(null);
});

test("a tool that throws still throws the same error, and is recorded as an error", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
  const boom = new Error("boom");
  server.registerTool("compare_vehicles", {}, async () => { throw boom; });
  await assert.rejects(() => runWithUsageContext(req(TEST_HOST, "node"), () => reg["compare_vehicles"]({})), (e) => e === boom);
  await flushUsageForTests();
  const p = inserts(pool)[0].params as unknown[]; assert.deepEqual([p[0], p[1], p[3]], ["compare", "error", "other"]);
  _setPoolForTests(null);
});

test("NHTSA failures are counted per tool call: nonzero for the search that had them, separate for a concurrent search, empty for tools that do not track them", async () => {
  const pool = fakePool(); _setPoolForTests(pool); resetNhtsaCacheForTests();
  const realFetch = globalThis.fetch; let nhtsaCalls = 0;
  globalThis.fetch = (async () => { nhtsaCalls++; return new Response("forbidden", { status: 403 }); }) as typeof fetch;
  const origWarn = console.warn; console.warn = () => undefined;
  try {
    const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
    const vins = (k: number, n: number) => Array.from({ length: n }, (_, i) => `1HGCV1F3${k}LA0000${String(i).padStart(2, "0")}`);
    server.registerTool("find_matching_vehicle", {}, async (a: { k: number; n: number }) => runWithNhtsaLedger(async () => { for (const v of vins(a.k, a.n)) await decodeNhtsaElectrification(v, "Honda", "Civic", 4); return searchResult(2); }));
    server.registerTool("compare_vehicles", {}, async () => ({ structuredContent: { meta: {}, results: [{}, {}] } }));
    const run = (name: string, args: unknown) => runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg[name](args));
    await Promise.all([run("find_matching_vehicle", { k: 1, n: 3 }), run("find_matching_vehicle", { k: 2, n: 5 }), run("compare_vehicles", {})]);
    await flushUsageForTests();
    assert.equal(nhtsaCalls, 8, "NHTSA was asked 8 times in total");
    const rows = inserts(pool).map((c) => c.params as unknown[]);
    const search = rows.filter((p) => p[0] === "search").map((p) => p[16]).sort();
    assert.deepEqual(search, [3, 5], "each search carries only its own failures, even when they run together");
    assert.equal(rows.find((p) => p[0] === "compare")![16], null, "a tool that does not track NHTSA failures leaves the column empty");
  } finally { globalThis.fetch = realFetch; console.warn = origWarn; _setPoolForTests(null); }
});

test("a search with no NHTSA failures records 0, not empty", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
  server.registerTool("find_matching_vehicle", {}, async () => runWithNhtsaLedger(async () => searchResult(1)));
  await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg["find_matching_vehicle"]({}));
  await flushUsageForTests();
  assert.equal((inserts(pool)[0].params as unknown[])[16], 0);
  _setPoolForTests(null);
});

test("write failures are reported as a code and a count only, at most once a minute, and never change the answer", async () => {
  _resetDiagnosticsForTests();
  const failing = { query: async () => { const e = new Error("password authentication failed for user secretuser at ep-secret-host"); (e as any).code = "28P01"; throw e; } };
  _setPoolForTests(failing);
  const warns: string[] = []; const origWarn = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  try {
    const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
    const result = searchResult(1); server.registerTool("find_matching_vehicle", {}, async () => result);
    for (let i = 0; i < 4; i++) { const out = await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg["find_matching_vehicle"]({})); assert.equal(out, result); await flushUsageForTests(); }
  } finally { console.warn = origWarn; _setPoolForTests(null); }
  const d = usageDiagnostics(); assert.equal(d.writeFailures, 4); assert.equal(d.lastCode, "28P01");
  assert.equal(warns.length, 1, "four failures inside one minute give one line");
  assert.match(warns[0], /\[usage-events\] event write failed \(code 28P01\); 1 write failures/);
  assert.ok(!/secretuser|secret-host|password/.test(warns[0]), "no error text or connection detail in the log line");
  assert.ok(DIAG_WARN_INTERVAL_MS >= 60000);
});

test("a call the SDK rejected for invalid input is recorded as invalid_input; unknown tool names are not", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  await runWithUsageContext(req(TEST_HOST, "openai-mcp/1.0.0"), async () => { noteToolValidationFailure("compare_vehicles", { vins: ["x"] }, 3); noteToolValidationFailure("find_matching_vehicle", { priceMax: "abc", make: "Honda" }, 4); noteToolValidationFailure("no_such_tool", {}, 1); });
  await flushUsageForTests();
  const rows = inserts(pool).map((c) => c.params as unknown[]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0][0], rows[0][1], rows[0][3], rows[0][15]], ["compare", "invalid_input", "chatgpt", 3]);
  assert.deepEqual([rows[1][0], rows[1][1]], ["search", "invalid_input"]);
  _setPoolForTests(null);
});

test("listen counting counts real subscriptions/listen messages only", () => {
  const listen = { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } };
  assert.equal(countListenMessages(JSON.stringify(listen)), 1);
  assert.equal(countListenMessages(JSON.stringify([listen, { ...listen, id: 2 }, { jsonrpc: "2.0", id: 3, method: "tools/list" }])), 2);
  assert.equal(countListenMessages(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { vehicleNeeds: ["subscriptions/listen"] } } })), 0, "a tool argument that mentions it is not a listen");
  assert.equal(countListenMessages(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "Subscriptions/Listen" })), 0);
  assert.equal(countListenMessages("subscriptions/listen but not json"), 0);
  assert.equal(countListenMessages(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" })), 0);
});

test("the destructive-test guard accepts local databases and refuses remote or real-looking ones", async () => {
  assert.equal(disposableUrlProblem("postgresql://u:p@127.0.0.1:5432/cc_test"), null);
  assert.equal(disposableUrlProblem("postgresql://u:p@localhost/anything"), null);
  assert.equal(disposableUrlProblem("postgresql://u:p@[::1]:5432/x"), null);
  assert.match(disposableUrlProblem("postgresql://u:p@ep-cool-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require")!, /not local/);
  assert.match(disposableUrlProblem("postgresql://u:p@db.example.com/prod_test", undefined)!, /not local/);
  assert.match(disposableUrlProblem("postgresql://u:p@db.example.com/prod_test", "other")!, /not local/);
  assert.match(disposableUrlProblem("postgresql://u:p@db.example.com/neondb", "neondb")!, /not local/, "an opt-in name must also contain test");
  assert.equal(disposableUrlProblem("postgresql://u:p@db.example.com/scratch_test", "scratch_test"), null);
  assert.match(disposableUrlProblem(undefined)!, /not set/); assert.match(disposableUrlProblem("not a url")!, /not a valid URL/); assert.match(disposableUrlProblem("postgresql://u:p@127.0.0.1:5432/")!, /no database/);
  const big = { query: async (sql: string) => sql.includes("to_regclass") ? { rows: [{ e: true }] } : { rows: [{ n: 1001 }] } };
  await assert.rejects(() => assertDisposableDatabase(big, "postgresql://u:p@127.0.0.1/cc_test"), /more than 1000 rows/);
  const small = { query: async (sql: string) => sql.includes("to_regclass") ? { rows: [{ e: true }] } : { rows: [{ n: 12 }] } };
  await assertDisposableDatabase(small, "postgresql://u:p@127.0.0.1/cc_test");
  await assert.rejects(() => assertDisposableDatabase(small, "postgresql://u:p@ep-x.neon.tech/neondb"), /not local/);
});

test("table setup is retried after a failure (T166)", async () => {
  const pool = fakePool(1); _setPoolForTests(pool);
  await assert.rejects(() => ensureUsageTables());
  await ensureUsageTables(); // second call succeeds
  assert.ok(pool.calls.length >= 4);
  _setPoolForTests(null);
});

test("listen requests are counted once the answer is known, one per POST request: 2xx as listen_accepted, anything else as listen_rejected, test host only", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  await runWithUsageContext(req(TEST_HOST, "Claude-User"), async () => { noteListenMessages(2); noteListenOutcome(200); }); // a batch with two listen messages is ONE request
  await runWithUsageContext(req(TEST_HOST, "Claude-User"), async () => { noteListenMessages(1); noteListenOutcome(400); });
  await runWithUsageContext(req(TEST_HOST, "Claude-User"), async () => { noteListenMessages(0); noteListenOutcome(200); });
  await runWithUsageContext(req("carclever-db.getcarwise.app", "Claude-User"), async () => { noteListenMessages(1); noteListenOutcome(200); });
  await flushUsageForTests();
  const bumps = pool.calls.filter((c) => c.sql.includes("INSERT INTO usage_counter"));
  assert.deepEqual(bumps.map((b) => b.params), [["test", "listen_accepted", 1], ["test", "listen_rejected", 1]]);
  _setPoolForTests(null);
});

function recordingPool(rowsInEachTable = 1001) {
  const stmts: string[] = []; const state = { ended: 0 };
  return { stmts, state, query: async (sql: string) => { stmts.push(sql); return sql.includes("to_regclass") ? { rows: [{ e: true }] } : { rows: [{ n: rowsInEachTable }] }; }, end: async () => { state.ended++; } };
}
const DESTRUCTIVE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE)\b/i;

test("guard refusal runs NO destructive statement and NO cleanup: not for a remote host, not for a real-sized table, not for a wrong opt-in", async () => {
  const body = async () => { throw new Error("the test body must not run after a refusal"); };
  const cleanupSql = ["DROP TABLE IF EXISTS listing, dealer, usage_event, usage_counter, usage_daily_summary CASCADE", "DELETE FROM search_log"];
  // 1) remote host: refused before any pool is opened
  let opened = 0;
  await assert.rejects(() => withDisposableDatabase("postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb", body, { cleanupSql, makePool: () => { opened++; return recordingPool(); } }), /not local/);
  assert.equal(opened, 0, "no connection is even made to a remote database");
  // 2) a wrong opt-in (database name has no test in it) is refused the same way
  await assert.rejects(() => withDisposableDatabase("postgresql://u:p@db.example.com/prod", body, { cleanupSql, makePool: () => { opened++; return recordingPool(); } }), /not local/);
  assert.equal(opened, 0);
  // 3) local host but a real-sized table: only the guard's own SELECTs run, then the pool is closed
  const rp = recordingPool(1001);
  await assert.rejects(() => withDisposableDatabase("postgresql://u:p@127.0.0.1/cc_test", body, { cleanupSql, makePool: () => rp }), /more than 1000 rows/);
  assert.ok(rp.stmts.length > 0, "the guard did look");
  assert.ok(rp.stmts.every((q) => /^\s*SELECT\b/i.test(q) && !DESTRUCTIVE.test(q)), `only SELECT statements ran: ${JSON.stringify(rp.stmts)}`);
  assert.ok(!rp.stmts.some((q) => cleanupSql.includes(q)), "the cleanup statements did not run");
  assert.equal(rp.state.ended, 1, "the pool was closed");
});

test("when the guard accepts, the body runs and the cleanup runs afterwards, even if the body fails", async () => {
  const cleanupSql = ["DROP TABLE IF EXISTS usage_event"];
  const ok = recordingPool(5); const order: string[] = [];
  await withDisposableDatabase("postgresql://u:p@localhost/cc_test", async (p) => { order.push("body"); await p.query("INSERT INTO t VALUES (1)"); }, { cleanupSql, makePool: () => ok });
  assert.deepEqual(ok.stmts.slice(-2), ["INSERT INTO t VALUES (1)", cleanupSql[0]]); assert.equal(ok.state.ended, 1);
  const bad = recordingPool(5);
  await assert.rejects(() => withDisposableDatabase("postgresql://u:p@localhost/cc_test", async () => { throw new Error("body failed"); }, { cleanupSql, makePool: () => bad }), /body failed/);
  assert.equal(bad.stmts.at(-1), cleanupSql[0]); assert.equal(bad.state.ended, 1);
});

// ---- rejected and accepted inputs can never put caller text into an event ----
const CANARY = "CANARY-9f3a john.smith@example.com 0412 345 678 123 Main Street; DROP TABLE x; 'quote";
const ADVERSARIAL: unknown[] = [CANARY, "x".repeat(5000), { nested: CANARY }, [CANARY, 1], 12345, true, null, "ünï©ødé \u202e " + CANARY, "SUV " + CANARY, "family best value " + CANARY];
const FIELDS = ["make", "model", "bodyType", "condition", "zip", "vin", "vins", "vehicleNeeds", "exteriorColor", "trimRequired", "trimPreference", "drivetrain", "priceMax", "priceMin", "seatsMinPreference", "electrificationTypes", "priorityAxis", "cpo", "year"];
const BANDS = ["up to 15k", "15k to 25k", "25k to 40k", "over 40k"];
function assertSafeParams(p: unknown[]) {
  const [tool, outcome, env, caller, found, shown, body, band, cond, mk, md, fc, label, ver, link, dur, nh] = p;
  assert.ok(["search", "compare", "check", "link", "more"].includes(tool as string)); assert.ok(OUTCOMES.includes(outcome as string));
  assert.ok(["test", "live", "unknown"].includes(env as string)); assert.ok(["claude", "chatgpt", "grok", "other", "unknown"].includes(caller as string));
  for (const n of [found, shown, fc, ver, dur, nh]) assert.ok(n === null || typeof n === "number", `number or empty, got ${String(n)}`);
  assert.ok(body === null || (BODY_STYLES as readonly string[]).includes(body as string), `body_style ${String(body)}`);
  assert.ok(band === null || BANDS.includes(band as string)); assert.ok(cond === null || cond === "new" || cond === "used");
  for (const b of [mk, md]) assert.ok(b === null || typeof b === "boolean");
  assert.ok(label === null || INTENT_LABELS.includes(label as string)); assert.equal(link, null);
  const text = JSON.stringify(p); assert.ok(!/CANARY|example\.com|Main Street|DROP TABLE|ünï|0412/i.test(text), "no caller text in the event");
}
test("privacy: adversarial values in every field, accepted or rejected, only ever become fixed vocabulary, numbers or yes/no", async () => {
  const pool = fakePool(); _setPoolForTests(pool);
  const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
  const results: Record<string, unknown> = { find_matching_vehicle: searchResult(2), check_vehicle: { structuredContent: { meta: {}, results: [{ identity: { make: "Ford", model: "Explorer", year: 2026 } }] } },
    compare_vehicles: { structuredContent: { meta: {}, results: [{}, {}] } }, get_edmunds_vehicle_link: { structuredContent: { affiliateUrl: "https://e.test/x" } } };
  for (const n of Object.keys(results)) server.registerTool(n, {}, async () => results[n]);
  let events = 0;
  for (const v of ADVERSARIAL) {
    const args = Object.fromEntries(FIELDS.map((f) => [f, v]));
    for (const n of Object.keys(results)) {
      await runWithUsageContext(req(TEST_HOST, `Claude-User ${CANARY}`), async () => { await reg[n](args); noteToolValidationFailure(n, args, 2); }); // accepted path and rejected path
      events += 2;
    }
  }
  await flushUsageForTests();
  const rows = inserts(pool).map((c) => c.params as unknown[]); assert.equal(rows.length, events);
  for (const p of rows) assertSafeParams(p);
  assert.ok(rows.some((p) => p[1] === "invalid_input") && rows.some((p) => p[1] !== "invalid_input"));
  const rejected = rows.filter((p) => p[1] === "invalid_input");
  assert.ok(rejected.every((p) => p[6] === null && p[7] === null && p[8] === null && p[9] === null && p[10] === null && p[11] === null && p[12] === null), "a rejected input yields no attributes and no label at all");
  _setPoolForTests(null);
});

test("privacy: the last line of defence forces any event into the fixed vocabularies", () => {
  const dirty: any = { tool: "search", outcome: CANARY, env: CANARY, caller_class: CANARY, found: CANARY, shown: CANARY, intent_label: CANARY, link_code: CANARY, duration_ms: CANARY, nhtsa_failures: CANARY,
    attrs: { body_style: CANARY, price_band: CANARY, condition: CANARY, make_given: CANARY, model_given: CANARY, filter_count: CANARY } };
  const clean = sanitizeUsageEvent(dirty)!;
  assert.ok(!/CANARY|example\.com/.test(JSON.stringify(clean)));
  assert.deepEqual([clean.outcome, clean.env, clean.caller_class, clean.intent_label, clean.link_code, clean.attrs!.body_style, clean.attrs!.condition], ["error", "unknown", "unknown", null, null, null, null]);
  assert.equal(sanitizeUsageEvent({ ...dirty, tool: CANARY }), null);
  assert.equal(bodyStyleOf("Pickup Truck " + CANARY), "truck"); assert.equal(bodyStyleOf(CANARY), "other"); assert.equal(bodyStyleOf(""), null); assert.equal(bodyStyleOf({}), "other");
});

const DB = process.env.TEST_DATABASE_URL;
test("real Postgres: tables are created twice safely, rows hold only the allowed columns, retention is exact and repeat-safe", { skip: !DB }, async () => {
  await withDisposableDatabase(DB, async (poolLike) => {
    const pool = poolLike as unknown as Pool;
    try {
    await pool.query("DROP TABLE IF EXISTS usage_event, usage_counter, usage_daily_summary");
    _setPoolForTests(pool); await ensureUsageTables(); _setPoolForTests(pool); await ensureUsageTables(); // twice, including a fresh readiness flag
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='usage_event' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ["event_id","time_utc","tool","outcome","env","caller_class","found","shown","body_style","price_band","condition","make_given","model_given","filter_count","intent_label","label_version","link_code","duration_ms","nhtsa_failures"]);
    assert.ok(!cols.some((c) => /vin|zip|ip|prompt|need|agent|text/.test(c)));
    const ins = (daysAgo: number, tool: string, outcome: string, caller: string, label: string | null, ver: number | null, ms: number) => pool.query(
      `INSERT INTO usage_event (time_utc, tool, outcome, env, caller_class, intent_label, label_version, duration_ms) VALUES (now() - ($1 || ' days')::interval, $2, $3, 'test', $4, $5, $6, $7)`, [String(daysAgo), tool, outcome, caller, label, ver, ms]);
    await ins(100, "search", "results", "claude", "value", 1, 100); await ins(100, "search", "results", "claude", "value", 1, 300);
    await ins(100, "search", "results", "claude", "value", 2, 50);  // same day, a newer label version: separate summary row
    await ins(95, "check", "decoded_recall_known", "chatgpt", null, null, 40);
    await ins(10, "search", "none", "claude", "unknown", 1, 20);     // recent: stays
    const now = new Date();
    const c1 = await pool.connect(); const r1 = await runUsageRetention(c1, now); c1.release();
    assert.equal(r1.deletedRows, 4); assert.equal(r1.rolledUpRows, 3);
    const sum = (await pool.query("SELECT tool, outcome, caller_class, intent_label, label_version, event_count, duration_ms_sum::int AS s, duration_ms_max FROM usage_daily_summary ORDER BY tool, label_version, caller_class")).rows;
    assert.deepEqual(sum, [
      { tool: "check", outcome: "decoded_recall_known", caller_class: "chatgpt", intent_label: "unknown", label_version: 0, event_count: 1, s: 40, duration_ms_max: 40 },
      { tool: "search", outcome: "results", caller_class: "claude", intent_label: "value", label_version: 1, event_count: 2, s: 400, duration_ms_max: 300 },
      { tool: "search", outcome: "results", caller_class: "claude", intent_label: "value", label_version: 2, event_count: 1, s: 50, duration_ms_max: 50 },
    ]);
    assert.equal(Number((await pool.query("SELECT count(*) FROM usage_event")).rows[0].count), 1, "the recent row remains");
    // repeat run: nothing more to add, nothing double counted
    const c2 = await pool.connect(); const r2 = await runUsageRetention(c2, now); c2.release();
    assert.equal(r2.deletedRows, 0); assert.equal(r2.rolledUpRows, 0);
    assert.equal(Number((await pool.query("SELECT sum(event_count) FROM usage_daily_summary")).rows[0].sum), 4);
    // two overlapping runs over fresh old rows: the second waits for the first, nothing is counted twice
    await ins(120, "search", "results", "claude", "value", 1, 10); await ins(120, "search", "results", "claude", "value", 1, 10);
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    await Promise.all([runUsageRetention(a, now), runUsageRetention(b, now)]); a.release(); b.release();
    assert.equal(Number((await pool.query("SELECT sum(event_count) FROM usage_daily_summary")).rows[0].sum), 6);
    assert.equal(Number((await pool.query("SELECT count(*) FROM usage_event WHERE time_utc < now() - interval '90 days'")).rows[0].count), 0);
    // a failure after the rollup step undoes the rollup too
    await ins(130, "link", "generated", "grok", null, null, 5);
    const c3 = await pool.connect();
    const failing = { query: async (sql: string, p?: unknown[]) => { if (sql.startsWith("DELETE FROM usage_daily_summary")) throw new Error("injected"); return c3.query(sql, p); } };
    await assert.rejects(() => runUsageRetention(failing, now), /injected/);
    c3.release();
    assert.equal(Number((await pool.query("SELECT count(*) FROM usage_event WHERE tool='link'")).rows[0].count), 1, "raw row kept after a failed run");
    assert.equal(Number((await pool.query("SELECT sum(event_count) FROM usage_daily_summary")).rows[0].sum), 6, "summary unchanged after a failed run");
    const c4 = await pool.connect(); await runUsageRetention(c4, now); c4.release();
    assert.equal(Number((await pool.query("SELECT sum(event_count) FROM usage_daily_summary")).rows[0].sum), 7, "the retry after the failure counts it once");
    // summaries older than 24 months go
    await pool.query("INSERT INTO usage_daily_summary (day, env, tool, outcome, event_count) VALUES (current_date - 800, 'test', 'search', 'results', 9)");
    const c5 = await pool.connect(); const r5 = await runUsageRetention(c5, now); c5.release(); assert.equal(r5.expiredSummaryRows, 1);
    // live write path end to end
    const reg: Record<string, any> = {}; const server = { registerTool: (n: string, _c: unknown, cb: any) => { reg[n] = cb; } }; instrumentTools(server);
    server.registerTool("find_matching_vehicle", {}, async () => searchResult(8));
    await runWithUsageContext(req(TEST_HOST, "Claude-User"), () => reg["find_matching_vehicle"]({ make: "Honda", zip: "90210" })); await flushUsageForTests();
    const row = (await pool.query("SELECT tool, outcome, env, caller_class, found, shown, make_given, model_given FROM usage_event WHERE time_utc > now() - interval '1 minute'")).rows[0];
    assert.deepEqual(row, { tool: "search", outcome: "results", env: "test", caller_class: "claude", found: 221, shown: 8, make_given: true, model_given: false });
    } finally { _setPoolForTests(null); }
  }, { poolMax: 4, cleanupSql: ["DROP TABLE IF EXISTS usage_event, usage_counter, usage_daily_summary"] }); // cleanup runs only if the guard accepted the database
});

test("real Postgres: a refused guard leaves a real-sized table and everything else untouched", { skip: !DB || disposableUrlProblem(DB) !== null }, async () => {
  const admin = new Pool({ connectionString: DB, max: 1 }); const schema = `guard_probe_${process.pid}`;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.query(`CREATE SCHEMA ${schema}`); // this test's own throwaway schema
    await admin.query(`CREATE TABLE ${schema}.listing AS SELECT g AS id FROM generate_series(1, 1001) g`);
    await admin.query(`CREATE TABLE ${schema}.usage_event (n int)`); await admin.query(`INSERT INTO ${schema}.usage_event VALUES (1)`);
    const u = new URL(DB!); u.searchParams.set("options", `-c search_path=${schema}`);
    let bodyRan = false;
    await assert.rejects(() => withDisposableDatabase(u.toString(), async (p: PoolLike) => { bodyRan = true; await p.query("DROP TABLE listing"); }, { cleanupSql: ["DROP TABLE IF EXISTS listing", "DROP TABLE IF EXISTS usage_event"] }), /more than 1000 rows/);
    assert.equal(bodyRan, false);
    assert.equal(Number((await admin.query(`SELECT count(*) FROM ${schema}.listing`)).rows[0].count), 1001, "the real-sized table is intact");
    assert.equal(Number((await admin.query(`SELECT count(*) FROM ${schema}.usage_event`)).rows[0].count), 1, "the other table is intact");
  } finally { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
