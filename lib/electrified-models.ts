/**
 * Electrification wording in the catalogue feed (SYS-20261021-004, R3 and R4).
 *
 * The feed names electrified cars inconsistently (evidence: getcarwise-docs EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md): sometimes in the model
 * ("RAV4 Hybrid", "RAV4 Plug-In Hybrid", "RAV4 Prime", "Blazer EV"), sometimes in the trim ("Sport-L Hybrid", "Hybrid SEL"). So the AI passes the BASE
 * model and the electrification field, and the route works out which model names of that make are electrified variants of it. Nothing here proves a car is
 * electrified: NHTSA still decides (lib/nhtsa-client.ts). The wording only decides which cars are looked at first, and which model names are searched.
 *
 * R9 (21 Oct 2026, from the catalogue's own names): luxury makes put a LETTER SUFFIX after digits in the trim or the model instead of a word: Lexus "350h Premium",
 * "450h+ Luxury", "RX 450h", "ES 300h"; BMW "xDrive50e", "330e"; Mercedes "GLC 350e 4MATIC"; Land Rover "P550e SE". h means hybrid, h+ plug-in hybrid, e plug-in
 * hybrid or electric (Lexus ES 350e is battery-electric, the BMW 330e is a plug-in hybrid, so e counts for both). About 10,000 cars (Lexus 7,156, BMW 1,883, Mercedes 625,
 * Land Rover 323, FIAT 29, INFINITI 1; evidence doc section 12).
 */
import { KNOWN_HYBRID_ONLY } from "./fuel-type";
import { alnumKey } from "./catalog-db/normalize";

export type ElectrifiedType = "hybrid" | "plug_in_hybrid" | "electric";

/** Removes the electrification words from a trim before comparing (only used when an electrified type was requested; lib/trim-match.ts). */
export function stripElectrificationWords(s: string): string {
  return s.replace(/\bplug[\s-]*in\b/gi, " ").replace(/\b(hybrid|phev|prime|electric|ev)\b/gi, " ");
}

/** Letter suffix after two or three digits, ending at a boundary: "350h", "450h+", "50e", "P550e" (R9). Not "350i", "350", "2.0T" or "330ex". */
function suffixKinds(name: string): ElectrifiedType[] {
  const out: ElectrifiedType[] = [];
  for (const m of String(name ?? "").matchAll(/\d{2,3}(h\+|h|e)(?![a-z0-9])/gi)) {
    const s = m[1].toLowerCase();
    if (s === "h") out.push("hybrid");
    else if (s === "h+") out.push("plug_in_hybrid");
    else out.push("plug_in_hybrid", "electric");
  }
  return out;
}

/** True when a model or trim name carries a letter-suffix marker (R9). Used by the pool prioritizer in lib/nhtsa-client.ts. */
export function hasLetterSuffixWording(name: string): boolean {
  return suffixKinds(name).length > 0;
}

const WORD_TYPE: Record<string, ElectrifiedType> = { hybrid: "hybrid", plugin: "plug_in_hybrid", phev: "plug_in_hybrid", prime: "plug_in_hybrid", electric: "electric", ev: "electric" };

function tokens(name: string): string[] {
  return String(name ?? "").toLowerCase().replace(/plug[\s-]*in/g, "plugin").split(/[^a-z0-9]+/).filter(Boolean);
}

/** The electrified types a model or trim name's wording points to. "Plug-In Hybrid", "PHEV" and "Prime" mean plug-in hybrid only; "Hybrid" alone means hybrid; letter suffixes as in R9. */
export function electrificationTypesOf(name: string): Set<ElectrifiedType> {
  const kinds = new Set<ElectrifiedType>([...tokens(name).map((t) => WORD_TYPE[t]).filter((x): x is ElectrifiedType => !!x), ...suffixKinds(name)]);
  const out = new Set<ElectrifiedType>();
  if (kinds.has("plug_in_hybrid")) out.add("plug_in_hybrid");
  else if (kinds.has("hybrid")) out.add("hybrid");
  if (kinds.has("electric")) out.add("electric");
  return out;
}

/**
 * The name without its electrification words and without a trailing "Class" (Mercedes names the model "GLA-Class" in the feed): "RAV4 Plug-In Hybrid" and
 * "RAV4 Prime" are both the family "rav4"; "GLC-Class" and "GLC Electric" are both "glc". The "Class" case is inferred from the GLA-Class name in the evidence.
 * A letter-suffix token ("450h") is dropped too, so the model "RX 450h" is the family "rx" (R9).
 */
function familyOf(name: string): string {
  return tokens(name).filter((t) => !WORD_TYPE[t] && t !== "class" && !/^\d{2,3}[eh]$/.test(t)).join(" ");
}

const overlaps = (a: Set<ElectrifiedType>, types: ElectrifiedType[]): boolean => types.some((t) => a.has(t));

/**
 * `requested` are the model names the AI sent (base names such as "RAV4"; may be empty for a broad search), `available` the model names the database
 * holds for the make. `variants` are other model names of the same family whose wording matches a requested type; `worded` are the model names, among
 * the requested ones and the variants, whose own wording matches (these cars are looked at first). For a broad search every matching name is worded.
 */
export function electrifiedModelsFor(requested: string[], available: string[], types: ElectrifiedType[]): { variants: string[]; worded: string[] } {
  const names = [...new Set(available.map((a) => String(a ?? "")).filter(Boolean))];
  if (!types.length) return { variants: [], worded: [] };
  if (!requested.length) return { variants: [], worded: names.filter((n) => overlaps(electrificationTypesOf(n), types)) };
  const asked = new Set(requested.map((r) => r.trim().toLowerCase()));
  const variants = new Set<string>();
  const worded = new Set<string>();
  for (const r of requested) {
    if (overlaps(electrificationTypesOf(r), types)) worded.add(r);
    const fam = familyOf(r);
    if (!fam) continue;
    for (const n of names) {
      if (asked.has(n.toLowerCase()) || familyOf(n) !== fam || !overlaps(electrificationTypesOf(n), types)) continue;
      variants.add(n);
      worded.add(n);
    }
  }
  return { variants: [...variants], worded: [...worded] };
}

/** PostgreSQL regular expression (case-insensitive use) for the wording and letter suffixes that mark a trim as electrified, limited to the requested types. */
export function trimWordingRegex(types: ElectrifiedType[]): string {
  const alt: string[] = [];
  if (types.includes("hybrid")) alt.push("hybrid");
  if (types.includes("plug_in_hybrid")) alt.push("plug[^a-z0-9]*in", "phev", "prime");
  if (types.includes("electric")) alt.push("electric", "ev");
  const parts: string[] = [];
  if (alt.length) parts.push(`\\y(${alt.join("|")})\\y`);
  // R9 letter suffixes: h (and h+) for hybrid, h+ and e for plug-in hybrid, e for electric
  const suffix: string[] = [];
  if (types.includes("hybrid")) suffix.push("h");
  if (types.includes("plug_in_hybrid")) suffix.push("h\\+", "e");
  if (types.includes("electric")) suffix.push("e");
  if (suffix.length) parts.push(`[0-9]{2,3}(${[...new Set(suffix)].join("|")})([^a-z0-9]|$)`);
  return parts.join("|");
}

/**
 * Model years of this make that are hybrid with no hybrid wording in the feed (the 2026 RAV4 is plain "RAV4"): listed first for a hybrid request.
 * Only for a request that includes the hybrid type; plug-in and electric requests get none. The list is in lib/fuel-type.ts (SYS-20261021-004, T58).
 */
export function knownHybridOnlyFor(make: string | undefined, types: ElectrifiedType[]): Array<{ modelKey: string; fromYear: number }> {
  if (!make || !types.includes("hybrid")) return [];
  const m = alnumKey(make);
  return KNOWN_HYBRID_ONLY.filter((e) => alnumKey(e.make) === m).map((e) => ({ modelKey: alnumKey(e.model), fromYear: e.fromYear ?? 0 }));
}
