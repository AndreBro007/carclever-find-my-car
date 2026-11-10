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

// ---- step 2 (André approved Option A, 10 Nov 2026): the VALUE of x-anthropic-client only, safe pattern, preview builds only ----
import { clientHeaderLine, maybeLogClientHeader } from "../lib/header-name-spike";
test("step 2: a safe value of x-anthropic-client is logged; an unsafe or long one is NOT (only its length and kinds of character)", () => {
  assert.equal(clientHeaderLine("claude-ai.web-1", "claude"), "[hdr-client] caller=claude x-anthropic-client=claude-ai.web-1");
  const long = clientHeaderLine("a".repeat(41), "claude"); assert.ok(!long.includes("aaaa") && long.includes("not logged: length 41, letters"), long);
  const odd = clientHeaderLine("user@example.com/abc", "claude"); assert.ok(!odd.includes("example") && !odd.includes("@") && odd.includes("not logged"), odd);
  assert.ok(clientHeaderLine("", "claude").includes("not logged: length 0, empty"));
});
test("step 2: only preview builds, only that one header, once per distinct value, never another header's value", () => {
  for (const env of ["production", undefined]) { _resetHeaderSpikeForTests(); lines.length = 0; if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env; maybeLogClientHeader(hdrs({ "x-anthropic-client": "claude-ai" }), "claude"); assert.equal(lines.length, 0); }
  process.env.VERCEL_ENV = "preview"; _resetHeaderSpikeForTests(); lines.length = 0;
  const h = hdrs({ "x-anthropic-client": "claude-ai", "x-openai-session": "SESSION-SECRET-9", "x-openai-subject": "SUBJECT-SECRET-7", "user-agent": "Claude-User" });
  maybeLogClientHeader(h, "claude"); maybeLogClientHeader(h, "claude"); assert.equal(lines.length, 1);
  maybeLogClientHeader(hdrs({ "x-anthropic-client": "claude-desktop" }), "claude"); assert.equal(lines.length, 2);
  maybeLogClientHeader(hdrs({ "x-openai-session": "SESSION-SECRET-9" }), "chatgpt"); assert.equal(lines.length, 2, "no x-anthropic-client: nothing logged");
  for (const l of lines) for (const secret of ["SESSION-SECRET-9", "SUBJECT-SECRET-7", "Claude-User"]) assert.ok(!l.includes(secret), `leaked ${secret}`);
});
test("step 2: it never throws", () => {
  process.env.VERCEL_ENV = "preview";
  assert.doesNotThrow(() => maybeLogClientHeader({ get() { throw new Error("boom"); } } as never, "claude"));
});
