// R4-1 spike (10 Nov 2026): header NAMES only, preview builds only, once per combination, never throws. Run: npx tsx --test tests/header-name-spike.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { headerNamesLine, maybeLogHeaderNames, _resetHeaderSpikeForTests } from "../lib/header-name-spike";

const realWarn = console.warn; const lines: string[] = []; const realEnv = process.env.VERCEL_ENV;
beforeEach(() => { lines.length = 0; _resetHeaderSpikeForTests(); console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); }; });
afterEach(() => { console.warn = realWarn; if (realEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = realEnv; });
const hdrs = (o: Record<string, string>) => new Headers(o);

test("the line has the caller class and the sorted lowercase NAMES, and never a value", () => {
  const l = headerNamesLine(hdrs({ "User-Agent": "Claude-User", "X-Forwarded-For": "203.0.113.9", "Accept": "text/event-stream", "Authorization": "Bearer SECRET-TOKEN-123" }), "claude");
  assert.equal(l, "[hdr-names] caller=claude names=accept,authorization,user-agent,x-forwarded-for");
  for (const secret of ["Claude-User", "203.0.113.9", "SECRET-TOKEN-123", "text/event-stream"]) assert.ok(!l.includes(secret), `value leaked: ${secret}`);
});
test("it logs only on preview builds: not in production, not when the variable is missing", () => {
  for (const env of ["production", "development", undefined]) {
    _resetHeaderSpikeForTests(); lines.length = 0; if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
    maybeLogHeaderNames(hdrs({ "user-agent": "x" }), "other"); assert.equal(lines.length, 0, `must stay off for ${String(env)}`);
  }
  process.env.VERCEL_ENV = "preview"; maybeLogHeaderNames(hdrs({ "user-agent": "x" }), "other"); assert.equal(lines.length, 1);
});
test("each distinct combination is logged once per instance, a different one again", () => {
  process.env.VERCEL_ENV = "preview";
  maybeLogHeaderNames(hdrs({ a: "1", b: "2" }), "claude"); maybeLogHeaderNames(hdrs({ b: "9", a: "8" }), "claude"); assert.equal(lines.length, 1, "same names, different values: one line");
  maybeLogHeaderNames(hdrs({ a: "1", b: "2", c: "3" }), "claude"); maybeLogHeaderNames(hdrs({ a: "1", b: "2" }), "chatgpt"); assert.equal(lines.length, 3);
});
test("it never throws, even for a broken headers object", () => {
  process.env.VERCEL_ENV = "preview";
  assert.doesNotThrow(() => maybeLogHeaderNames({ forEach() { throw new Error("boom"); } } as never, "claude"));
});
