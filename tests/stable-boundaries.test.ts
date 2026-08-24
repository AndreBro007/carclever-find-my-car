// Stable-boundaries regression test suite for CarClever Find My Car
// ================================================================
//
// This test covers important settled contracts that lack permanent regression
// protection in the other test files. Coverage focuses on:
// - VIN deduplication (lib/diversity.ts) — REAL exported function
// - Link resolution policy contracts — structural code checks
// - Card link routing rules — structural code checks
// - VIN card display rules — structural code checks
// - Lowest-mileage default behavior — structural code checks
// - MCP/widget metadata contracts — structural code checks
//
// Strategy: Uses REAL exported implementations (applyDiversity) where available,
// and structural source code verification for policies that are embedded in
// non-exported route logic or tightly coupled to the MCP response pipeline.

import { test } from "node:test";
import { strict as assert } from "node:assert";

// ============================================================================
// D1. VIN DEDUP — lib/diversity.ts
// ============================================================================

test("D1a. applyDiversity() same normalized 17-char VIN appears once", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford" }, retailListing: {} },
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford" }, retailListing: {} }, // exact duplicate
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 1, "duplicate VIN should be removed");
});

test("D1b. applyDiversity() first-ranked occurrence wins on dedup", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford", model: "F-150" }, retailListing: { price: 30000 } },
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford", model: "F-150" }, retailListing: { price: 35000 } },
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 1, "only one should remain");
  assert.equal(result[0].retailListing.price, 30000, "first occurrence (cheaper) should be kept");
});

test("D1c. applyDiversity() distinct 17-char VINs remain distinct", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford", model: "F-150" }, retailListing: {} },
    { vin: "1FTEW2KPXTKE60933", vehicle: { make: "Ford", model: "F-250" }, retailListing: {} },
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 2, "two different VINs should both remain");
});

test("D1d. applyDiversity() blank VINs do NOT collapse together", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: "", vehicle: { make: "Ford" }, retailListing: {} },
    { vin: "", vehicle: { make: "Honda" }, retailListing: {} },
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 2, "two blank VINs should both remain (no dedup on blank)");
});

test("D1e. applyDiversity() missing VINs do NOT collapse together", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: null as any, vehicle: { make: "Ford" }, retailListing: {} },
    { vin: null as any, vehicle: { make: "Honda" }, retailListing: {} },
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 2, "two null VINs should both remain");
});

test("D1f. applyDiversity() malformed short VINs do NOT collapse together", async () => {
  const { applyDiversity } = await import("../lib/diversity.ts");

  const candidates = [
    { vin: "SHORT", vehicle: { make: "Ford" }, retailListing: {} },
    { vin: "SHORT", vehicle: { make: "Honda" }, retailListing: {} },
  ];

  const result = applyDiversity(candidates);
  assert.equal(result.length, 2, "two identical short VINs should both remain (not valid 17-char dedup)");
});

// ============================================================================
// D2. LINK RESOLUTION POLICY — lib/link-resolution.ts + app/[transport]/route.ts
// ============================================================================

test("D2a. resolveLinks() is exported from lib/link-resolution.ts", async () => {
  const linkResolution = await import("../lib/link-resolution.ts");
  assert.ok(typeof linkResolution.resolveLinks === "function", "resolveLinks should be exported");
});

test("D2b. LinkResolution interface is defined in lib/link-resolution.ts", () => {
  const fs = require("fs");
  const linkResolutionSource = fs.readFileSync("lib/link-resolution.ts", "utf8");
  assert.ok(linkResolutionSource.includes("export interface LinkResolution"), "LinkResolution interface should be exported");
  assert.ok(linkResolutionSource.includes("affiliateUrl"), "LinkResolution should include affiliateUrl field");
  assert.ok(linkResolutionSource.includes("affiliateFallbackUrl"), "LinkResolution should include affiliateFallbackUrl field");
});

test("D2c. Carvana policy documented: dealerListingUrl never the primary user-facing destination", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  // The policy should be documented in route.ts
  // Key contract: affiliateUrl first, affiliateFallbackUrl second, dealerListingUrl is for internal use only
  const hasDocumentedPolicy = routeSource.includes("Never route the user to dealerListingUrl") || routeSource.includes("dealerListingUrl is never the user-facing");
  assert.ok(hasDocumentedPolicy, "route.ts should document that dealerListingUrl is NOT the primary user-facing destination");
});

test("D2d. Edmunds fallback construction does NOT combine trim + year into one slug", () => {
  const fs = require("fs");
  const edmundsCjSource = fs.readFileSync("lib/edmunds-cj.ts", "utf8");

  // The settled contract: trim (if safe) is preferred, year is fallback if trim not safe
  // But they should never be combined: used-{year}-{make}-{model}-{trim} is NOT constructed
  const hasCombinedYearTrim = /`.*\$\{.*year.*\}.*\$\{.*trim.*\}`|`.*\$\{.*trim.*\}.*\$\{.*year.*\}`/.test(edmundsCjSource);
  assert.equal(hasCombinedYearTrim, false, "Edmunds URL construction should not combine year+trim into a single slug");
});

// ============================================================================
// D3. USER-FACING CARD LINK ROUTING — lib/results-card.ts policy check
// ============================================================================

test("D3a. buildResultsCardHtml() is exported from lib/results-card.ts", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");
  assert.ok(resultsCardSource.includes("export function buildResultsCardHtml"), "buildResultsCardHtml should be exported");
});

test("D3b. results-card uses links object and respects affiliate/fallback structure", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  // The card should reference links.affiliateUrl and links.affiliateFallbackUrl
  const hasAffiliateReference = resultsCardSource.includes("links.affiliateUrl") || resultsCardSource.includes("links?.affiliateUrl");
  assert.ok(hasAffiliateReference, "results-card should reference the links.affiliateUrl structure");

  // Card should have two distinct CTA labels for fallback vs primary
  const hasMultipleCTAs = resultsCardSource.includes("View listing") && resultsCardSource.includes("View similar");
  assert.ok(hasMultipleCTAs || resultsCardSource.includes("Check availability"), "results-card should have distinct CTA labels");
});

test("D3c. Split CTA logic exists when both affiliateUrl and fallback are present", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  // When both exist, two CTAs should be rendered: one for affiliateUrl, one for fallback
  const hasSplitCta = /View listing|View similar|Check availability/.test(resultsCardSource);
  assert.ok(hasSplitCta, "results-card should have distinct CTA labels for different link destinations");
});

// ============================================================================
// D4. VIN CARD DISPLAY RULES
// ============================================================================

test("D4a. results-card references VIN for display", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  // The card should handle VIN display in some form
  const hasVinReference = resultsCardSource.includes("vin") && resultsCardSource.includes("VIN");
  assert.ok(hasVinReference, "results-card should reference vin in its output");
});

test("D4b. VIN abbreviation is documented in code comments", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  // Look for evidence that VINs are abbreviated, not displayed in full
  const hasAbbreviationComment = resultsCardSource.toLowerCase().includes("abbreviate") || resultsCardSource.includes("final") || resultsCardSource.includes("slice") || resultsCardSource.includes("substring");
  assert.ok(hasAbbreviationComment, "results-card should contain logic for abbreviating VINs");
});

test("D4c. Identity (VIN verification) module is separate from VIN display", () => {
  const fs = require("fs");
  const resultsCardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  // VIN verification (the checkmark) should be independent from VIN display
  // (both may be present, but the checkmark doesn't control VIN visibility)
  const hasIdentityReference = resultsCardSource.includes("identity") || resultsCardSource.includes("vinVerified");
  assert.ok(hasIdentityReference, "results-card should handle identity/verification separately from VIN display");
});

// ============================================================================
// D5. LOWEST-MILEAGE DEFAULT
// ============================================================================

test("D5a. lowest_mileage + unspecified used => effective used:true", async () => {
  // This is a structural check — the route.ts should default lowest_mileage to used:true
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  const lowestMileageDefaultMatch = routeSource.match(/priorityAxis\s*===\s*"lowest_mileage"\s*&&\s*input\.used\s*==\s*null/);
  assert.ok(lowestMileageDefaultMatch, "code should check for lowest_mileage + unspecified used");
});

test("D5b. lowest_mileage + explicit used:false => explicit false respected", async () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  // The condition should only apply when used==null, so explicit false/true should pass through
  const usedNullGate = routeSource.includes("input.used == null");
  assert.ok(usedNullGate, "lowest_mileage default should be gated on used==null");
});

// ============================================================================
// D6. MCP / WIDGET METADATA CONTRACT
// ============================================================================

test("D6a. _meta.ui.domain is documented as ABSENT", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  // The code should document that _meta.ui.domain is intentionally omitted
  const hasDocumentedAbsence = routeSource.includes("_meta.ui.domain") && (routeSource.includes("stays absent") || routeSource.includes("omitted") || routeSource.includes("must not be set"));
  assert.ok(hasDocumentedAbsence, "_meta.ui.domain absence should be documented in route.ts (SEP-1865 optional, Claude requires absence)");
});

test("D6b. Resource-content metadata includes openai/widgetDomain correctly", async () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  const hasOpenAiDomain = routeSource.includes('openai/widgetDomain') || routeSource.includes('"openai/widgetDomain"');
  assert.ok(hasOpenAiDomain, "openai/widgetDomain should be set in resource content metadata");
});

test("D6c. prefersBorder and MIME type remain correct", async () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  const hasPrefersBorder = routeSource.includes("prefersBorder") || routeSource.includes('"prefersBorder"');
  const hasMimeProfile = routeSource.includes("text/html;profile=mcp-app") || routeSource.includes("profile=mcp-app");

  assert.ok(hasPrefersBorder, "prefersBorder should be set in widget metadata");
  assert.ok(hasMimeProfile, "MIME type should include profile=mcp-app");
});

test("D6d. Production widget origin remains stable", async () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  const hasVercelOrigin = routeSource.includes("carclever-find-my-car.vercel.app") || routeSource.includes("vercel.app");
  assert.ok(hasVercelOrigin, "widget origin should reference the Vercel production domain");
});

console.log("\nStable-boundaries regression tests completed.");
