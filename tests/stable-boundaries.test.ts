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

  assert.ok(leftBtn, "View listing CTA should exist");
  assert.equal(leftBtn!.getAttribute("data-url"), "https://cj.example.com/affiliate-vin-specific", "'View listing' must use affiliateUrl");

  assert.ok(rightBtn, "View similar CTA should exist");
  assert.equal(rightBtn!.getAttribute("data-url"), "https://cj.example.com/affiliate-fallback", "'View similar' must use affiliateFallbackUrl");

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
  assert.equal(doc.querySelector(".cc-cta-left"), null, "split 'View listing' button must not render in fallback-only mode");
  assert.equal(doc.querySelector(".cc-cta-right"), null, "split 'View similar' button must not render in fallback-only mode");

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

  // Every one of the four response-construction sites identified in the
  // fix (2 VIN-error paths, 1 VIN-success path, 1 normal-search path) must
  // set resultsShown. This count must stay in lockstep with any future
  // response-construction site added to route.ts.
  const resultsShownMatches = routeSource.match(/resultsShown:\s*[^,]+,/g) ?? [];
  assert.equal(resultsShownMatches.length, 4, `expected exactly 4 resultsShown assignments, found ${resultsShownMatches.length} — every meta object must set it`);

  // The two empty-result error paths must use the literal 0, not a variable
  // that could silently drift from the actual (empty) results array.
  const zeroAssignments = routeSource.match(/resultsShown:\s*0,/g) ?? [];
  assert.equal(zeroAssignments.length, 2, "both VIN-error paths (invalid format, not found) must set resultsShown: 0 to match their empty results: [] arrays");

  // The VIN-success and normal-search paths must derive resultsShown from
  // a `.length` expression (ground truth), never a hardcoded/copied number.
  const lengthDerivedAssignments = routeSource.match(/resultsShown:\s*\w+(\.\w+)*\.length,/g) ?? [];
  assert.equal(lengthDerivedAssignments.length, 2, "VIN-success and normal-search paths must derive resultsShown via .length, not a separate hardcoded number");
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

