// R4-1 surface column and R4-3 stage timings (10 Nov 2026). Run: npx tsx --test tests/r4-surface-stage.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  surfaceOf, SURFACES, sanitizeUsageEvent, insertUsageEvent, instrumentTools, runWithUsageContext, flushUsageForTests, _setPoolForTests, _resetOptionalColumnsForTests,
} from "../lib/usage-events";
import { addStageMs, timeStage, timeStageSync, newStageTotals, runWithStageTotals, sanitizeStageMs, STAGE_KEYS } from "../lib/stage-timer";
import { buildResultsCardHtml } from "../lib/results-card";

type Call = { sql: string; params?: unknown[] };
function fakePool(optionalPresent: string[]) {
  const calls: Call[] = [];
  return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); if (/information_schema/.test(sql)) return { rows: optionalPresent.map((c) => ({ column_name: c })) }; return { rowCount: 1, rows: [] }; } };
}
beforeEach(() => { _resetOptionalColumnsForTests(); });
afterEach(() => { _setPoolForTests(null); });
const insertCall = (p: { calls: Call[] }) => p.calls.find((c) => /INSERT INTO usage_event/.test(c.sql))!;

// ---- R4-1 ----
test("surface: only the two seen values map; everything else, a missing header or another caller is unknown", () => {
  assert.equal(surfaceOf("ClaudeAI", "claude"), "claude_ai");
  assert.equal(surfaceOf("Cowork", "claude"), "cowork");
  assert.equal(surfaceOf("  cowork ", "claude"), "cowork");
  for (const v of ["ClaudeCode", "web", "", null, undefined, "ClaudeAI; drop table", "x".repeat(500)]) assert.equal(surfaceOf(v as string, "claude"), "unknown");
  for (const c of ["chatgpt", "grok", "other", "unknown"] as const) assert.equal(surfaceOf("ClaudeAI", c), "unknown", `caller ${c}`);
});
test("sanitize: surface is forced into the fixed list, stage_ms into the four fixed keys", () => {
  const base = { tool: "search" as const, outcome: "results", env: "test" as const, caller_class: "claude" as const };
  assert.equal(sanitizeUsageEvent({ ...base, surface: "evil" as never })!.surface, "unknown");
  assert.equal(sanitizeUsageEvent({ ...base, surface: "cowork" })!.surface, "cowork");
  const s = sanitizeUsageEvent({ ...base, stage_ms: { db: 12.4, nhtsa: -5, rank: "x", assemble: 9e12, vin: 1 } as never })!.stage_ms!;
  assert.deepEqual(Object.keys(s).sort(), [...STAGE_KEYS].sort());
  assert.deepEqual(s, { db: 12, nhtsa: 0, rank: 0, assemble: 3_600_000 });
  assert.equal(sanitizeUsageEvent({ ...base })!.stage_ms, null);
  assert.ok(SURFACES.includes(sanitizeUsageEvent({ ...base })!.surface as never));
});

// ---- R4-3 ----
test("stage timer: fixed keys, sums, never negative, nothing outside a call, errors pass through", async () => {
  addStageMs("db", 50); // outside a call: ignored, no throw
  const t = newStageTotals();
  await runWithStageTotals(t, async () => {
    addStageMs("db", 10); addStageMs("db", 5); addStageMs("rank", -7); addStageMs("nhtsa", Number.NaN); addStageMs("bogus" as never, 3);
    await timeStage("assemble", async () => { await new Promise((r) => setTimeout(r, 15)); });
    assert.equal(timeStageSync("rank", () => 42), 42);
    await assert.rejects(timeStage("nhtsa", async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); }), /boom/);
  });
  assert.deepEqual(Object.keys(t).sort(), [...STAGE_KEYS].sort());
  assert.equal(t.db, 15); assert.equal(t.rank >= 0 && t.rank < 5, true);
  assert.ok(t.assemble >= 10, `assemble ${t.assemble}`); assert.ok(t.nhtsa >= 3, "the failed call is still timed");
  for (const k of STAGE_KEYS) assert.ok(t[k] >= 0);
  assert.equal(sanitizeStageMs("nope"), null);
});

// ---- writer: optional columns ----
test("insert: surface and stage_ms are written only when the columns exist", async () => {
  const ev = { tool: "search" as const, outcome: "results", env: "test" as const, caller_class: "claude" as const, surface: "cowork" as const, stage_ms: { db: 1, nhtsa: 2, rank: 3, assemble: 4 } };
  const both = fakePool(["surface", "stage_ms"]); _setPoolForTests(both); await insertUsageEvent(ev);
  const a = insertCall(both); assert.match(a.sql, /surface, stage_ms\)/); assert.ok(a.params!.includes("cowork")); assert.ok(a.params!.includes(JSON.stringify({ db: 1, nhtsa: 2, rank: 3, assemble: 4 })));
  _resetOptionalColumnsForTests();
  const none = fakePool([]); _setPoolForTests(none); await insertUsageEvent(ev);
  const b = insertCall(none); assert.ok(!/surface|stage_ms/.test(b.sql), "no new column in the statement"); assert.equal(b.params!.length, 17);
  _resetOptionalColumnsForTests();
  const onlySurface = fakePool(["surface"]); _setPoolForTests(onlySurface); await insertUsageEvent(ev);
  const c = insertCall(onlySurface); assert.match(c.sql, /surface\)/); assert.ok(!/stage_ms/.test(c.sql));
});
test("insert: a failing column lookup writes exactly as before (a missing column can never break a write)", async () => {
  const calls: Call[] = [];
  _setPoolForTests({ query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); if (/information_schema/.test(sql)) throw new Error("no"); return { rowCount: 1, rows: [] }; } });
  await insertUsageEvent({ tool: "check", outcome: "not_decoded", env: "test", caller_class: "chatgpt" });
  const ins = calls.find((c) => /INSERT INTO usage_event/.test(c.sql))!; assert.ok(!/surface|stage_ms/.test(ins.sql)); assert.equal(ins.params!.length, 17);
});

// ---- end to end through the tool wrapper ----
test("a timed tool call records its stage totals and the surface in the event, and the tool's answer is untouched", async () => {
  const pool = fakePool(["surface", "stage_ms"]); _setPoolForTests(pool);
  const registered: Record<string, (...a: any[]) => Promise<any>> = {};
  const server = { registerTool: (name: string, _c: unknown, cb: (...a: any[]) => Promise<any>) => { registered[name] = cb; } };
  instrumentTools(server);
  const answer = { content: [{ type: "text", text: "ok" }], structuredContent: { results: [{ a: 1 }], meta: { totalMatches: 5 } } };
  server.registerTool("find_matching_vehicle", {}, async () => { addStageMs("db", 20); addStageMs("rank", 3); return answer; });
  const req = new Request("https://carclever-db-test.getcarwise.app/mcp", { method: "POST", headers: { "user-agent": "Claude-User", "x-anthropic-client": "Cowork", "x-forwarded-host": "carclever-db-test.getcarwise.app" } });
  const out = await runWithUsageContext(req, () => registered.find_matching_vehicle({ make: "Honda" }));
  assert.equal(out, answer);
  await flushUsageForTests();
  const ins = insertCall(pool); assert.ok(ins, "an event was written");
  assert.ok(ins.params!.includes("cowork"));
  const stage = JSON.parse(String(ins.params!.find((p) => typeof p === "string" && p.startsWith("{"))));
  assert.equal(stage.db, 20); assert.equal(stage.rank, 3); assert.equal(stage.nhtsa, 0); assert.equal(stage.assemble, 0);
});

// ---- first-card picture ----
test("card widget: the first card's picture loads at once, the others stay lazy", () => {
  const html = buildResultsCardHtml();
  assert.ok(html.includes('function cardHtml(c, idx)'));
  assert.ok(html.includes('visible.map(cardHtml)'), "map passes the index");
  assert.ok(html.includes('(idx === 0 ? "eager" : "lazy")'));
  assert.ok(!html.includes('class="cc-photo" src="\' + esc(photo) + \'" alt="\' + (primaryUrl ? "" : esc(title)) + \'" loading="lazy"'), "no fixed lazy on the card picture");
});
