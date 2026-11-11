// R4-6 step 5 (11 Nov 2026): the published contract. The search gains NO new field (only one more text line and one marked string inside the already-declared meta.dataNotes);
// the added tool has its own output. Run: npx tsx --test tests/show-more-contract.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CatalogDbOutputSchema } from "../lib/find-matching-vehicle-output";
import { ShowMoreOutputSchema } from "../lib/show-more/output";
import { hintNote, HINT_MARKER } from "../lib/show-more/first-search";

const meta = { totalCandidatesConsidered: 3, totalMatches: null, resultsShown: 0, corpusSizeApprox: "1.4 million", relaxations: [], dataNotes: [] as string[], scopeNote: "local" as const, serviceError: null, interpretationNotes: [], qualifierAccounting: [] };

test("a search reply that carries the hint entry still validates against the search's own published schema, and a strict connector sees no undeclared field", () => {
  const reply = { meta: { ...meta, dataNotes: [hintNote("abcdefghjkmn")] }, results: [] };
  assert.equal(CatalogDbOutputSchema.safeParse(reply).success, true);
  assert.ok(reply.meta.dataNotes[0].startsWith(HINT_MARKER));
  // an undeclared field would be rejected (strict connectors): the hint must NOT travel as a new field
  const json = z.toJSONSchema(CatalogDbOutputSchema) as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(json.properties).sort(), ["meta", "results"], "the search's published output has no new top-level field");
  assert.ok(!JSON.stringify(json).includes("continuation"), "no continuation field leaked into the search schema");
});
test("the added tool's output is the search's own meta and results plus ONE continuation, nothing else", () => {
  const a = z.toJSONSchema(ShowMoreOutputSchema) as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(a.properties).sort(), ["continuation", "meta", "results"]);
  const s = z.toJSONSchema(CatalogDbOutputSchema) as { properties: Record<string, unknown> };
  assert.deepEqual(a.properties.meta, s.properties.meta); assert.deepEqual(a.properties.results, s.properties.results);
});
test("an old-style reply (no hint, no continuation) validates for the search; the new tool needs its continuation key (null when the list is unknown)", () => {
  assert.equal(CatalogDbOutputSchema.safeParse({ meta, results: [] }).success, true);
  assert.equal(ShowMoreOutputSchema.safeParse({ meta, results: [] }).success, false, "continuation is required (null allowed)");
  assert.equal(ShowMoreOutputSchema.safeParse({ meta, results: [], continuation: null }).success, true);
});
