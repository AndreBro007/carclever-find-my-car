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
// LAST-RESORT ERROR BOUNDARY
// ===========================================================================
// The actual tool handler can't be unit-invoked in isolation (it's the
// entire find_matching_vehicle registration body, deeply coupled to the
// live Auto.dev client and MCP server registration) -- these are
// structural checks confirming the try/catch boundary exists with the
// exact required shape, contract, and precedence. Live verification (no
// raw exception surfaces to the user) was additionally performed against
// a real preview deployment, reported separately alongside this commit.
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");

  check(
    "12a. The tool handler wraps its entire body in try/catch",
    /async \(input\) => \{[\s\S]*?try \{/.test(routeSource),
  );
  check(
    "12b. On catch, structuredContent is a valid FindMatchingVehicleOutput shape with results: [] and meta.totalMatches: null",
    /const safeContent: FindMatchingVehicleOutput = \{[\s\S]*?results: \[\],/.test(routeSource) &&
      /totalMatches: null,/.test(routeSource),
  );
  check(
    "12c. meta.serviceError is populated with the exact required user-safe message",
    routeSource.includes('"The vehicle search hit an unexpected data issue. Please try the search again."'),
  );
  check(
    "12d. The raw exception's .message/stack is NEVER included in the returned content or structuredContent",
    !/err\.message/.test(routeSource.match(/\} catch \(err\) \{[\s\S]*?\n      \}\n    \},\n  \);/)?.[0] ?? "") &&
      !/err\.stack/.test(routeSource.match(/\} catch \(err\) \{[\s\S]*?\n      \}\n    \},\n  \);/)?.[0] ?? ""),
  );
  check(
    "13. Server-side logging path (console.error) is present in the catch block, tagged for identification",
    /console\.error\("\[find_matching_vehicle\] UNEXPECTED ERROR \(last-resort boundary\):", err\);/.test(routeSource),
  );
  check(
    "14a. The safe fallback populates every required MetaSchema field (not just serviceError) -- would fail real schema validation otherwise",
    /totalCandidatesConsidered: 0,/.test(routeSource) &&
      /corpusSizeApprox: "unknown",/.test(routeSource) &&
      /scopeNote: "local",/.test(routeSource) &&
      /relaxations: \[\],/.test(routeSource) &&
      /dataNotes: \[\],/.test(routeSource) &&
      /interpretationNotes: \[\],/.test(routeSource) &&
      /qualifierAccounting: \[\],/.test(routeSource),
  );
  check(
    "14b. No widget render is attempted for the fallback -- only content + structuredContent returned, same shape as every other real error path",
    /return \{\s*\n\s*content: \[\s*\n\s*\{\s*\n\s*type: "text" as const,\s*\n\s*text: "The vehicle search hit an unexpected data issue\. Please try the search again\."/.test(routeSource),
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

// 14c. The exact safe-fallback object literal (mirrored here from the
// route.ts catch block for direct validation) DOES validate against the
// REAL FindMatchingVehicleOutputSchema, not just structurally resemble it.
async function safeFallbackSchemaTest() {
  const { FindMatchingVehicleOutputSchema } = await import("@/lib/find-matching-vehicle-output");
  const safeContent = {
    meta: {
      totalCandidatesConsidered: 0,
      totalMatches: null,
      corpusSizeApprox: "unknown",
      relaxations: [],
      dataNotes: [],
      scopeNote: "local",
      serviceError: "The vehicle search hit an unexpected data issue. Please try the search again.",
      interpretationNotes: [],
      qualifierAccounting: [],
    },
    results: [],
  };
  const parsed = FindMatchingVehicleOutputSchema.safeParse(safeContent);
  check(
    "14c. The exact safe-fallback shape used in the catch block validates against the REAL FindMatchingVehicleOutputSchema",
    parsed.success,
    parsed.success ? undefined : JSON.stringify(parsed.error.issues.slice(0, 5)),
  );
}

async function runAll() {
  await cardRenderingTest();
  await safeFallbackSchemaTest();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

runAll();
