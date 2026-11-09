// Group 1, design 1 (9 Nov 2026): the database failure line. Run: npx tsx --test tests/db-failure.test.ts
// Needs no database: a fake pool throws on purpose. Checks (1) every error class, (2) the line carries only fixed fields and never SQL, a VIN, a ZIP or the error message,
// (3) at most one line per class per second, (4) every catch block returns exactly what it returned before, (5) a success logs nothing.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyDbError, noteDbFailure, resetDbFailureLogForTests } from "../lib/db-failure";
import { searchCatalogDbListings, lookupCatalogDbVin, catalogDbModelFacets, catalogDbTrimFacets, stockPhotoFor, setCatalogDbPoolForTests, resetStockPhotoCacheForTests } from "../lib/catalog-db-source";

const lines: string[] = [];
const realWarn = console.warn;
beforeEach(() => { lines.length = 0; resetDbFailureLogForTests(); resetStockPhotoCacheForTests(); console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); }; });
afterEach(() => { console.warn = realWarn; setCatalogDbPoolForTests(null); });

const withCode = (m: string, code: string): Error => Object.assign(new Error(m), { code });
const SECRET_MESSAGE = "SELECT * FROM listing l WHERE l.vin = '1HGCM82633A004352' AND zip = '90210' AND make = 'Honda' failed";
const failingPool = (err: unknown) => ({ totalCount: 3, idleCount: 0, waitingCount: 5, query: async () => { throw err; } });

test("classifyDbError: every class, and Node codes are not mistaken for SQL states", () => {
  assert.deepEqual(classifyDbError(new Error("timeout exceeded when trying to connect")), { cls: "connect_timeout", code: null });
  assert.deepEqual(classifyDbError(new Error("Query read timeout")), { cls: "query_timeout", code: null });
  assert.deepEqual(classifyDbError(withCode("canceling statement due to statement timeout", "57014")), { cls: "query_timeout", code: "57014" });
  assert.deepEqual(classifyDbError(new Error("Connection terminated unexpectedly")), { cls: "connection_ended", code: null });
  assert.deepEqual(classifyDbError(withCode("read ECONNRESET", "ECONNRESET")), { cls: "connection_ended", code: null });
  assert.deepEqual(classifyDbError(withCode("write EPIPE", "EPIPE")), { cls: "connection_ended", code: null }, "EPIPE has five capitals but no digit: not an SQL state");
  assert.deepEqual(classifyDbError(withCode("terminating connection due to administrator command", "57P01")), { cls: "connection_ended", code: "57P01" });
  assert.deepEqual(classifyDbError(new Error("Cannot use a pool after calling end on the pool")), { cls: "pool_ended", code: null });
  assert.deepEqual(classifyDbError(withCode('relation "listing" does not exist', "42P01")), { cls: "sql_error", code: "42P01" });
  assert.deepEqual(classifyDbError(new Error("something unexpected")), { cls: "other", code: null });
  assert.deepEqual(classifyDbError("a string"), { cls: "other", code: null });
  assert.deepEqual(classifyDbError(null), { cls: "other", code: null });
  assert.deepEqual(classifyDbError(undefined), { cls: "other", code: null });
});

test("the line has fixed fields only and never the message, SQL, VIN, ZIP or make", () => {
  const cls = noteDbFailure("search", withCode(SECRET_MESSAGE, "42P01"), Date.now() - 1234, { totalCount: 3, idleCount: 0, waitingCount: 5 });
  assert.equal(cls, "sql_error");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[db-failure\] stage=search class=sql_error code=42P01 ms=\d+ pool=3\/0\/5$/);
  for (const s of ["SELECT", "listing", "1HGCM82633A004352", "90210", "Honda", "zip", "failed"]) assert.ok(!lines[0].includes(s), `the line must not contain ${s}`);
  const ms = Number(lines[0].match(/ms=(\d+)/)![1]);
  assert.ok(ms >= 1200 && ms < 5000, `elapsed time is recorded (${ms})`);
});

test("a missing or odd pool is written as na and never throws", () => {
  noteDbFailure("vin", new Error("Connection terminated unexpectedly"), Date.now(), null);
  noteDbFailure("photo", new Error("timeout exceeded when trying to connect"), Date.now(), { totalCount: "x", idleCount: -1, waitingCount: undefined });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /pool=na\/na\/na$/);
  assert.match(lines[1], /pool=na\/na\/na$/);
});

test("at most one line per class per second; another class still logs", () => {
  for (let i = 0; i < 20; i++) noteDbFailure("search", new Error("Query read timeout"), Date.now());
  assert.equal(lines.length, 1, "twenty identical failures in the same moment make one line");
  noteDbFailure("search", new Error("timeout exceeded when trying to connect"), Date.now());
  assert.equal(lines.length, 2, "a different class is not hidden by the first");
  resetDbFailureLogForTests();
  noteDbFailure("search", new Error("Query read timeout"), Date.now());
  assert.equal(lines.length, 3);
});

test("a failing pool: every function returns exactly what it returned before and logs one clean line", async () => {
  setCatalogDbPoolForTests(failingPool(withCode(SECRET_MESSAGE, "57014")) as never);
  const q = { make: "Honda", model: "CR-V", zip: "90210" } as never;
  const s = await searchCatalogDbListings(q);
  assert.deepEqual(s.data, []); assert.equal(s.total, 0); assert.equal(s.source, "catalog_db"); assert.ok(typeof s.error === "string" && s.error.length > 0, "the generic service error is unchanged");
  assert.deepEqual(await lookupCatalogDbVin("1HGCM82633A004352"), { status: "error" });
  assert.deepEqual(await catalogDbModelFacets(q), []);
  assert.deepEqual(await catalogDbTrimFacets(q), []);
  const photo = await stockPhotoFor({ vin: "1HGCM82633A004352", vehicle: { make: "Honda", model: "Accord", year: 2003, exteriorColor: "Blue", trim: "EX" } } as never);
  assert.equal(photo, null);
  assert.equal(lines.length, 1, "five failures in the same moment, one class: one line (rate limit)");
  assert.match(lines[0], /^\[db-failure\] stage=(search|vin|model_facets|trim_facets|photo) class=query_timeout code=57014 ms=\d+ pool=3\/0\/5$/);
  for (const l of lines) for (const x of ["SELECT", "1HGCM82633A004352", "90210", "Honda", "Accord"]) assert.ok(!l.includes(x));
});

test("each stage names itself when its own class differs", async () => {
  setCatalogDbPoolForTests(failingPool(new Error("Query read timeout")) as never);
  await searchCatalogDbListings({ make: "Honda" } as never);
  setCatalogDbPoolForTests(failingPool(new Error("timeout exceeded when trying to connect")) as never);
  await lookupCatalogDbVin("1HGCM82633A004352");
  setCatalogDbPoolForTests(failingPool(new Error("Connection terminated unexpectedly")) as never);
  await catalogDbModelFacets({ make: "Honda" } as never);
  setCatalogDbPoolForTests(failingPool(withCode("syntax error", "42601")) as never);
  await catalogDbTrimFacets({ make: "Honda" } as never);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /stage=search class=query_timeout/);
  assert.match(lines[1], /stage=vin class=connect_timeout/);
  assert.match(lines[2], /stage=model_facets class=connection_ended/);
  assert.match(lines[3], /stage=trim_facets class=sql_error code=42601/);
});

test("a successful call logs nothing", async () => {
  setCatalogDbPoolForTests({ totalCount: 1, idleCount: 1, waitingCount: 0, query: async () => ({ rows: [] }) } as never);
  assert.deepEqual(await lookupCatalogDbVin("1HGCM82633A004352"), { status: "absent" });
  assert.equal(lines.length, 0);
});
