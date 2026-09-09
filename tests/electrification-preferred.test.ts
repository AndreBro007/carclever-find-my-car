// Functional regression tests for electrificationRequirement ("required"
// and "preferred") — addressing the gap ChatGPT
// flagged in the frozen branch at commit 6f599a6: "preferred" was accepted
// by the schema but had no effect on ranking.
//
// These call the REAL functions the route imports (applyLocalBestForBudgetOrdering,
// applyLocalLowerRiskOrdering from lib/local-ranking.ts; electrificationStateSatisfies
// from lib/nhtsa-client.ts), not source-text/regex checks and not a
// hand-copied duplicate — genuine behavioral assertions on real output order
// and real filter results, using constructed AutoDevListing fixtures.
//
// IMPORTANT LIMITATION, flagged not hidden: these tests exercise the pure
// ordering/matching functions directly, with electrification match/no-match
// supplied as a plain predicate — they do NOT exercise the live NHTSA
// decode step itself (decodeNhtsaElectrification, the bounded pool-of-20
// fetch, or the shortfall-computation closure in route.ts). That decode
// step is covered separately by tests/nhtsa-classifier.test.ts (classifier
// correctness) and would be covered by a real NHTSA latency/hit-rate spike once one is actually run (not yet done — see the open validation question on ELECTRIFICATION_POOL_SIZE)
// (latency/concurrency, real NHTSA calls). No live VIN test was run in this
// pass — that remains explicitly unverified, not silently assumed to work.
//
// Run: npx tsx tests/electrification-preferred.test.ts

import { applyLocalBestForBudgetOrdering, applyLocalLowerRiskOrdering } from "@/lib/local-ranking";
import { electrificationStateSatisfies, type ElectrificationState } from "@/lib/nhtsa-client";
import { FindMatchingVehicleInput } from "@/lib/find-matching-vehicle-input";
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

interface MiniListing {
  vin: string;
  year?: number;
  price?: number;
  miles?: number;
  trim?: string;
}
function toListing(l: MiniListing): AutoDevListing {
  return {
    vin: l.vin,
    vehicle: { year: l.year, trim: l.trim },
    retailListing: { price: l.price, miles: l.miles },
  } as AutoDevListing;
}

// ===========================================================================
// electrificationStateSatisfies() -- real function, real assertions
// ===========================================================================
{
  check(
    "internal mild_hybrid satisfies public hybrid",
    electrificationStateSatisfies("mild_hybrid", ["hybrid"]) === true,
  );
  check(
    "internal mild_hybrid does NOT satisfy public plug_in_hybrid",
    electrificationStateSatisfies("mild_hybrid", ["plug_in_hybrid"]) === false,
  );
  check(
    "hybrid satisfies ['hybrid']",
    electrificationStateSatisfies("hybrid", ["hybrid"]) === true,
  );
  check(
    "plug_in_hybrid remains distinct: does not satisfy ['hybrid']",
    electrificationStateSatisfies("plug_in_hybrid", ["hybrid"]) === false,
  );
  check(
    "electric remains distinct: does not satisfy ['hybrid']",
    electrificationStateSatisfies("electric", ["hybrid"]) === false,
  );
  check(
    "mixed requested types use OR semantics -- electric satisfies ['hybrid','electric']",
    electrificationStateSatisfies("electric", ["hybrid", "electric"]) === true,
  );
  check(
    "mixed requested types use OR semantics -- plug_in_hybrid satisfies ['plug_in_hybrid','electric'] via first entry",
    electrificationStateSatisfies("plug_in_hybrid", ["plug_in_hybrid", "electric"]) === true,
  );
  check(
    "unknown never satisfies a required request (any type)",
    electrificationStateSatisfies("unknown", ["hybrid", "plug_in_hybrid", "electric"]) === false,
  );
  check(
    "ambiguous never satisfies a required request (any type)",
    electrificationStateSatisfies("ambiguous", ["hybrid", "plug_in_hybrid", "electric"]) === false,
  );
  check(
    "not_electrified never satisfies a required request",
    electrificationStateSatisfies("not_electrified", ["hybrid"]) === false,
  );
}

// ===========================================================================
// "required" filtering semantics (pool-filter simulation) -- mirrors what
// route.ts's electrificationResult closure actually does: filter a pool to
// only NHTSA-confirmed matches, compute a shortfall when short.
// ===========================================================================
{
  const pool = [
    { vin: "hybrid1", state: "hybrid" as ElectrificationState },
    { vin: "mildhybrid1", state: "mild_hybrid" as ElectrificationState },
    { vin: "phev1", state: "plug_in_hybrid" as ElectrificationState },
    { vin: "electric1", state: "electric" as ElectrificationState },
    { vin: "gas1", state: "not_electrified" as ElectrificationState },
    { vin: "unknown1", state: "unknown" as ElectrificationState },
    { vin: "ambiguous1", state: "ambiguous" as ElectrificationState },
  ];
  const requestedHybrid: ElectrificationState[] = ["hybrid"];
  const confirmedHybrid = pool.filter((p) => electrificationStateSatisfies(p.state, requestedHybrid));
  check(
    "required excludes not_electrified, unknown, ambiguous, and non-matching confirmed types",
    confirmedHybrid.map((c) => c.vin).sort().join(",") === "hybrid1,mildhybrid1",
    `got: ${confirmedHybrid.map((c) => c.vin).join(",")}`,
  );

  const targetCount = 5;
  const shortfall = confirmedHybrid.length < targetCount
    ? { requested: targetCount, confirmed: confirmedHybrid.length }
    : null;
  check(
    "required returns a shortfall object when fewer candidates confirm than the target count",
    shortfall !== null && shortfall.confirmed === 2 && shortfall.requested === 5,
    JSON.stringify(shortfall),
  );

  const bigPool = Array.from({ length: 6 }, (_, i) => ({ vin: `h${i}`, state: "hybrid" as ElectrificationState }));
  const confirmedBig = bigPool.filter((p) => electrificationStateSatisfies(p.state, requestedHybrid));
  const noShortfall = confirmedBig.length < targetCount ? { requested: targetCount, confirmed: confirmedBig.length } : null;
  check(
    "required produces no shortfall when enough candidates confirm",
    noShortfall === null,
  );
}

// ===========================================================================
// "preferred" ranking -- best_for_budget axis (default). Real function,
// real sort, real assertions on output order.
// ===========================================================================
{
  // Comparable candidates: identical year/price/miles, differ only in
  // electrification match -- balancedScore ties, so the electrification
  // tiebreak is the only thing that can move them.
  const pool = [
    toListing({ vin: "gas-comparable", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "hybrid-comparable", year: 2024, price: 30000, miles: 20000 }),
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "hybrid-comparable";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred hybrid ranks a confirmed hybrid ahead of a comparable gasoline candidate",
    ranked[0].vin === "hybrid-comparable",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}
{
  const pool = [
    toListing({ vin: "nonphev-comparable", year: 2024, price: 28000, miles: 15000 }),
    toListing({ vin: "phev-comparable", year: 2024, price: 28000, miles: 15000 }),
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "phev-comparable";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred PHEV ranks a confirmed PHEV ahead of a comparable non-PHEV",
    ranked[0].vin === "phev-comparable",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}
{
  const pool = [
    toListing({ vin: "nonev-comparable", year: 2025, price: 45000, miles: 5000 }),
    toListing({ vin: "ev-comparable", year: 2025, price: 45000, miles: 5000 }),
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "ev-comparable";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred electric ranks a confirmed EV ahead of a comparable non-EV",
    ranked[0].vin === "ev-comparable",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}
{
  // Non-comparable case: a much better (cheaper, lower-mileage, newer) gas
  // candidate must still win over a worse but electrified one -- preferred
  // is a tiebreaker, never an override of the primary balancedScore.
  const pool = [
    toListing({ vin: "much-better-gas", year: 2026, price: 15000, miles: 500 }),
    toListing({ vin: "worse-hybrid", year: 2018, price: 45000, miles: 150000 }),
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "worse-hybrid";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred never overrides a materially better primary-axis candidate (electrification is a tiebreaker, not a primary key)",
    ranked[0].vin === "much-better-gas",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}
{
  // No electrification fields at all (matchOf undefined) -- existing
  // behavior must be byte-for-byte unchanged (identical to calling the
  // 2-arg version).
  const pool = [
    toListing({ vin: "a", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "b", year: 2024, price: 29000, miles: 20000 }),
  ];
  const rankedNoArg = applyLocalBestForBudgetOrdering(pool, undefined);
  const rankedUndefinedArg = applyLocalBestForBudgetOrdering(pool, undefined, undefined);
  check(
    "no electrification fields preserves existing behavior (2-arg and 3-arg-undefined calls produce identical order)",
    JSON.stringify(rankedNoArg.map((c) => c.vin)) === JSON.stringify(rankedUndefinedArg.map((c) => c.vin)),
  );
}
{
  // preferred must never EXCLUDE -- both candidates present in output
  // regardless of match.
  const pool = [
    toListing({ vin: "match", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "no-match", year: 2024, price: 31000, miles: 21000 }),
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "match";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred does not exclude non-matching candidates -- both present in output",
    ranked.length === 2 && ranked.some((c) => c.vin === "match") && ranked.some((c) => c.vin === "no-match"),
  );
}
{
  // Unknown/ambiguous candidates (i.e. matchOf returns false for them,
  // since they were never confirmed) remain eligible and present --
  // "preferred" never drops them, only fails to promote them.
  const pool = [
    toListing({ vin: "confirmed-match", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "unknown-candidate", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "ambiguous-candidate", year: 2024, price: 30000, miles: 20000 }),
  ];
  // Simulates the real predicate: only the confirmed one is in the matched
  // set built from the bounded-pool NHTSA decode; unknown/ambiguous never
  // appear in that set (electrificationStateSatisfies would return false
  // for them), so the predicate correctly returns false for both without
  // excluding them from the candidate list itself.
  const matchOf = (c: AutoDevListing) => c.vin === "confirmed-match";
  const ranked = applyLocalBestForBudgetOrdering(pool, undefined, matchOf);
  check(
    "preferred keeps unknown and ambiguous candidates eligible (present in output, just not promoted)",
    ranked.length === 3 &&
      ranked.some((c) => c.vin === "unknown-candidate") &&
      ranked.some((c) => c.vin === "ambiguous-candidate"),
  );
  check(
    "preferred still promotes the one genuinely confirmed match ahead of the unknown/ambiguous ones when otherwise comparable",
    ranked[0].vin === "confirmed-match",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}

// ===========================================================================
// "preferred" ranking -- lower_risk axis. Real function, real assertions.
// Uses vins with no VIN-cross-check/history/CPO data at all, so every
// candidate lands in the same ("unknown") risk tier -- isolates the
// electrification tiebreak from risk-tier grouping.
// ===========================================================================
{
  const pool = [
    toListing({ vin: "1HGCM82633A004352", year: 2024, price: 30000, miles: 20000 }), // gas, same tier
    toListing({ vin: "1HGCM82633A004353", year: 2024, price: 30000, miles: 20000 }), // hybrid, same tier
  ];
  const matchOf = (c: AutoDevListing) => c.vin === "1HGCM82633A004353";
  const ranked = applyLocalLowerRiskOrdering(pool, matchOf);
  check(
    "lower_risk axis: preferred electrification tiebreaks within the same risk tier",
    ranked[0].vin === "1HGCM82633A004353",
    `got order: ${ranked.map((c) => c.vin).join(",")}`,
  );
}
{
  // No matchOf -- lower_risk behavior must be unchanged from before this
  // feature existed (both candidates same tier, order stable/unchanged).
  const pool = [
    toListing({ vin: "1HGCM82633A004352", year: 2024, price: 30000, miles: 20000 }),
    toListing({ vin: "1HGCM82633A004353", year: 2024, price: 30000, miles: 20000 }),
  ];
  const rankedNoArg = applyLocalLowerRiskOrdering(pool);
  check(
    "lower_risk axis: no electrification fields preserves existing stable-order behavior",
    rankedNoArg[0].vin === "1HGCM82633A004352" && rankedNoArg[1].vin === "1HGCM82633A004353",
    `got order: ${rankedNoArg.map((c) => c.vin).join(",")}`,
  );
}

// ===========================================================================
// Legacy `goals` schema rejection -- real Zod schema, real safeParse call,
// not a source-text check.
// ===========================================================================
{
  const resultWithGoals = FindMatchingVehicleInput.safeParse({ goals: ["family", "reliability"] });
  check(
    "legacy goals produces an actual schema parse error, not a silently-stripped success",
    resultWithGoals.success === false,
    resultWithGoals.success ? `unexpectedly succeeded: ${JSON.stringify(resultWithGoals.data)}` : undefined,
  );
  check(
    "legacy goals rejection error mentions the unrecognized key",
    resultWithGoals.success === false &&
      JSON.stringify(resultWithGoals.error.issues).toLowerCase().includes("goals"),
    resultWithGoals.success ? undefined : JSON.stringify(resultWithGoals.error.issues),
  );

  const resultWithVehicleNeeds = FindMatchingVehicleInput.safeParse({ vehicleNeeds: ["family"] });
  check(
    "vehicleNeeds (the replacement field) parses successfully",
    resultWithVehicleNeeds.success === true,
    resultWithVehicleNeeds.success ? undefined : JSON.stringify(resultWithVehicleNeeds.error.issues),
  );

  const resultEmpty = FindMatchingVehicleInput.safeParse({});
  check(
    "an empty input (no electrification fields at all) still parses successfully -- preserves existing behavior",
    resultEmpty.success === true,
  );

  const resultBothGoalsAndVehicleNeeds = FindMatchingVehicleInput.safeParse({
    goals: ["family"],
    vehicleNeeds: ["family"],
  });
  check(
    "sending both legacy goals AND vehicleNeeds together still fails (no dual-acceptance)",
    resultBothGoalsAndVehicleNeeds.success === false,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
