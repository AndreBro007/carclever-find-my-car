// Drivetrain requests (AWD, 4WD, FWD, RWD). The listing feed has no drivetrain field, so the only evidence is the NHTSA VIN
// decode. The decode is often empty (it covers about half of the cars), so a request must never drop a car just because the
// decode is silent. Rule (André, 19 Oct 2026, option A, following SYS-20261015-019): cars the decode shows with a DIFFERENT
// drivetrain are left out; cars it confirms come first; cars it cannot show are kept after them and marked "not confirmed".

export type WantedDrive = "awd4" | "fwd" | "rwd";
export type DriveClass = WantedDrive | "two" | "unknown";
export type DriveJudgement = "match" | "mismatch" | "unknown";

/** Class of a decoded or displayed drivetrain text, for example "AWD/All-Wheel Drive", "4WD", "FWD/Front-Wheel Drive", "4x2". */
export function classifyDriveType(s: string | null | undefined): DriveClass {
  const t = String(s ?? "").trim();
  if (!t) return "unknown";
  if (/AWD|4WD|4X4|ALL[- ]?WHEEL|4[- ]?WHEEL|FOUR[- ]?WHEEL/i.test(t)) return "awd4";
  if (/FWD|FRONT[- ]?WHEEL/i.test(t)) return "fwd";
  if (/RWD|REAR[- ]?WHEEL/i.test(t)) return "rwd";
  if (/4X2|4 X 2|2WD|2[- ]?WHEEL/i.test(t)) return "two";
  return "unknown";
}

/** The set of drivetrains a request accepts ("AWD", "AWD, 4WD", "FWD,RWD", "2WD"), or null when nothing in it is recognised. */
export function wantedDriveClasses(wanted: string | null | undefined): Set<WantedDrive> | null {
  const raw = String(wanted ?? "").trim();
  if (!raw) return null;
  const out = new Set<WantedDrive>();
  for (const part of raw.split(/[,;/|]+|\s+or\s+/i)) {
    const c = classifyDriveType(part);
    if (c === "awd4" || c === "fwd" || c === "rwd") out.add(c);
    else if (c === "two") { out.add("fwd"); out.add("rwd"); }
  }
  return out.size > 0 ? out : null;
}

export function judgeDrive(decoded: string | null | undefined, wanted: Set<WantedDrive>): DriveJudgement {
  const c = classifyDriveType(decoded);
  if (c === "unknown") return "unknown";
  if (c === "two") return wanted.has("fwd") || wanted.has("rwd") ? "unknown" : "mismatch"; // 4x2 does not say front or rear
  return wanted.has(c) ? "match" : "mismatch";
}

export function partitionByDrive<T>(items: T[], decodedOf: (t: T) => string | null | undefined, wanted: Set<WantedDrive>): { confirmed: T[]; unknown: T[]; excluded: number } {
  const confirmed: T[] = [];
  const unknown: T[] = [];
  let excluded = 0;
  for (const it of items) {
    const j = judgeDrive(decodedOf(it), wanted);
    if (j === "match") confirmed.push(it);
    else if (j === "unknown") unknown.push(it);
    else excluded++;
  }
  return { confirmed, unknown, excluded };
}

/** The drivetrain label a decoded text carries ("AWD", "4WD", "FWD", "RWD", "4x2"), or null when it carries none. This reports what the VIN data says; it does not decide anything. */
function decodedLabel(s: string | null | undefined): "AWD" | "4WD" | "FWD" | "RWD" | "4x2" | null {
  const t = String(s ?? "").trim();
  if (!t) return null;
  if (/AWD|ALL[- ]?WHEEL/i.test(t)) return "AWD";
  if (/4WD|4X4|4[- ]?WHEEL|FOUR[- ]?WHEEL/i.test(t)) return "4WD";
  if (/FWD|FRONT[- ]?WHEEL/i.test(t)) return "FWD";
  if (/RWD|REAR[- ]?WHEEL/i.test(t)) return "RWD";
  if (/4X2|4 X 2|2WD|2[- ]?WHEEL/i.test(t)) return "4x2";
  return null;
}

/**
 * One search-level line for the reply. It reports what the VIN data LABELS on the cars that are shown (counts come from those cars), never a mechanical
 * confirmation: the labels are used loosely (many all-wheel-drive crossovers are labelled 4WD), AWD and 4WD are searched together, and matching labels
 * do not show low-range capability, so that caution is given even when every car has the same label. Null when nothing is shown. The filtering is not touched here.
 */
export function drivetrainNote(_requested: string, shown: Array<string | null | undefined>, wanted: Set<WantedDrive>, excluded: number): string | null {
  const n = shown.length;
  if (n === 0) return null;
  const left = excluded > 0 ? " Cars the VIN decode shows with a different drivetrain were left out." : "";
  const labels = shown.map(decodedLabel);
  const order = ["4WD", "AWD", "FWD", "RWD", "4x2"] as const;
  const parts = order.map((l) => ({ l, k: labels.filter((x) => x === l).length })).filter((p) => p.k > 0);
  const labelled = parts.reduce((a, p) => a + p.k, 0);
  const unlabelled = n - labelled;
  const veh = (k: number) => `${k} vehicle${k === 1 ? "" : "s"}`;
  const awd4 = wanted.has("awd4");
  const caution = awd4 ? " Low-range capability is not verified; confirm it with the dealer if required." : "";
  if (labelled === 0) {
    return `VIN data gives no drivetrain label for ${n === 1 ? "the vehicle" : `any of the ${n} vehicles`} shown; ${n === 1 ? "it is" : "they are"} marked not confirmed.${awd4 ? " This search includes both AWD and 4WD." : ""}${caution}${awd4 ? "" : " Ask the dealer to confirm the drivetrain."}${left}`;
  }
  let sentence: string;
  if (parts.length === 1) {
    const p = parts[0];
    sentence = labelled === n ? (n === 1 ? `VIN data labels 1 vehicle as ${p.l}.` : `VIN data labels all ${n} vehicles as ${p.l}.`) : `VIN data labels ${labelled} of ${n} vehicles as ${p.l}.`;
  } else {
    const bits = parts.map((p, i) => (i === 0 ? `${veh(p.k)} as ${p.l}` : `${p.k} as ${p.l}`));
    sentence = `VIN data labels ${bits.length > 2 ? `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}` : bits.join(" and ")}.`;
  }
  const hasBoth = parts.some((p) => p.l === "4WD") && parts.some((p) => p.l === "AWD");
  const includes = awd4 ? (hasBoth ? " This search includes both." : " This search includes both AWD and 4WD.") : "";
  const un = unlabelled > 0 ? ` ${unlabelled} ${unlabelled === 1 ? "has" : "have"} no drivetrain label in the VIN data and ${unlabelled === 1 ? "is" : "are"} marked not confirmed.` : "";
  const ask = !awd4 && unlabelled > 0 ? " Ask the dealer to confirm." : "";
  return `${sentence}${includes}${un}${caution}${ask}${left}`;
}

/**
 * Last step before the reply (review finding 3): the VIN decode read at the shortlist stage can show a drivetrain the first read
 * missed. Cars now known to have a different drivetrain are removed, confirmed cars go first, silent cars follow (stable order).
 * If removal would leave nothing, the list is returned unchanged with `allMismatch` set so the reply can say so instead of going empty.
 */
export function finalizeByDrive<T>(cards: T[], driveOf: (t: T) => string | null | undefined, wanted: Set<WantedDrive>): { cards: T[]; removed: number; allMismatch: boolean } {
  const confirmed: T[] = [];
  const unknown: T[] = [];
  let removed = 0;
  for (const c of cards) {
    const j = judgeDrive(driveOf(c), wanted);
    if (j === "match") confirmed.push(c);
    else if (j === "unknown") unknown.push(c);
    else removed++;
  }
  if (confirmed.length + unknown.length === 0 && removed > 0) return { cards, removed: 0, allMismatch: true };
  return { cards: [...confirmed, ...unknown], removed, allMismatch: false };
}
