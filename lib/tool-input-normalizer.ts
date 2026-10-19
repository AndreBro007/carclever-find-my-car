/**
 * Forgiving input for tool calls. An AI sometimes sends a harmless slip: null for an optional field, a number as text ("45000"),
 * a list where text is expected or the other way round, or a field name the tool does not have. The tool's published schema stays
 * strict (it is what reviewers and AI clients read), but before a call is validated the slip is repaired instead of returning an
 * error that ends the buyer's search. Nothing here changes what a valid call means.
 */

const NUMBER_FIELDS = new Set(["priceMax", "priceMin", "yearMin", "yearMax", "mileageMax", "doors", "cylinders", "seatsMinPreference", "radiusMiles", "year"]);
const BOOLEAN_FIELDS = new Set(["used", "cpo", "noAccidents", "oneOwner"]);
const ARRAY_FIELDS = new Set(["vehicleNeeds", "electrificationTypes", "vins"]);

const TOOL_FIELDS: Record<string, string[]> = {
  find_matching_vehicle: ["bodyType", "cpo", "cylinders", "doors", "drivetrain", "electrificationRequirement", "electrificationTypes", "exteriorColor", "interiorColor", "make", "mileageMax", "model", "noAccidents", "oneOwner", "priceFlexibility", "priceMax", "priceMin", "priorityAxis", "radiusMiles", "seatsMinPreference", "state", "transmission", "trimPreference", "trimRequired", "used", "vehicleNeeds", "vehicleType", "vin", "yearMax", "yearMin", "zip"],
  check_vehicle: ["make", "model", "vin", "year"],
  get_edmunds_vehicle_link: ["vin", "make", "model", "year"],
  resolve_dealer_url: ["vin", "make", "model", "year"], // the old name of the link tool (still called by older clients)
  compare_vehicles: ["vins", "zip"],
};

export type NormalizeResult = { args: Record<string, unknown>; changes: string[] };

function toNumber(v: string): number | null {
  let s = v.trim().toLowerCase().replace(/[$,\s]/g, "");
  let mult = 1;
  if (/^\d+(\.\d+)?k$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : null;
}

/** Repairs the arguments of one tool call. Unknown tools and non-object arguments are returned untouched. */
export function normalizeToolArguments(toolName: string, args: unknown): NormalizeResult {
  const allowed = TOOL_FIELDS[toolName];
  if (!allowed || args == null || typeof args !== "object" || Array.isArray(args)) return { args: (args as Record<string, unknown>) ?? {}, changes: [] };
  const known = new Set(allowed);
  const out: Record<string, unknown> = {};
  const changes: string[] = [];
  for (const [k, raw] of Object.entries(args as Record<string, unknown>)) {
    if (!known.has(k)) { changes.push(`dropped unknown field ${k}`); continue; }
    if (raw === null || raw === undefined) { changes.push(`dropped empty ${k}`); continue; }
    let v: unknown = raw;
    if (NUMBER_FIELDS.has(k)) {
      if (typeof v === "string") { const n = toNumber(v); if (n !== null) { v = n; changes.push(`${k}: text to number`); } }
    } else if (BOOLEAN_FIELDS.has(k)) {
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (["true", "yes", "1"].includes(t)) { v = true; changes.push(`${k}: text to true`); }
        else if (["false", "no", "0"].includes(t)) { v = false; changes.push(`${k}: text to false`); }
      }
    } else if (ARRAY_FIELDS.has(k)) {
      if (typeof v === "string") {
        v = k === "vehicleNeeds" ? [v] : v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        changes.push(`${k}: text to list`);
      }
    } else {
      // text fields
      if (Array.isArray(v)) { v = v.filter((x) => typeof x === "string" || typeof x === "number").map(String).join(", "); changes.push(`${k}: list to text`); }
      else if (typeof v === "number") { v = k === "zip" ? String(v).padStart(5, "0") : String(v); changes.push(`${k}: number to text`); }
      else if (typeof v !== "string") { changes.push(`dropped unusable ${k}`); continue; }
    }
    out[k] = v;
  }
  return { args: out, changes };
}
