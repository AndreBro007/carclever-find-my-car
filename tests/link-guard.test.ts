// V3 link guard (plan Oct 8): every URL the MCP link builders produce must (a) use the Impact base edmunds.sjv.io, (b) carry sharedid=mcpapp
// exactly once, (c) never contain anrdoezrs.net (the dead CJ network). Covers resolveLinks (all branches), the dead-end links and the
// VIN-not-listed link, plus the Shared ID helper itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLinks } from "../lib/link-resolution";
import { withSharedId, MCP_SHARED_ID, wrapWithAffiliateNetwork } from "../lib/edmunds-cj";
import { modelLevelLink, closingExitLine, zeroResultsExitLine } from "../lib/dead-end-links";
import { notListedLinksText } from "../lib/vin-not-listed";

const FEED = "https://edmunds.sjv.io/c/7765200/3913681/52125?prodsku=abc123&u=https%3A%2F%2Fwww.edmunds.com%2Fused-honda-civic%2F&intsrc=CATF_34070";
const listings: Array<[string, any]> = [
  ["used with VIN", { vin: "2HGFE2F59RH512345", vehicle: { make: "Honda", model: "Civic", year: 2024, trim: "Sport" }, retailListing: { used: true } }],
  ["used without VIN", { vehicle: { make: "Honda", model: "Civic", year: 2024, trim: "Sport" } }],
  ["new", { vin: "2HGFE2F59SH512345", vehicle: { make: "Honda", model: "Civic", year: 2026, trim: "Sport" }, retailListing: { used: false } }],
  ["Carvana", { vin: "1FTEW2KPXTKE60933", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, dealer: "Carvana" } }],
  ["certified", { vin: "KM8K2CAB5PU123456", vehicle: { make: "Hyundai", model: "Kona", year: 2023, trim: "SEL" }, retailListing: { used: true, cpo: true } }],
  ["make and model only", { vehicle: { make: "Toyota", model: "RAV4" } }],
  ["feed item link", { vin: "2HGFE2F59RH512345", vehicle: { make: "Honda", model: "Civic", year: 2024 }, catalog: { itemId: "abc123", trackingUrl: FEED } }],
];
function assertGuarded(url: string | null | undefined, label: string) {
  if (!url) return;
  assert.ok(url.startsWith("https://edmunds.sjv.io/"), `${label}: must use the Impact base: ${url}`);
  assert.equal((url.match(/sharedid=/g) ?? []).length, 1, `${label}: exactly one sharedid: ${url}`);
  assert.ok(url.includes(`sharedid=${MCP_SHARED_ID}`), `${label}: must carry sharedid=${MCP_SHARED_ID}`);
  assert.ok(!url.includes("anrdoezrs.net"), `${label}: no dead CJ network`);
  assert.match(MCP_SHARED_ID, /^[A-Za-z0-9]+$/); // Impact: letters and numbers only
}
test("every link resolveLinks produces is on the Impact base and carries the MCP Shared ID", () => {
  let checked = 0;
  for (const [name, l] of listings) { const r = resolveLinks(l); for (const u of [r.affiliateUrl, r.affiliateFallbackUrl]) { assertGuarded(u, name); if (u) checked++; } }
  assert.ok(checked >= 10, `expected at least 10 links to be checked, got ${checked}`);
});
test("the wrapped destination is unchanged by the tag (u= still decodes to the same Edmunds page) and the feed link keeps all its own parameters", () => {
  const w = wrapWithAffiliateNetwork("https://www.edmunds.com/used-honda-civic-sport/");
  assert.equal(decodeURIComponent(w.split("u=")[1].split("&sharedid=")[0]), "https://www.edmunds.com/used-honda-civic-sport/");
  const f = resolveLinks(listings[6][1]).affiliateUrl!;
  assert.ok(f.startsWith(FEED) && f.endsWith("&sharedid=mcpapp") && f.includes("prodsku=abc123") && f.includes("intsrc=CATF_34070"));
});
test("withSharedId: idempotent, only edmunds.sjv.io, never invalid tags, never re-encodes", () => {
  const u = "https://edmunds.sjv.io/c/1/2/3?u=https%3A%2F%2Fwww.edmunds.com%2Fx%2F";
  const once = withSharedId(u); assert.equal(once, u + "&sharedid=mcpapp"); assert.equal(withSharedId(once), once);
  assert.equal(withSharedId("https://edmunds.sjv.io/c/1/2/3"), "https://edmunds.sjv.io/c/1/2/3?sharedid=mcpapp");
  assert.equal(withSharedId("https://example.com/a?b=1"), "https://example.com/a?b=1"); assert.equal(withSharedId("not a url"), "not a url");
  assert.equal(withSharedId(u + "&sharedid=other"), u + "&sharedid=other"); // an existing tag is kept
  for (const bad of ["claude-test", "lite_result", "has space", "", "a".repeat(256)]) assert.throws(() => withSharedId(u, bad), /letters and numbers only/);
});
test("dead-end links and the VIN-not-listed link carry the tag too", async () => {
  assertGuarded(modelLevelLink("Toyota", "RAV4", false), "model level used"); assertGuarded(modelLevelLink("Toyota", "RAV4", true), "model level new");
  for (const text of [closingExitLine([{ identity: { make: "Honda", model: "CR-V" }, condition: { inventoryType: "used" } }], true), zeroResultsExitLine("Toyota", "Supra", undefined, true)])
    for (const u of text.match(/https:\/\/\S+/g) ?? []) assertGuarded(u, "dead end line");
  const t = await notListedLinksText("2T3H1RFV0MC000001", { decode: (async () => ({ make: "TOYOTA", model: "RAV4", modelYear: "2021", trimOptions: ["LE"] })) as any, currentYear: 2026 });
  const urls = t.match(/https:\/\/\S+/g) ?? []; assert.equal(urls.length, 1); urls.forEach((u) => assertGuarded(u, "not listed"));
});
