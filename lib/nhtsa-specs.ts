/**
 * Specs read from NHTSA's VIN decode (vPIC). The call is already made for every shortlisted car, so using more of its answer is free.
 * NHTSA describes the VIN's model/trim configuration, not an inspected car: "Standard" means standard on that configuration.
 * Values are only used to FILL BLANKS in the listing, never to override what the listing itself says.
 */
export interface NhtsaSpecs {
  driveType: "AWD" | "4WD" | "FWD" | "RWD" | null; // NHTSA's "4x2" says two-wheel drive without front/rear, so it stays null (never guessed)
  transmission: "Automatic" | "Manual" | null; // CVT, dual-clutch etc. stay null: a user asking for "automatic" must not see a false mismatch
  cylinders: number | null;
  engine: string | null; // e.g. "2.5L 4-cyl 203 hp turbo"
  seats: number | null;
  fuel: "Gasoline" | "Diesel" | "Hybrid" | "Plug-In Hybrid" | "Electric" | null; // from the app's own electrification classifier + NHTSA primary fuel; ambiguous stays null
  safetyTech: string[]; // only features NHTSA lists as Standard (ABS, stability control and traction control are universal, so not listed)
}

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  const n = Number(s(v));
  return s(v) !== "" && Number.isFinite(n) ? n : null;
};

export function normalizeDriveType(raw: unknown): NhtsaSpecs["driveType"] {
  const t = s(raw).toLowerCase();
  if (!t) return null;
  if (t.includes("all-wheel") || t.includes("awd")) return "AWD";
  if (t.includes("4wd") || t.includes("4-wheel") || t.includes("4x4")) return "4WD";
  if (t.includes("front-wheel") || t.includes("fwd")) return "FWD";
  if (t.includes("rear-wheel") || t.includes("rwd")) return "RWD";
  return null;
}

export function normalizeTransmission(raw: unknown): NhtsaSpecs["transmission"] {
  const t = s(raw).toLowerCase();
  if (t === "automatic") return "Automatic";
  if (t === "manual" || t === "manual/standard") return "Manual";
  return null;
}

const SAFETY: Array<[field: string, label: string]> = [
  ["CIB", "Automatic emergency braking"],
  ["ForwardCollisionWarning", "Forward collision warning"],
  ["PedestrianAutomaticEmergencyBraking", "Pedestrian emergency braking"],
  ["LaneDepartureWarning", "Lane departure warning"],
  ["LaneKeepSystem", "Lane keeping assist"],
  ["BlindSpotMon", "Blind spot monitoring"],
  ["RearCrossTrafficAlert", "Rear cross-traffic alert"],
  ["AdaptiveCruiseControl", "Adaptive cruise control"],
  ["ParkAssist", "Parking assist"],
  ["RearVisibilitySystem", "Rear camera"],
];

export function specsFromRow(r: Row): NhtsaSpecs {
  const cyl = num(r.EngineCylinders);
  const disp = num(r.DisplacementL);
  const hp = num(r.EngineHP);
  const seats = num(r.Seats);
  const parts = [disp != null ? `${disp.toFixed(1)}L` : "", cyl != null ? `${cyl}-cyl` : "", hp != null ? `${Math.round(hp)} hp` : "", s(r.Turbo).toLowerCase() === "yes" ? "turbo" : ""].filter(Boolean);
  const seen = new Set<string>();
  const safetyTech: string[] = [];
  for (const [field, label] of SAFETY) {
    if (s(r[field]).toLowerCase() === "standard" && !seen.has(label)) { seen.add(label); safetyTech.push(label); }
  }
  return {
    driveType: normalizeDriveType(r.DriveType),
    transmission: normalizeTransmission(r.TransmissionStyle),
    cylinders: cyl,
    engine: disp != null || cyl != null ? parts.join(" ") : null,
    seats: seats != null && seats >= 1 && seats <= 15 ? seats : null,
    fuel: null, // set by the decoder, which owns the electrification classifier (lib/nhtsa-client.ts)
    safetyTech,
  };
}

/** Fuel for the card from the electrification state (classifier output) and NHTSA's primary fuel. Anything unclear stays null. */
export function fuelFor(state: string, primary: unknown): NhtsaSpecs["fuel"] {
  if (state === "electric") return "Electric";
  if (state === "plug_in_hybrid") return "Plug-In Hybrid";
  if (state === "hybrid" || state === "mild_hybrid") return "Hybrid";
  if (state === "not_electrified") {
    const p = s(primary).toLowerCase();
    if (p === "gasoline") return "Gasoline";
    if (p === "diesel") return "Diesel";
  }
  return null;
}

/** Fill ONLY the blanks in listing.vehicle from the decode; a value the listing already has is never replaced. */
export function withNhtsaSpecs<L extends { vehicle?: unknown }>(listing: L, nhtsa?: { specs?: NhtsaSpecs } | null): L {
  const sp = nhtsa?.specs;
  if (!sp || !listing.vehicle || typeof listing.vehicle !== "object") return listing;
  const v: Record<string, unknown> = { ...(listing.vehicle as Record<string, unknown>) };
  let changed = false;
  const fill = (k: string, val: unknown) => {
    if (val != null && (v[k] == null || v[k] === "")) { v[k] = val; changed = true; }
  };
  fill("drivetrain", sp.driveType);
  fill("transmission", sp.transmission);
  fill("engine", sp.engine);
  fill("cylinders", sp.cylinders);
  fill("seats", sp.seats);
  fill("fuel", sp.fuel);
  return changed ? { ...listing, vehicle: v } : listing;
}

const mkey = (x: unknown): string => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Do the listing's model and NHTSA's decoded model name the same car? Prefix-tolerant, plus the naming families where the two sources
 * differ only in style (found on 395 real listings: MINI Cooper/Hardtop, BMW 3 Series/330i, Mercedes C-Class/C300).
 * Returns true when there is nothing to compare, so a missing name is never a conflict.
 */
export function modelsAgree(claimed: unknown, decoded: unknown, make?: unknown): boolean {
  const c = mkey(claimed), d = mkey(decoded);
  if (!c || !d) return true;
  if (d.startsWith(c) || c.startsWith(d)) return true;
  const series = /^(\d)SERIES/.exec(c); // BMW: "3 Series" against 330i, 530e, M340i
  if (series && d.replace(/^M(?=\d{3})/, "").startsWith(series[1]) && /^\d{3}/.test(d.replace(/^M(?=\d{3})/, ""))) return true;
  const cls = /^([A-Z]{1,3})CLASS$/.exec(c); // Mercedes-Benz: "C-Class" against C300, E350, GLC300
  if (cls && d.startsWith(cls[1]) && /\d/.test(d.charAt(cls[1].length))) return true;
  if (mkey(make) === "MINI" && c.startsWith("COOPER") && /^(HARDTOP|CLUBMAN|COUNTRYMAN|PACEMAN|CONVERTIBLE|COUPE|ROADSTER)/.test(d)) return true; // MINI
  return false;
}
