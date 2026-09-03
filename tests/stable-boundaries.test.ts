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

  // b. Exactly ONE actual "openai/widgetDomain": "https://carclever-find-my-car.vercel.app"
  const widgetDomainMatches = routeSource.match(/"openai\/widgetDomain":\s*"https:\/\/carclever-find-my-car\.vercel\.app"/g) ?? [];
  assert.equal(widgetDomainMatches.length, 1, `expected exactly one openai/widgetDomain field, found ${widgetDomainMatches.length}`);

  // c. prefersBorder is exactly false (boolean literal, not just the word present)
  const prefersBorderMatches = routeSource.match(/prefersBorder:\s*false/g) ?? [];
  assert.ok(prefersBorderMatches.length >= 1, "prefersBorder: false must be present as an actual boolean literal");

  // d. exact resource MIME type
  const mimeMatches = routeSource.match(/mimeType:\s*"text\/html;profile=mcp-app"/g) ?? [];
  assert.ok(mimeMatches.length >= 1, "mimeType text/html;profile=mcp-app must be present");

  // e. exact production origin appears in CSP resourceDomains
  assert.ok(routeSource.includes('"https://carclever-find-my-car.vercel.app"'), "production origin must appear as an actual string literal");

  // f. exact resource URI wired through resourceUri
  assert.ok(/ui:\s*\{\s*resourceUri:\s*RESULTS_CARD_RESOURCE_URI\s*\}/.test(routeSource), "tool registration must wire resourceUri: RESULTS_CARD_RESOURCE_URI");

  // g. exact openai/outputTemplate wired to the same constant
  assert.ok(/"openai\/outputTemplate":\s*RESULTS_CARD_RESOURCE_URI/.test(routeSource), "openai/outputTemplate must be wired to RESULTS_CARD_RESOURCE_URI");

  // Confirm the constant itself resolves to the expected URI (results-card.ts)
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");
  assert.ok(resultsCardSource.includes('"ui://carclever-find-my-car/results-card"'), "RESULTS_CARD_RESOURCE_URI must resolve to ui://carclever-find-my-car/results-card");
});
