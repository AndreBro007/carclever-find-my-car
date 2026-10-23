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

export interface NhtsaElectrificationResult {
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

    return {
      electrificationLevel: r.ElectrificationLevel || null,
      fuelTypePrimary: r.FuelTypePrimary || null,
      fuelTypeSecondary: r.FuelTypeSecondary || null,
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
 * True when NHTSA's electrification data indicates a genuine hybrid or
 * plug-in hybrid, regardless of what Auto.dev's own fuel field says.
 */
export function nhtsaIndicatesElectrified(result: NhtsaElectrificationResult | null | undefined): boolean {
  if (!result) return false;
  const level = (result.electrificationLevel ?? "").toLowerCase();
  return level.includes("hev") || level.includes("phev") || level.includes("hybrid") || level.includes("electric");
}
