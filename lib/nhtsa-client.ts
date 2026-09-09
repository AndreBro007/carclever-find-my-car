/**
 * NHTSA vPIC client — free, no-key, government VIN decode.
 *
 * Purpose (SYS-20260819-002): Auto.dev's `vehicle.fuel` field only ever
 * carries primary fuel type ("Gasoline" for every hybrid, since that's
 * technically correct — hybrids do have a gasoline engine). There is no
 * secondary/electrification field anywhere in Auto.dev's schema, confirmed
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
 * Auto.dev trim, takes the first candidate when ambiguous — picking one
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

const NHTSA_BASE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues";
const NHTSA_TIMEOUT_MS = 3_000;

/**
 * Canonical electrification classification (SYS-20260909-003), replacing
 * the boolean-only nhtsaIndicatesElectrified() helper. Fixture-backed
 * against 39 real VIN decodes for `hybrid`/`plug_in_hybrid`/
 * `not_electrified` — see DECISIONS.md SYS-20260909-003 for the exact
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
 * a canonical state. Never infers from Auto.dev's primary-fuel label —
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
  // Broadened SYS-20260909-008 (found via regression fixture test): the
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
  // — confirmed via ChatGPT review, addendum to SYS-20260909-003.
  return "ambiguous";
}

export interface NhtsaElectrificationResult {
  /** Canonical classification (SYS-20260909-003) derived from the raw
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
   * Auto.dev's field. Cross-checked, not blindly trusted; disagreement is
   * surfaced, never silently overrides Auto.dev's own display value. */
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
 * call sites (app/[transport]/route.ts) pass a raw AutoDevListing
 * vehicle.make/vehicle.model value straight through on EVERY shortlisted
 * result (not an edge case — this runs for every search's full-detail
 * refetch), and a live production crash confirmed Auto.dev can return a
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
): Promise<NhtsaElectrificationResult | null> {
  const claimedMake = claimedMakeRaw == null ? null : String(claimedMakeRaw);
  const claimedModel = claimedModelRaw == null ? null : String(claimedModelRaw);
  try {
    const res = await fetch(`${NHTSA_BASE_URL}/${encodeURIComponent(vin)}?format=json`, {
      signal: AbortSignal.timeout(NHTSA_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const r = data?.Results?.[0];
    if (!r) return null;

    // NHTSA returns ErrorCode "0" for a clean decode; anything else (6, 7,
    // 11, 400, etc, comma-separated) means the VIN was incomplete, unknown
    // to NHTSA, or otherwise not reliably decoded — treat as unknown.
    const errorCode = String(r.ErrorCode ?? "");
    if (errorCode !== "0") return null;

    const make: string | null = r.Make || null;
    const model: string | null = r.Model || null;
    const engineCylinders: string | null = r.EngineCylinders || null;

    const makeConflict =
      !!claimedMake && !!make && claimedMake.trim().toUpperCase() !== make.trim().toUpperCase();
    // Prefix-tolerant, same reasoning as post-verify.ts/match-score.ts —
    // cross-API model-family naming varies (SYS-20260812-039), exact
    // equality would produce false conflicts on genuinely matching cars.
    const modelConflict =
      !!claimedModel &&
      !!model &&
      !model.trim().toUpperCase().startsWith(claimedModel.trim().toUpperCase()) &&
      !claimedModel.trim().toUpperCase().startsWith(model.trim().toUpperCase());
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

    return {
      electrificationState: classifyElectrification(electrificationLevel, fuelTypeSecondary),
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
 * what Auto.dev's own fuel field says.
 *
 * Kept as a thin wrapper over `electrificationState` (SYS-20260909-003)
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
