import { AsyncLocalStorage } from "node:async_hooks";
/**
 * NHTSA vPIC client — free, no-key, government VIN decode.
 *
 * Purpose (SYS-20260819-002): the provider's `vehicle.fuel` field only ever
 * carries primary fuel type ("Gasoline" for every hybrid, since that's
 * technically correct — hybrids do have a gasoline engine). There is no
 * secondary/electrification field anywhere in the provider's schema, confirmed
 * by testing both the /listings response and the paid /vin/{vin} decode.
 * This is a genuine data gap, not a data error — NHTSA's manufacturer-
 * submitted vPIC data is the authoritative source for electrification
 * status specifically.
 *
 * Scope, deliberately narrow: only called on the final shortlist (5-8
 * vehicles), same stage as getListingByVin's full-detail refetch — never
 * on the full 100-candidate lean pool. One more parallel call per shortlist
 * VIN, same latency budget already being spent on that stage.
 *
 * Live-tested 2026-08-19: ~350-500ms per call, well-behaved on both bad
 * VINs (structured ErrorCode/ErrorText, never throws) and real hybrids
 * (correctly returns ElectrificationLevel + FuelTypeSecondary).
 *
 * Fields pulled: ElectrificationLevel, FuelTypePrimary, FuelTypeSecondary
 * (the actual ask) plus Make/Model/ModelYear (a second, stronger identity
 * cross-check than vin-anatomy.ts's WMI-only local check, free since the
 * call is already being made). Deliberately NOT pulling BodyClass/
 * PlantCountry/etc — no current use for them, same
 * don't-collect-fields-without-a-use discipline as baseInvoice/baseMsrp.
 *
 * Trim (2026-09-04, SYS-20260904-004): also pulled from this same
 * already-happening response — genuinely free, same reasoning as above.
 * NHTSA's Trim field is frequently ambiguous (a comma-separated list —
 * live-confirmed on a real VIN returning "EX, X-Line" for a Kia Sportage
 * Hybrid, where "X-Line" is an appearance package layered on the EX trim
 * rather than a separately-VIN-encoded model) or simply absent for many
 * manufacturers. Exposed as `trimOptions: string[]` (parsed, trimmed,
 * empty array when NHTSA has nothing) rather than a single string,
 * specifically so callers can't accidentally treat an ambiguous decode as
 * a confident single answer — see lib/link-resolution.ts (fills a missing
 * the provider trim, takes the first candidate when ambiguous — picking one
 * is simple, low-risk) and app/[transport]/route.ts's trim-conflict badge
 * (flags only when the claimed trim matches NONE of the candidates,
 * however many there are — checking array membership is simple regardless
 * of candidate count, so no "only if exactly one" restriction is needed
 * here, unlike the URL-fill case's simpler "just take the first" rule).
 *
 * NHTSA also exposes separate recalls and safety-ratings APIs
 * (api.nhtsa.gov/recalls, api.nhtsa.gov/SafetyRatings) — confirmed NOT
 * present in this decodevinvalues response (checked all 154 returned
 * fields). Those are a distinct, not-yet-scoped integration — see
 * DECISIONS.md SYS-20260819-003/004.
 */

import { specsFromRow, fuelFor, modelsAgree, type NhtsaSpecs } from "./nhtsa-specs";
import { isKnownHybridOnly } from "./fuel-type";
import { hasLetterSuffixWording } from "./electrified-models";

const NHTSA_BASE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues";
const NHTSA_TIMEOUT_MS = 3_000;

// 24-hour in-memory cache of raw decode rows by VIN (a VIN's decode never changes). Only successful decodes are cached;
// a failure or timeout is retried on the next search. Per server instance, so it speeds repeat searches and cuts NHTSA load.
const ROW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROW_CACHE_MAX = 3000;
const rowCache = new Map<string, { t: number; r: Record<string, unknown> }>();
function cacheGet(key: string): Record<string, unknown> | null {
  const e = rowCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > ROW_CACHE_TTL_MS) { rowCache.delete(key); return null; }
  return e.r;
}
function cachePut(key: string, r: Record<string, unknown>): void {
  if (rowCache.size >= ROW_CACHE_MAX) { const k = rowCache.keys().next().value; if (k !== undefined) rowCache.delete(k); }
  rowCache.set(key, { t: Date.now(), r });
}
export function resetNhtsaCacheForTests(): void { rowCache.clear(); }

/**
 * One search request's memory that NHTSA is down (ChatGPT review BA22-10, SYS-20261022-056). Once a whole batch of the electrification check got no answer, nothing more is asked of NHTSA
 * in the rest of that request except the 24 h cache, so the drivetrain split and the cards do not repeat the failed round: an outage costs one round, not several. A single VIN that failed
 * while the others answered may still be read again at a later stage (the accepted rule of the 19 Oct review, finding 3: a later read is honoured). The flag lives only as long as the request.
 */
export interface NhtsaRequestLedger { down: boolean }
const ledgerStore = new AsyncLocalStorage<NhtsaRequestLedger>();
export function runWithNhtsaLedger<T>(fn: () => Promise<T>): Promise<T> { return ledgerStore.run({ down: false }, fn); }
function markNhtsaDown(): void { const l = ledgerStore.getStore(); if (l) l.down = true; }

/**
 * Canonical electrification classification, replacing
 * the boolean-only nhtsaIndicatesElectrified() helper. Fixture-backed
 * against real VIN decode fixtures for `hybrid`/`plug_in_hybrid`/
 * `not_electrified` — see tests/nhtsa-classifier.test.ts for the exact
 * corpus. `mild_hybrid`, `electric`, and `ambiguous` are implemented from
 * NHTSA's documented ElectrificationLevel vocabulary but were NOT
 * exercised by that corpus (zero real examples of any of the three
 * turned up); do not treat those three branches as fixture-verified
 * until the still-outstanding regression fixtures land.
 *
 * `unknown` (decode failed/timed out) and `ambiguous` (decode succeeded
 * but the evidence doesn't cleanly resolve) are DELIBERATELY distinct
 * states for debugging/evidence purposes, but are treated identically
 * by any `required`-electrification caller: neither is ever reclassified
 * as gasoline, per the project's "unknown != false" standing principle
 * and Section C of INDEPENDENT_V2_ELECTRIFICATION_FEASIBILITY_AUDIT_20260908.md.
 */
export type ElectrificationState =
  | "hybrid"
  | "plug_in_hybrid"
  | "electric"
  | "mild_hybrid"
  | "not_electrified"
  | "unknown"
  | "ambiguous";

/**
 * Classify raw NHTSA ElectrificationLevel/FuelTypeSecondary evidence into
 * a canonical state. Never infers from the provider's primary-fuel label —
 * NHTSA fields only, per the audit's explicit requirement.
 */
export function classifyElectrification(
  electrificationLevel: string | null,
  fuelTypeSecondary: string | null,
): ElectrificationState {
  const level = (electrificationLevel ?? "").toLowerCase().trim();
  const secondary = (fuelTypeSecondary ?? "").toLowerCase().trim();
  const secondaryIsElectric = secondary.includes("electric");

  if (level === "") {
    // No electrification level reported. If the secondary fuel field
    // nonetheless claims "Electric," that's a contradiction between two
    // NHTSA fields on the same record — don't silently pick a winner,
    // surface it as ambiguous instead (same "surface conflicts, never
    // silently resolve them" pattern as makeConflict/modelConflict below).
    return secondaryIsElectric ? "ambiguous" : "not_electrified";
  }

  if (level.includes("phev") || level.includes("plug-in") || level.includes("plug in")) {
    return "plug_in_hybrid";
  }
  // Broadened after a regression fixture test caught a real classifier bug: the
  // exact phrase "mild hybrid" or literal "mhev" missed a realistic NHTSA
  // variant like "Mild HEV (Hybrid Electric Vehicle)" — "mild" and "hev"
  // appear in the string but not adjacent as "mild hybrid", so the old
  // check fell through to the plain hybrid branch below and silently
  // misclassified a mild hybrid as a full hybrid. Any occurrence of "mild"
  // combined with hybrid-family wording anywhere in the string is treated
  // as mild_hybrid — this is intentionally broad (a false positive here
  // just means a mild hybrid gets treated as mild_hybrid, which is
  // correct; there's no other NHTSA vocabulary "mild" would plausibly
  // appear in that isn't mild-hybrid-related).
  if (level.includes("mild") && (level.includes("hybrid") || level.includes("hev") || level.includes("mhev"))) {
    return "mild_hybrid";
  }
  if (level.includes("bev") || (level.includes("electric") && !level.includes("hybrid"))) {
    return "electric";
  }
  if (level.includes("hev") || level.includes("hybrid")) {
    return "hybrid";
  }
  // Level present but didn't match any known NHTSA vocabulary pattern —
  // genuinely ambiguous, not a bug in the classifier's pattern list. This
  // includes fuel-cell vehicles (NHTSA's "FCV"): out of scope for this
  // project's hybrid/PHEV/electric taxonomy, so FCV correctly falls
  // through to ambiguous rather than silently miscounting as electric
  // — confirmed via ChatGPT review.
  return "ambiguous";
}

export interface NhtsaElectrificationResult {
  /** Drive type, transmission, engine, seats and standard safety tech from the same decode (lib/nhtsa-specs.ts). */
  specs?: NhtsaSpecs;
  /** NHTSA 5-star overall rating for this model year (database mode; attached by lib/nhtsa-ratings.ts). */
  rating?: { overall: 1 | 2 | 3 | 4 | 5 } | null;
  /** NHTSA recall campaigns listed for this model year variant (not specific to one car; attached by lib/nhtsa-ratings.ts). */
  recallCampaigns?: number | null;
  /** Canonical classification derived from the raw
   * fields below. Prefer this over hand-rolling ElectrificationLevel
   * string matching at call sites — see classifyElectrification(). */
  electrificationState: ElectrificationState;
  electrificationLevel: string | null;
  fuelTypePrimary: string | null;
  fuelTypeSecondary: string | null;
  /** Second, stronger identity cross-check (full VIN decode, not just WMI). */
  make: string | null;
  model: string | null;
  modelYear: string | null;
  /** True when NHTSA reports Make disagreeing with what the listing claims. */
  makeConflict: boolean;
  /** True when NHTSA's model string disagrees with what the listing claims
   * (loose/prefix-tolerant compare, same reasoning as post-verify.ts's
   * model matching — cross-API model-family naming varies, e.g. "F250
   * Super Duty" vs "Super Duty F-250"). */
  modelConflict: boolean;
  /** Answers the powertrain.type:"unknown" gap (SYS-20260819 testing,
   * Test 5) — NHTSA's own cylinder/drivetrain read, independent of
   * the provider's field. Cross-checked, not blindly trusted; disagreement is
   * surfaced, never silently overrides the provider's own display value. */
  engineCylinders: string | null;
  driveType: string | null;
  cylindersConflict: boolean;
  /** Parsed from NHTSA's Trim field (2026-09-04, SYS-20260904-004) —
   * always an array, never a bare string, because the field is frequently
   * ambiguous (comma-separated multiple candidates) or absent entirely.
   * Empty array means NHTSA had nothing usable; one entry means an
   * unambiguous decode; multiple entries means NHTSA itself couldn't
   * narrow it down further (e.g. a trim-package name layered on a base
   * trim that shares the same VIN pattern). Never treat this as a single
   * confident answer without checking its length first. */
  trimOptions: string[];
}

/**
 * Decode a VIN against NHTSA's free vPIC API. Returns null on any failure
 * (timeout, network error, malformed VIN) rather than throwing — callers
 * must treat this as "unknown," never as a negative signal, consistent
 * with the project's "unknown != false" standing principle.
 *
 * Runtime-safety fix (fix/provider-string-runtime-safety, SYS-20260828):
 * claimedMake/claimedModel accept `unknown`, not `string | null`. Both
 * call sites (app/[transport]/route.ts) pass a raw VehicleListing
 * vehicle.make/vehicle.model value straight through on EVERY shortlisted
 * result (not an edge case — this runs for every search's full-detail
 * refetch), and a live production crash confirmed the provider can return a
 * non-string value for a sibling field (vehicle.trim, observed as the
 * number 1958) despite its declared string type in the client contract.
 * The old `!!claimedMake` guard only protected against falsy values; a
 * truthy non-string sailed straight into `.trim().toUpperCase()` and
 * would crash the same way. String()-coercing here can only ever produce
 * a literal string comparison that correctly reports a conflict (or
 * doesn't) without throwing — it never invents agreement/disagreement
 * that wasn't really there.
 */
export async function decodeNhtsaElectrification(
  vin: string,
  claimedMakeRaw?: unknown,
  claimedModelRaw?: unknown,
  claimedCylinders?: number | null,
  /** cacheOnly: answer from the 24 h cache or not at all (null), never ask NHTSA. Used for the cards when the batch check has just found NHTSA down (T52). */
  opts?: { cacheOnly?: boolean },
): Promise<NhtsaElectrificationResult | null> {
  const claimedMake = claimedMakeRaw == null ? null : String(claimedMakeRaw);
  const claimedModel = claimedModelRaw == null ? null : String(claimedModelRaw);
  const ledger = ledgerStore.getStore();
  const cacheKey = String(vin).toUpperCase();
  try {
    let r: any = cacheGet(cacheKey);
    const fromCache = r != null;
    if (!r && (opts?.cacheOnly || ledger?.down)) return null;
    if (!r) {
      const res = await fetch(`${NHTSA_BASE_URL}/${encodeURIComponent(vin)}?format=json`, {
        signal: AbortSignal.timeout(NHTSA_TIMEOUT_MS),
      });
      if (!res.ok) return null;

      const data = await res.json();
      r = data?.Results?.[0];
      if (!r) return null;
    }

    // NHTSA returns ErrorCode "0" for a clean decode; anything else (6, 7,
    // 11, 400, etc, comma-separated) means the VIN was incomplete, unknown
    // to NHTSA, or otherwise not reliably decoded — treat as unknown.
    const errorCode = String(r.ErrorCode ?? "");
    if (errorCode !== "0") return null;
    if (!fromCache) cachePut(cacheKey, r);

    const make: string | null = r.Make || null;
    const model: string | null = r.Model || null;
    const engineCylinders: string | null = r.EngineCylinders || null;

    const makeConflict =
      !!claimedMake && !!make && claimedMake.trim().toUpperCase() !== make.trim().toUpperCase();
    // Prefix-tolerant, same reasoning as post-verify.ts/match-score.ts —
    // cross-API model-family naming varies (SYS-20260812-039), exact
    // equality would produce false conflicts on genuinely matching cars.
    const modelConflict = !!claimedModel && !!model && !modelsAgree(claimedModel, model, make);
    const cylindersConflict =
      claimedCylinders != null &&
      engineCylinders != null &&
      Number(engineCylinders) !== claimedCylinders;

    // Trim (SYS-20260904-004): split NHTSA's Trim field on commas, trim
    // whitespace, drop empty segments. Never assume the first segment is
    // "the" answer here — that decision belongs to each caller, which may
    // have different tolerance for ambiguity (see module doc above).
    const trimOptions: string[] = (r.Trim ?? "")
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0);

    const electrificationLevel: string | null = r.ElectrificationLevel || null;
    const fuelTypeSecondary: string | null = r.FuelTypeSecondary || null;

    const electrificationState = classifyElectrification(electrificationLevel, fuelTypeSecondary);
    return {
      electrificationState,
      electrificationLevel,
      fuelTypePrimary: r.FuelTypePrimary || null,
      fuelTypeSecondary,
      make,
      model,
      modelYear: r.ModelYear || null,
      makeConflict,
      modelConflict,
      engineCylinders,
      driveType: r.DriveType || null,
      cylindersConflict,
      trimOptions,
      specs: { ...specsFromRow(r), fuel: fuelFor(electrificationState, r.FuelTypePrimary) },
    };
  } catch {
    // Timeout, network error, or malformed JSON — never let this block or
    // fail a search. The shortlist's existing data stands on its own.
    return null;
  }
}

/**
 * True when NHTSA's electrification data indicates a genuine hybrid,
 * mild hybrid, plug-in hybrid, or battery electric vehicle, regardless of
 * what the provider's own fuel field says.
 *
 * Kept as a thin wrapper over `electrificationState`
 * rather than removed, so any existing call site relying on the old
 * boolean keeps working unchanged. New code should prefer reading
 * `electrificationState` directly — this collapses `mild_hybrid` into
 * "true" the same way the old string-matching version did, which loses
 * the required-vs-preferred distinction the audit calls for (Section D:
 * mild_hybrid satisfies public `hybrid`, never `plug_in_hybrid`).
 */
export function nhtsaIndicatesElectrified(result: NhtsaElectrificationResult | null | undefined): boolean {
  if (!result) return false;
  return (
    result.electrificationState === "hybrid" ||
    result.electrificationState === "mild_hybrid" ||
    result.electrificationState === "plug_in_hybrid" ||
    result.electrificationState === "electric"
  );
}

/**
 * Bounded decode set for electrificationRequirement pre-processing, both "required" (pre-filter) and "preferred" (ranking-only match lookup).
 *
 * The value (24: three batches of 8) comes from measurement, not assumption. From the Claude sandbox on 21 Oct 2026 a parallel burst of 45 decodes had a 90th
 * percentile near 2.2 s against the 3 s call limit, and groups of 8 about 0.27 s (getcarwise-docs EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md sections 14 and 15;
 * DECISIONS.md SYS-20261021-011 and -013). Small samples, one time window, not the Vercel region: revisit if NHTSA's behaviour changes. (Older comments cited a
 * "live spike" behind the earlier value 20; no such record exists and that value is gone.)
 *
 * Moved here from route.ts alongside electrificationStateSatisfies() so both are importable from a test file — Next.js Route Handler files only permit a fixed
 * set of named exports and cannot export arbitrary functions/constants for direct unit testing (confirmed by a real local build failure).
 */
/** Most cars decoded per electrified search: three batches of ELECTRIFICATION_BATCH_SIZE (T52, SYS-20261021-003). Was 45 in one parallel burst. */
export const ELECTRIFICATION_POOL_SIZE = 24;
/** Cars decoded in parallel per batch. Measured 21 Oct from the sandbox: batches of 8 had a 90th percentile of about 0.27 s, a burst of 45 about 2.2 s against the 3 s limit. */
export const ELECTRIFICATION_BATCH_SIZE = 8;

/** Most cars decoded when a required electrification type is combined with a drivetrain request (review T93, 22 Oct): the batches go on until enough cars satisfy BOTH, so the AWD cars behind the cheap FWD ones are reached. Twelve batches, about 3 s when NHTSA answers normally; an unanswered batch still stops the search. */
export const ELECTRIFICATION_COMBINED_POOL_SIZE = 96;

/**
 * Decode `pool` in order, in parallel batches, and stop as soon as `enough` says so, at ELECTRIFICATION_POOL_SIZE cars, or when a whole batch got no answer
 * at all (NHTSA is down or throttling: `down` is true and no further batch is tried, so an outage costs one round of at most the 3 s limit, never more).
 * `results[i]` belongs to `pool[i]` for the decoded prefix; null means no usable answer (timeout, error, undecodable VIN).
 */
export async function decodePoolInBatches<T extends { vin: string; vehicle?: { make?: unknown; model?: unknown; cylinders?: number | null } | null }>(
  pool: T[],
  enough: (results: Array<NhtsaElectrificationResult | null>) => boolean,
  maxCars: number = ELECTRIFICATION_POOL_SIZE,
): Promise<{ results: Array<NhtsaElectrificationResult | null>; down: boolean }> {
  const results: Array<NhtsaElectrificationResult | null> = [];
  const limit = Math.min(pool.length, maxCars);
  for (let off = 0; off < limit; off += ELECTRIFICATION_BATCH_SIZE) {
    const chunk = pool.slice(off, Math.min(off + ELECTRIFICATION_BATCH_SIZE, limit));
    const res = await Promise.all(chunk.map((c) => decodeNhtsaElectrification(c.vin, c.vehicle?.make, c.vehicle?.model, c.vehicle?.cylinders)));
    results.push(...res);
    if (res.every((r) => r == null)) { markNhtsaDown(); return { results, down: true }; }
    if (enough(results)) break;
  }
  return { results, down: false };
}

const ELECTRIFIED_HINT = /\b(hybrid|hev|phev|plug-?in|prime|electric|ev\d*|e-?tron|ioniq|bolt|leaf|volt|prius|niro|mach-?e|id\.?4|taycan|lucid|rivian|polestar|recharge|e-?hybrid|[24]xe|i[3-8x]|ix\d?|model [3sxy])\b/i;

/**
 * For hybrid/EV searches the decode pool is only the first ELECTRIFICATION_POOL_SIZE candidates (decoded in batches, decodePoolInBatches). Put cars whose make, model or
 * trim already hints at electrification first (stable order inside each group), so the bounded pool is spent where hybrids are.
 */
export function prioritizeElectrificationCandidates<T extends { vehicle?: { make?: unknown; model?: unknown; trim?: unknown; year?: unknown } | null }>(cands: T[]): T[] {
  // Wording in the make, model or trim, a letter suffix such as "350h" or "xDrive50e" (R9), or a model year known to be hybrid-only with no wording (the 2026 RAV4;
  // lib/fuel-type.ts, SYS-20261021-004, T58). Wording first, so the bounded pool is spent where electrified cars are.
  const hinted = (c: T) =>
    ELECTRIFIED_HINT.test([c.vehicle?.make, c.vehicle?.model, c.vehicle?.trim].map((x) => (x == null ? "" : String(x))).join(" ")) ||
    hasLetterSuffixWording([c.vehicle?.model, c.vehicle?.trim].map((x) => (x == null ? "" : String(x))).join(" ")) ||
    isKnownHybridOnly(c.vehicle?.year == null ? null : Number(c.vehicle.year), c.vehicle?.make == null ? null : String(c.vehicle.make), c.vehicle?.model == null ? null : String(c.vehicle.model));
  return [...cands.filter(hinted), ...cands.filter((c) => !hinted(c))];
}

/**
 * True when a decoded NHTSA electrification state satisfies one of the
 * caller's requested electrificationTypes. Per
 * André (Sep 9 2026): requesting "hybrid" implicitly satisfies a
 * "mild_hybrid" decode — callers never need to list both, and in fact
 * cannot list "mild_hybrid" directly at all (it was removed from the
 * public electrificationTypes enum in route.ts as a caller-selectable
 * value, SYS-20260909 enum-narrowing fix — it remains purely an internal
 * NHTSA classification outcome). "plug_in_hybrid" and "electric" are never
 * implied by anything else and never imply anything else.
 * "unknown"/"ambiguous"/"not_electrified" never satisfy any requested
 * type — this is the enforcement point for the audit's "unknown != false"
 * rule for a required electrification search. Multiple requested types
 * use OR semantics (any one match is sufficient), never AND.
 */
export function electrificationStateSatisfies(
  state: ElectrificationState | undefined,
  requestedTypes: ElectrificationState[],
): boolean {
  if (!state) return false;
  if (requestedTypes.includes(state)) return true;
  if (state === "mild_hybrid" && requestedTypes.includes("hybrid")) return true;
  return false;
}
