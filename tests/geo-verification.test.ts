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
// 1c (locks a deliberate, documented limitation). A far-away listing in
// the SAME state as the search origin is retained/unverified -- this
// coarse, state-level guard deliberately does NOT attempt to verify
// in-state distance (module doc: "never exclude same-state; large
// in-state distances are a real possibility this coarse check
// deliberately does not attempt to resolve"). Houston (77002, zip3 anchor
// 770) to a same-state Texas listing genuinely near El Paso is roughly
// 750+ real miles apart -- yet must still be retained, even at a radius
// as tight as 1 mile, precisely because this module only ever reasons at
// state-bounding-box granularity, never real per-listing distance for a
// same-state pair. This test exists specifically so nobody later mistakes
// this module for comprehensive radius enforcement.
// ===========================================================================
{
  check(
    "1c. Far-away same-state listing (Houston origin, TX listing, real-world El Paso-scale distance) is retained even at a 1-mile radius -- same-state distance is never verified by design",
    isConfirmedOutsideRadius("77002", 1, "TX") === false,
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
// 4. Widened radius uses the widened/effective radius, not the original —
// proven against the ACTUAL production automatic-widening contract (50 ->
// 100 miles), not merely that the radius parameter isn't hardcoded.
// Deterministic anchored fixture: Denver origin (zip3 anchor 802) vs a
// Wyoming-reported listing. Real, precise computed result (confirmed via
// direct probing of the real function, not hand-estimated): excluded at
// the original 50-mile radius, retained once genuinely widened to 100 --
// this is the exact 50->100 step the production widening ladder performs,
// so this test proves the real contract, not just non-hardcoding.
// ===========================================================================
{
  check(
    "4a. Denver origin (80201) -> WY listing excluded at the original 50mi radius",
    isConfirmedOutsideRadius("80201", 50, "WY") === true,
  );
  check(
    "4b. The SAME Denver->WY listing is retained once the search genuinely widens to 100mi (the real production 50->100 widening step)",
    isConfirmedOutsideRadius("80201", 100, "WY") === false,
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
// 4e (locks the intentional partial-coverage behavior). An unrecognized/
// unanchored search ZIP prefix must never exclude a listing -- unknown ≠
// false. ZIP3_ORIGIN_ANCHORS is deliberately non-exhaustive (~22 major-
// metro prefixes only); "123" is a well-formed 5-digit-ZIP prefix shape
// but is NOT one of the covered anchors, so the search origin itself is
// unresolvable. Paired with an obviously-distant state (CO) specifically
// to prove this isn't accidentally passing only because CO happens to be
// close to whatever fallback might exist -- there is no fallback, no
// guess; verification is skipped entirely for the whole search.
// ===========================================================================
{
  check(
    "4e. Unrecognized/unanchored search ZIP prefix (12345, not in the ~22-entry anchor table) never excludes, even paired with an obviously-distant state",
    isConfirmedOutsideRadius("12345", 50, "CO") === false,
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
