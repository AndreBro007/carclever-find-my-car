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
 * DriveType/PlantCountry/etc — no current use for them, same
 * don't-collect-fields-without-a-use discipline as baseInvoice/baseMsrp.
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
}

/**
 * Decode a VIN against NHTSA's free vPIC API. Returns null on any failure
 * (timeout, network error, malformed VIN) rather than throwing — callers
 * must treat this as "unknown," never as a negative signal, consistent
 * with the project's "unknown != false" standing principle.
 */
export async function decodeNhtsaElectrification(
  vin: string,
  claimedMake?: string | null,
): Promise<NhtsaElectrificationResult | null> {
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
    const makeConflict =
      !!claimedMake && !!make && claimedMake.trim().toUpperCase() !== make.trim().toUpperCase();

    return {
      electrificationLevel: r.ElectrificationLevel || null,
      fuelTypePrimary: r.FuelTypePrimary || null,
      fuelTypeSecondary: r.FuelTypeSecondary || null,
      make,
      model: r.Model || null,
      modelYear: r.ModelYear || null,
      makeConflict,
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
export function nhtsaIndicatesElectrified(result: NhtsaElectrificationResult | null): boolean {
  if (!result) return false;
  const level = (result.electrificationLevel ?? "").toLowerCase();
  return level.includes("hev") || level.includes("phev") || level.includes("hybrid") || level.includes("electric");
}
