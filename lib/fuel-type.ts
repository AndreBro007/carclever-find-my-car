/**
 * Fuel-type normalization helpers for provider API values.
 *
 * the provider canonical values (confirmed from documentation):
 *   "Gasoline", "Hybrid", "Plug-In Hybrid", "Electric", "Diesel"
 *
 * Defensive variants (common aliases seen in similar data feeds; not confirmed
 * from provider docs — will be validated against live API responses post-deploy):
 *   EV, BEV, Battery Electric, Plug-in Hybrid, Plug In Hybrid, PHEV,
 *   Hybrid-Electric, Gas, Petrol
 */

export type NormalizedFuelType =
  | "electric"
  | "hybrid"
  | "plug_in_hybrid"
  | "diesel"
  | "gasoline"
  | "unknown";

/**
 * Normalize a raw fuel_type string from the provider into a canonical lowercase enum value.
 * Returns "unknown" for null, undefined, empty, or unrecognized inputs.
 */
export function normalizeFuelType(rawFuel: string | null | undefined): NormalizedFuelType {
  if (rawFuel == null || String(rawFuel).trim() === "") return "unknown";
  const f = String(rawFuel).trim().toLowerCase();

  // --- Confirmed from the provider documentation ---
  if (f === "electric")        return "electric";
  if (f === "hybrid")          return "hybrid";
  if (f === "plug-in hybrid")  return "plug_in_hybrid";
  if (f === "gasoline")        return "gasoline";
  if (f === "diesel")          return "diesel";

  // --- Defensive: common EV aliases ---
  if (f === "ev")              return "electric";
  if (f === "bev")             return "electric";
  if (f === "battery electric") return "electric";

  // --- Defensive: plug-in hybrid aliases ---
  if (f === "plug in hybrid")  return "plug_in_hybrid";
  if (f === "phev")            return "plug_in_hybrid";

  // --- Defensive: hybrid aliases ---
  if (f === "hybrid-electric") return "hybrid";

  // --- Defensive: gasoline aliases ---
  if (f === "gas")             return "gasoline";
  if (f === "petrol")          return "gasoline";

  return "unknown";
}

/**
 * Returns true only when the vehicle is a strict battery-electric vehicle (BEV).
 * Hybrids and plug-in hybrids return false.
 * Unknown fuel type returns false (fail-safe — treats as gas car).
 */
export function isStrictEV(rawFuel: string | null | undefined): boolean {
  return normalizeFuelType(rawFuel) === "electric";
}

/**
 * Known hybrid-only models.
 * Used in two places: (1) the fuel-label override below, which fires only when the provider returns "Gasoline" (or unknown) for a model that is
 * unambiguously hybrid in the given model year; (2) the electrified search (lib/electrified-models.ts, SYS-20261021-004 R4), which lists these cars first
 * for a hybrid request, because the catalogue feed names them with no hybrid wording ("RAV4", "Camry", "Sienna", "Prius"). In both uses the list is a hint:
 * NHTSA still decides whether a car is a hybrid.
 *
 * Conservative inclusion rules:
 *   - Only models where EVERY trim sold in that year range is hybrid, with a first model year (`fromYear`) where gas trims existed before.
 *   - Do NOT include Highlander (gas trims still sold; the feed names the hybrid "Highlander Hybrid").
 *   - Do NOT include Sorento Hybrid, Forester Hybrid, Crosstrek Hybrid, Santa Fe Hybrid, Crown Signia as gas lines — these share a model line with gas trims.
 *
 * Confirmed hybrid-only:
 *   - Toyota Sequoia: redesigned to hybrid-only in MY2023+
 *   - Toyota Prius: all years (gas-only Prius never sold in US)
 *   - Toyota Crown: all-hybrid since US launch MY2023+
 *   - Toyota Corolla Cross Hybrid: US-market Corolla Cross is hybrid-only MY2023+
 *   - Toyota Grand Highlander Hybrid: US-market Grand Highlander is hybrid-only MY2024+
 *   - Kia Niro: base Niro sold in US is hybrid-only MY2017+
 *   - Honda Insight: all years (2000-2014, 2018-2022; no gas-only US variant)
 *   - Toyota Venza: hybrid-only since US relaunch MY2021+
 *   - Toyota Crown Signia: hybrid-only since US launch MY2024+
 *   - Toyota Land Cruiser: hybrid-only since MY2022+ US relaunch
 *   - Ford F-150 PowerBoost: PowerBoost is the hybrid trim name; gas F-150s use different trim names
 *   - Lexus ES 300h, LX 600h, RX 500h/450h/450h+/350h, NX 350h/450h+, UX 250h, LC 500h, LS 500h: hybrid-only nameplates (h suffix). Note: the catalogue
 *     feed names these cars with the plain model ("ES", "RX") and the h in the TRIM ("350h Premium"), so these entries do not match feed data.
 *   - Toyota RAV4: hybrid-only from MY2026 (added 21 Oct 2026)
 *   - Toyota Camry: hybrid-only from MY2025 (added 21 Oct 2026)
 *   - Toyota Sienna: hybrid-only from MY2021 (added 21 Oct 2026)
 *     Evidence for the last three: NHTSA decode of 6 real catalogue VINs per model year, 21 Oct 2026: 2026 RAV4, 2025 and 2026 Camry, 2021, 2023 and 2025
 *     Sienna all hybrid; controls 2025 RAV4 and 2024 Camry all not electrified; 2024 CR-V correctly mixed (see getcarwise-docs
 *     EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md).
 */
export interface KnownHybridOnly {
  make: string;
  model: string;
  /** First model year in which every US trim is hybrid; omitted means all years. */
  fromYear?: number;
}

export const KNOWN_HYBRID_ONLY: readonly KnownHybridOnly[] = [
  { make: "Toyota", model: "Sequoia", fromYear: 2023 },
  { make: "Toyota", model: "Prius" },
  { make: "Toyota", model: "Crown", fromYear: 2023 },
  { make: "Toyota", model: "Corolla Cross Hybrid", fromYear: 2023 },
  { make: "Toyota", model: "Grand Highlander Hybrid", fromYear: 2024 },
  { make: "Kia", model: "Niro", fromYear: 2017 },
  { make: "Honda", model: "Insight" },
  { make: "Toyota", model: "Venza", fromYear: 2021 },
  { make: "Toyota", model: "Crown Signia", fromYear: 2024 },
  { make: "Toyota", model: "Land Cruiser", fromYear: 2022 },
  { make: "Ford", model: "F-150 PowerBoost" },
  { make: "Lexus", model: "ES 300h" },
  { make: "Lexus", model: "LX 600h" },
  { make: "Lexus", model: "RX 500h" },
  { make: "Lexus", model: "RX 450h" },
  { make: "Lexus", model: "RX 450h+" },
  { make: "Lexus", model: "RX 350h" },
  { make: "Lexus", model: "NX 350h" },
  { make: "Lexus", model: "NX 450h+" },
  { make: "Lexus", model: "UX 250h" },
  { make: "Lexus", model: "LC 500h" },
  { make: "Lexus", model: "LS 500h" },
  { make: "Toyota", model: "RAV4", fromYear: 2026 },
  { make: "Toyota", model: "Camry", fromYear: 2025 },
  { make: "Toyota", model: "Sienna", fromYear: 2021 },
];

function buildKnownHybridKey(make: string, model: string): string {
  return `${String(make).toLowerCase().trim()}|${String(model).toLowerCase().trim()}`;
}

/**
 * Returns true when the given make/model/year combination is a known
 * hybrid-only vehicle where the provider may incorrectly return "Gasoline".
 * Returns false for any ambiguous model (conservative fail-safe).
 */
export function isKnownHybridOnly(
  year: number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!make || !model) return false;
  const key = buildKnownHybridKey(make, model);
  const hit = KNOWN_HYBRID_ONLY.find((e) => buildKnownHybridKey(e.make, e.model) === key);
  if (!hit) return false;
  if (hit.fromYear == null) return true;
  return year != null && year >= hit.fromYear;
}

/**
 * Apply known-hybrid override: if the provider returned "Gasoline" (or unknown)
 * for a confirmed hybrid-only model, force the normalized type to "hybrid".
 * Override is logged when the DEBUG env var is set to "true".
 * isStrictEV is unaffected — this function targets hybrid only.
 */
export function applyKnownHybridOverride(
  year: number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined,
  rawFuel: string | null | undefined,
): NormalizedFuelType {
  const normalized = normalizeFuelType(rawFuel);
  // Only override when the provider returned gasoline or unknown for a known hybrid
  if (normalized !== "gasoline" && normalized !== "unknown") return normalized;
  if (isKnownHybridOnly(year, make, model)) {
    if (process.env.DEBUG === "true") {
      console.log(
        `[CarClever] Known-hybrid override: ${year} ${make} ${model} ` +
        `rawFuel="${rawFuel}" ? "hybrid"`,
      );
    }
    return "hybrid";
  }
  return normalized;
}

/**
 * Map a NormalizedFuelType enum value to the display string shown in the UI.
 * When the normalized result is "unknown", returns the original fallback string
 * (which may be the raw provider value) so no information is lost.
 */
export function formatFuelTypeForDisplay(
  normalized: NormalizedFuelType,
  fallback?: string | null,
): string | undefined {
  if (normalized === "hybrid")        return "Hybrid";
  if (normalized === "plug_in_hybrid") return "Plug-In Hybrid";
  if (normalized === "electric")      return "Electric";
  if (normalized === "diesel")        return "Diesel";
  if (normalized === "gasoline")      return "Gasoline";
  // "unknown" — return raw fallback so existing data isn't silently dropped
  return fallback ?? undefined;
}
