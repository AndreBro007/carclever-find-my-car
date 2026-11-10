// R4-2 (10 Nov 2026, André approved Option 1): the Impact Shared ID names the platform and the link role (mcp + platform + role), no redirect.
// Run: npx tsx --test tests/shared-id-tags.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveLinks } from "../lib/link-resolution";
import { modelLevelLink } from "../lib/dead-end-links";
import { sharedIdTag, setSharedIdPlatformProvider, getSharedIdPlatformProvider, LEGACY_SHARED_ID } from "../lib/shared-id-context";
import { runWithUsageContext } from "../lib/usage-events";

const FEED = "https://edmunds.sjv.io/c/7765200/3913681/52125?prodsku=abc123&u=https%3A%2F%2Fwww.edmunds.com%2Fused-honda-civic%2F&intsrc=CATF_34070";
const listings: Array<[string, any]> = [
  ["used with VIN", { vin: "2HGFE2F59RH512345", vehicle: { make: "Honda", model: "Civic", year: 2024, trim: "Sport" }, retailListing: { used: true } }],
  ["new", { vin: "2HGFE2F59SH512345", vehicle: { make: "Honda", model: "Civic", year: 2026, trim: "Sport" }, retailListing: { used: false } }],
  ["Carvana", { vin: "1FTEW2KPXTKE60933", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, dealer: "Carvana" } }],
  ["certified", { vin: "KM8K2CAB5PU123456", vehicle: { make: "Hyundai", model: "Kona", year: 2023, trim: "SEL" }, retailListing: { used: true, cpo: true } }],
  ["feed item link", { vin: "2HGFE2F59RH512345", vehicle: { make: "Honda", model: "Civic", year: 2024 }, catalog: { itemId: "abc123", trackingUrl: FEED } }],
];
const tagOf = (u: string) => (u.match(/[?&]sharedid=([^&]*)/) ?? [])[1];
const strip = (u: string) => u.replace(/([?&])sharedid=[^&]*&?/, "$1").replace(/[?&]$/, "");
// usage-events registers the real provider when it loads (imported above); each test restores THAT one, never clears it
const original = getSharedIdPlatformProvider();
assert.ok(original, "usage-events must have registered the platform provider");
afterEach(() => setSharedIdPlatformProvider(original));

test("no platform known (tests, scripts): the legacy generic tag, as before", () => {
  assert.equal(sharedIdTag("check"), LEGACY_SHARED_ID); assert.equal(sharedIdTag("similar"), LEGACY_SHARED_ID);
  for (const [label, l] of listings) { const r = resolveLinks(l); for (const u of [r.affiliateUrl, r.affiliateFallbackUrl]) if (u) assert.equal(tagOf(u), "mcpapp", label); }
});
test("each platform and role: Check avail. carries mcp+platform+check, View similar mcp+platform+similar, exactly one tag, letters and numbers only, the affiliate part unchanged", () => {
  const legacy = listings.map(([, l]) => resolveLinks(l));
  for (const p of ["claude", "chatgpt", "grok", "other", "unknown"]) {
    setSharedIdPlatformProvider(() => p);
    listings.forEach(([label, l], i) => {
      const r = resolveLinks(l);
      if (r.affiliateUrl) {
        assert.equal(tagOf(r.affiliateUrl), `mcp${p}check`, `${label} ${p}`); assert.equal((r.affiliateUrl.match(/sharedid=/g) ?? []).length, 1);
        assert.ok(r.affiliateUrl.startsWith("https://edmunds.sjv.io/")); assert.equal(strip(r.affiliateUrl), strip(legacy[i].affiliateUrl!), `${label}: only the tag may differ`);
      }
      if (r.affiliateFallbackUrl) {
        assert.equal(tagOf(r.affiliateFallbackUrl), `mcp${p}similar`, `${label} ${p}`); assert.equal((r.affiliateFallbackUrl.match(/sharedid=/g) ?? []).length, 1);
        assert.ok(r.affiliateFallbackUrl.startsWith("https://edmunds.sjv.io/")); assert.equal(strip(r.affiliateFallbackUrl), strip(legacy[i].affiliateFallbackUrl!), `${label}: only the tag may differ`);
      }
      for (const u of [r.affiliateUrl, r.affiliateFallbackUrl]) if (u) assert.match(tagOf(u)!, /^[A-Za-z0-9]{1,255}$/);
    });
  }
});
test("a malformed or failing platform value never produces a malformed tag: the legacy tag is used", () => {
  for (const bad of ["Claude!", "", "CLAUDE", "has space", "toolongplatformname", "a-b", "x_y", "claude1", null]) {
    setSharedIdPlatformProvider(() => bad as never); assert.equal(sharedIdTag("check"), "mcpapp", String(bad));
  }
  setSharedIdPlatformProvider(() => { throw new Error("boom"); }); assert.equal(sharedIdTag("similar"), "mcpapp");
});
test("the dead-end and not-listed style links are View similar links: role similar", () => {
  setSharedIdPlatformProvider(() => "chatgpt");
  const u = modelLevelLink("Honda", "Civic", false);
  assert.ok(u && tagOf(u) === "mcpchatgptsimilar", String(u));
});
test("in a real request context the platform comes from the caller class (the user agent); outside it, the legacy tag", async () => {
  const cases: Array<[string | null, string]> = [["Claude-User", "claude"], ["openai-mcp/1.0.0", "chatgpt"], ["Grok-Agent/1", "grok"], ["Python-urllib/3.12", "other"], [null, "unknown"]];
  for (const [ua, platform] of cases) {
    const headers: Record<string, string> = { host: "carclever-db-test.getcarwise.app" }; if (ua) headers["user-agent"] = ua;
    const got = await runWithUsageContext(new Request("https://carclever-db-test.getcarwise.app/mcp", { method: "POST", headers }), async () => resolveLinks(listings[0][1]));
    assert.equal(tagOf(got.affiliateUrl!), `mcp${platform}check`, String(ua)); assert.equal(tagOf(got.affiliateFallbackUrl!), `mcp${platform}similar`, String(ua));
  }
  assert.equal(tagOf(resolveLinks(listings[0][1]).affiliateUrl!), "mcpapp", "outside a request: legacy");
});
