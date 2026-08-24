// Deterministic regression tests for the settled best_for_budget ranking
// (merged to main at commit 6e302b1, live in production). No test
// framework is installed in this repo (confirmed: no jest/vitest, no
// prior test files in history) — the established convention is a
// standalone TypeScript script run via `npx tsx`, with manual PASS/FAIL
// assertions (used throughout the investigation's diagnostic/repro
// scripts, e.g. the diagnostic/* and experiment/* branches). This file
// follows that same convention, committed now that the ranking rule is
// actually settled (per SYS-20260824 series in DECISIONS.md and the Aug
// 24 update in specs/Auto_Dev_Field_Audit_v1.md) — an earlier version of
// this file was deliberately removed while the formula was still
// experimental.
//
// applyLocalBestForBudgetOrdering() and isAnomalousPrice() are not
// exported from app/[transport]/route.ts (local functions in a Next.js
// route handler file with framework-level side effects at import time),
// so this file keeps a byte-for-byte faithful copy of the current
// function bodies below, rather than importing them directly. Whenever
// the real functions in route.ts change, this copy must be updated to
// match — that synchronization is manual, not automatic, and is worth
// checking by eye at review time.
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

// --- Faithful copy, current as of commit 6e302b1 (main) ---

const ANOMALOUS_PRICE_FLOOR = 1000;
function isAnomalousPrice(price: number | undefined | null): boolean {
  return price != null && price < ANOMALOUS_PRICE_FLOOR;
}

function trimMatches(requested: string, actual: string | null | undefined): boolean {
  if (!actual) return false;
  return actual.trim().toLowerCase() === requested.trim().toLowerCase();
}

function applyLocalBestForBudgetOrdering(candidates: any[], trimPreference: string | undefined): any[] {
  if (candidates.length === 0) return candidates;

  const years = candidates.map((c) => c.vehicle?.year).filter((y: any): y is number => y != null);
  const miles = candidates.map((c) => c.retailListing?.miles).filter((m: any): m is number => m != null);
  const genuinePrices = candidates
    .map((c) => c.retailListing?.price)
    .filter((p: any): p is number => p != null && !isAnomalousPrice(p));
  const yearMin = years.length > 0 ? Math.min(...years) : null;
  const yearMax = years.length > 0 ? Math.max(...years) : null;
  const milesMin = miles.length > 0 ? Math.min(...miles) : null;
  const milesMax = miles.length > 0 ? Math.max(...miles) : null;
  const priceMin = genuinePrices.length > 0 ? Math.min(...genuinePrices) : null;
  const priceMax = genuinePrices.length > 0 ? Math.max(...genuinePrices) : null;

  const yearRank = (y: number | undefined): number => {
    if (y == null || yearMin == null || yearMax == null || yearMax === yearMin) return 0.5;
    return (y - yearMin) / (yearMax - yearMin);
  };
  const mileageRank = (m: number | undefined): number => {
    if (m == null || milesMin == null || milesMax == null || milesMax === milesMin) return 0.5;
    return (milesMax - m) / (milesMax - milesMin);
  };
  const priceRank = (c: any): number => {
    const p = c.retailListing?.price;
    if (isAnomalousPrice(p)) return 0.5;
    if (p == null || priceMin == null || priceMax == null || priceMax === priceMin) return 0.5;
    return (priceMax - p) / (priceMax - priceMin);
  };
  const balancedScore = (c: any): number =>
    (yearRank(c.vehicle?.year) + mileageRank(c.retailListing?.miles) + priceRank(c)) / 3;
  const trimMatchRank = (c: any): number =>
    trimPreference && trimMatches(trimPreference, c.vehicle?.trim) ? 0 : 1;
  const anomalyRank = (c: any): number => (isAnomalousPrice(c.retailListing?.price) ? 1 : 0);

  return [...candidates].sort((a, b) => {
    const trimDiff = trimMatchRank(a) - trimMatchRank(b);
    if (trimDiff !== 0) return trimDiff;

    const anomalyDiff = anomalyRank(a) - anomalyRank(b);
    if (anomalyDiff !== 0) return anomalyDiff;

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
// ===========================================================================
{
  const pool = [
    { vin: "cheap-old-highmiles", used: true, year: 2018, make: "BMW", model: "X5", trim: "xDrive35i", price: 25000, miles: 74102 },
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
// filters/relaxes. Pure permutation: same VINs/prices/count in and out.
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
  check("3a. Same set of VINs in and out (no filtering/relaxation inside ranking)", JSON.stringify(inVins) === JSON.stringify(outVins));
  check("3b. Same set of prices in and out (no price ceiling altered by ranking)", JSON.stringify(inPrices) === JSON.stringify(outPrices));
  check("3c. Output length unchanged", ranked.length === pool.length);
}

// ===========================================================================
// Contract 4: Trim preference precedence remains intact
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
// Contract 5: No condition quota — structural check, never asserts a
// required NEW/USED split.
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
// Contract 6: Fair-pool gating rules + Explicit condition paths unchanged
// ===========================================================================
{
  const fs = require("fs");
  const routeSource: string = fs.readFileSync("app/[transport]/route.ts", "utf8");
  
  // useFairPool is gated behind both:
  // 1. baseQuery.used == null (condition-neutral input)
  // 2. priorityAxis is best_for_budget OR null (not cheapest/lowest_mileage/newest/lower_risk)
  const hasFairPoolLogic = /useFairPool\s*=[\s\S]*?baseQuery\.used\s*==\s*null[\s\S]*?\(input\.priorityAxis\s*===\s*"best_for_budget"\s*\|\|\s*input\.priorityAxis\s*==\s*null\)/.test(routeSource);
  
  // Else-branch is unchanged: explicit used:true/used:false should hit the single searchListingsLean(baseQuery) path
  const hasUnchangedElseBranch = /\}\s*else\s*\{\s*rawResult\s*=\s*await\s*searchListingsLean\(baseQuery\);\s*\}/.test(routeSource);
  
  check("6a. Fair-pool merge is gated by both baseQuery.used==null AND (best_for_budget || null priorityAxis)", hasFairPoolLogic);
  check("6b. Explicit used:true/used:false else-branch is still the single unchanged searchListingsLean(baseQuery) call", hasUnchangedElseBranch);
}

// ===========================================================================
// Contract 6c/6d/6e: Verify fair-pool is correctly scoped (best_for_budget/null only)
// ===========================================================================
{
  const fs = require("fs");
  const routeSource: string = fs.readFileSync("app/[transport]/route.ts", "utf8");
  
  // The useFairPool condition should only reference best_for_budget and null,
  // never cheapest/lowest_mileage/newest/lower_risk
  const fairPoolBlockMatch = routeSource.match(/const\s+useFairPool\s*=[\s\S]*?(?=;)/);
  const fairPoolBlock = fairPoolBlockMatch ? fairPoolBlockMatch[0] : "";
  
  const hasOnlyBestForBudgetInFairPool = fairPoolBlock.includes("best_for_budget") && !fairPoolBlock.includes("cheapest") && !fairPoolBlock.includes("lowest_mileage") && !fairPoolBlock.includes("newest") && !fairPoolBlock.includes("lower_risk");
  
  check("6c. useFairPool condition only references best_for_budget (and null), not cheapest/lowest_mileage/newest/lower_risk", hasOnlyBestForBudgetInFairPool, fairPoolBlock.length > 0 ? "" : "could not locate useFairPool declaration");
}

// ===========================================================================
// Contract 7: Anomalous-price exclusion (added post-merge, F-150 fix)
// ===========================================================================
{
  const pool = [
    { vin: "anomaly1", used: true, year: 2026, trim: "Lariat", price: 595, miles: 486 },
    { vin: "anomaly2", used: true, year: 2026, trim: "XLT", price: 948, miles: 3815 },
    { vin: "good1", used: true, year: 2026, trim: "STX", price: 40946, miles: 490 },
    { vin: "good2", used: true, year: 2026, trim: "STX", price: 40084, miles: 1589 },
    { vin: "new1", used: false, year: 2026, trim: "Raptor", price: 85415, miles: 1 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined);
  const top3Vins = ranked.slice(0, 3).map((c) => c.vin);
  check(
    "7a. Anomalous sub-$1,000 prices do not occupy the top 3 (best-value) positions",
    !top3Vins.some((v) => v.startsWith("anomaly")),
    `top3=${top3Vins}`,
  );
  check(
    "7b. Anomalous candidates are reordered to the back, never discarded (still present in output)",
    ranked.length === pool.length && ranked.some((c) => c.vin === "anomaly1") && ranked.some((c) => c.vin === "anomaly2"),
  );
}

// ===========================================================================
// Contract 8: Anomalous prices don't distort priceMin/priceMax
// normalization for genuine candidates.
// ===========================================================================
{
  const pool = [
    { vin: "anomaly1", used: true, year: 2026, trim: "Lariat", price: 595, miles: 486 },
    { vin: "good1", used: true, year: 2026, trim: "STX", price: 40946, miles: 490 },
    { vin: "good2", used: true, year: 2026, trim: "STX", price: 85415, miles: 1 },
  ].map(toAutoDevShape);
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined);
  check(
    "8. Anomalous price does not distort genuine-candidate normalization (anomaly stays last)",
    ranked[ranked.length - 1].vin === "anomaly1",
    `got order=${ranked.map((c: any) => c.vin)}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
