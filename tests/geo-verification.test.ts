// Focused tests for lib/geo-verification.ts (the pure exclusion function)
// and its wiring into app/[transport]/route.ts's existing stage-2/backfill
// architecture (structural source-text checks, same convention as the
// existing tests/best-for-budget-ranking.test.ts contracts 5/6, since the
// stage-2 pipeline itself lives inline in a Next.js route handler and
// isn't independently exported/callable).
//
// Run: npx tsx tests/geo-verification.test.ts

import fs from "node:fs";
import { isConfirmedOutsideRadius } from "@/lib/geo-verification";

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
// 1. Confirmed local (same-state) listing inside radius -> retained.
// Houston origin (zip3 anchor 770) falls literally inside Texas's own
// bounding box, so same-state is the clearest "confirmed local" case this
// module can express with real anchor data. Also a genuinely close
// cross-state case: DC's anchor point falls literally inside Maryland's
// bounding box (DC is geographically surrounded by MD/VA), giving a real,
// non-same-state "confirmed nearby" case with zero computed distance.
// ===========================================================================
{
  check(
    "1a. Same-state (Houston origin, TX listing) is retained regardless of radius",
    isConfirmedOutsideRadius("77002", 10, "TX") === false,
  );
  check(
    "1b. Cross-state but genuinely nearby (DC origin, MD listing, anchor point falls inside MD's bounds) is retained even at a tiny radius",
    isConfirmedOutsideRadius("20001", 1, "MD") === false,
  );
}

// ===========================================================================
// 2. Confirmed far-away listing outside radius -> excluded. This is the
// deterministic fixture for the confirmed production regression: search
// ZIP 77002 (Houston), 50-mile radius, listing reported in Colorado (the
// real VIN 1FTPX14504NB68591's reported state) -- must now be excluded.
// ===========================================================================
{
  check(
    "2. REGRESSION: Houston 77002, 50mi radius, listing state CO (VIN 1FTPX14504NB68591's condition) is confirmed excluded",
    isConfirmedOutsideRadius("77002", 50, "CO") === true,
  );
}

// ===========================================================================
// 3. Missing/unresolvable listing location -> retained (unknown ≠ false).
// ===========================================================================
{
  check("3a. null listing state is retained (never guessed as out-of-radius)", isConfirmedOutsideRadius("77002", 50, null) === false);
  check("3b. undefined listing state is retained", isConfirmedOutsideRadius("77002", 50, undefined) === false);
  check("3c. empty-string listing state is retained", isConfirmedOutsideRadius("77002", 50, "") === false);
  check("3d. malformed (non-2-letter) listing state is retained", isConfirmedOutsideRadius("77002", 50, "TEXAS") === false);
  check("3e. unrecognized 2-letter state code is retained (not guessed)", isConfirmedOutsideRadius("77002", 50, "ZZ") === false);
}

// ===========================================================================
// 4. Widened radius uses the widened/effective radius, not the original.
// Module-level: the exact same far-away listing (Houston->CO) is excluded
// at the original 50mi radius but retained once a large-enough effective
// radius is passed in -- proving the function's behavior genuinely tracks
// whatever radius value it's given, which is the contract the route.ts
// call site relies on when it passes effectiveQuery.radius specifically.
// ===========================================================================
{
  check(
    "4a. Houston->CO excluded at original 50mi radius",
    isConfirmedOutsideRadius("77002", 50, "CO") === true,
  );
  check(
    "4b. Same Houston->CO listing retained once a sufficiently widened radius is passed (proves the function tracks the radius argument, not a hardcoded 50)",
    isConfirmedOutsideRadius("77002", 5000, "CO") === false,
  );

  // Structural check: the actual route.ts call site passes
  // effectiveQuery.zip/effectiveQuery.radius (the widened values after the
  // automatic-widening ladder runs), never baseQuery's or input's original
  // pre-widening zip/radius -- confirms the widening-respect requirement
  // at the integration point itself, not just at the pure-function level.
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const callSiteMatch = routeSource.match(/isConfirmedOutsideRadius\(\s*[\s\S]*?\);/);
  const callSite = callSiteMatch ? callSiteMatch[0] : "";
  check(
    "4c. route.ts's isConfirmedOutsideRadius() call site passes effectiveQuery.zip",
    /effectiveQuery\.zip/.test(callSite),
    callSite || "call site not found",
  );
  check(
    "4d. route.ts's isConfirmedOutsideRadius() call site passes effectiveQuery.radius (the widened value), not baseQuery.radius or input.radiusMiles",
    /effectiveQuery\.radius/.test(callSite) && !/baseQuery\.radius/.test(callSite) && !/input\.radiusMiles/.test(callSite),
    callSite || "call site not found",
  );
}

// ===========================================================================
// 5. Out-of-radius primary result can be replaced by a valid spare/backfill
// candidate -- structural check confirming the geo filter is wired into
// BOTH the primary-match filter condition and the backfill-match filter
// condition (the same existing bounded-backfill mechanism already proven
// for body-style/trim exclusions), so a shortfall caused by geo exclusion
// triggers the same one-round spare-pool backfill, not a new/separate path.
// ===========================================================================
{
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const primaryMatchesLine = routeSource.match(/const primaryMatches = \([\s\S]*?\)\s*\n\s*\? shortlistWithPriceCheck\.filter\(applyLocalStage2Filters\)/);
  const backfillMatchesLine = routeSource.match(/const backfillMatches = \(\([\s\S]*?\)\s*\n\s*\? spareResolved\.filter\(applyLocalStage2Filters\)/);
  check(
    "5a. primaryMatches filter-trigger condition includes effectiveQuery.zip (geo exclusion can cause a shortfall)",
    !!primaryMatchesLine && /effectiveQuery\.zip/.test(primaryMatchesLine[0]),
  );
  check(
    "5b. backfillMatches filter-trigger condition ALSO includes effectiveQuery.zip (same bounded spare-pool backfill now covers geo exclusion too)",
    !!backfillMatchesLine && /effectiveQuery\.zip/.test(backfillMatchesLine[0]),
  );
  // Same spareLean pool used elsewhere (already capped to targetCount by
  // construction) -- confirms no new/separate candidate-sourcing path was
  // introduced for geo backfill specifically.
  check(
    "5c. backfill draws from the existing spareLean/spareResolved pool, not a new geo-specific pool",
    routeSource.includes("spareResolved.filter(applyLocalStage2Filters)"),
  );
}

// ===========================================================================
// 6. No behavior change when no ZIP/radius search is active.
// ===========================================================================
{
  check(
    "6a. No search zip (undefined) -> never excludes, regardless of a suspicious-looking state",
    isConfirmedOutsideRadius(undefined, 50, "CO") === false,
  );
  check(
    "6b. No effective radius (undefined) -> never excludes",
    isConfirmedOutsideRadius("77002", undefined, "CO") === false,
  );
  check(
    "6c. Search zip present but no radius and no state search zip resolvable together -> never excludes",
    isConfirmedOutsideRadius("77002", null, "CO") === false,
  );

  // Structural check: the primary-match filter-trigger condition is only
  // extended by effectiveQuery.zip being present -- when it's falsy (no
  // zip/radius search active) and neither droppedBodyStyle nor
  // trimRequired apply, the pipeline takes the exact same
  // shortlistWithPriceCheck-unfiltered path as before this change existed.
  const routeSource = fs.readFileSync("app/[transport]/route.ts", "utf8");
  check(
    "6d. Unconditional shortlistWithPriceCheck fallback (no-filter path) still exists unchanged for when none of droppedBodyStyle/trimRequired/effectiveQuery.zip apply",
    /: shortlistWithPriceCheck;/.test(routeSource),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
