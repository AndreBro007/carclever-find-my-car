/**
 * Vehicle-class safety net for the Edmunds catalogue source (spike/edmunds-catalog-mode).
 *
 * The tool's own instructions tell the calling LLM to turn a class such as "large family SUV" into real
 * model names before calling (find-matching-vehicle-input.ts). ChatGPT sometimes sends only
 * bodyType "SUV" + vehicleNeeds ("large SUV", "three rows") + seatsMinPreference 7 and NO model list; the
 * catalogue (which has no seat count, no size class, and an inconsistent Category vocabulary) then returns
 * every SUV, small ones included. When - and only when - no model was supplied, expand that class here.
 * This is an approximation from general market knowledge, not feed data.
 */

export type ClassHint = "large_suv_3row";

// [make, model]. Mainstream-first order: the cap keeps the most plausible models for ordinary budgets.
const LARGE_3ROW_SUV: Array<[string, string]> = [
  ["Chevrolet", "Tahoe"], ["Chevrolet", "Suburban"], ["GMC", "Yukon"], ["GMC", "Yukon XL"], ["Ford", "Expedition"], ["Ford", "Expedition MAX"],
  ["Toyota", "Sequoia"], ["Nissan", "Armada"], ["Kia", "Telluride"], ["Hyundai", "Palisade"], ["Honda", "Pilot"], ["Toyota", "Highlander"],
  ["Toyota", "Grand Highlander"], ["Volkswagen", "Atlas"], ["Chevrolet", "Traverse"], ["GMC", "Acadia"], ["Buick", "Enclave"], ["Dodge", "Durango"],
  ["Ford", "Explorer"], ["Nissan", "Pathfinder"], ["Subaru", "Ascent"], ["Mazda", "CX-90"], ["Mazda", "CX-9"], ["Kia", "Sorento"],
  ["Jeep", "Wagoneer"], ["Jeep", "Grand Wagoneer"], ["Lincoln", "Navigator"], ["Cadillac", "Escalade"], ["Cadillac", "Escalade ESV"], ["Toyota", "Land Cruiser"],
  ["Infiniti", "QX80"], ["Infiniti", "QX60"], ["Acura", "MDX"], ["Volvo", "XC90"], ["Lincoln", "Aviator"], ["Mercedes-Benz", "GLS"],
  ["BMW", "X7"], ["Jeep", "Grand Cherokee L"], ["Lexus", "TX"], ["Lexus", "GX"], ["Lexus", "LX"], ["Land Rover", "Defender"], ["Rivian", "R1S"],
];
const LUXURY_FIRST_FROM = 24; // index where the luxury block starts
const MAX_CLASS_MODELS = 24;

const TEXT = (v: unknown): string => (typeof v === "string" ? v : "");

/** True when the request describes a large / three-row SUV and gave no model of its own. */
export function inferClassHint(input: {
  model?: string; bodyType?: string; vehicleType?: string; vehicleNeeds?: string[]; seatsMinPreference?: number;
}): ClassHint | undefined {
  if (input.model && input.model.trim()) return undefined; // the caller resolved the class itself: respect it
  const text = [input.bodyType, input.vehicleType, ...(input.vehicleNeeds ?? [])].map(TEXT).join(" | ").toLowerCase();
  const isSuv = /\b(suv|sport utility|crossover)\b/.test(text);
  const large = /\b(large|full[- ]?size|big|three[- ]?row|3[- ]?row|third[- ]?row|7[- ]?(seat|passenger)|8[- ]?(seat|passenger))/.test(text) || (input.seatsMinPreference ?? 0) >= 7;
  return isSuv && large ? "large_suv_3row" : undefined;
}

/** Model names for a class hint, optionally restricted to the requested make(s); order depends on the budget. */
export function classModels(hint: ClassHint, opts: { make?: string; priceMax?: number; priceMin?: number } = {}): string[] {
  if (hint !== "large_suv_3row") return [];
  const makes = (opts.make ?? "").split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  const rows = LARGE_3ROW_SUV.filter(([mk]) => makes.length === 0 || makes.includes(mk.toLowerCase()));
  const luxuryBudget = (opts.priceMax != null && opts.priceMax > 70_000) || (opts.priceMin != null && opts.priceMin >= 50_000);
  const ordered = luxuryBudget && makes.length === 0 ? [...LARGE_3ROW_SUV.slice(LUXURY_FIRST_FROM), ...LARGE_3ROW_SUV.slice(0, LUXURY_FIRST_FROM)].filter((r) => rows.includes(r)) : rows;
  return ordered.slice(0, MAX_CLASS_MODELS).map(([, m]) => m);
}
