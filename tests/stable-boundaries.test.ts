// Stable-boundaries regression test suite for CarClever Find My Car
// ================================================================
//
// Tests important settled contracts using REAL exported implementations
// wherever they exist, with actual jsdom DOM rendering for widget behavior.
// Only D5/D6 use structural (comment-stripped source) verification, since
// that logic is embedded in the Next.js route handler and not exported.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";

// Strips // line comments and /* */ block comments from a TS source string,
// so structural assertions (D5/D6) can never be satisfied by a comment.
// Uses a negative lookbehind so "//" inside a URL (e.g. "https://...") is
// never mistaken for the start of a line comment.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

// ============================================================================
// D1. VIN DEDUP — REAL applyDiversity(listings, limit)
// ============================================================================

function listing(overrides: any) {
  return {
    vin: overrides.vin,
    vehicle: { make: overrides.make, model: overrides.model, year: overrides.year ?? 2026, trim: overrides.trim },
    retailListing: { used: true, price: overrides.price, miles: overrides.miles, cpo: false },
  };
}

test("D1a. applyDiversity() same VIN with casing AND whitespace variation appears once", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: "1FTEW2KP9TKE60602", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "  1ftew2kp9tke60602  ", make: "Ford", model: "F-150", trim: "Lariat", price: 35000, miles: 1500 }), // lowercase + whitespace-padded duplicate
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 1, "case/whitespace-normalized duplicate VIN should be removed");
});

test("D1b. applyDiversity() first-ranked included occurrence wins (distinguishable price)", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: "1FTEW2KP9TKE60602", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "1FTEW2KP9TKE60602", make: "Ford", model: "F-150", trim: "Lariat", price: 99999, miles: 1500 }),
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.retailListing?.price, 30000, "the first-ranked object should survive, not the second");
});

test("D1c. applyDiversity() two distinct valid VINs with IDENTICAL make/model/trim remain distinct", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: "1FTEW2KP9TKE60602", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "1FTEW2KPXTKE60933", make: "Ford", model: "F-150", trim: "Lariat", price: 32000, miles: 1200 }),
  ];

  // limit is high enough that the make/model cap (2) does not interfere
  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "two distinct VINs must both survive despite identical make/model/trim");
});

test("D1d. applyDiversity() blank VINs do not collapse", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: "", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "", make: "Honda", model: "CR-V", trim: "EX", price: 25000, miles: 800 }),
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "blank VINs must not be treated as the same VIN");
});

test("D1e. applyDiversity() missing/null VINs do not collapse", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: undefined, make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: null, make: "Honda", model: "CR-V", trim: "EX", price: 25000, miles: 800 }),
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "missing/null VINs must not be treated as the same VIN");
});

test("D1f. applyDiversity() identical malformed/short VINs do not collapse", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    listing({ vin: "SHORT", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "SHORT", make: "Honda", model: "CR-V", trim: "EX", price: 25000, miles: 800 }),
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "identical <17-char VINs are not valid VINs and must not dedup");
});

test("D1g. applyDiversity() make/model diversity: alternative make preferred before backfilling a 3rd same-model copy", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  // 3 distinct-VIN Ford F-150 candidates (ranked first) + 1 Toyota Tundra (ranked last).
  // MAX_PER_MAKE_MODEL is 2, so only 2 F-150s pass the diversity pass; with limit=3,
  // the diversity pass should include the Tundra before the backfill pass would
  // reach for the 3rd F-150.
  const candidates = [
    listing({ vin: "VIN001", make: "Ford", model: "F-150", trim: "Lariat", price: 30000, miles: 1000 }),
    listing({ vin: "VIN002", make: "Ford", model: "F-150", trim: "XLT", price: 28000, miles: 2000 }),
    listing({ vin: "VIN003", make: "Ford", model: "F-150", trim: "STX", price: 26000, miles: 3000 }),
    listing({ vin: "VIN004", make: "Toyota", model: "Tundra", trim: "SR", price: 32000, miles: 1500 }),
  ];

  const result = applyDiversity(candidates as any, 3);
  assert.equal(result.length, 3, "result respects limit");

  const includesTundra = result.some((c: any) => c.vin === "VIN004");
  assert.ok(includesTundra, "diversity pass must include the alternative make/model before the backfill pass reaches the 3rd same-model F-150");

  const fPickupCount = result.filter((c: any) => c.vehicle.make === "Ford").length;
  assert.equal(fPickupCount, 2, "only 2 F-150s should be included by the diversity cap; the 3rd comes only if there is no alternative");
});

// ============================================================================
// D2. LINK RESOLUTION — REAL resolveLinks() + buildEdmundsCategoryUrl()
// ============================================================================

test("D2a. resolveLinks() normal non-Carvana listing: affiliateUrl is VIN-specific, fallback exists, dealerListingUrl separate, isCarvana false", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, vdp: "https://dealer.example.com/vdp/12345", dealer: "Example Ford" },
  };

  const links = resolveLinks(l as any);

  assert.ok(links.affiliateUrl, "affiliateUrl should be present for a normal non-Carvana listing");
  assert.ok(links.affiliateUrl!.includes("1FTEW2KP9TKE60602"), "affiliateUrl should be VIN-specific");
  assert.ok(links.affiliateFallbackUrl, "affiliateFallbackUrl should be present");
  assert.equal(links.dealerListingUrl, "https://dealer.example.com/vdp/12345", "dealerListingUrl must remain the raw dealer VDP, separate from affiliateUrl");
  assert.notEqual(links.dealerListingUrl, links.affiliateUrl, "dealer VDP must never replace/equal affiliateUrl");
  assert.equal(links.isCarvana, false);
  assert.equal(links.checkAvailSource, "unconfirmed", "no hostSearchResult supplied -> fails open to the pre-verification default");
});

test("D2b. resolveLinks() Carvana listing: affiliateUrl is null, dealerListingUrl and fallback remain available", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KPXTKE60933",
    vehicle: { make: "Honda", model: "CR-V", year: 2026, trim: "EX" },
    retailListing: { used: true, vdp: "https://www.carvana.com/vehicle/1234567", dealer: "Carvana" },
  };

  const links = resolveLinks(l as any);

  assert.equal(links.isCarvana, true, "Carvana dealer name should be detected");
  assert.equal(links.affiliateUrl, null, "affiliateUrl must be null for a Carvana listing (known-dead on Edmunds)");
  assert.equal(links.dealerListingUrl, "https://www.carvana.com/vehicle/1234567", "dealerListingUrl must remain available for internal use");
  assert.ok(links.affiliateFallbackUrl, "affiliateFallbackUrl (category page) should still be available since make/model are valid");
  assert.equal(links.checkAvailSource, "none", "Carvana has no exact-VIN URL to confirm or fall back from in the first place");
});

test("D2p. resolveLinks() unavailable-bare: neither VIN-specific nor category fallback available (make/model missing) -- the 4th required deterministic outcome per the approved design doc (exact VIN / targeted fallback / unavailable-with-similar / unavailable-bare)", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  // Carvana (kills affiliateUrl) AND make/model missing (kills
  // affiliateFallbackUrl too, since buildEdmundsCategoryUrl requires both
  // to build even the widest bare-make/model tier) -- the one combination
  // that genuinely has no CJ destination at all, matching Edmunds' own
  // "unavailable, no similar grid" case from the design doc's Chrome
  // ground-truth testing (2/24 URLs, both 2027 MINI Cooper Countryman).
  const l = {
    vin: "1FTEW2KPXTKE60933",
    vehicle: { make: undefined, model: undefined, year: 2026 },
    retailListing: { used: true, vdp: "https://www.carvana.com/vehicle/1234567", dealer: "Carvana" },
  };

  const links = resolveLinks(l as any);

  assert.equal(links.affiliateUrl, null);
  assert.equal(links.affiliateFallbackUrl, null, "unavailable-bare: no category fallback either when make/model are unknown");
  assert.equal(links.linkStatus, "dealer-only", "dealerListingUrl is the only thing left -- never routed to as a user-facing link, but present internally");
  assert.equal(links.checkAvailSource, "none");
});

// ----------------------------------------------------------------------------
// D2h-l. Host-AI-driven Edmunds verification (SYS-20260903-005). Unlike the
// earlier (blocked, see SYS-20260903-004) Google-CSE design, there's no
// vendor API for these tests to mock — resolveLinks() just takes a plain
// HostSearchResult object, exactly what the resolve_vehicle_availability
// tool in app/[transport]/route.ts constructs from its input. Covers the 5
// scenarios Andre asked for explicitly: exact VIN found; VIN not found but
// wider match found; neither found; timeout/failure (modeled as the host
// simply not supplying a result, e.g. because its search infra failed);
// and that every final link stays CJ-wrapped in every case.
// ----------------------------------------------------------------------------

const CJ_PREFIX = "https://www.anrdoezrs.net/click-";

test("D2h. resolveLinks() exact VIN found by host search -> checkAvailSource 'confirmed-exact', uses the deterministic canonical URL (not the host's raw found URL)", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford", city: "Dallas", state: "TX" },
  };
  const hostSearchResult = {
    vinFound: true,
    edmundsFound: true,
    edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/1FTEW2KP9TKE60602/featured-listing/?src=serp",
    fallbackUsed: false,
  };

  const links = resolveLinks(l as any, hostSearchResult);

  assert.equal(links.checkAvailSource, "confirmed-exact");
  assert.ok(links.affiliateUrl, "affiliateUrl should be present");
  assert.ok(links.affiliateUrl!.startsWith(CJ_PREFIX), "must be CJ-wrapped");
  const decoded = decodeURIComponent(links.affiliateUrl!.split("url=")[1]);
  assert.ok(!decoded.includes("src=serp"), "must use our own canonical URL, not the host's raw found URL/tracking params");
  assert.ok(decoded.includes("1FTEW2KP9TKE60602"));
});

test("D2i. resolveLinks() VIN not found, wider Edmunds match found -> checkAvailSource 'targeted-fallback', uses the host's actual found URL", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford", city: "Dallas", state: "TX" },
  };
  const hostSearchResult = {
    vinFound: false,
    edmundsFound: true,
    edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/DIFFERENTVIN12345/featured-listing/",
    fallbackUsed: true,
  };

  const links = resolveLinks(l as any, hostSearchResult);

  assert.equal(links.checkAvailSource, "targeted-fallback");
  assert.ok(links.affiliateUrl);
  assert.ok(links.affiliateUrl!.startsWith(CJ_PREFIX), "must be CJ-wrapped");
  const decoded = decodeURIComponent(links.affiliateUrl!.split("url=")[1]);
  assert.ok(decoded.includes("DIFFERENTVIN12345"), "must use the host's actual found URL for a close match, not fabricate the original VIN's URL");
  assert.ok(!decoded.includes("1FTEW2KP9TKE60602"), "a wider-search result must never be presented as if it confirmed the exact VIN");
});

test("D2j. resolveLinks() neither search finds a useful result -> checkAvailSource 'unconfirmed', fails open to the deterministic exact URL, CTA never dropped", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford" },
  };
  const hostSearchResult = { vinFound: false, edmundsFound: false, edmundsUrl: null, fallbackUsed: false };

  const links = resolveLinks(l as any, hostSearchResult);

  assert.equal(links.checkAvailSource, "unconfirmed");
  assert.ok(links.affiliateUrl, "affiliateUrl must still be present even when neither search finds evidence");
  assert.ok(links.affiliateUrl!.startsWith(CJ_PREFIX));
  const decoded = decodeURIComponent(links.affiliateUrl!.split("url=")[1]);
  assert.ok(decoded.includes("1FTEW2KP9TKE60602"));
});

test("D2k. resolveLinks() host search timeout/failure (no hostSearchResult supplied at all) -> identical fail-open behavior to 'neither found', never throws, CTA never dropped", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford" },
  };

  // No second argument at all — represents the host's verification step
  // never completing (timed out, errored, or was simply never called).
  const links = resolveLinks(l as any);

  assert.equal(links.checkAvailSource, "unconfirmed");
  assert.ok(links.affiliateUrl, "a missing/failed host verification must never remove the existing monetized CTA");
  assert.ok(links.affiliateUrl!.startsWith(CJ_PREFIX));
});

test("D2m. redactLinksForDataOnlyResponse() enforces the mandatory two-call sequence contract (SYS-20260903-006): always nulls affiliateUrl/affiliateFallbackUrl regardless of input, never touches other fields — this is what makes it structurally impossible for find_matching_vehicle to leak a real link no matter what resolveLinks() computed", async () => {
  const { resolveLinks, redactLinksForDataOnlyResponse } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, vdp: "https://dealer.example.com/vdp/12345", dealer: "Example Ford" },
  };

  const scenarios: Array<{ vinFound: boolean; edmundsFound: boolean; edmundsUrl: string | null; fallbackUsed: boolean } | undefined> = [
    { vinFound: true, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/1FTEW2KP9TKE60602/featured-listing/", fallbackUsed: false },
    { vinFound: false, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/DIFFERENTVIN12345/featured-listing/", fallbackUsed: true },
    { vinFound: false, edmundsFound: false, edmundsUrl: null, fallbackUsed: false },
    undefined,
  ];

  for (const s of scenarios) {
    const resolved = resolveLinks(l as any, s);
    const redacted = redactLinksForDataOnlyResponse(resolved);

    assert.equal(redacted.affiliateUrl, null, `affiliateUrl must always be null after redaction, scenario ${JSON.stringify(s)}`);
    assert.equal(redacted.affiliateFallbackUrl, null, `affiliateFallbackUrl must always be null after redaction, scenario ${JSON.stringify(s)}`);
    // Everything else must pass through unchanged — redaction is
    // link-only, it must not hide other diagnostic fields.
    assert.equal(redacted.dealerListingUrl, resolved.dealerListingUrl);
    assert.equal(redacted.isCarvana, resolved.isCarvana);
    assert.equal(redacted.linkStatus, resolved.linkStatus);
    assert.equal(redacted.checkAvailSource, resolved.checkAvailSource);
  }
});

test("D2n. resolveLinks() alone (no redaction) still returns a real, unconfirmed link — confirming redaction in route.ts's data-only paths is load-bearing and not redundant with resolveLinks()'s own fail-open default", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford" },
  };

  // Mirrors exactly how find_matching_vehicle calls buildResultCard() (via
  // resolveLinks(listing) with no second argument) before route.ts's own
  // redactLinksForDataOnlyResponse() step runs.
  const withoutRedaction = resolveLinks(l as any);
  assert.ok(
    withoutRedaction.affiliateUrl,
    "resolveLinks() alone still returns a real (unconfirmed) link — the redaction call site in route.ts, not resolveLinks() itself, is what must never be skipped or removed",
  );
});

test("D2q. resolveLinks() CPO listing: affiliateFallbackUrl always routes to the dedicated used-certified-pre-owned-{make}-{model} page, never plain used-/new-, regardless of close vs. loose -- SYS-20260903-011, Andre live-test finding", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const cpoListing = {
    vin: "KM8HFCAB1TU453247",
    vehicle: { make: "Hyundai", model: "Kona", year: 2026, trim: "SEL Sport" },
    retailListing: { used: true, cpo: true, dealer: "Example Hyundai" },
  };

  // confirmed-exact -- would normally get the trim-specific "close" URL,
  // but CPO should still route to the dedicated CPO page instead.
  const confirmed = resolveLinks(cpoListing as any, {
    vinFound: true,
    edmundsFound: true,
    edmundsUrl: "https://www.edmunds.com/hyundai/kona/2026/vin/KM8HFCAB1TU453247/featured-listing/",
    fallbackUsed: false,
  });
  assert.equal(confirmed.checkAvailSource, "confirmed-exact");
  const decodedConfirmed = decodeURIComponent(confirmed.affiliateFallbackUrl!.split("url=")[1]);
  assert.equal(decodedConfirmed, "https://www.edmunds.com/used-certified-pre-owned-hyundai-kona/", "CPO must override the close-tier trim URL, not just the loose one");

  // targeted-fallback (loose case) -- same dedicated CPO page.
  const targeted = resolveLinks(cpoListing as any, {
    vinFound: false,
    edmundsFound: true,
    edmundsUrl: "https://www.edmunds.com/2026-hyundai-kona-sel-sport/",
    fallbackUsed: true,
  });
  const decodedTargeted = decodeURIComponent(targeted.affiliateFallbackUrl!.split("url=")[1]);
  assert.equal(decodedTargeted, "https://www.edmunds.com/used-certified-pre-owned-hyundai-kona/");

  // Non-CPO listing (cpo undefined/false) must NOT be affected by this change at all.
  const nonCpoListing = {
    vin: "3CZRZ2H52TM772942",
    vehicle: { make: "Honda", model: "HR-V", year: 2026, trim: "Sport" },
    retailListing: { used: true, dealer: "Example Honda" },
  };
  const nonCpo = resolveLinks(nonCpoListing as any, {
    vinFound: false,
    edmundsFound: true,
    edmundsUrl: "https://edmunds.com/2026-honda-hr-v-sport",
    fallbackUsed: true,
  });
  const decodedNonCpo = decodeURIComponent(nonCpo.affiliateFallbackUrl!.split("url=")[1]);
  assert.ok(!decodedNonCpo.includes("certified-pre-owned"), "non-CPO listings must keep the existing plain used-{make}-{model} fallback, unaffected by this change");
});

test("D2o. resolveLinks() affiliateFallbackUrl (View similar) widens when Check avail is not confirmed-exact -- must not offer a near-duplicate of an already-unconfirmed Check avail link", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const l = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford" },
  };

  // confirmed-exact -> View similar stays trim-specific (a "close" match is fine, since Check avail already nailed this exact vehicle)
  const confirmed = resolveLinks(l as any, { vinFound: true, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/1FTEW2KP9TKE60602/featured-listing/", fallbackUsed: false });
  assert.equal(confirmed.checkAvailSource, "confirmed-exact");
  assert.ok(confirmed.affiliateFallbackUrl!.includes("lariat"), "confirmed-exact: View similar should stay trim-specific ('close')");

  // targeted-fallback -> Check avail is itself only a close match, so View similar must widen (drop trim/year), not mirror it
  const targeted = resolveLinks(l as any, { vinFound: false, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/DIFFERENT/featured-listing/", fallbackUsed: true });
  assert.equal(targeted.checkAvailSource, "targeted-fallback");
  assert.ok(!targeted.affiliateFallbackUrl!.includes("lariat"), "targeted-fallback: View similar must widen -- must not repeat the trim");
  const decodedTargeted = decodeURIComponent(targeted.affiliateFallbackUrl!.split("url=")[1]);
  assert.ok(decodedTargeted.includes("used-ford-f-150"), "should fall to the bare make/model tier");

  // unconfirmed -> Check avail is also not confirmed here, so View similar should widen the same way
  const unconfirmed = resolveLinks(l as any);
  assert.equal(unconfirmed.checkAvailSource, "unconfirmed");
  assert.ok(!unconfirmed.affiliateFallbackUrl!.includes("lariat"), "unconfirmed: View similar must widen too, not just the targeted-fallback case");
});

test("D2l. resolveLinks() all final links remain CJ-wrapped across every host-search outcome, including affiliateFallbackUrl", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");

  const baseListing = {
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" },
    retailListing: { used: true, dealer: "Example Ford", city: "Dallas", state: "TX" },
  };

  const scenarios: Array<{ vinFound: boolean; edmundsFound: boolean; edmundsUrl: string | null; fallbackUsed: boolean } | undefined> = [
    { vinFound: true, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/1FTEW2KP9TKE60602/featured-listing/", fallbackUsed: false },
    { vinFound: false, edmundsFound: true, edmundsUrl: "https://www.edmunds.com/ford/f-150/2026/vin/DIFFERENTVIN12345/featured-listing/", fallbackUsed: true },
    { vinFound: false, edmundsFound: false, edmundsUrl: null, fallbackUsed: false },
    undefined,
  ];

  for (const s of scenarios) {
    const links = resolveLinks(baseListing as any, s);
    if (links.affiliateUrl) {
      assert.ok(links.affiliateUrl.startsWith(CJ_PREFIX), `affiliateUrl must be CJ-wrapped for scenario ${JSON.stringify(s)}`);
      assert.ok(!links.affiliateUrl.includes("google.com") && !links.affiliateUrl.includes("serper"), "must never expose a raw Google/Serper URL");
    }
    if (links.affiliateFallbackUrl) {
      assert.ok(links.affiliateFallbackUrl.startsWith(CJ_PREFIX), "affiliateFallbackUrl must always be CJ-wrapped regardless of host-search outcome");
    }
  }
});

test("D2c. buildEdmundsCategoryUrl() USED + safe trim: exact trim URL, no year in path", async () => {
  const { buildEdmundsCategoryUrl } = await import("../lib/edmunds-cj");

  const url = buildEdmundsCategoryUrl({ make: "Chevrolet", model: "Tahoe", year: 2026, trim: "High Country" }, { used: true });

  assert.equal(url, "https://www.edmunds.com/used-chevrolet-tahoe-high-country/");
  assert.ok(!url!.includes("2026"), "year must never appear in a trim-based used URL");
});

test("D2d. buildEdmundsCategoryUrl() USED + unsafe/no trim falls back to year form", async () => {
  const { buildEdmundsCategoryUrl } = await import("../lib/edmunds-cj");

  // Unsafe trim (contains punctuation not allowed by isSafeTrimForSlug)
  const urlUnsafeTrim = buildEdmundsCategoryUrl({ make: "Mercedes-Benz", model: "GLA", year: 2026, trim: "AMG GLA 35/4MATIC" }, { used: true });
  assert.equal(urlUnsafeTrim, "https://www.edmunds.com/used-2026-mercedes-benz-gla/", "unsafe trim should fall back to the year form");

  // No trim at all
  const urlNoTrim = buildEdmundsCategoryUrl({ make: "Honda", model: "CR-V", year: 2025 }, { used: true });
  assert.equal(urlNoTrim, "https://www.edmunds.com/used-2025-honda-cr-v/");
});

test("D2e. buildEdmundsCategoryUrl() NEW + safe trim uses the new-vehicle trim URL form", async () => {
  const { buildEdmundsCategoryUrl } = await import("../lib/edmunds-cj");

  const url = buildEdmundsCategoryUrl({ make: "Chevrolet", model: "Tahoe", year: 2026, trim: "LS" }, { used: false });

  assert.equal(url, "https://www.edmunds.com/new-chevrolet-tahoe-ls-for-sale/");
});

// ============================================================================
// D3. CARD ROUTING — REAL jsdom render of buildResultsCardHtml()
// ============================================================================

async function renderCard(cardOverrides: any) {
  const { buildResultsCardHtml } = await import("@/lib/results-card");
  const { JSDOM } = await import("jsdom");

  const html = buildResultsCardHtml();
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 200));

  const vinValue = Object.prototype.hasOwnProperty.call(cardOverrides, "vin") ? cardOverrides.vin : "1FTEW2KP9TKE60602";

  const mockResult = {
    structuredContent: {
      meta: { corpusSizeApprox: "3.4 million", totalMatches: 1 },
      results: [
        {
          identity: { vin: vinValue, year: 2026, make: "Ford", model: "F-150", trim: "Lariat" },
          condition: { inventoryType: "used", used: true, cpo: false },
          powertrain: { drivetrain: "AWD" },
          listing: { price: 40000, mileage: 20000, dealer: "Test Dealer", city: "Austin", state: "TX" },
          media: { cardImageUrl: null },
          detail: { carfaxUrl: null, exteriorColor: "Blue", fuelTypeDisplay: "Gasoline" },
          ranking: { matchScore: 90 },
          links: cardOverrides.links,
          badges: cardOverrides.badges ?? [],
          intentConfirmations: [],
          risk: { tier: "unknown" },
        },
      ],
    },
  };

  window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
  await new Promise((r) => setTimeout(r, 200));

  return window.document;
}

test("D3a. Card routing: affiliateUrl + affiliateFallbackUrl + dealerListingUrl -> split CTA, dealer URL never primary", async () => {
  const doc = await renderCard({
    links: {
      affiliateUrl: "https://cj.example.com/affiliate-vin-specific",
      affiliateFallbackUrl: "https://cj.example.com/affiliate-fallback",
      dealerListingUrl: "https://dealer.example.com/vdp/999",
      isCarvana: false,
      linkStatus: "both-available",
    },
  });

  const photoLink = doc.querySelector(".cc-photo-link") as HTMLAnchorElement | null;
  const titleLink = doc.querySelector(".cc-title-link") as HTMLAnchorElement | null;
  const leftBtn = doc.querySelector(".cc-cta-left") as HTMLElement | null;
  const rightBtn = doc.querySelector(".cc-cta-right") as HTMLElement | null;

  assert.ok(photoLink, "photo link should exist");
  assert.equal(photoLink!.getAttribute("data-url"), "https://cj.example.com/affiliate-vin-specific", "photo destination must be affiliateUrl");

  assert.ok(titleLink, "title link should exist");
  assert.equal(titleLink!.getAttribute("data-url"), "https://cj.example.com/affiliate-vin-specific", "title destination must be affiliateUrl");

  assert.ok(leftBtn, "Check avail. CTA should exist");
  assert.equal(leftBtn!.getAttribute("data-url"), "https://cj.example.com/affiliate-vin-specific", "'Check avail.' must use affiliateUrl");
  assert.ok(leftBtn!.textContent!.includes("Check avail."), "split left button must be labeled 'Check avail.' per 2026-09-03 design decision, not 'View listing'");

  assert.ok(rightBtn, "View similar CTA should exist");
  assert.equal(rightBtn!.getAttribute("data-url"), "https://cj.example.com/affiliate-fallback", "'View similar' must use affiliateFallbackUrl");
  assert.ok(rightBtn!.textContent!.includes("View similar"), "split right button must be labeled 'View similar'");

  const cardHtml = doc.querySelector(".cc-card")!.innerHTML;
  assert.ok(!cardHtml.includes("https://dealer.example.com/vdp/999"), "dealerListingUrl must never appear as any clickable destination");
});

test("D3b. Card routing: fallback-only -> photo/title/CTA all use affiliateFallbackUrl, dealer URL never substituted", async () => {
  const doc = await renderCard({
    links: {
      affiliateUrl: null,
      affiliateFallbackUrl: "https://cj.example.com/affiliate-fallback-only",
      dealerListingUrl: "https://dealer.example.com/vdp/888",
      isCarvana: false,
      linkStatus: "fallback-only",
    },
  });

  const photoLink = doc.querySelector(".cc-photo-link") as HTMLAnchorElement | null;
  const titleLink = doc.querySelector(".cc-title-link") as HTMLAnchorElement | null;
  const primaryBtn = doc.querySelector(".cc-primary") as HTMLElement | null;

  assert.ok(photoLink, "photo link should exist for fallback-only");
  assert.equal(photoLink!.getAttribute("data-url"), "https://cj.example.com/affiliate-fallback-only");

  assert.ok(titleLink, "title link should exist for fallback-only");
  assert.equal(titleLink!.getAttribute("data-url"), "https://cj.example.com/affiliate-fallback-only");

  assert.ok(primaryBtn, "single primary CTA should exist (not split) when only fallback is available");
  assert.equal(primaryBtn!.getAttribute("data-url"), "https://cj.example.com/affiliate-fallback-only");

  // Split CTA buttons must NOT be present in fallback-only mode
  assert.equal(doc.querySelector(".cc-cta-left"), null, "split 'Check avail.' button must not render in fallback-only mode");
  assert.equal(doc.querySelector(".cc-cta-right"), null, "split 'View similar' button must not render in fallback-only mode");

  // Fallback-only label deliberately stays "Similar options on Edmunds",
  // NOT "Check avail." — affiliateFallbackUrl is a make/model category page,
  // not a VIN-specific destination, so labeling it as an availability check
  // would misrepresent what the link does. See 2026-09-03 design decision
  // comment in results-card.ts for the reasoning (the "Check avail." fallback
  // tier described in the design doc is a separate, unbuilt targeted-search
  // feature, not this category link).
  assert.ok(
    primaryBtn!.textContent!.includes("Similar options on Edmunds"),
    "fallback-only primary CTA must keep 'Similar options on Edmunds' label, not be relabeled 'Check avail.'"
  );

  const cardHtml = doc.querySelector(".cc-card")!.innerHTML;
  assert.ok(!cardHtml.includes("https://dealer.example.com/vdp/888"), "dealerListingUrl must not be substituted anywhere");
});

test("D3c. Card routing: dealer-only (no affiliateUrl/fallback) -> no fabricated primary CTA, photo/title not clickable to dealer URL", async () => {
  const doc = await renderCard({
    links: {
      affiliateUrl: null,
      affiliateFallbackUrl: null,
      dealerListingUrl: "https://dealer.example.com/vdp/777",
      isCarvana: false,
      linkStatus: "dealer-only",
    },
  });

  const photoLink = doc.querySelector(".cc-photo-link");
  const titleLink = doc.querySelector(".cc-title-link");
  const primaryBtn = doc.querySelector(".cc-primary");
  const leftBtn = doc.querySelector(".cc-cta-left");
  const rightBtn = doc.querySelector(".cc-cta-right");

  assert.equal(photoLink, null, "photo must not be made clickable to dealerListingUrl");
  assert.equal(titleLink, null, "title must not be made clickable to dealerListingUrl");
  assert.equal(primaryBtn, null, "no primary CTA should be fabricated from dealerListingUrl");
  assert.equal(leftBtn, null);
  assert.equal(rightBtn, null);

  const cardHtml = doc.querySelector(".cc-card")!.innerHTML;
  assert.ok(!cardHtml.includes("https://dealer.example.com/vdp/777"), "dealerListingUrl must not appear as a clickable destination anywhere in the card");
});

// ============================================================================
// D4. VIN DISPLAY — REAL jsdom render of buildResultsCardHtml()
// ============================================================================

test("D4a. VIN display: valid VIN + vin-verified badge shows abbreviated VIN with checkmark, never the full VIN", async () => {
  const doc = await renderCard({
    vin: "1FTEW2KP9TKE60602",
    badges: ["vin-verified"],
    links: { affiliateUrl: "https://cj.example.com/x", affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
  });

  const cardText = doc.querySelector(".cc-card")!.textContent ?? "";

  assert.ok(cardText.includes("VIN \u202660602 \u2713") || cardText.includes("VIN …60602 ✓"), `expected abbreviated verified VIN, got: ${cardText}`);
  assert.ok(!cardText.includes("1FTEW2KP9TKE60602"), "full 17-character VIN must never be visible in rendered card text");
});

test("D4b. VIN display: valid VIN without vin-verified shows abbreviated VIN, no checkmark", async () => {
  const doc = await renderCard({
    vin: "1FTEW2KPXTKE60933",
    badges: [],
    links: { affiliateUrl: "https://cj.example.com/x", affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
  });

  const cardText = doc.querySelector(".cc-card")!.textContent ?? "";

  assert.ok(cardText.includes("VIN \u202660933") || cardText.includes("VIN …60933"), `expected abbreviated VIN, got: ${cardText}`);
  assert.ok(!cardText.includes("\u2713"), "no verification checkmark should be attached to an unverified VIN");
  assert.ok(!cardText.includes("1FTEW2KPXTKE60933"), "full VIN must not appear");
});

test("D4c. VIN display: missing/invalid VIN produces no invented abbreviated VIN", async () => {
  const doc = await renderCard({
    vin: null,
    badges: [],
    links: { affiliateUrl: "https://cj.example.com/x", affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
  });

  const cardText = doc.querySelector(".cc-card")!.textContent ?? "";

  assert.ok(!/VIN\s*[\u2026.]{1,3}[A-Z0-9]{5}/.test(cardText), `no fabricated abbreviated VIN should appear for a missing VIN, got: ${cardText}`);
});

// ============================================================================
// D5. LOWEST-MILEAGE DEFAULT — structural contract (comment-stripped)
// ============================================================================

test("D5. lowest_mileage defaults baseQuery.used to true only when input.used is unspecified", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));

  // The exact contract: unspecified (null/undefined) input.used defaults to
  // true ONLY for priorityAxis === "lowest_mileage"; explicit true/false and
  // other axes pass through untouched.
  const hasExactGate = /input\.priorityAxis\s*===\s*"lowest_mileage"\s*&&\s*input\.used\s*==\s*null/.test(routeSource);
  assert.ok(hasExactGate, "route.ts must contain the exact lowest_mileage default gate: input.priorityAxis === \"lowest_mileage\" && input.used == null");

  // The corresponding ternary/ effective-used assignment
  const hasTernary = /\?\s*true\s*:\s*input\.used/.test(routeSource);
  assert.ok(hasTernary, "route.ts must contain the corresponding '? true : input.used' assignment");
});

// ============================================================================
// D6. MCP / WIDGET METADATA — structural contract (comment-stripped)
// ============================================================================

test("D6. MCP metadata contract: domain absent, single widgetDomain, prefersBorder false, correct MIME/origin/resource URIs", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));

  // a. _meta.ui.domain must be absent as an actual field (not merely commented out
  //    — comments already stripped above, so a literal `domain:` inside a ui block
  //    would still be caught here).
  const hasUnquotedDomainField = /\bdomain\s*:\s*["'`]/.test(routeSource);
  assert.ok(!hasUnquotedDomainField, "_meta.ui.domain must be absent as an actual executable field");

  // b. Exactly ONE actual openai/widgetDomain field, now derived dynamically via
  //    getAppOrigin() rather than hardcoded (SYS-20260831-002 — hardcoding this to
  //    production broke any preview deployment's widget domain declaration).
  const widgetDomainMatches = routeSource.match(/"openai\/widgetDomain":\s*getAppOrigin\(\)/g) ?? [];
  assert.equal(widgetDomainMatches.length, 1, `expected exactly one dynamic openai/widgetDomain field, found ${widgetDomainMatches.length}`);

  // c. prefersBorder is exactly false (boolean literal, not just the word present)
  const prefersBorderMatches = routeSource.match(/prefersBorder:\s*false/g) ?? [];
  assert.ok(prefersBorderMatches.length >= 1, "prefersBorder: false must be present as an actual boolean literal");

  // d. exact resource MIME type
  const mimeMatches = routeSource.match(/mimeType:\s*"text\/html;profile=mcp-app"/g) ?? [];
  assert.ok(mimeMatches.length >= 1, "mimeType text/html;profile=mcp-app must be present");

  // e. CSP resourceDomains is derived dynamically via getAppOrigin(), never a hardcoded
  //    production literal (SYS-20260831-002 — same reasoning as (b) above).
  const cspMatches = routeSource.match(/csp:\s*\{\s*resourceDomains:\s*\[getAppOrigin\(\)\]\s*\}/g) ?? [];
  assert.equal(cspMatches.length, 2, `expected exactly two dynamic csp.resourceDomains fields (registration + resources/read), found ${cspMatches.length}`);
  assert.ok(!routeSource.includes('"https://carclever-find-my-car.vercel.app"'), "no hardcoded production literal should remain in route.ts's widget metadata — everything must derive from getAppOrigin()");

  // f. exact resource URI wired through resourceUri
  assert.ok(/ui:\s*\{\s*resourceUri:\s*RESULTS_CARD_RESOURCE_URI\s*\}/.test(routeSource), "tool registration must wire resourceUri: RESULTS_CARD_RESOURCE_URI");

  // g. exact openai/outputTemplate wired to the same constant
  assert.ok(/"openai\/outputTemplate":\s*RESULTS_CARD_RESOURCE_URI/.test(routeSource), "openai/outputTemplate must be wired to RESULTS_CARD_RESOURCE_URI");

  // Confirm the constant itself resolves to the expected URI (results-card.ts)
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");
  assert.ok(resultsCardSource.includes('"ui://carclever-find-my-car/results-card-v2"'), "RESULTS_CARD_RESOURCE_URI must resolve to ui://carclever-find-my-car/results-card-v2");
});

// ============================================================================
// D7. RESULT-COUNT DISPLAY — resultsShown ground-truth contract
test("D7c. tool description no longer instructs opening with totalMatches immediately before introducing results, and explicitly names resultsShown as the authoritative shown-count field", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));

  // The old priming phrase ("...matching this request, here are the
  // strongest options:") juxtaposed totalMatches directly against the
  // results that followed — must not reappear verbatim.
  assert.ok(
    !routeSource.includes("matching this request, here are the strongest options"),
    "the old totalMatches-priming phrasing must not reappear — it directly caused the resurfaced count-display bug",
  );

  // The description must explicitly tell the calling LLM to use
  // resultsShown, not totalMatches/totalCandidatesConsidered, for stating
  // how many results are shown.
  assert.ok(
    /use \\`resultsShown\\`/.test(routeSource) || /use `resultsShown`/.test(routeSource),
    "tool description must explicitly instruct using resultsShown for the shown-result count",
  );
});

// ============================================================================
//
// Regression guard for the resurfaced totalMatches count-display bug
// (Aug 17 testing: host narrated "5 strong matches" while only 4 result
// cards were actually returned). Root cause was the tool description
// priming the calling LLM to state totalMatches right before "here are the
// strongest options," inviting it to treat a corpus/candidate-pool-scale
// number as if it were the count of items about to be shown. Fix adds a
// ground-truth `resultsShown` field, set from the same array as `results`
// at every response-construction site, plus rewritten guidance telling the
// calling LLM to use ONLY resultsShown for that purpose.

test("D7a. FindMatchingVehicleOutputSchema requires meta.resultsShown as a number", async () => {
  const { FindMatchingVehicleOutputSchema } = await import("../lib/find-matching-vehicle-output");

  const base = {
    meta: {
      totalCandidatesConsidered: 5,
      totalMatches: 5,
      corpusSizeApprox: "3,000,000+",
      relaxations: [],
      dataNotes: [],
      scopeNote: "local" as const,
      serviceError: null,
      interpretationNotes: [],
      qualifierAccounting: [],
    },
    results: [],
  };

  // Missing resultsShown must fail validation.
  assert.throws(() => FindMatchingVehicleOutputSchema.parse(base));

  // Present as a number must pass.
  const withField = { ...base, meta: { ...base.meta, resultsShown: 0 } };
  assert.doesNotThrow(() => FindMatchingVehicleOutputSchema.parse(withField));
});

test("D7b. every meta object literal in route.ts sets resultsShown from the same array as its results field, never a different variable", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));

  // Five response-construction sites as of SYS-20260903-012 (merging V1's
  // count-display fix onto V2): the original four (2 VIN-error paths, 1
  // VIN-success path, 1 normal-search path) plus resolve_vehicle_availability
  // (SYS-20260903-006/-012), a legitimate new fifth site introduced by V2's
  // mandatory two-call flow, which didn't exist when this fix was written.
  // This count must stay in lockstep with any future response-construction
  // site added to route.ts.
  const resultsShownMatches = routeSource.match(/resultsShown:\s*[^,]+,/g) ?? [];
  assert.equal(resultsShownMatches.length, 5, `expected exactly 5 resultsShown assignments, found ${resultsShownMatches.length} — every meta object must set it`);

  // The two empty-result error paths must use the literal 0, not a variable
  // that could silently drift from the actual (empty) results array.
  const zeroAssignments = routeSource.match(/resultsShown:\s*0,/g) ?? [];
  assert.equal(zeroAssignments.length, 2, "both VIN-error paths (invalid format, not found) must set resultsShown: 0 to match their empty results: [] arrays");

  // The VIN-success, normal-search, and resolve_vehicle_availability paths
  // must derive resultsShown from a `.length` expression (ground truth),
  // never a hardcoded/copied number.
  const lengthDerivedAssignments = routeSource.match(/resultsShown:\s*\w+(\.\w+)*\.length,/g) ?? [];
  assert.equal(lengthDerivedAssignments.length, 3, "VIN-success, normal-search, and resolve_vehicle_availability paths must derive resultsShown via .length, not a separate hardcoded number");
});

// ============================================================================
// D8. WIDGET CARD-COUNT HONESTY — real jsdom render, results.length > 5
// ============================================================================
//
// Real bug found via live testing (Aug 31, screenshot from a "bodyType: SUV,
// zip: 90210" search): the text summary correctly said "Found 8 closely
// matching vehicles," but the rendered widget's header said only "Top 5
// shown" with no indication 3 more results existed in the same response.
// buildResultsCardHtml()'s own render() function hardcodes
// `results.slice(0, 5)` for the carousel — a deliberate, reasonable display
// cap — but the header label previously read the sliced array's own length
// ("Top " + visible.length + " shown"), which is tautological and can never
// reveal a cap is in effect. This is the same class of bug as D7 (a stated
// count that doesn't reflect the true result count) in a different surface
// (the widget DOM, not the text/meta contract).

async function renderCardWithResults(resultCount: number) {
  const { buildResultsCardHtml } = await import("@/lib/results-card");
  const { JSDOM } = await import("jsdom");

  const html = buildResultsCardHtml();
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 200));

  const results = Array.from({ length: resultCount }, (_, i) => ({
    identity: { vin: `1FTEW2KP9TKE6060${i}`, year: 2027, make: "Kia", model: "Seltos", trim: "EX" },
    condition: { inventoryType: "used", used: true, cpo: false },
    powertrain: { drivetrain: "FWD" },
    listing: { price: 31899, mileage: 102, dealer: "Test Dealer", city: "Cerritos", state: "CA" },
    media: { cardImageUrl: null },
    detail: { carfaxUrl: null, exteriorColor: "Blue", fuelTypeDisplay: "Gasoline" },
    ranking: { matchScore: 100 },
    links: { affiliateUrl: null, affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "none-available" },
    badges: [],
    intentConfirmations: [],
    risk: { tier: "unknown" },
  }));

  const mockResult = {
    structuredContent: {
      meta: { corpusSizeApprox: "3.4 million", totalMatches: 61455 },
      results,
    },
  };

  window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
  await new Promise((r) => setTimeout(r, 200));

  return window.document;
}

test("D8a. Widget header discloses the cap when results.length (8) exceeds the display slice (5): 'Top 5 of 8 shown', not the tautological 'Top 5 shown'", async () => {
  const doc = await renderCardWithResults(8);
  const header = doc.querySelector(".cc-header-center");
  assert.ok(header, "cc-header-center element must exist");
  assert.equal(header?.textContent, "Top 5 of 8 shown", `expected 'Top 5 of 8 shown', got '${header?.textContent}'`);
});

test("D8b. Widget header does NOT claim a cap when results.length (5) does not exceed the display slice (5)", async () => {
  const doc = await renderCardWithResults(5);
  const header = doc.querySelector(".cc-header-center");
  assert.equal(header?.textContent, "5 shown", `expected '5 shown' with no false 'Top' cap language, got '${header?.textContent}'`);
});

test("D8c. Widget header uses singular phrasing for exactly one result", async () => {
  const doc = await renderCardWithResults(1);
  const header = doc.querySelector(".cc-header-center");
  assert.equal(header?.textContent, "1 match shown", `expected '1 match shown', got '${header?.textContent}'`);
});

test("D8d. Carousel itself still renders at most 5 cards even when more results are present (display cap unchanged, only its label was dishonest)", async () => {
  const doc = await renderCardWithResults(8);
  const cards = doc.querySelectorAll("#cc-carousel > article");
  assert.equal(cards.length, 5, `expected exactly 5 rendered cards (unchanged display cap), got ${cards.length}`);
});

// ============================================================================
// D9. WIDGET-ORIGIN SAFETY — production output must stay byte-identical
// ============================================================================
//
// Real bug found live (Aug 31, 2026): APP_ORIGIN, csp.resourceDomains,
// openai/widgetDomain, and a since-removed duplicate (IMG_PROXY_ORIGIN)
// were all hardcoded to the production URL. Any preview deployment
// declared a domain it wasn't actually being served from, matching an
// already-documented failure class (SYS-20260825: "fetch it, then fail to
// mount/render it"). Fixed by deriving APP_ORIGIN from Vercel's own
// VERCEL_ENV/VERCEL_PROJECT_PRODUCTION_URL/VERCEL_URL system env vars.
//
// This is the safety invariant that made the fix acceptable to ship on a
// branch of an app currently IN REVIEW with Anthropic: production's
// declared domain must be byte-identical to the old hardcoded value,
// regardless of whether these env vars are even correctly populated.
// These tests assert that directly against the real module, not by
// inspection of the diff.

test("D9a. getAppOrigin() returns the exact pre-existing hardcoded production URL when VERCEL_ENV=production, even with no other Vercel env vars set", async () => {
  const { getAppOrigin } = await import("@/lib/results-card");
  const originalEnv = { ...process.env };
  try {
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    process.env.VERCEL_ENV = "production";
    assert.equal(getAppOrigin(), "https://carclever-find-my-car.vercel.app", `production fallback must be byte-identical to the pre-fix hardcoded value, got '${getAppOrigin()}'`);
  } finally {
    process.env = originalEnv;
  }
});

test("D9b. getAppOrigin() uses VERCEL_PROJECT_PRODUCTION_URL when present and VERCEL_ENV=production (correct precedence, not VERCEL_URL)", async () => {
  const { getAppOrigin } = await import("@/lib/results-card");
  const originalEnv = { ...process.env };
  try {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "custom-prod-domain.example.com";
    process.env.VERCEL_URL = "should-not-be-used-in-production.vercel.app";
    assert.equal(getAppOrigin(), "https://custom-prod-domain.example.com");
  } finally {
    process.env = originalEnv;
  }
});

test("D9c. getAppOrigin() falls back to VERCEL_URL only when VERCEL_BRANCH_URL is absent, for any non-production environment", async () => {
  const { getAppOrigin } = await import("@/lib/results-card");
  const originalEnv = { ...process.env };
  try {
    process.env.VERCEL_ENV = "preview";
    delete process.env.VERCEL_BRANCH_URL;
    process.env.VERCEL_URL = "carclever-find-my-car-git-some-branch-team.vercel.app";
    assert.equal(getAppOrigin(), "https://carclever-find-my-car-git-some-branch-team.vercel.app", "preview must declare its own actual serving domain, not production's");
  } finally {
    process.env = originalEnv;
  }
});

test("D10. getAppOrigin() prefers VERCEL_BRANCH_URL (the stable branch alias a connector actually reaches) over VERCEL_URL (the per-deployment hash), for preview -- SYS-20260831-004, a real bug caught live where these two were confused", async () => {
  const { getAppOrigin } = await import("@/lib/results-card");
  const originalEnv = { ...process.env };
  try {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "carclever-find-my-car-git-fix-total-matches-count-bug-andre-broekmans-projects.vercel.app";
    process.env.VERCEL_URL = "carclever-find-my-76cqhr7vq-andre-broekmans-projects.vercel.app";
    assert.equal(
      getAppOrigin(),
      "https://carclever-find-my-car-git-fix-total-matches-count-bug-andre-broekmans-projects.vercel.app",
      "must use the stable branch alias (VERCEL_BRANCH_URL), never the per-deployment hash URL (VERCEL_URL), when both are present",
    );
  } finally {
    process.env = originalEnv;
  }
});

// ============================================================================
// D11. BUILD-IDENTITY VISIBILITY -- diagnostic only, invisible to end users
// ============================================================================
//
// Added Aug 31 2026 to stop chasing symptoms that turn out to be stale/cached
// code rather than real bugs -- a recurring problem this same session. Pure
// MCP protocol metadata (serverInfo, exchanged during `initialize`), never
// rendered to a user, never part of any screenshot -- zero relation to
// anything submitted to Anthropic or OpenAI. This is intentionally NOT a
// widget/visual change; see DECISIONS.md SYS-20260831-005 for why a visible
// marker was considered and rejected (OpenAI's locked submission screenshots).

test("D11a. route.ts passes an explicit serverInfo to createMcpHandler, not the package default", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));
  assert.ok(/serverInfo:\s*\{/.test(routeSource), "createMcpHandler must be given an explicit serverInfo option");
  assert.ok(routeSource.includes('name: "carclever-find-my-car"'), "serverInfo.name must identify this specific app");
});

test("D11b. serverInfo.version derives from VERCEL_GIT_COMMIT_SHA (real build identity), with a static fallback only for environments where it's unset (e.g. local dev)", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));
  assert.ok(routeSource.includes("process.env.VERCEL_GIT_COMMIT_SHA"), "version must be derived from the real per-deployment commit SHA, not a hand-maintained number");
  assert.ok(/VERCEL_GIT_COMMIT_SHA\?\.slice\(0,\s*7\)\s*\?\?\s*"0\.1\.0"/.test(routeSource), "must have a safe static fallback for environments without this env var (e.g. local dev), never throw or return undefined");
});


test("D9d. route.ts's img-proxy URL construction and widget domain metadata all derive from the single shared getAppOrigin() — no second hardcoded copy exists anymore", () => {
  const routeSource = stripComments(fs.readFileSync("app/[transport]/route.ts", "utf8"));
  assert.ok(!routeSource.includes('"https://carclever-find-my-car.vercel.app"'), "no literal production URL should remain hardcoded in route.ts — everything must derive from the imported getAppOrigin()");
  assert.ok(routeSource.includes("getAppOrigin()"), "route.ts must import and call the shared getAppOrigin() function");
});

