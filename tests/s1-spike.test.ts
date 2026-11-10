// R4-6 spike S1 (10 Nov 2026): one harmless added tool, preview builds only, throwaway. Run: npx tsx --test tests/s1-spike.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerS1Spike, s1SpikeEnabled, S1_TOOL_NAME, S1_REPLY } from "../lib/s1-spike";

const realEnv = process.env.VERCEL_ENV; const realWarn = console.warn;
afterEach(() => { console.warn = realWarn; if (realEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = realEnv; });
const fake = () => { const calls: Array<{ name: string; config: any; cb: any }> = []; return { calls, registerTool: (name: string, config: any, cb: any) => { calls.push({ name, config, cb }); } }; };

test("S1: the tool is registered only on preview builds, never in production, development or when the variable is missing", () => {
  for (const env of ["production", "development", undefined]) {
    if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
    const s = fake(); assert.equal(registerS1Spike(s), false); assert.equal(s.calls.length, 0, `must stay off for ${String(env)}`); assert.equal(s1SpikeEnabled(), false);
  }
  process.env.VERCEL_ENV = "preview"; const s = fake(); assert.equal(registerS1Spike(s), true); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].name, S1_TOOL_NAME);
});
test("S1: it takes no input, is read-only, and answers one fixed sentence with no caller data", async () => {
  process.env.VERCEL_ENV = "preview"; const s = fake(); registerS1Spike(s);
  const c = s.calls[0]; assert.deepEqual(c.config.inputSchema, {}); assert.equal(c.config.annotations.readOnlyHint, true); assert.equal(c.config.annotations.destructiveHint, false);
  const lines: string[] = []; console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const r = await c.cb({ anything: "ignored", vin: "1HGCM82633A004352" });
  assert.deepEqual(r, { content: [{ type: "text", text: S1_REPLY }] });
  assert.deepEqual(lines, ["[s1-spike] spike_added_tool called"], "the log line holds the tool name only");
});
test("S1: a failing log never affects the call", async () => {
  process.env.VERCEL_ENV = "preview"; const s = fake(); registerS1Spike(s);
  console.warn = () => { throw new Error("boom"); };
  const r = await s.calls[0].cb({}); assert.equal(r.content[0].text, S1_REPLY);
});
