// R4-6 step 4b (11 Nov 2026): the words of the reply, the card context and the new tool's published output. Run: npx tsx --test tests/show-more-reply.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { statusText, notFoundText, slotLine, gone, unchecked, leftOutPhrase } from "../lib/show-more/reply";
import { slateCounts, newSlate, expandSlate, type Slot } from "../lib/show-more/slate";
import { cardContextFromRequirements } from "../lib/show-more/card-context";
import { buildRequirements } from "../lib/show-more/requirements";
import { buildQualifierAccounting } from "../lib/qualifier-accounting";
import { ShowMoreOutputSchema, SHOW_MORE_DESCRIPTION } from "../lib/show-more/output";

const slot = (vin: string): Slot => ({ vin, price: 20000, drive: "na", fuel: "na", stars: 5 });
const mk = (nShown: number, nReserve: number) => newSlate(Array.from({ length: nShown }, (_, i) => slot(`S${i + 1}`)), Array.from({ length: nReserve }, (_, i) => ({ vin: `R${i + 1}`, drive: "na" as const, fuel: "na" as const })));

test("status line: counts from the arrays, left-out reasons in words, three end states kept apart", async () => {
  const s = mk(8, 8);
  assert.equal(statusText(slateCounts(s), 8), "8 cars shown · 0 added. Ask for up to 8 more.");
  assert.equal(statusText(slateCounts(s), 12), "8 cars shown · 0 added. Ask again to add more.", "asked for more than the list could give this time (a lost race): say so");
  const grown = (await expandSlate(s, 12, async (e) => (e.vin === "R1" ? { kind: "exclude", reason: "removed" } : { kind: "pass", slot: slot(e.vin) }))).slate;
  assert.equal(statusText(slateCounts(grown, 12), 12), "12 cars shown · 4 added · 1 left out (1 no longer listed). Ask for up to 3 more.");
  const pend = (await expandSlate(mk(8, 2), 10, async (e) => (e.vin === "R1" ? { kind: "pending" } : { kind: "pass", slot: slot(e.vin) }))).slate;
  const t = statusText(slateCounts(pend, 10), 10); assert.match(t, /1 could not be checked right now/); assert.match(t, /ask again to retry/); assert.ok(!/no more verified matches/i.test(t), "never says no more while a car is pending");
  let fin = pend; for (let i = 0; i < 2; i++) fin = (await expandSlate(fin, 10, async () => ({ kind: "pending" }))).slate;
  const f = statusText(slateCounts(fin, 10), 10); assert.match(f, /No more verified matches in this list\. 1 cars could not be verified and are not shown; start a new search/); assert.ok(!/ask again to retry/.test(f), "final: asking again cannot change it");
  const done = (await expandSlate(mk(8, 1), 9, async (e) => ({ kind: "pass", slot: slot(e.vin) }))).slate;
  assert.equal(statusText(slateCounts(done, 9), 9), "9 cars shown · 1 added. No more verified matches in this list.");
});
test("a request for fewer than the list holds still tells the buyer how many more are ready", async () => {
  const full = (await expandSlate(mk(8, 8), 16, async (e) => ({ kind: "pass", slot: slot(e.vin) }))).slate;
  assert.equal(statusText(slateCounts(full, 12), 12), "12 cars shown · 4 added. Ask for up to 4 more.");
  assert.equal(statusText(slateCounts(full, 16), 16), "16 cars shown · 8 added. No more verified matches in this list.");
});
test("left-out phrase uses each reason's own words and skips zero counts", () => {
  const c = slateCounts({ ...mk(8, 0), excluded: [{ vin: "a", reason: "limit_break" }, { vin: "b", reason: "limit_break" }, { vin: "c", reason: "outside_radius" }] });
  assert.equal(leftOutPhrase(c), "1 outside the search area, 2 now outside your limits");
});
test("a list that is unknown, expired or unreadable gets an explicit answer, never a silent rerun", () => {
  assert.match(notFoundText("expired"), /expired.*24 hours.*new search/); assert.match(notFoundText("unknown"), /could not find a list/); assert.match(notFoundText("unavailable"), /could not read the saved list.*Try again/);
});
test("a slot line keeps its number and VIN and says what moved since it was first shown", () => {
  const base = { n: 3, title: "2022 Honda CR-V EX", vin: "VIN3", price: 24500, miles: 30000, used: true, place: "House Of Imports, Buena Park, CA", firstPrice: 24500 };
  assert.equal(slotLine(base), "3. 2022 Honda CR-V EX — VIN VIN3 — $24,500, 30,000 mi, Used — House Of Imports, Buena Park, CA");
  assert.match(slotLine({ ...base, price: 23900 }), /\$23,900 \(was \$24,500 when first shown\)/);
  assert.match(slotLine({ ...base, price: null }), /price not available \(\$24,500 when first shown\)/);
  assert.match(gone(4, "V4", 18000), /^4\. VIN V4 — no longer listed.*keeps this number/); assert.match(unchecked(5, "V5", 18000), /^5\. VIN V5 — could not be re-checked just now/);
});
test("the card context is rebuilt from the stored requirements only", () => {
  const ctx = cardContextFromRequirements({ make: "Honda", models: ["CR-V"], priceMax: 30000, condition: "used", trimRequired: ["EX-L"], exteriorColors: ["gray", "silver"], relaxations: ["price", "trim_close"] });
  assert.equal(ctx.intent.hardConstraints.priceMax, 30000); assert.equal(ctx.intentInput.used, true); assert.equal(ctx.intentInput.exteriorColor, "gray silver");
  assert.equal(ctx.evidence.used, true); assert.deepEqual([...ctx.relaxedFields].sort(), ["priceMax", "trimRequired"]);
  assert.doesNotThrow(() => cardContextFromRequirements({}));
});
test("CONFIRM AT BUILD (design section 7): the colour disclosure is IDENTICAL when fed the stored colour words instead of the original wording", () => {
  for (const wording of ["Silver", "silver", "WHITE", "Gray silver"]) {
    const req = buildRequirements({ make: "Honda", exteriorColor: wording, interiorColor: wording })!;
    const original = buildQualifierAccounting({ exteriorColor: wording, interiorColor: wording } as never);
    const rebuilt = buildQualifierAccounting(cardContextFromRequirements(req).intentInput);
    assert.deepEqual(rebuilt, original, wording);
  }
  assert.equal(buildRequirements({ exteriorColor: "Glacier White" }), null, "a word outside the table: not expandable, the search answers as today");
});
test("the new tool's own output is the search's results and meta plus a continuation (null when the list is unknown)", () => {
  const meta = { totalCandidatesConsidered: 0, totalMatches: null, resultsShown: 0, corpusSizeApprox: "1.4 million", relaxations: [], dataNotes: [], scopeNote: "local", serviceError: null, interpretationNotes: [], qualifierAccounting: [] };
  assert.equal(ShowMoreOutputSchema.safeParse({ meta, results: [], continuation: null }).success, true);
  const cont = { reference: "abcdefghjkmn", shown: 12, added: 4, addedNow: 4, leftOut: { contradicted_filter: 0, outside_radius: 0, removed: 1, limit_break: 0 }, leftOutTotal: 1, pending: 0, couldNotCheck: 0, canAdd: 3, cap: 16, state: "more_available" };
  assert.equal(ShowMoreOutputSchema.safeParse({ meta, results: [], continuation: cont }).success, true);
  assert.equal(ShowMoreOutputSchema.safeParse({ meta, results: [], continuation: { ...cont, state: "weird" } }).success, false);
  assert.ok(SHOW_MORE_DESCRIPTION.length < 600 && /never make one up/.test(SHOW_MORE_DESCRIPTION));
});
test("the tool exists only on preview builds, is flagged as writing list state, and the search's own contract is untouched", () => {
  const src = readFileSync("app/[transport]/route.ts", "utf8");
  assert.match(src, /if \(showMoreEnabled\(\)\) \{\s*server\.registerTool\(\s*"show_more_vehicles"/);
  assert.match(src, /readOnlyHint: false, idempotentHint: true, openWorldHint: true, destructiveHint: false/);
  assert.ok(src.includes('outputSchema: CatalogDbOutputSchema'), "the search keeps its own published output schema");
});
