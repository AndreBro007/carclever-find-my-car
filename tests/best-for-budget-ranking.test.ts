// Deterministic regression tests for the value-based best_for_budget
// ranking (experiment/value-based-best-for-budget). No test framework is
// installed in this repo (confirmed: no jest/vitest, no prior test files
// in history) — the established convention is a standalone TypeScript
// script run via `npx tsx`, with manual PASS/FAIL assertions (used
// throughout this investigation's diagnostic/repro scripts). This file
// follows that same convention, but is committed rather than thrown away,
// since these checks are meant to be rerun before any future change to
// this ranking.
//
// applyLocalBestForBudgetOrdering() is not exported from
// app/[transport]/route.ts (it's a local function in a Next.js route
// handler file with framework-level side effects at import time), so this
// file keeps a byte-for-byte faithful copy of the current function body
// below, rather than importing it directly. Whenever the real function in
// route.ts changes, this copy must be updated to match — that
// synchronization is manual, not automatic, and is itself worth checking
// by eye at review time.
//
// Run: npx tsx tests/best-for-budget-ranking.test.ts

interface MiniListing {
  vin: string;
  used?: boolean;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  price?: number;
  miles?: number;
}

function toAutoDevShape(l: MiniListing) {
  return {
    vin: l.vin,
    vehicle: { make: l.make, model: l.model, year: l.year, trim: l.trim },
    retailListing: { price: l.price, miles: l.miles, used: l.used },
  };
}

// --- Faithful copy, current as of commit 59085ba (experiment/value-based-best-for-budget) ---

function trimMatches(requested: string, actual: string | null | undefined): boolean {
  if (!actual) return false;
  return actual.trim().toLowerCase() === requested.trim().toLowerCase();
}

function applyLocalBestForBudgetOrdering(candidates: any[], trimPreference: string | undefined): any[] {
  if (candidates.length === 0) return candidates;

  const years = candidates.map((c) => c.vehicle?.year).filter((y: any): y is number => y != null);
  const miles = candidates.map((c) => c.retailListing?.miles).filter((m: any): m is number => m != null);
  const prices = candidates.map((c) => c.retailListing?.price).filter((p: any): p is number => p != null);
  const yearMin = years.length > 0 ? Math.min(...years) : null;
  const yearMax = years.length > 0 ? Math.max(...years) : null;
  const milesMin = miles.length > 0 ? Math.min(...miles) : null;
  const milesMax = miles.length > 0 ? Math.max(...miles) : null;
  const priceMin = prices.length > 0 ? Math.min(...prices) : null;
  const priceMax = prices.length > 0 ? Math.max(...prices) : null;

  const yearRank = (y: number | undefined): number => {
    if (y == null || yearMin == null || yearMax == null || yearMax === yearMin) return 0.5;
    return (y - yearMin) / (yearMax - yearMin);
  };
  const mileageRank = (m: number | undefined): number => {
    if (m == null || milesMin == null || milesMax == null || milesMax === milesMin) return 0.5;
    return (milesMax - m) / (milesMax - milesMin);
  };
  const priceRank = (p: number | undefined): number => {
    if (p == null || priceMin == null || priceMax == null || priceMax === priceMin) return 0.5;
    return (priceMax - p) / (priceMax - priceMin);
  };
  const balancedScore = (c: any): number =>
    (yearRank(c.vehicle?.year) + mileageRank(c.retailListing?.miles) + priceRank(c.retailListing?.price)) / 3;
  const trimMatchRank = (c: any): number =>
    trimPreference && trimMatches(trimPreference, c.vehicle?.trim) ? 0 : 1;

  return [...candidates].sort((a, b) => {
    const trimDiff = trimMatchRank(a) - trimMatchRank(b);
    if (trimDiff !== 0) return trimDiff;

    const scoreDiff = balancedScore(b) - balancedScore(a);
    if (scoreDiff !== 0) return scoreDiff;

    const priceA = a.retailListing?.price ?? Infinity;
    const priceB = b.retailListing?.price ?? Infinity;
    if (priceA !== priceB) return priceA - priceB;

    return 0;
  });
}

// --- Test harness ---

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
// Contract 1: Near-new value wins when justified
// Same year, comparable trim; USED materially cheaper with only a few
// hundred miles; should outrank a substantially pricier NEW equivalent.
// ===========================================================================
{
  const pool = [
    { vin: "NEW-pricier", used: false, year: 2026, make: "BMW", model: "X5", trim: "xDrive40i", price: 101425, miles: 1 },
    { vin: "USED-value", used: true, year: 2026, make: "BMW", model: "X5", trim: "xDrive40i", price: 70489, miles: 269 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined);
  check(
    "1. Near-new value USED wins vs substantially pricier NEW equivalent",
    ranked[0].vin === "USED-value",
    `got top=${ranked[0].vin}`,
  );
}

// ===========================================================================
// Contract 2: Cheap does not automatically mean best
// A materially older/very-high-mileage vehicle is cheapest; a clearly
// stronger newer/low-mileage option (even if pricier) should still beat it
// on the combined score, not lose purely because it costs more.
// ===========================================================================
{
  const pool = [
    { vin: "cheap-old-highmiles", used: true, year: 2018, make: "BMW", model: "X5", trim: "xDrive35i", price: 599, miles: 74102 },
    { vin: "newer-lowmiles-pricier", used: false, year: 2026, make: "BMW", model: "X5", trim: "xDrive40i", price: 84149, miles: 3 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined);
  check(
    "2. Cheapest-but-old/high-mileage does NOT beat clearly stronger newer/low-mileage option",
    ranked[0].vin === "newer-lowmiles-pricier",
    `got top=${ranked[0].vin}`,
  );
}

// ===========================================================================
// Contract 3: Hard priceMax remains hard — ordering only, never
// filters/relaxes. applyLocalBestForBudgetOrdering() has no knowledge of
// priceMax at all (eligibility filtering happens upstream, unchanged by
// this branch) — this checks the function is a pure permutation: same
// VINs, same count, same prices in and out, only reordered.
// ===========================================================================
{
  const pool = [
    { vin: "a", used: false, year: 2025, make: "BMW", model: "X5", trim: "xDrive40i", price: 60000, miles: 5000 },
    { vin: "b", used: true, year: 2023, make: "BMW", model: "X5", trim: "xDrive40i", price: 45000, miles: 20000 },
    { vin: "c", used: true, year: 2021, make: "BMW", model: "X5", trim: "xDrive40i", price: 38000, miles: 40000 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined);
  const inVins = pool.map((c) => c.vin).sort();
  const outVins = ranked.map((c) => c.vin).sort();
  const inPrices = pool.map((c) => c.retailListing.price).sort((x, y) => (x ?? 0) - (y ?? 0));
  const outPrices = ranked.map((c) => c.retailListing.price).sort((x, y) => (x ?? 0) - (y ?? 0));
  check(
    "3a. Same set of VINs in and out (no filtering/relaxation inside ranking)",
    JSON.stringify(inVins) === JSON.stringify(outVins),
    `in=${inVins} out=${outVins}`,
  );
  check(
    "3b. Same set of prices in and out (no price ceiling altered by ranking)",
    JSON.stringify(inPrices) === JSON.stringify(outPrices),
    `in=${inPrices} out=${outPrices}`,
  );
  check("3c. Output length unchanged", ranked.length === pool.length, `in=${pool.length} out=${ranked.length}`);
}

// ===========================================================================
// Contract 4: Trim preference precedence remains intact
// A confirmed preferred-trim candidate must outrank a non-matching trim
// even when the non-match scores materially better on year+mileage+price.
// ===========================================================================
{
  const pool = [
    { vin: "non-match-strong", used: false, year: 2026, make: "BMW", model: "X5", trim: "xDrive40i", price: 50000, miles: 1 },
    { vin: "confirmed-match-weak", used: true, year: 2019, make: "BMW", model: "X5", trim: "M60i", price: 90000, miles: 60000 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, "M60i");
  check(
    "4. Confirmed trim-preference match outranks a materially stronger non-match",
    ranked[0].vin === "confirmed-match-weak",
    `got top=${ranked[0].vin}`,
  );
}

// ===========================================================================
// Contract 5: No condition quota
// A mixed NEW/USED pool ranks purely on buyer-value factors — this test
// deliberately does NOT assert any required NEW/USED split in the output;
// it only confirms the ranking function's own code never reads condition
// at all (grep-level structural check against the real route.ts source,
// not just this test's local copy — catches a regression even if someone
// edits route.ts without updating this file's copy above).
// ===========================================================================
{
  const fs = require("fs");
  const routeSource: string = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const fnMatch = routeSource.match(/function applyLocalBestForBudgetOrdering\([\s\S]*?\n\}\n/);
  const fnBody = fnMatch ? fnMatch[0] : "";
  check(
    "5. applyLocalBestForBudgetOrdering() source never reads retailListing.used (no condition quota possible)",
    fnBody.length > 0 && !fnBody.includes(".used"),
    fnBody.length === 0 ? "could not locate function in route.ts — update this test's regex" : "found a .used reference inside the function body",
  );
}

// ===========================================================================
// Contract 6: Explicit condition paths unchanged
// used:false / used:true continue through the existing single-query path,
// not the fair-pool dual query. Structural check against the real
// route.ts source: the merge branch must be gated strictly behind
// `baseQuery.used == null`, with an unconditional single
// searchListingsLean(baseQuery) call in the else branch.
// ===========================================================================
{
  const fs = require("fs");
  const routeSource: string = fs.readFileSync("app/[transport]/route.ts", "utf8");
  const hasNullGate = /if\s*\(\s*baseQuery\.used\s*==\s*null\s*\)/.test(routeSource);
  const hasUnchangedElseBranch = /\}\s*else\s*\{\s*rawResult\s*=\s*await\s*searchListingsLean\(baseQuery\);\s*\}/.test(
    routeSource,
  );
  check("6a. Fair-pool merge is gated strictly behind baseQuery.used == null", hasNullGate);
  check(
    "6b. Explicit used:true/used:false else-branch is still the single unchanged searchListingsLean(baseQuery) call",
    hasUnchangedElseBranch,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
