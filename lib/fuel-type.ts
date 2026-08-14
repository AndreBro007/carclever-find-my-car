/**
 * Fuel-type normalization helpers for Auto.dev API values.
 *
 * Auto.dev canonical values (confirmed from documentation):
 *   "Gasoline", "Hybrid", "Plug-In Hybrid", "Electric", "Diesel"
 *
 * Defensive variants (common aliases seen in similar data feeds; not confirmed
 * from Auto.dev docs — will be validated against live API responses post-deploy):
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
 * Normalize a raw fuel_type string from Auto.dev into a canonical lowercase enum value.
 * Returns "unknown" for null, undefined, empty, or unrecognized inputs.
 */
export function normalizeFuelType(rawFuel: string | null | undefined): NormalizedFuelType {
  if (rawFuel == null || String(rawFuel).trim() === "") return "unknown";
  const f = String(rawFuel).trim().toLowerCase();

  // --- Confirmed from Auto.dev documentation ---
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
 * Known hybrid-only model overrides.
 * Applied AFTER Auto.dev returns fuel type; fires only when Auto.dev returns
 * "Gasoline" (or unknown) for a model that is unambiguously hybrid in the
 * given model year.
 *
 * Conservative inclusion rules:
 *   - Only models where EVERY trim sold in that year range is hybrid.
 *   - Do NOT include Camry, Highlander, RAV4, Sienna (non-hybrid base trims
 *     exist or have existed in the same era).
 *   - Do NOT include Sorento Hybrid, Forester Hybrid, Crosstrek Hybrid,
 *     Santa Fe Hybrid, Crown Signia — these share a model line with gas trims.
 *
 * Confirmed hybrid-only:
 *   - Toyota Sequoia: redesigned to hybrid-only in MY2023+
 *   - Toyota Prius: all years (gas-only Prius never sold in US)
 *   - Toyota Crown: all-hybrid since US launch MY2023+
 *   - Toyota Corolla Cross Hybrid: US-market Corolla Cross is hybrid-only MY2023+
 *   - Toyota Grand Highlander Hybrid: US-market Grand Highlander is hybrid-only MY2024+
 *   - Kia Niro: base Niro sold in US is hybrid-only MY2017+
 *   - Honda Insight: all years (2000–2014, 2018–2022; no gas-only US variant)
 *   - Toyota Venza: hybrid-only since US relaunch MY2021+
 *   - Toyota Crown Signia: hybrid-only since US launch MY2024+
 *   - Toyota Land Cruiser: hybrid-only since MY2022+ US relaunch
 *   - Ford F-150 PowerBoost: PowerBoost is the hybrid trim name; gas F-150s use different trim names
 *   - Lexus ES 300h: hybrid-only nameplate (ES 350 is the gas variant)
 *   - Lexus LX 600h: hybrid-only nameplate (LX 600h replaced the V8 LX 570)
 *   - Lexus RX 500h/450h/450h+/350h: hybrid-only nameplates (h suffix)
 *   - Lexus NX 350h/450h+: hybrid-only nameplates (h suffix)
 *   - Lexus UX 250h: hybrid-only
 *   - Lexus LC 500h: hybrid-only
 *   - Lexus LS 500h: hybrid-only
 */
function buildKnownHybridKey(make: string, model: string): string {
  return `${String(make).toLowerCase().trim()}|${String(model).toLowerCase().trim()}`;
}

/**
 * Returns true when the given make/model/year combination is a known
 * hybrid-only vehicle where Auto.dev may incorrectly return "Gasoline".
 * Returns false for any ambiguous model (conservative fail-safe).
 */
export function isKnownHybridOnly(
  year: number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!make || !model) return false;
  const key = buildKnownHybridKey(make, model);

  // Toyota Sequoia: hybrid-only from MY2023
  if (key === buildKnownHybridKey("Toyota", "Sequoia")) {
    return year != null && year >= 2023;
  }
  // Toyota Prius: all years
  if (key === buildKnownHybridKey("Toyota", "Prius")) return true;
  // Toyota Crown: hybrid-only since US launch MY2023
  if (key === buildKnownHybridKey("Toyota", "Crown")) {
    return year != null && year >= 2023;
  }
  // Toyota Corolla Cross Hybrid: US market is hybrid-only from MY2023
  if (key === buildKnownHybridKey("Toyota", "Corolla Cross Hybrid")) {
    return year != null && year >= 2023;
  }
  // Toyota Grand Highlander Hybrid: US market is hybrid-only from MY2024
  if (key === buildKnownHybridKey("Toyota", "Grand Highlander Hybrid")) {
    return year != null && year >= 2024;
  }
  // Kia Niro: US-market base Niro is hybrid-only from MY2017
  if (key === buildKnownHybridKey("Kia", "Niro")) {
    return year != null && year >= 2017;
  }
  // Honda Insight: every US trim is hybrid-only (2000–2014, 2018–2022)
  if (key === buildKnownHybridKey("Honda", "Insight")) return true;
  // Toyota Venza: hybrid-only since US relaunch MY2021
  if (key === buildKnownHybridKey("Toyota", "Venza")) {
    return year != null && year >= 2021;
  }
  // Toyota Crown Signia: hybrid-only since US launch MY2024
  if (key === buildKnownHybridKey("Toyota", "Crown Signia")) {
    return year != null && year >= 2024;
  }
  // Toyota Land Cruiser: hybrid-only since US relaunch MY2022
  if (key === buildKnownHybridKey("Toyota", "Land Cruiser")) {
    return year != null && year >= 2022;
  }
  // Ford F-150 PowerBoost: "PowerBoost" is the hybrid trim family name; gas F-150s don't use it
  if (key === buildKnownHybridKey("Ford", "F-150 PowerBoost")) return true;
  // Lexus hybrid-only nameplates (h-suffix models, ES 300h, and LX 600h)
  const lexusHybridModels = new Set([
    buildKnownHybridKey("Lexus", "ES 300h"),
    buildKnownHybridKey("Lexus", "LX 600h"),
    buildKnownHybridKey("Lexus", "RX 500h"),
    buildKnownHybridKey("Lexus", "RX 450h"),
    buildKnownHybridKey("Lexus", "RX 450h+"),
    buildKnownHybridKey("Lexus", "RX 350h"),
    buildKnownHybridKey("Lexus", "NX 350h"),
    buildKnownHybridKey("Lexus", "NX 450h+"),
    buildKnownHybridKey("Lexus", "UX 250h"),
    buildKnownHybridKey("Lexus", "LC 500h"),
    buildKnownHybridKey("Lexus", "LS 500h"),
  ]);
  if (lexusHybridModels.has(key)) return true;

  return false;
}

/**
 * Apply known-hybrid override: if Auto.dev returned "Gasoline" (or unknown)
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
  // Only override when Auto.dev returned gasoline or unknown for a known hybrid
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
 * (which may be the raw Auto.dev value) so no information is lost.
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
