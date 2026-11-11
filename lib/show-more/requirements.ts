/**
 * R4-6 step 3 (11 Nov 2026): the search requirements that are stored with a list, reduced to VALIDATED values only (design section 3).
 * If any criterion cannot be reduced (an unmapped colour, an odd character in a name, an unknown drivetrain word), buildRequirements returns null:
 * NO row is written, the search answers exactly as today, and no hint is sent. Raw host text is never stored; no ZIP, radius, distance or caller data ever appears here.
 */
export const COLOUR_KEYS = ["gray", "grey", "silver", "white", "black", "blue", "red", "green", "brown", "orange", "yellow", "gold", "burgundy", "beige", "tan"] as const;
/** A word from the fixed colour table, kept as the buyer typed it (letters only): the card's "filtered on exterior color = Silver" line repeats it, so changing its case would change the text. */
export type ColourKey = string;
export const DRIVETRAINS = ["AWD", "4WD", "FWD", "RWD"] as const;
export type Drivetrain = (typeof DRIVETRAINS)[number];
export const ELECTRIFICATION = ["hybrid", "plug_in_hybrid", "electric"] as const;
export type Electrification = (typeof ELECTRIFICATION)[number];

export interface Requirements {
  make?: string;
  models?: string[];
  trimRequired?: string[];
  priceMin?: number; priceMax?: number; yearMin?: number; yearMax?: number; mileageMax?: number;
  bodyType?: string;
  condition?: "new" | "used";
  drivetrain?: Drivetrain[];
  electrificationTypes?: Electrification[];
  electrificationRequirement?: "required" | "preferred";
  cpo?: boolean; noAccidents?: boolean; oneOwner?: boolean;
  doors?: number;
  exteriorColors?: ColourKey[]; interiorColors?: ColourKey[];
  /** Fixed codes for the widening already applied at the first search (never the numbers). */
  relaxations?: string[];
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .\-\/+&']{0,39}$/;
const SAFE_CODE = /^[a-z_]{1,24}$/;
const int = (v: unknown, lo: number, hi: number): number | undefined | "bad" => {
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return "bad";
  return Math.min(hi, Math.max(lo, Math.round(v)));
};
const names = (v: unknown, max: number): string[] | undefined | "bad" => {
  if (v == null || v === "") return undefined;
  const parts = (Array.isArray(v) ? v.map(String) : String(v).split(",")).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length > max || parts.some((p) => !SAFE_NAME.test(p))) return "bad";
  return parts;
};
export function colourKeys(text: unknown): ColourKey[] | undefined | "bad" {
  if (text == null || text === "") return undefined;
  const words = String(text).split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words.length > 3) return "bad";
  const out: ColourKey[] = [];
  for (const w of words) {
    if (!(COLOUR_KEYS as readonly string[]).includes(w.toLowerCase())) return "bad"; // any word outside the table: the whole search is not expandable
    if (!out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w);
  }
  return out;
}

export interface RequirementsSource {
  make?: unknown; model?: unknown; trimRequired?: unknown; priceMin?: unknown; priceMax?: unknown; yearMin?: unknown; yearMax?: unknown; mileageMax?: unknown;
  bodyType?: unknown; condition?: unknown; drivetrain?: unknown; electrificationTypes?: unknown; electrificationRequirement?: unknown;
  cpo?: unknown; noAccidents?: unknown; oneOwner?: unknown; doors?: unknown; exteriorColor?: unknown; interiorColor?: unknown; relaxations?: unknown;
}

export function buildRequirements(src: RequirementsSource): Requirements | null {
  const r: Requirements = {};
  if (src.make != null && src.make !== "") { const m = names(src.make, 1); if (m === "bad") return null; if (m) r.make = m[0]; }
  const models = names(src.model, 8); if (models === "bad") return null; if (models) r.models = models;
  const trims = names(src.trimRequired, 8); if (trims === "bad") return null; if (trims) r.trimRequired = trims;
  for (const [k, lo, hi] of [["priceMin", 0, 10_000_000], ["priceMax", 0, 10_000_000], ["yearMin", 1980, 2100], ["yearMax", 1980, 2100], ["mileageMax", 0, 2_000_000]] as const) {
    const v = int((src as Record<string, unknown>)[k], lo, hi); if (v === "bad") return null; if (v !== undefined) (r as Record<string, unknown>)[k] = v;
  }
  if (src.bodyType != null && src.bodyType !== "") { const b = names(src.bodyType, 1); if (b === "bad") return null; if (b) r.bodyType = b[0]; }
  if (src.condition != null) { if (src.condition !== "new" && src.condition !== "used") return null; r.condition = src.condition; }
  if (src.drivetrain != null && src.drivetrain !== "") {
    const words = String(src.drivetrain).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const out: Drivetrain[] = [];
    for (const w of words) { if (!(DRIVETRAINS as readonly string[]).includes(w)) return null; if (!out.includes(w as Drivetrain)) out.push(w as Drivetrain); }
    if (out.length) r.drivetrain = out;
  }
  if (src.electrificationTypes != null) {
    if (!Array.isArray(src.electrificationTypes)) return null;
    const out: Electrification[] = [];
    for (const t of src.electrificationTypes) { if (!(ELECTRIFICATION as readonly string[]).includes(String(t))) return null; if (!out.includes(t as Electrification)) out.push(t as Electrification); }
    if (out.length) r.electrificationTypes = out;
  }
  if (src.electrificationRequirement != null) { if (src.electrificationRequirement !== "required" && src.electrificationRequirement !== "preferred") return null; r.electrificationRequirement = src.electrificationRequirement; }
  for (const k of ["cpo", "noAccidents", "oneOwner"] as const) { const v = src[k]; if (v == null) continue; if (typeof v !== "boolean") return null; r[k] = v; }
  const doors = int(src.doors, 1, 8); if (doors === "bad") return null; if (doors !== undefined) r.doors = doors;
  const ex = colourKeys(src.exteriorColor); if (ex === "bad") return null; if (ex) r.exteriorColors = ex;
  const inn = colourKeys(src.interiorColor); if (inn === "bad") return null; if (inn) r.interiorColors = inn;
  if (src.relaxations != null) {
    if (!Array.isArray(src.relaxations) || src.relaxations.length > 8 || src.relaxations.some((x) => typeof x !== "string" || !SAFE_CODE.test(x))) return null;
    if (src.relaxations.length) r.relaxations = [...new Set(src.relaxations as string[])];
  }
  return r;
}

/** Fields that must never be stored; used by tests and by the store as a last guard. */
export const FORBIDDEN_KEYS = ["zip", "radius", "radiusMiles", "state", "distance", "userAgent", "ip", "caller", "host", "conversation", "account", "vehicleNeeds", "goal"] as const;
export function hasForbiddenKey(o: unknown): boolean {
  if (o == null || typeof o !== "object") return false;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) { if ((FORBIDDEN_KEYS as readonly string[]).includes(k) || hasForbiddenKey(v)) return true; }
  return false;
}
