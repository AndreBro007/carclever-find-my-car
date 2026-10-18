/**
 * Vehicle-class safety net for the Edmunds catalogue source.
 *
 * The tool's own instructions tell the calling LLM to turn a class such as "large family SUV" or "midsize SUV" into real
 * model names before calling (find-matching-vehicle-input.ts). The AI sometimes sends only bodyType "SUV" plus the
 * wording and NO model list; the catalogue (which has no seat count, no size class, and an inconsistent Category
 * vocabulary) then returns every SUV, small ones included. When - and only when - no model was supplied, expand the
 * class here. The lists are an approximation from general market knowledge, not feed data, and the reply says so.
 */

export type ClassHint = "large_suv_3row" | "subcompact_suv" | "compact_suv" | "midsize_suv";

// [make, model]. Mainstream-first order: the cap keeps the most plausible models for ordinary budgets.
const LARGE_3ROW_SUV: Array<[string, string]> = [
  ["Chevrolet", "Tahoe"], ["Chevrolet", "Suburban"], ["GMC", "Yukon"], ["GMC", "Yukon XL"], ["Ford", "Expedition"], ["Ford", "Expedition MAX"],
  ["Toyota", "Sequoia"], ["Nissan", "Armada"], ["Kia", "Telluride"], ["Hyundai", "Palisade"], ["Honda", "Pilot"], ["Toyota", "Highlander"],
  ["Toyota", "Grand Highlander"], ["Volkswagen", "Atlas"], ["Chevrolet", "Traverse"], ["GMC", "Acadia"], ["Buick", "Enclave"], ["Dodge", "Durango"],
  ["Ford", "Explorer"], ["Nissan", "Pathfinder"], ["Subaru", "Ascent"], ["Mazda", "CX-90"], ["Mazda", "CX-9"], ["Kia", "Sorento"],
  ["Jeep", "Wagoneer"], ["Jeep", "Grand Wagoneer"], ["Lincoln", "Navigator"], ["Cadillac", "Escalade"], ["Cadillac", "Escalade ESV"], ["Toyota", "Land Cruiser"],
  ["Infiniti", "QX80"], ["Infiniti", "QX60"], ["Acura", "MDX"], ["Volvo", "XC90"], ["Lincoln", "Aviator"], ["Mercedes-Benz", "GLS"],
  ["BMW", "X7"], ["Jeep", "Grand Cherokee L"], ["Lexus", "TX"], ["Lexus", "GX"], ["Lexus", "LX"], ["Land Rover", "Defender"], ["Rivian", "R1S"],
  ["Kia", "EV9"], ["Audi", "Q7"], ["Genesis", "GV80"],
];
const LUXURY_FIRST_FROM = 24; // index where the luxury block starts

const SUBCOMPACT_SUV: Array<[string, string]> = [
  ["Chevrolet", "Trax"], ["Chevrolet", "Trailblazer"], ["Buick", "Encore"], ["Buick", "Encore GX"], ["Buick", "Envista"], ["Nissan", "Kicks"], ["Nissan", "Juke"],
  ["Hyundai", "Kona"], ["Hyundai", "Venue"], ["Kia", "Seltos"], ["Kia", "Niro"], ["Mazda", "CX-3"], ["Mazda", "CX-30"], ["Honda", "HR-V"], ["Toyota", "C-HR"],
  ["Toyota", "Corolla Cross"], ["Subaru", "Crosstrek"], ["Mitsubishi", "Outlander Sport"], ["Mitsubishi", "Eclipse Cross"], ["Jeep", "Renegade"], ["Fiat", "500X"],
  ["Ford", "EcoSport"], ["Volkswagen", "Taos"], ["Volvo", "XC40"], ["Audi", "Q3"], ["BMW", "X1"], ["Mercedes-Benz", "GLA"], ["Lexus", "UX"], ["Mini", "Countryman"],
];
const COMPACT_SUV: Array<[string, string]> = [
  ["Toyota", "RAV4"], ["Honda", "CR-V"], ["Nissan", "Rogue"], ["Nissan", "Rogue Sport"], ["Ford", "Escape"], ["Ford", "Bronco Sport"], ["Chevrolet", "Equinox"],
  ["GMC", "Terrain"], ["Mazda", "CX-5"], ["Mazda", "CX-50"], ["Subaru", "Forester"], ["Hyundai", "Tucson"], ["Kia", "Sportage"], ["Jeep", "Compass"],
  ["Jeep", "Cherokee"], ["Volkswagen", "Tiguan"], ["Mitsubishi", "Outlander"], ["Ford", "Mustang Mach-E"], ["Hyundai", "Ioniq 5"], ["Kia", "EV6"], ["Tesla", "Model Y"],
  ["Volkswagen", "ID.4"], ["Buick", "Envision"], ["Lexus", "NX"], ["Acura", "RDX"], ["BMW", "X3"], ["Audi", "Q5"], ["Mercedes-Benz", "GLC"], ["Volvo", "XC60"],
  ["Lincoln", "Corsair"], ["Cadillac", "XT4"], ["Genesis", "GV70"], ["Alfa Romeo", "Stelvio"], ["Jaguar", "F-Pace"], ["Porsche", "Macan"],
  ["Land Rover", "Discovery Sport"], ["Land Rover", "Range Rover Evoque"], ["Infiniti", "QX50"],
];
const MIDSIZE_SUV: Array<[string, string]> = [
  ["Toyota", "Highlander"], ["Toyota", "4Runner"], ["Toyota", "Venza"], ["Honda", "Pilot"], ["Honda", "Passport"], ["Ford", "Edge"], ["Ford", "Explorer"], ["Ford", "Bronco"],
  ["Chevrolet", "Blazer"], ["Chevrolet", "Traverse"], ["GMC", "Acadia"], ["Nissan", "Murano"], ["Nissan", "Pathfinder"], ["Hyundai", "Santa Fe"], ["Hyundai", "Palisade"],
  ["Kia", "Sorento"], ["Kia", "Telluride"], ["Subaru", "Ascent"], ["Mazda", "CX-9"], ["Mazda", "CX-90"], ["Jeep", "Grand Cherokee"], ["Jeep", "Wrangler"], ["Dodge", "Durango"],
  ["Volkswagen", "Atlas"], ["Volkswagen", "Atlas Cross Sport"], ["Buick", "Enclave"], ["Lexus", "RX"], ["Acura", "MDX"], ["BMW", "X5"], ["Audi", "Q7"], ["Mercedes-Benz", "GLE"],
  ["Volvo", "XC90"], ["Lincoln", "Nautilus"], ["Lincoln", "Aviator"], ["Cadillac", "XT5"], ["Cadillac", "XT6"], ["Infiniti", "QX60"], ["Genesis", "GV80"],
  ["Land Rover", "Discovery"], ["Land Rover", "Range Rover Sport"], ["Tesla", "Model X"], ["Rivian", "R1S"],
];
const CLASS_LABEL: Record<ClassHint, string> = { large_suv_3row: "large three-row SUV", subcompact_suv: "subcompact SUV", compact_suv: "compact SUV", midsize_suv: "midsize SUV" };
const MAX_CLASS_MODELS = 60; // the database handles a long model list at no cost

const TEXT = (v: unknown): string => (typeof v === "string" ? v : "");
type ClassInput = { model?: string; bodyType?: string; vehicleType?: string; vehicleNeeds?: string[]; seatsMinPreference?: number };
const textOf = (input: ClassInput): string => [input.bodyType, input.vehicleType, ...(input.vehicleNeeds ?? [])].map(TEXT).join(" | ").toLowerCase();

/** The class a request describes (SUV size classes) when it gave no model of its own. */
export function inferClassHint(input: ClassInput): ClassHint | undefined {
  if (input.model && input.model.trim()) return undefined; // the caller resolved the class itself: respect it
  const text = textOf(input);
  if (!/\b(suv|sport utility|crossover)\b/.test(text)) return undefined;
  const large = /\b(large|full[- ]?size|big|three[- ]?row|3[- ]?row|third[- ]?row|7[- ]?(seat|passenger)|8[- ]?(seat|passenger))/.test(text) || (input.seatsMinPreference ?? 0) >= 7;
  if (large) return "large_suv_3row";
  if (/\b(sub[- ]?compact|mini)\b/.test(text)) return "subcompact_suv";
  if (/\b(mid[- ]?size|medium|mid)\b/.test(text)) return "midsize_suv";
  if (/\b(compact|small)\b/.test(text)) return "compact_suv";
  return undefined;
}

const LISTS: Record<ClassHint, Array<[string, string]>> = { large_suv_3row: LARGE_3ROW_SUV, subcompact_suv: SUBCOMPACT_SUV, compact_suv: COMPACT_SUV, midsize_suv: MIDSIZE_SUV };

/** Model names for a class hint, optionally restricted to the requested make(s); order depends on the budget. */
export function classModels(hint: ClassHint, opts: { make?: string; priceMax?: number; priceMin?: number } = {}): string[] {
  const list = LISTS[hint];
  if (!list) return [];
  const makes = (opts.make ?? "").split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  const rows = list.filter(([mk]) => makes.length === 0 || makes.includes(mk.toLowerCase()));
  const luxuryBudget = (opts.priceMax != null && opts.priceMax > 70_000) || (opts.priceMin != null && opts.priceMin >= 50_000);
  const ordered = hint === "large_suv_3row" && luxuryBudget && makes.length === 0 ? [...list.slice(LUXURY_FIRST_FROM), ...list.slice(0, LUXURY_FIRST_FROM)].filter((r) => rows.includes(r)) : rows;
  return [...new Set(ordered.slice(0, MAX_CLASS_MODELS).map(([, m]) => m))];
}

/**
 * A plain note about size wording. With a class list: says the size was matched against a list of models (general market
 * knowledge), because the catalogue has no size field. Without one (a size word on another body style, or an unlisted
 * size): says the size could not be applied. "" when no size wording was used or a model was named.
 */
export function classSizeNote(input: ClassInput): string {
  if (input.model && input.model.trim()) return "";
  const hint = inferClassHint(input);
  if (hint) return `"${CLASS_LABEL[hint]}" was matched against a list of models from general market knowledge, because the catalogue has no size field; check the class of any result you like.`;
  const text = textOf(input);
  const size = text.match(/\b(sub[- ]?compact|compact|mid[- ]?size|medium|full[- ]?size|large|small|big)\b/);
  if (!size) return "";
  return `The catalogue has no size field, so "${size[1]}" could not be applied: the results are all sizes of the requested body style (closest class match only).`;
}
