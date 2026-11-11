// R4-6 step 3b (11 Nov 2026): the first-search snapshot and the texts. Run: npx tsx --test tests/show-more-first-search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFirstSearchSlate, showMoreEnabled, starsOf, triState, hintNote, moreText, HINT_MARKER, type FirstSearchData } from "../lib/show-more/first-search";
import { readFileSync } from "node:fs";

const shown = (n: number) => Array.from({ length: n }, (_, i) => ({ vin: `s${i + 1}`, price: 20000 + i * 100.4, rating: 5 }));
const base = (over: Partial<FirstSearchData> = {}): FirstSearchData => ({ shown: shown(8), reserveVins: ["r1", "r2", "r3"], excludedVins: [], driveRequired: false, driveConfirmed: new Set(), fuelRequired: false, fuelMatched: null, ...over });

test("only preview builds (or an explicit switch) write a list; production stays off", () => {
  assert.equal(showMoreEnabled({ VERCEL_ENV: "preview" }), true); assert.equal(showMoreEnabled({ SHOW_MORE_ENABLED: "1" }), true);
  assert.equal(showMoreEnabled({ VERCEL_ENV: "production" }), false); assert.equal(showMoreEnabled({}), false); assert.equal(showMoreEnabled({ SHOW_MORE_ENABLED: "0" }), false);
});
test("the list freezes the shown cars exactly: upper-case VINs, whole-dollar price when first shown, stars, states", () => {
  const s = buildFirstSearchSlate(base())!;
  assert.equal(s.slots.length, 8); assert.equal(s.firstShown, 8); assert.deepEqual(s.slots[0], { vin: "S1", price: 20000, drive: "na", fuel: "na", stars: 5 }); assert.equal(s.slots[1].price, 20100);
  assert.deepEqual(s.reserve.map((r) => r.vin), ["R1", "R2", "R3"]);
});
test("drive and fuel states: confirmed or unconfirmed only when required, otherwise not applicable", () => {
  const s = buildFirstSearchSlate(base({ driveRequired: true, driveConfirmed: new Set(["S1", "R1"]), fuelRequired: true, fuelMatched: new Set(["S1"]) }))!;
  assert.equal(s.slots[0].drive, "confirmed"); assert.equal(s.slots[1].drive, "unconfirmed"); assert.equal(s.slots[0].fuel, "confirmed"); assert.equal(s.slots[1].fuel, "unconfirmed");
  assert.equal(s.reserve[0].drive, "confirmed"); assert.equal(s.reserve[1].drive, "unconfirmed"); assert.equal(s.reserve[0].fuel, "unconfirmed");
  assert.equal(triState(false, true), "na");
});
test("cars the detail stage rejected are recorded as left out and never sit in the reserve", () => {
  const s = buildFirstSearchSlate(base({ excludedVins: ["r2", "s3"], reserveVins: ["r1", "r2", "r3"] }))!;
  assert.deepEqual(s.excluded, [{ vin: "R2", reason: "contradicted_filter" }], "a shown car is never excluded");
  assert.deepEqual(s.reserve.map((r) => r.vin), ["R1", "R3"]);
});
test("nothing to expand, or a card that cannot be frozen exactly, means no list at all", () => {
  assert.equal(buildFirstSearchSlate(base({ reserveVins: [] })), null, "empty reserve: no hint");
  assert.equal(buildFirstSearchSlate(base({ reserveVins: ["s1", "s2"] })), null, "reserve made only of shown cars");
  assert.equal(buildFirstSearchSlate(base({ shown: [] })), null);
  assert.equal(buildFirstSearchSlate(base({ shown: [{ vin: "s1", price: null }] })), null, "no price: cannot freeze it");
  assert.equal(buildFirstSearchSlate(base({ shown: [{ vin: "s1", price: 1 }, { vin: "S1", price: 2 }] })), null, "duplicate VIN");
});
test("stars: 0 to 5 as given, anything else means none", () => {
  assert.equal(starsOf(4.6), 5); assert.equal(starsOf(undefined), "none"); assert.equal(starsOf(9), "none"); assert.equal(starsOf("5"), "none");
});
test("the texts carry the reference, the 24 hours, the tool name and the cap; the hint starts with the marker", () => {
  assert.ok(hintNote("abcdefghjkmn").startsWith(HINT_MARKER)); assert.match(hintNote("abcdefghjkmn"), /abcdefghjkmn/); assert.match(hintNote("abcdefghjkmn"), /show_more_vehicles/);
  const t = moreText("abcdefghjkmn"); assert.match(t, /abcdefghjkmn/); assert.match(t, /24 hours/); assert.match(t, /up to 16/); assert.match(t, /keep their numbers/);
});
test("the search hooks the write before the reply is built, and adds the text only when a reference exists", () => {
  const src = readFileSync("app/[transport]/route.ts", "utf8");
  assert.ok(src.indexOf("buildFirstSearchSlate(") < src.indexOf("const response = {", src.indexOf("buildFirstSearchSlate(") - 6000), "the write happens before the search's reply object");
  assert.ok(src.indexOf("buildFirstSearchSlate(") < src.indexOf("const response = {", src.indexOf("buildFirstSearchSlate(")), "and a reply object follows the write");
  assert.match(src, /\(moreRef \? moreText\(moreRef\) : ""\)/);
  assert.match(src, /showMoreEnabled\(\) && cards\.length > 0/);
});
