// Database app: accurate tool description and input notes, and the VIN-not-listed links (decode, then the same Edmunds affiliate links).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogDescription, CATALOG_DESCRIPTION_EDITS } from "../lib/catalog-output";
import { FindMatchingVehicleInput, FindMatchingVehicleInputCatalog } from "../lib/find-matching-vehicle-input";
import { notListedLinksText } from "../lib/vin-not-listed";

const src = readFileSync("app/[transport]/route.ts", "utf8");
const m = /const FIND_MATCHING_VEHICLE_DESCRIPTION = \(\) => `((?:[^`\\]|\\.)*)`;/.exec(src);

test("description variant: the three Auto.dev-era sentences are replaced, the rest is untouched", () => {
  assert.ok(m, "description template must be found in route.ts");
  const base = m![1];
  for (const [from] of CATALOG_DESCRIPTION_EDITS) assert.ok(base.includes(from), "base must contain: " + from.slice(0, 50));
  const v = catalogDescription(base);
  for (const [from, to] of CATALOG_DESCRIPTION_EDITS) { assert.ok(!v.includes(from)); assert.ok(v.includes(to)); }
  let expected = base; for (const [from, to] of CATALOG_DESCRIPTION_EDITS) expected = expected.replace(from, () => to);
  assert.equal(v, expected); // nothing else changed
  assert.ok(!v.includes("Most direct criteria are matched against actual listing data")); // the inaccurate claim is gone
  assert.ok(/NHTSA safety information/.test(v) && /a link to similar vehicles on Edmunds/.test(v) && !/exact VIN and to similar/.test(v));
  assert.ok(!/carfax|risk tier|accident-free guarantee/i.test(v));
});
test("input variant: same fields and types, only the notes for vin, colours, cpo, noAccidents, oneOwner differ", () => {
  const a = Object.keys(FindMatchingVehicleInput.shape).sort(), b = Object.keys(FindMatchingVehicleInputCatalog.shape).sort();
  assert.deepEqual(a, b); assert.equal(a.length, 31);
  const d = (k: string, s: any) => String(s.shape[k].description);
  for (const k of ["cpo", "noAccidents", "oneOwner"]) assert.ok(/no .* data, so results are reported as unconfirmed/.test(d(k, FindMatchingVehicleInputCatalog)), k);
  assert.ok(/a link to similar vehicles on Edmunds/.test(d("vin", FindMatchingVehicleInputCatalog)));
  assert.ok(/fewer than 3 cars match/.test(d("exteriorColor", FindMatchingVehicleInputCatalog)));
  assert.ok(!/no similar-vehicle substitute/.test(d("vin", FindMatchingVehicleInputCatalog))); assert.ok(/no similar-vehicle substitute/.test(d("vin", FindMatchingVehicleInput)));
  // the parsing behaviour is identical
  assert.deepEqual(FindMatchingVehicleInputCatalog.safeParse({ make: "Honda", used: true, cpo: true }).success, FindMatchingVehicleInput.safeParse({ make: "Honda", used: true, cpo: true }).success);
  assert.equal(FindMatchingVehicleInputCatalog.safeParse({ used: "yes" }).success, false);
});

const fakeDecode = (o: object) => (async () => ({ make: "TOYOTA", model: "RAV4", modelYear: "2021", trimOptions: ["LE"], ...o })) as any;
test("VIN not listed: a used-age car gets ONE link, the similar-vehicles Edmunds link (real link builder)", async () => {
  const t = await notListedLinksText("2T3H1RFV0MC000001", { decode: fakeDecode({}), currentYear: 2026 });
  assert.match(t, /This VIN decodes to a 2021 Toyota RAV4 LE\./);
  assert.match(t, /Similar 2021 Toyota RAV4 LE for sale on Edmunds: https:\/\/edmunds\.sjv\.io\//);
  assert.equal((t.match(/https:\/\//g) ?? []).length, 1); assert.ok(!/exact VIN|availability/i.test(t));
});
test("VIN not listed: a current-model-year car is treated as new, and still only the similar link is shown", async () => {
  let seen: any;
  const t = await notListedLinksText("2T3H1RFV0TC000001", { decode: fakeDecode({ modelYear: "2026", trimOptions: [] }), currentYear: 2026, resolve: ((l: any) => { seen = l; return { affiliateUrl: "https://x/a", affiliateFallbackUrl: "https://x/b" }; }) as any });
  assert.equal(seen.retailListing.used, false); assert.equal(seen.vehicle.trim, undefined);
  assert.match(t, /Similar 2026 Toyota RAV4 for sale on Edmunds: https:\/\/x\/b/); assert.ok(!t.includes("https://x/a")); // the availability link is never shown
});
test("VIN not listed: several NHTSA trims means no trim is claimed; an undecodable VIN adds nothing", async () => {
  const t = await notListedLinksText("2T3H1RFV0MC000001", { decode: fakeDecode({ trimOptions: ["LE", "XLE"] }), currentYear: 2026 });
  assert.match(t, /decodes to a 2021 Toyota RAV4\./); assert.ok(!/ LE|XLE/.test(t));
  assert.equal(await notListedLinksText("2T3H1RFV0MC000001", { decode: (async () => null) as any }), "");
  assert.equal(await notListedLinksText("X", { decode: fakeDecode({ model: null }) }), "");
  assert.equal(await notListedLinksText("X", { decode: fakeDecode({}), resolve: (() => ({ affiliateUrl: null, affiliateFallbackUrl: null })) as any }), "");
  assert.equal(await notListedLinksText("X", { decode: fakeDecode({}), resolve: (() => ({ affiliateUrl: "https://x/a", affiliateFallbackUrl: null })) as any }), ""); // no similar link: nothing is shown
});
