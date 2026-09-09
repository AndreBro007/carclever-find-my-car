// Regression fixtures for lib/nhtsa-client.ts's classifyElectrification()
// and app/[transport]/route.ts's electrificationStateSatisfies()
// covering the release-gate fixtures required before
// implementation authorization (see FEASIBILITY_EQUIVALENCE_PACKAGE_20260909.md,
// Section 7, cases 3-5).
//
// Real-corpus cases (hybrid/plug_in_hybrid/not_electrified) use 39
// VINs pulled from existing project docs (not a live NHTSA decode run —
// hardcoded here as fixtures rather than re-hitting the live NHTSA API on
// every test run, since the classifier is pure and doesn't need network
// access to test. mild_hybrid/electric/ambiguous cases are deterministic,
// hand-built from NHTSA's documented ElectrificationLevel vocabulary
// (ChatGPT-cross-checked this session) since the live 39-VIN corpus
// happened to contain zero real examples of any of the three — this file
// is what closes that fixture gap for CI purposes, though a live spot-check
// against real mild-hybrid/BEV VINs is still recommended before resubmission
// (see FEASIBILITY_EQUIVALENCE_PACKAGE_20260909.md Section 8/gates).
//
// Run: npx tsx tests/nhtsa-classifier.test.ts

import { classifyElectrification, type ElectrificationState } from "@/lib/nhtsa-client";

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

// --- electrificationStateSatisfies, mirrored from route.ts ---
// Kept as a local copy rather than importing a non-exported route.ts helper —
// route.ts doesn't export it (it's a route-local function), so this
// reproduces the exact same logic to test it in isolation. If route.ts's
// version ever diverges from this copy, that's a real bug this test won't
// catch — flagged limitation, not hidden.
function electrificationStateSatisfies(
  state: ElectrificationState | undefined,
  requestedTypes: ElectrificationState[],
): boolean {
  if (!state) return false;
  if (requestedTypes.includes(state)) return true;
  if (state === "mild_hybrid" && requestedTypes.includes("hybrid")) return true;
  return false;
}

// --- Real corpus (39 VINs sourced from existing project docs; NOT independently re-verified against a live NHTSA decode) ---
// [ElectrificationLevel, FuelTypeSecondary, expected state]
const REAL_CORPUS: Array<[string, string | null, ElectrificationState]> = [
  ["", null, "not_electrified"], // 29 VINs total shared this exact shape
  ["PHEV (Plug-in Hybrid Electric Vehicle)", "Gasoline", "plug_in_hybrid"], // 2 VINs
  ["HEV (Hybrid Electric Vehicle) - Level Unknown", "Electric", "hybrid"], // 5 VINs
  ["Strong HEV (Hybrid Electric Vehicle)", "Electric", "hybrid"], // 3 VINs
];

for (const [level, secondary, expected] of REAL_CORPUS) {
  const got = classifyElectrification(level, secondary);
  check(
    `real corpus: ${JSON.stringify(level)} -> ${expected}`,
    got === expected,
    `got ${got}`,
  );
}

// --- Deterministic fixtures: mild_hybrid, electric (BEV), ambiguous, FCV ---
// (Regression cases 5 and part of the feasibility package's release gates —
// no matching example existed in the 39-VIN doc-sourced corpus.)
const SYNTHETIC_CASES: Array<[string, string | null, ElectrificationState, string]> = [
  ["Mild HEV (Hybrid Electric Vehicle)", "Electric", "mild_hybrid", "documented NHTSA mild-hybrid form -- this exact case caught a real classifier bug: the original pattern only matched the literal phrase 'mild hybrid' or 'mhev', so this variant fell through to plain 'hybrid'. Fixed by broadening the check to 'mild' + any hybrid/HEV wording."],
  ["Mild Hybrid Electric Vehicle (MHEV)", "Electric", "mild_hybrid", "alternate documented mild-hybrid form"],
  ["BEV (Battery Electric Vehicle)", null, "electric", "documented NHTSA BEV form"],
  ["Electric", null, "electric", "bare 'Electric' level, no hybrid qualifier"],
  ["FCV (Fuel Cell Vehicle)", null, "ambiguous", "FCV is out of this project's taxonomy, must fall through to ambiguous, not electric"],
  ["Some Unrecognized Future NHTSA String", null, "ambiguous", "unrecognized vocabulary, not a classifier bug"],
  ["", "Electric", "ambiguous", "blank level contradicts secondary=Electric -- surfaced, not silently resolved"],
];

for (const [level, secondary, expected, why] of SYNTHETIC_CASES) {
  const got = classifyElectrification(level, secondary);
  check(`synthetic: ${JSON.stringify(level)} -> ${expected} (${why})`, got === expected, `got ${got}`);
}

// --- electrificationStateSatisfies: required-type matching semantics ---
// (André, Sep 9 2026: "hybrid" implicitly includes "mild_hybrid";
// "plug_in_hybrid"/"electric" are never implied by anything else.)
check(
  "mild_hybrid satisfies requested ['hybrid']",
  electrificationStateSatisfies("mild_hybrid", ["hybrid"]) === true,
);
check(
  "mild_hybrid does NOT satisfy requested ['plug_in_hybrid']",
  electrificationStateSatisfies("mild_hybrid", ["plug_in_hybrid"]) === false,
);
check(
  "hybrid satisfies requested ['hybrid']",
  electrificationStateSatisfies("hybrid", ["hybrid"]) === true,
);
check(
  "plug_in_hybrid does NOT satisfy requested ['hybrid'] (never implied the other way)",
  electrificationStateSatisfies("plug_in_hybrid", ["hybrid"]) === false,
);
check(
  "electric satisfies requested ['hybrid','electric'] (OR semantics across array)",
  electrificationStateSatisfies("electric", ["hybrid", "electric"]) === true,
);
check(
  "unknown never satisfies any requested type",
  electrificationStateSatisfies("unknown", ["hybrid", "plug_in_hybrid", "electric", "mild_hybrid"]) === false,
);
check(
  "ambiguous never satisfies any requested type",
  electrificationStateSatisfies("ambiguous", ["hybrid", "plug_in_hybrid", "electric", "mild_hybrid"]) === false,
);
check(
  "not_electrified never satisfies any requested type",
  electrificationStateSatisfies("not_electrified", ["hybrid"]) === false,
);
check(
  "undefined state (decode never ran) never satisfies any requested type",
  electrificationStateSatisfies(undefined, ["hybrid"]) === false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
