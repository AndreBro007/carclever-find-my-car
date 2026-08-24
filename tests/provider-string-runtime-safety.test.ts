// Regression tests for fix/provider-string-runtime-safety (SYS-20260828).
//
// PRODUCTION INCIDENT: a real Auto.dev listing returned vehicle.trim as
// the NUMBER 1958, despite the client's own declared `trim?: string`
// type. `configurationKey()` in app/[transport]/route.ts called
// `(c.vehicle?.trim ?? "").trim()` directly on it -- `?? ""` only
// substitutes for null/undefined, so the number sailed through unchanged
// and crashed on `.trim()`, taking down the entire find_matching_vehicle
// request for a plain `{"bodyType": "SUV"}` search (confirmed live via
// temporary diagnostic logging against production, see DECISIONS.md).
//
// A broad audit of the same failure class (any Auto.dev-derived field
// used with a runtime string method without defensive coercion) found
// four further genuinely reachable call sites, all fixed the same way
// this session: trimMatches() (lib/trim-match.ts), the zero-result
// widening fallback's bodyStyleMatchFilter() (route.ts),
// normalizeCompareString() (lib/constraint-evidence.ts, shared by
// bodyStyle/vehicleType/state comparisons), decodeNhtsaElectrification()
// (lib/nhtsa-client.ts, runs on every shortlisted result), and the
// body-style confirmation text builder (lib/qualifier-accounting.ts).
//
// configurationKey()/applyConfigurationVarietyPass() were extracted from
// route.ts into lib/configuration-variety.ts (pure move, zero behavior
// change beyond the runtime-safety fix itself) specifically so they could
// be tested directly here rather than mirrored -- same reasoning as the
// buildBuyerCheck() extraction earlier this session (route.ts is a
// Next.js route file; only specific named exports like GET/POST are
// permitted there).
//
// Run: npx tsx tests/provider-string-runtime-safety.test.ts

import { configurationKey, applyConfigurationVarietyPass } from "@/lib/configuration-variety";
import { trimMatches } from "@/lib/trim-match";
import { normalizeCompareString } from "@/lib/constraint-evidence";
import type { AutoDevListing } from "@/lib/auto-dev-client";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS: ${name}`);
    pass++;
  } else {
    console.log(`FAIL: ${name}${detail ? ` -- ${detail}` : ""}`);
    fail++;
  }
}

function listing(vehicle: Partial<AutoDevListing["vehicle"]>, vin = "1FTEW2KP9TKE60602"): AutoDevListing {
  return {
    vin,
    vehicle: { make: "Ford", model: "F-150", year: 2024, trim: "XLT", ...vehicle },
    retailListing: { price: 40000, miles: 20000, used: true },
  };
}

// ===========================================================================
// A. configurationKey() / best_for_budget path
// ===========================================================================

// A1: the EXACT confirmed production fixture -- vehicle.trim as the real
// observed malformed value (the number 1958).
{
  let threw = false;
  let key = "";
  try {
    key = configurationKey(listing({ trim: 1958 as unknown as string }));
  } catch {
    threw = true;
  }
  check("A1. configurationKey() does not throw when vehicle.trim is the number 1958 (the exact confirmed production value)", !threw);
  check("A1b. The malformed trim is coerced to its literal string reading (\"1958\"), never invented into something else", key.endsWith("|1958"), key);
}

// A2/A3: make and model as unexpected non-string types don't throw either
// -- the same failure class could affect any of the three fields.
{
  let threw = false;
  try {
    configurationKey(listing({ make: 12345 as unknown as string }));
  } catch {
    threw = true;
  }
  check("A2. configurationKey() does not throw when vehicle.make is a number", !threw);
}
{
  let threw = false;
  try {
    configurationKey(listing({ model: ["RAV4"] as unknown as string }));
  } catch {
    threw = true;
  }
  check("A3. configurationKey() does not throw when vehicle.model is an array", !threw);
}

// A4: null/missing values still normalize as before (empty string, never invented).
{
  const key = configurationKey(listing({ trim: undefined }));
  check("A4. Missing trim still normalizes to \"\" (never invented) -- unchanged from before this fix", key.endsWith("|"), key);
}

// A5: normal string values produce the exact same configuration key as before.
{
  const key = configurationKey(listing({ make: "Ford", model: "F-150", year: 2024, trim: "XLT" }));
  check("A5. Normal string values produce the expected key format unchanged", key === "ford|f-150|2024|xlt", key);
}

// ===========================================================================
// B. broad/bodyType search architecture -- applyConfigurationVarietyPass()
// with one malformed candidate in the pool
// ===========================================================================
{
  const pool: AutoDevListing[] = [
    listing({ trim: "XLT" }, "VIN0001"),
    listing({ trim: 1958 as unknown as string }, "VIN0002"), // the malformed one
    listing({ trim: "Lariat" }, "VIN0003"),
    listing({ trim: "Platinum" }, "VIN0004"),
  ];
  let threw = false;
  let result: AutoDevListing[] = [];
  try {
    result = applyConfigurationVarietyPass(pool, 2);
  } catch {
    threw = true;
  }
  check("B1. A candidate pool containing one malformed (numeric) trim does not crash applyConfigurationVarietyPass()", !threw);
  check("B2. Valid candidates are still all returned (none silently dropped because of the one malformed record)", result.length === 4, `got ${result.length}`);
  check(
    "B3. The malformed-trim candidate itself is still present in the result (never discarded, never treated as ineligible)",
    result.some((c) => c.vin === "VIN0002"),
  );
}

// B4: a bodyType-only/default-best_for_budget-style pool (no model filter,
// many distinct configurations, matching the real production shape) still
// reaches a usable shortlist even with a malformed record mixed in.
{
  const pool: AutoDevListing[] = [
    listing({ make: "Ford", model: "Expedition", trim: "Active" }, "VIN0001"),
    listing({ make: "Toyota", model: "4Runner", trim: 1958 as unknown as string }, "VIN0002"),
    listing({ make: "Jeep", model: "Grand Wagoneer", trim: "Upland" }, "VIN0003"),
    listing({ make: "Honda", model: "CR-V", trim: "EX" }, "VIN0004"),
    listing({ make: "Mazda", model: "CX-90", trim: null as unknown as string }, "VIN0005"),
  ];
  let threw = false;
  let result: AutoDevListing[] = [];
  try {
    result = applyConfigurationVarietyPass(pool, 2);
  } catch {
    threw = true;
  }
  check("B4. A realistic bodyType-only-style mixed-make pool with one malformed record reaches a usable shortlist without throwing", !threw);
  check("B4b. All 5 candidates present in the result", result.length === 5, `got ${result.length}`);
}

// ===========================================================================
// C. trim path (trimMatches / trimRequired)
// ===========================================================================
{
  let threw = false;
  let matched = true;
  try {
    matched = trimMatches("XLT", 1958 as unknown as string);
  } catch {
    threw = true;
  }
  check("C1. trimMatches() does not throw when the provider-reported trim is the number 1958", !threw);
  check(
    "C2. A malformed (numeric) trim does NOT falsely satisfy a real trimRequired -- \"1958\" never matches \"XLT\"",
    matched === false,
  );
}
{
  // A pathological but real-shaped case: requesting a trim that happens to
  // BE the coerced malformed value should still not silently misbehave --
  // confirms coercion doesn't invent a false match either.
  const matched = trimMatches("1958", 1958 as unknown as string);
  check(
    "C3. Coercion is literal, not invented: requesting the literal string \"1958\" against a malformed numeric trim of 1958 DOES correctly match (String(1958) === \"1958\"), proving the coercion is honest, not a black hole that always returns false",
    matched === true,
  );
}
{
  // Valid trim matching semantics remain unchanged for normal strings.
  check("C4. Normal exact trim match still works unchanged", trimMatches("XLT", "XLT") === true);
  check("C5. Normal directional trim match (more-specific actual) still works unchanged", trimMatches("AMG", "AMG GLA 35") === true);
  check("C6. Normal directional trim non-match (less-specific actual) still correctly fails, unchanged", trimMatches("AMG GLA 35", "AMG") === false);
  check("C7. Missing/null actual trim still correctly returns false, unchanged", trimMatches("XLT", null) === false);
  check("C8. Missing/undefined actual trim still correctly returns false, unchanged", trimMatches("XLT", undefined) === false);
}

// ===========================================================================
// Shared helper: normalizeCompareString() (bodyStyle/vehicleType/state
// comparisons in lib/constraint-evidence.ts)
// ===========================================================================
{
  let threw = false;
  let result = "";
  try {
    result = normalizeCompareString(1958);
  } catch {
    threw = true;
  }
  check("normalizeCompareString() does not throw on a numeric input", !threw);
  check("normalizeCompareString() coerces a numeric input to its literal string form", result === "1958", result);
  check("normalizeCompareString() still behaves normally for real strings", normalizeCompareString("  SUV  ") === "suv");
  check("normalizeCompareString() still returns \"\" for null/undefined, unchanged", normalizeCompareString(null) === "" && normalizeCompareString(undefined) === "");
}

// ===========================================================================
// D. UI/output -- a card built from a coerced malformed value (e.g. the
// literal string "1958" produced by this session's fix, standing in for
// what the real pipeline now produces instead of throwing) still renders
// as normal, valid card HTML -- no special-casing needed downstream once
// the value is a real string.
// ===========================================================================
async function uiOutputTest() {
  const { buildResultsCardHtml } = await import("@/lib/results-card");
  const { JSDOM } = await import("jsdom");

  const html = buildResultsCardHtml();
  let threw = false;
  try {
    const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
    const { window } = dom;
    await new Promise((r) => setTimeout(r, 200));

    const mockResult = {
      structuredContent: {
        meta: { corpusSizeApprox: "3.4 million", totalMatches: 1 },
        results: [
          {
            identity: { vin: "1FTEW2KP9TKE60602", year: 2024, make: "Ford", model: "F-150", trim: "1958" },
            condition: { inventoryType: "used", used: true, cpo: false },
            powertrain: { drivetrain: "AWD" },
            listing: { price: 40000, mileage: 20000, dealer: "Test Dealer", city: "Austin", state: "TX" },
            media: { cardImageUrl: null },
            detail: { carfaxUrl: null, exteriorColor: "Blue", fuelTypeDisplay: "Gasoline" },
            ranking: { matchScore: 90 },
            links: { affiliateUrl: "https://www.edmunds.com/vin/1FTEW2KP9TKE60602/", affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
            badges: ["vin-verified"],
            intentConfirmations: [],
            risk: { tier: "unknown" },
          },
        ],
      },
    };

    window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
    await new Promise((r) => setTimeout(r, 200));

    const doc = window.document;
    const cards = doc.querySelectorAll(".cc-card");
    check("D1. Card renders successfully with a coerced (formerly-numeric) trim value", cards.length === 1, `got ${cards.length} cards`);
  } catch {
    threw = true;
  }
  check("D2. buildResultsCardHtml()/card rendering does not throw on a card carrying a coerced malformed-origin string value", !threw);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

uiOutputTest();
