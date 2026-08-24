// Stable-boundaries regression test suite for CarClever Find My Car
// ================================================================
//
// Tests important settled contracts using dynamic imports and structural verification.

import { test } from "node:test";
import { strict as assert } from "node:assert";

// ============================================================================
// D1. VIN DEDUP — REAL applyDiversity() behavioral tests
// ============================================================================

test("D1a. applyDiversity() normalizes same VIN (case variation) to single occurrence", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 30000, miles: 1000, cpo: false }, matchScore: 85 },
    { vin: "1ftew2kp9tke60602", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 35000, miles: 1500, cpo: false }, matchScore: 84 },
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 1, "normalized duplicate VIN should be removed");
  assert.equal(result[0].retailListing.price, 30000, "first occurrence should be kept");
});

test("D1b. applyDiversity() preserves distinct valid VINs", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    { vin: "1FTEW2KP9TKE60602", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 30000, miles: 1000, cpo: false }, matchScore: 85 },
    { vin: "1FTEW2KPXTKE60933", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 32000, miles: 1200, cpo: false }, matchScore: 84 },
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "two distinct VINs should remain");
  assert(result.some((c) => c.vin?.toUpperCase() === "1FTEW2KP9TKE60602"), "first VIN preserved");
  assert(result.some((c) => c.vin?.toUpperCase() === "1FTEW2KPXTKE60933"), "second VIN preserved");
});

test("D1c. applyDiversity() blank VINs do not collapse together", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    { vin: "", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 30000, miles: 1000, cpo: false }, matchScore: 85 },
    { vin: "", vehicle: { make: "Honda", model: "CR-V", year: 2026, trim: "EX" }, retailListing: { used: true, price: 25000, miles: 800, cpo: false }, matchScore: 82 },
  ];

  const result = applyDiversity(candidates as any, 10);
  assert.equal(result.length, 2, "blank VINs should not collapse");
});

test("D1d. applyDiversity() make/model diversity works", async () => {
  const { applyDiversity } = await import("../lib/diversity");

  const candidates = [
    { vin: "VIN001", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "Lariat" }, retailListing: { used: true, price: 30000, miles: 1000, cpo: false }, matchScore: 85 },
    { vin: "VIN002", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "XLT" }, retailListing: { used: true, price: 28000, miles: 2000, cpo: false }, matchScore: 84 },
    { vin: "VIN003", vehicle: { make: "Ford", model: "F-150", year: 2026, trim: "STX" }, retailListing: { used: true, price: 26000, miles: 3000, cpo: false }, matchScore: 83 },
    { vin: "VIN004", vehicle: { make: "Toyota", model: "Tundra", year: 2026, trim: "SR" }, retailListing: { used: true, price: 32000, miles: 1500, cpo: false }, matchScore: 82 },
  ];

  const result = applyDiversity(candidates as any, 3);
  assert.equal(result.length, 3, "result respects limit");
  
  const makes = new Set(result.map((c) => c.vehicle.make));
  assert.ok(makes.size > 1, "diversity should include multiple makes when available");
});

// ============================================================================
// D2. LINK RESOLUTION — REAL exported functions
// ============================================================================

test("D2a. resolveLinks() is exported from lib/link-resolution.ts", async () => {
  const { resolveLinks } = await import("../lib/link-resolution");
  assert.ok(typeof resolveLinks === "function", "resolveLinks should be exported as a function");
});

test("D2b. buildEdmundsCategoryUrl() is exported from lib/edmunds-cj.ts", async () => {
  const { buildEdmundsCategoryUrl } = await import("../lib/edmunds-cj");
  assert.ok(typeof buildEdmundsCategoryUrl === "function", "buildEdmundsCategoryUrl should be exported");
  
  // Actually call it with proper vehicle object
  const url = buildEdmundsCategoryUrl({ make: "Honda", model: "CR-V", year: 2026, trim: "EX" }, { used: true });
  assert.ok(url && typeof url === "string", "should return a URL string");
  assert.ok(url.includes("edmunds"), "should be an Edmunds URL");
});

test("D2c. CJ constants are exported", async () => {
  const { CJ_CLICK_DOMAIN, CJ_PUBLISHER_ID, CJ_EDMUNDS_PRODUCT_AD_ID } = await import("../lib/edmunds-cj");
  assert.ok(CJ_CLICK_DOMAIN && typeof CJ_CLICK_DOMAIN === "string", "CJ_CLICK_DOMAIN should be defined");
  assert.ok(CJ_PUBLISHER_ID && typeof CJ_PUBLISHER_ID === "string", "CJ_PUBLISHER_ID should be defined");
  assert.ok(CJ_EDMUNDS_PRODUCT_AD_ID && typeof CJ_EDMUNDS_PRODUCT_AD_ID === "string", "CJ_EDMUNDS_PRODUCT_AD_ID should be defined");
});

// ============================================================================
// D3. STRUCTURAL VERIFICATION — Production policies
// ============================================================================

test("D3a. Carvana policy documented in route.ts", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  const hasPolicy = routeSource.includes("dealerListingUrl") && (
    routeSource.includes("Never route") || 
    routeSource.includes("dealerListingUrl is never")
  );
  assert.ok(hasPolicy, "Carvana non-bypass policy should be documented");
});

test("D3b. Lower-risk ranking exists", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  assert.ok(routeSource.includes("lower_risk"), "lower_risk priorityAxis should exist");
  assert.ok(routeSource.includes("riskTier"), "risk tier handling should exist");
});

test("D3c. VIN abbreviation logic present", () => {
  const fs = require("fs");
  const cardSource = fs.readFileSync("lib/results-card.ts", "utf8");

  assert.ok(cardSource.includes("vin"), "VIN reference should exist");
  assert.ok(cardSource.includes("substring") || cardSource.includes("slice"), "abbreviation logic should exist");
});

test("D3d. applyDiversity imported in route", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  assert.ok(routeSource.includes("applyDiversity"), "applyDiversity should be imported");
});

test("D3e. MCP metadata correct", () => {
  const fs = require("fs");
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  assert.ok(routeSource.includes("openai/widgetDomain"), "openai/widgetDomain should be present");
});

console.log("\n✅ Stable-boundaries regression tests completed");
