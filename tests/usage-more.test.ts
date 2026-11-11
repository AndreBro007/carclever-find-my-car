// R4-6 (11 Nov 2026, André approved the count-only line): usage rows for show_more_vehicles. Run: npx tsx --test tests/usage-more.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { moreOutcome, sanitizeUsageEvent, OUTCOMES, type UsageEvent } from "../lib/usage-events";

const cont = (o: Record<string, unknown> = {}) => ({ structuredContent: { continuation: { reference: "abcdefghjkmn", shown: 12, added: 4, pending: 0, couldNotCheck: 0, ...o } }, content: [{ type: "text", text: "Showing 12 cars from your search (reference abcdefghjkmn)." }] });

test("the outcome is one fixed word and two counts: added, unchanged, pending", () => {
  assert.deepEqual(moreOutcome(cont()), { outcome: "added", found: 4, shown: 12 });
  assert.deepEqual(moreOutcome(cont({ added: 0 })), { outcome: "unchanged", found: 0, shown: 12 });
  assert.deepEqual(moreOutcome(cont({ pending: 2 })), { outcome: "pending", found: 4, shown: 12 });
});
test("no list: unknown, expired and unreadable are told apart; an error is an error", () => {
  const t = (text: string) => ({ content: [{ type: "text", text }], structuredContent: { continuation: null } });
  assert.equal(moreOutcome(t("That list has expired (lists are kept for 24 hours). Run a new search to get a fresh list.")).outcome, "list_expired");
  assert.equal(moreOutcome(t("I could not read the saved list just now. Try again in a moment, or run a new search.")).outcome, "list_unavailable");
  assert.equal(moreOutcome(t("I could not find a list with that reference.")).outcome, "list_unknown");
  assert.equal(moreOutcome({ isError: true, content: [] }).outcome, "error"); assert.equal(moreOutcome(null).outcome, "error");
});
test("the stored event carries the fixed words and counts only: the reference, a VIN or any text never reaches it", () => {
  const out = moreOutcome(cont()); const ev = { tool: "more", outcome: out.outcome, env: "test", caller_class: "chatgpt", found: out.found, shown: out.shown } as UsageEvent;
  const clean = sanitizeUsageEvent(ev)!; assert.equal(clean.tool, "more"); assert.equal(clean.outcome, "added"); assert.equal(clean.found, 4); assert.equal(clean.shown, 12);
  assert.ok(!JSON.stringify(clean).includes("abcdefghjkmn"), "no reference in the event");
  const bad = sanitizeUsageEvent({ ...ev, outcome: "abcdefghjkmn 1HGCM82633A004352" } as UsageEvent)!; assert.equal(bad.outcome, "error", "any word outside the fixed list becomes error");
  assert.equal(sanitizeUsageEvent({ ...ev, tool: "other" } as unknown as UsageEvent), null);
  for (const w of ["added", "unchanged", "pending", "list_unknown", "list_expired", "list_unavailable"]) assert.ok(OUTCOMES.includes(w), w);
});
