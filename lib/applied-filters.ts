/**
 * The "Searched:" line at the top of every find_matching_vehicle reply (SYS-20261021-036, proposal G).
 * It states what the search really used, from the call as repaired, so the AI can compare it with what the buyer asked for and search again when they differ:
 * a real run sent condition "either" for a buyer who said "new", added values nobody stated (strict, a radius) and left a stated one out. Only fields that were set appear;
 * the defaults that apply (the 50-mile radius) are named. When the condition is either, one sentence tells the AI how to correct it.
 */
export interface AppliedFilters {
  used?: boolean;
  make?: string; model?: string; bodyType?: string; vehicleType?: string;
  priceMin?: number; priceMax?: number; priceFlexibility?: string;
  yearMin?: number; yearMax?: number; mileageMax?: number;
  drivetrain?: string; trimRequired?: unknown; trimPreference?: unknown; exteriorColor?: string; interiorColor?: string; doors?: number; seatsMinPreference?: number;
  electrificationTypes?: string[]; electrificationRequirement?: string;
  zip?: string; zipUsable?: boolean; radiusMiles?: number; state?: string;
  priorityAxis?: string;
}

const money = (n: number): string => `$${n.toLocaleString("en-US")}`;
const text = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" ? v.trim() : "");
const TYPE_WORDS: Record<string, string> = { hybrid: "hybrid", plug_in_hybrid: "plug-in hybrid", electric: "electric" };
const AXIS_WORDS: Record<string, string> = { best_for_budget: "best for budget", cheapest: "cheapest", lowest_mileage: "lowest mileage", newest: "newest", lower_risk: "lower risk" };

export function appliedFiltersLine(f: AppliedFilters): string {
  const parts: string[] = [];
  parts.push(f.used === false ? "new cars" : f.used === true ? "used cars" : "new and used (condition: either)");
  const make = text(f.make), model = text(f.model);
  if (make && model) parts.push(`${make}, models ${model}`); else if (make) parts.push(`make ${make}`); else if (model) parts.push(`models ${model}`);
  if (text(f.bodyType)) parts.push(`body style ${text(f.bodyType)}`);
  if (text(f.vehicleType)) parts.push(`vehicle type ${text(f.vehicleType)}`);
  const types = (f.electrificationTypes ?? []).map((t) => TYPE_WORDS[t] ?? t);
  if (types.length) parts.push(`${types.join(" or ")} ${f.electrificationRequirement === "preferred" ? "preferred" : "required"}`);
  const flex = f.priceFlexibility ? ` (${f.priceFlexibility})` : "";
  if (f.priceMin != null && f.priceMax != null) parts.push(`${money(f.priceMin)} to ${money(f.priceMax)}${flex}`);
  else if (f.priceMax != null) parts.push(`up to ${money(f.priceMax)}${flex}`);
  else if (f.priceMin != null) parts.push(`from ${money(f.priceMin)}${flex}`);
  if (f.yearMin != null && f.yearMax != null) parts.push(`model years ${f.yearMin} to ${f.yearMax}`);
  else if (f.yearMin != null) parts.push(`model year ${f.yearMin} or newer`);
  else if (f.yearMax != null) parts.push(`model year ${f.yearMax} or older`);
  if (f.mileageMax != null) parts.push(`up to ${f.mileageMax.toLocaleString("en-US")} miles`);
  if (text(f.drivetrain)) parts.push(`drivetrain ${text(f.drivetrain)}`);
  if (text(f.trimRequired)) parts.push(`trim ${text(f.trimRequired)} (required)`);
  if (text(f.trimPreference)) parts.push(`trim ${text(f.trimPreference)} (preferred)`);
  if (text(f.exteriorColor)) parts.push(`exterior ${text(f.exteriorColor)}`);
  if (text(f.interiorColor)) parts.push(`interior ${text(f.interiorColor)}`);
  if (f.doors != null) parts.push(`${f.doors} doors`);
  if (f.seatsMinPreference != null) parts.push(`at least ${f.seatsMinPreference} seats (preferred)`);
  if (f.zip && f.zipUsable !== false) parts.push(`within ${f.radiusMiles ?? 50} miles of ZIP ${f.zip}`);
  else if (text(f.state)) parts.push(`state ${text(f.state).toUpperCase()}`);
  else parts.push("nationwide");
  if (f.priorityAxis && AXIS_WORDS[f.priorityAxis]) parts.push(`ranked ${AXIS_WORDS[f.priorityAxis]}`);
  const hint = f.used === undefined ? " If the buyer asked for new or used only, search again with condition set to new or used." : "";
  return `Searched: ${parts.join("; ")}.${hint}`;
}
