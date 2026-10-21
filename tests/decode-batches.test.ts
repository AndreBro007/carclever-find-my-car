/**
 * decodePoolInBatches (T52, SYS-20261021-003 and -012): batches of 8, early stop, cap of 24, and the circuit breaker when a whole batch gets no answer.
 * NHTSA is stubbed; no network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decodePoolInBatches, decodeNhtsaElectrification, resetNhtsaCacheForTests, electrificationStateSatisfies, ELECTRIFICATION_BATCH_SIZE, ELECTRIFICATION_POOL_SIZE } from "../lib/nhtsa-client";

type Kind = "hybrid" | "gas" | "fail";
let calls = 0;
const kinds = new Map<string, Kind>();
const vin = (n: number) => `4T1DAC1K${String(n).padStart(9, "0")}`;
const car = (n: number, k: Kind) => { kinds.set(vin(n), k); return { vin: vin(n), vehicle: { make: null, model: null, cylinders: null } }; };
beforeEach(() => {
  calls = 0; kinds.clear(); resetNhtsaCacheForTests();
  globalThis.fetch = (async (u: string | URL) => {
    const m = String(u).match(/decodevinvalues\/([A-Z0-9]{17})/i);
    if (!m) return new Response("{}", { status: 404 });
    calls++;
    const k = kinds.get(m[1].toUpperCase());
    if (k === "fail") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "", Model: "", ElectrificationLevel: k === "hybrid" ? "Strong Hybrid (SHEV)" : "", FuelTypePrimary: "Gasoline", FuelTypeSecondary: k === "hybrid" ? "Electric" : "" }] }), { status: 200 });
  }) as typeof fetch;
});
const hybrids = (rs: Array<{ electrificationState?: string } | null>) => rs.filter((r) => electrificationStateSatisfies(r?.electrificationState as never, ["hybrid"])).length;

test("constants: batches of 8, at most 24 decoded", () => {
  assert.equal(ELECTRIFICATION_BATCH_SIZE, 8);
  assert.equal(ELECTRIFICATION_POOL_SIZE, 24);
});

test("stops after the first batch when it already gives enough confirmed cars", async () => {
  const pool = Array.from({ length: 40 }, (_, i) => car(i + 1, "hybrid"));
  const { results, down } = await decodePoolInBatches(pool, (rs) => hybrids(rs) >= 8);
  assert.equal(results.length, 8); assert.equal(calls, 8); assert.equal(down, false);
});

test("asks for a second batch only when the first did not give enough, and results line up with the pool", async () => {
  const pool = Array.from({ length: 40 }, (_, i) => car(i + 1, i < 4 ? "gas" : "hybrid"));
  const { results } = await decodePoolInBatches(pool, (rs) => hybrids(rs) >= 8);
  assert.equal(results.length, 16); assert.equal(calls, 16);
  assert.equal(results[0]?.electrificationState, "not_electrified");
  assert.equal(results[4]?.electrificationState, "hybrid");
});

test("never decodes more than the cap of 24, even when nothing confirms", async () => {
  const pool = Array.from({ length: 60 }, (_, i) => car(i + 1, "gas"));
  const { results, down } = await decodePoolInBatches(pool, (rs) => hybrids(rs) >= 8);
  assert.equal(results.length, 24); assert.equal(calls, 24); assert.equal(down, false);
});

test("circuit breaker: when a whole batch gets no answer it stops, so an outage costs one batch", async () => {
  const pool = Array.from({ length: 40 }, (_, i) => car(i + 1, "fail"));
  const { results, down } = await decodePoolInBatches(pool, (rs) => hybrids(rs) >= 8);
  assert.equal(down, true); assert.equal(results.length, 8); assert.equal(calls, 8);
  assert.ok(results.every((r) => r == null));
});

test("a batch with some answers is not an outage: the next batch is tried", async () => {
  const pool = Array.from({ length: 40 }, (_, i) => car(i + 1, i < 7 ? "fail" : "hybrid"));
  const { results, down } = await decodePoolInBatches(pool, (rs) => hybrids(rs) >= 8);
  assert.equal(down, false); assert.equal(results.length, 16);
});

test("cacheOnly answers from the cache and never asks NHTSA", async () => {
  const c = car(1, "hybrid");
  assert.equal(await decodeNhtsaElectrification(c.vin, null, null, null, { cacheOnly: true }), null); assert.equal(calls, 0);
  const first = await decodeNhtsaElectrification(c.vin, null, null, null); assert.equal(first?.electrificationState, "hybrid"); assert.equal(calls, 1);
  const again = await decodeNhtsaElectrification(c.vin, null, null, null, { cacheOnly: true }); assert.equal(again?.electrificationState, "hybrid"); assert.equal(calls, 1);
});

test("an empty pool decodes nothing", async () => {
  const { results, down } = await decodePoolInBatches([], () => false);
  assert.deepEqual(results, []); assert.equal(down, false); assert.equal(calls, 0);
});
