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

/** One search-level line for the reply: how many of the shown cars have the drivetrain confirmed. Null when nothing is shown. */
export function drivetrainNote(requested: string, shown: Array<string | null | undefined>, wanted: Set<WantedDrive>, excluded: number): string | null {
  const n = shown.length;
  if (n === 0) return null;
  const confirmed = shown.filter((d) => judgeDrive(d, wanted) === "match").length;
  const left = excluded > 0 ? " Cars the VIN decode shows with a different drivetrain were left out." : "";
  if (confirmed === n) return `Drivetrain ${requested}: confirmed by the VIN decode on all ${n} shown.${left}`;
  if (confirmed === 0) return `Drivetrain ${requested} could not be confirmed on any of these: the VIN decode has no drivetrain for them.${left} Ask the dealer to confirm the drivetrain.`;
  return `Drivetrain ${requested}: confirmed on ${confirmed} of ${n} shown (listed first); for the others the VIN decode has no drivetrain, so they are marked not confirmed.${left} Ask the dealer to confirm.`;
}
