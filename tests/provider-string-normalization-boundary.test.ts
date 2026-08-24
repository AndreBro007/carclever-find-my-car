// Follow-up regression tests for fix/provider-string-runtime-safety
// (SYS-20260828 review follow-up).
//
// PRODUCT RULE being tested: malformed Auto.dev string-typed fields must
// become unknown (undefined/null) in user-facing data, never a literal
// coerced display value like "1958" or "[object Object]". The earlier
// commit on this branch fixed the CRASH (String(x ?? "") everywhere) but
// ChatGPT's review correctly flagged that String()-coercing all the way
// into buildResultCard()'s identity fields could display that coercion
// as if it were a real vehicle fact. This file tests the real fix:
// normalization at the provider-ingestion boundary (lib/auto-dev-client.ts)
// so malformed data becomes unknown before it ever reaches a card, plus a
// last-resort error boundary around the tool handler itself.
//
// Run: npx tsx tests/provider-string-normalization-boundary.test.ts

import fs from "node:fs";
import { providerString, providerVin, normalizeListing, leanRowToListing, type LeanRow } from "@/lib/auto-dev-client";

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

// ===========================================================================
// PROVIDER BOUNDARY
// ===========================================================================

// 1. numeric vehicle.trim -> normalized to undefined/unknown, NOT "1958".
{
  const listing = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", year: 2024, trim: 1958 },
    retailListing: { price: 40000, miles: 20000 },
  });
  check("1. Numeric vehicle.trim (the exact confirmed production value 1958) normalizes to undefined, not the string \"1958\"", listing?.vehicle?.trim === undefined, JSON.stringify(listing?.vehicle?.trim));
}

// 2. object/array vehicle.model -> unknown, NOT "[object Object]" / joined text.
{
  const listingObj = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: { weird: "shape" }, year: 2024 },
    retailListing: {},
  });
  check("2a. Object vehicle.model normalizes to undefined, never \"[object Object]\"", listingObj?.vehicle?.model === undefined, JSON.stringify(listingObj?.vehicle?.model));

  const listingArr = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: ["F-150", "Raptor"], year: 2024 },
    retailListing: {},
  });
  check("2b. Array vehicle.model normalizes to undefined, never a joined string", listingArr?.vehicle?.model === undefined, JSON.stringify(listingArr?.vehicle?.model));
}

// 3. malformed make/bodyStyle/type/engine/location strings do not leak literal garbage.
{
  const listing = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: 42, bodyStyle: {}, type: [1, 2, 3], engine: null },
    retailListing: { city: 12345, state: {}, dealer: true },
  });
  check("3a. Numeric vehicle.make normalizes to undefined", listing?.vehicle?.make === undefined);
  check("3b. Object vehicle.bodyStyle normalizes to undefined", listing?.vehicle?.bodyStyle === undefined);
  check("3c. Array vehicle.type normalizes to undefined", listing?.vehicle?.type === undefined);
  check("3d. null vehicle.engine normalizes to undefined (unchanged null-handling)", listing?.vehicle?.engine === undefined);
  check("3e. Numeric retailListing.city normalizes to undefined, never a stringified number", listing?.retailListing?.city === undefined);
  check("3f. Object retailListing.state normalizes to undefined", listing?.retailListing?.state === undefined);
  check("3g. Boolean retailListing.dealer normalizes to undefined, never \"true\"", listing?.retailListing?.dealer === undefined);
}

// 4. valid strings survive byte-for-byte.
{
  const listing = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: "F-150", trim: "XLT", year: 2024 },
    retailListing: { city: "Conroe", state: "TX", dealer: "Gullo Ford" },
  });
  check("4. Valid strings survive normalizeListing() byte-for-byte", listing?.vehicle?.make === "Ford" && listing?.vehicle?.model === "F-150" && listing?.vehicle?.trim === "XLT" && listing?.retailListing?.city === "Conroe" && listing?.retailListing?.state === "TX" && listing?.retailListing?.dealer === "Gullo Ford");
}

// 5. null/undefined stay unknown.
{
  const listing = normalizeListing({
    vin: "1FTEW2KP9TKE60602",
    vehicle: { make: "Ford", model: undefined, trim: null },
    retailListing: {},
  });
  check("5. null/undefined vehicle fields stay undefined (unknown), unchanged behavior", listing?.vehicle?.model === undefined && listing?.vehicle?.trim === undefined);
}

// 6. unusable non-string VIN does not become a valid candidate.
{
  const listingNumVin = normalizeListing({ vin: 12345, vehicle: { make: "Ford" }, retailListing: {} });
  check("6a. Numeric VIN -> row is rejected entirely (null), never becomes a candidate", listingNumVin === null);

  const listingEmptyVin = normalizeListing({ vin: "", vehicle: { make: "Ford" }, retailListing: {} });
  check("6b. Empty-string VIN -> row is rejected entirely (null)", listingEmptyVin === null);

  const listingNullVin = normalizeListing({ vin: null, vehicle: { make: "Ford" }, retailListing: {} });
  check("6c. null VIN -> row is rejected entirely (null)", listingNullVin === null);

  const listingObjVin = normalizeListing({ vin: { weird: true }, vehicle: {}, retailListing: {} });
  check("6d. Object VIN -> row is rejected entirely (null), never coerced into a fake VIN string", listingObjVin === null);

  // Same VIN-validity rule applies to the lean (?select=) ingestion path.
  const leanRow: LeanRow = { "vehicle.vin": 99999, "vehicle.make": "Ford" };
  const leanListing = leanRowToListing(leanRow);
  check("6e. Same VIN-validity rule applies to leanRowToListing() (?select= path)", leanListing === null);
}

// 7. normal search output remains schema-valid (structural check: the four
// ingestion points route.ts relies on all go through normalization).
{
  const clientSource = fs.readFileSync("lib/auto-dev-client.ts", "utf8");
  check(
    "7a. searchListings() routes through normalizeListing()",
    /\(outcome\.data\.data \?\? \[\]\)\.map\(normalizeListing\)/.test(clientSource),
  );
  check(
    "7b. getListingByVin() routes through normalizeListing()",
    /return outcome\.ok \? normalizeListing\(outcome\.data\.data\) : null;/.test(clientSource),
  );
  check(
    "7c. searchListingByVinExact() routes through normalizeListing()",
    /return row != null \? normalizeListing\(row\) : null;/.test(clientSource),
  );
  check(
    "7d. leanRowToListing() uses providerString()/providerVin(), not a raw passthrough",
    /const vin = providerVin\(row\["vehicle\.vin"\]\);/.test(clientSource) && /make: providerString\(row\["vehicle\.make"\]\)/.test(clientSource),
  );
}

// ===========================================================================
// USER-FACING OUTPUT
// ===========================================================================

// 8/9. malformed trim/model never displays literal garbage -- structural
// check confirming buildResultCard()'s identity fields were reverted to
// plain passthrough (relying on the ingestion-boundary fix above), NOT
// String()-coerced, which is the actual mechanism that prevents "1958"/
// "[object Object]" from ever being displayed.
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const identityBlock = routeSource.match(/identity: \{\s*\n\s*vin: listing\.vin,[\s\S]*?bodyStyleConfig: v\?\.style \?\? null,[\s\S]*?\n\s*\},/);
  const block = identityBlock ? identityBlock[0] : "";
  check("Identity block located in buildResultCard()", block.length > 0, block || "regex may need updating if reshaped");
  check(
    "8. identity.trim uses plain passthrough (v?.trim ?? null), NOT String(v.trim) -- malformed values become null, never a coerced literal string",
    /trim: v\?\.trim \?\? null,/.test(block) && !/trim: v\?\.trim != null \? String/.test(block),
    block,
  );
  check(
    "9. identity.model uses plain passthrough (v?.model ?? null), NOT String(v.model) -- malformed values become null, never \"[object Object]\"",
    /model: v\?\.model \?\? null,/.test(block) && !/model: v\?\.model != null \? String/.test(block),
    block,
  );
  check(
    "9b. identity.make/series also plain passthrough, same principle",
    /make: v\?\.make \?\? null,/.test(block) && /series: v\?\.series \?\? null,/.test(block),
  );
}

// 10/11. card HTML rendering -- a card with unknown (null) identity fields
// renders gracefully, and a normal valid card is completely unchanged.
async function cardRenderingTest() {
  const { buildResultsCardHtml } = await import("@/lib/results-card");
  const { JSDOM } = await import("jsdom");

  const html = buildResultsCardHtml();
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 200));

  const mockResult = {
    structuredContent: {
      meta: { corpusSizeApprox: "3.4 million", totalMatches: 2 },
      results: [
        {
          // 10. Unknown/null trim (what a malformed provider value now
          // normalizes to) -- card must render gracefully, no crash, no
          // literal garbage text anywhere.
          identity: { vin: "1FTEW2KP9TKE60602", year: 2024, make: "Ford", model: "F-150", trim: null },
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
        {
          // 11. A completely normal, valid card -- must render identically
          // to before this whole fix, unaffected.
          identity: { vin: "1FTEW2KPXTKE60933", year: 2025, make: "Honda", model: "CR-V", trim: "EX" },
          condition: { inventoryType: "used", used: true, cpo: false },
          powertrain: { drivetrain: "AWD" },
          listing: { price: 28000, mileage: 15000, dealer: "Test Dealer 2", city: "Conroe", state: "TX" },
          media: { cardImageUrl: null },
          detail: { carfaxUrl: null, exteriorColor: "White", fuelTypeDisplay: "Gasoline" },
          ranking: { matchScore: 95 },
          links: { affiliateUrl: "https://www.edmunds.com/vin/1FTEW2KPXTKE60933/", affiliateFallbackUrl: null, dealerListingUrl: null, isCarvana: false, linkStatus: "edmunds-only" },
          badges: ["vin-verified"],
          intentConfirmations: [],
          risk: { tier: "positive" },
        },
      ],
    },
  };

  window.postMessage({ method: "ui/notifications/tool-result", params: mockResult }, "*");
  await new Promise((r) => setTimeout(r, 200));

  const doc = window.document;
  const cards = doc.querySelectorAll(".cc-card");
  check("Both cards rendered", cards.length === 2, `got ${cards.length}`);

  const card0Text = cards[0]?.textContent ?? "";
  check("10. Card with unknown/null trim renders gracefully -- no crash, no literal \"null\"/\"undefined\" text visible", !card0Text.includes("null") && !card0Text.includes("undefined"));

  const card1Text = cards[1]?.textContent ?? "";
  check("11. Normal valid card (Honda CR-V EX) renders its real data unchanged", card1Text.includes("Honda") && card1Text.includes("CR-V") && card1Text.includes("EX"));
}

// ===========================================================================
// LAST-RESORT ERROR BOUNDARY -- executable, not structural. Calls the REAL
// withFindMatchingVehicleErrorBoundary() (lib/tool-error-boundary.ts) --
// the exact same function app/[transport]/route.ts's registered handler
// wraps its entire body in (confirmed by import below) -- with a test-only
// callback that throws. No fallback logic is duplicated here; every
// assertion inspects the wrapper's own real return value and the wrapper's
// own real console.error call.
// ===========================================================================
async function errorBoundaryTest() {
  const { withFindMatchingVehicleErrorBoundary, FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE } = await import(
    "@/lib/tool-error-boundary"
  );
  const { FindMatchingVehicleOutputSchema } = await import("@/lib/find-matching-vehicle-output");

  // Structural confirmation the REAL registered handler actually uses this
  // exact wrapper (not a copy, not a second inline try/catch) -- ties the
  // executable test below to the real production code path.
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "12a. route.ts imports withFindMatchingVehicleErrorBoundary from lib/tool-error-boundary",
    /import \{ withFindMatchingVehicleErrorBoundary \} from "@\/lib\/tool-error-boundary";/.test(routeSource),
  );
  check(
    "12b. The registered find_matching_vehicle handler's entire body is wrapped by calling that exact function",
    /async \(input\) => \{\s*\n\s*return withFindMatchingVehicleErrorBoundary\(async \(\) => \{/.test(routeSource),
  );
  check(
    "12c. No second/duplicate inline try/catch exists anywhere else in the file for this purpose",
    (routeSource.match(/UNEXPECTED ERROR \(last-resort boundary\)/g) ?? []).length === 0, // this string now lives ONLY in lib/tool-error-boundary.ts, not duplicated in route.ts
  );

  // 1. Call the REAL wrapper with a test callback that throws a sentinel
  // error containing a fake secret-shaped string, to prove nothing about
  // the thrown error's content ever leaks through.
  const SENTINEL = "RAW_SECRET_SENTINEL";
  let threw = false;
  const originalConsoleError = console.error;
  const loggedCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedCalls.push(args);
  };

  let result;
  try {
    result = await withFindMatchingVehicleErrorBoundary(async () => {
      throw new Error(SENTINEL);
    });
  } catch {
    threw = true;
  } finally {
    // 5 (restore). Always restore console.error even if an assertion below fails.
    console.error = originalConsoleError;
  }

  // 2. Confirms the thrown error is caught -- withFindMatchingVehicleErrorBoundary
  // itself never re-throws; it always resolves normally.
  check("1/2. The thrown error is caught inside the wrapper -- calling code never sees it re-thrown", !threw);

  // 3. structuredContent validates against the REAL schema + exact required shape.
  check("3a. A result was returned (not undefined)", result !== undefined);
  const parsed = result ? FindMatchingVehicleOutputSchema.safeParse(result.structuredContent) : { success: false };
  check(
    "3b. The returned structuredContent validates against the REAL FindMatchingVehicleOutputSchema",
    parsed.success,
    parsed.success ? undefined : JSON.stringify((parsed as { error?: { issues?: unknown } }).error?.issues),
  );
  check("3c. results = []", Array.isArray(result?.structuredContent.results) && result?.structuredContent.results.length === 0);
  check("3d. meta.totalMatches = null", result?.structuredContent.meta.totalMatches === null);
  check(
    "3e. meta.serviceError = the exact required user-safe message",
    result?.structuredContent.meta.serviceError === FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE &&
      FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE === "The vehicle search hit an unexpected data issue. Please try the search again.",
  );

  // 4. Serialized user-facing content + structuredContent contains NONE of
  // the sentinel, the exception's own message, or a stack trace.
  const serialized = JSON.stringify(result);
  check("4a. Serialized response does NOT contain the RAW_SECRET_SENTINEL", !serialized.includes(SENTINEL));
  check("4b. Serialized response does NOT contain the literal exception message text", !serialized.includes("Error: " + SENTINEL));
  check("4c. Serialized response does NOT contain a stack trace (\"at \" / \".ts:\" frame markers)", !/\bat \S+\s*\(?.*:\d+:\d+/.test(serialized));

  // 5. console.error was actually called, and received the real thrown Error.
  check("5a. console.error was called exactly once", loggedCalls.length === 1, `got ${loggedCalls.length} calls`);
  check(
    "5b. console.error's arguments include the real thrown Error object (server-side logging genuinely received it)",
    loggedCalls[0]?.some((arg) => arg instanceof Error && arg.message === SENTINEL) ?? false,
  );
  check(
    "5c. console.error was tagged for identification (the same tag route.ts's real call uses)",
    loggedCalls[0]?.[0] === "[find_matching_vehicle] UNEXPECTED ERROR (last-resort boundary):",
  );
  check("5d. console.error was restored to the original after the test", console.error === originalConsoleError);

  // 6. No widget/render payload -- only content (plain text) + structuredContent.
  check(
    "6. No widget/render payload returned on this fallback -- only content (plain text array) + structuredContent, same shape as every other real error path",
    Array.isArray(result?.content) &&
      result?.content.length === 1 &&
      result?.content[0]?.type === "text" &&
      Object.keys(result ?? {}).sort().join(",") === "content,structuredContent",
  );
}

// ===========================================================================
// PRESERVATION (structural, unit-testable slice; live/full-suite
// preservation confirmed via the existing test files listed in the
// commit report, and via live preview testing reported separately)
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "16. trimRequired eligibility logic untouched (still present, unrelated to this diff)",
    routeSource.includes("trimRequiredLeanFilter") && routeSource.includes("trimRequiredFullFilter"),
  );
  check(
    "17. lower_risk dispatch branch untouched (still present, unrelated to this diff)",
    routeSource.includes('applyLocalLowerRiskOrdering(trimOrderedCandidates)'),
  );
  check(
    "18. buildBuyerCheck() import/usage untouched (still present, unrelated to this diff)",
    routeSource.includes('import { buildBuyerCheck, type BuyerCheck } from "@/lib/buyer-check";'),
  );
}

async function runAll() {
  await cardRenderingTest();
  await errorBoundaryTest();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

runAll();
