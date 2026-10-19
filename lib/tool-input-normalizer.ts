/**
 * Forgiving input for tool calls. An AI sometimes sends a harmless slip: null or an empty value for an optional field, a number as
 * text ("45000"), a fixed-choice value in the wrong case or with an invented value, a list where text is expected, or a field the
 * tool does not have. The tool's published schema stays strict (reviewers and AI clients read it), but before a call is validated the
 * slip is repaired, or the unusable input is set aside and the reply says so, instead of an error that ends the buyer's search.
 * Nothing here changes what a valid call means.
 */

const NUMBER_FIELDS = new Set(["priceMax", "priceMin", "yearMin", "yearMax", "mileageMax", "doors", "cylinders", "seatsMinPreference", "radiusMiles", "year"]);
const BOOLEAN_FIELDS = new Set(["used", "cpo", "noAccidents", "oneOwner"]);
const ARRAY_FIELDS = new Set(["vehicleNeeds", "electrificationTypes", "vins"]);

const ENUMS: Record<string, string[]> = {
  priorityAxis: ["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"],
  priceFlexibility: ["strict", "flexible"],
  transmission: ["Automatic", "Manual"],
  electrificationRequirement: ["required", "preferred"],
};
const ELECTRIFICATION_TYPES = ["hybrid", "plug_in_hybrid", "electric"];
const ELECTRIFICATION_ALIASES: Record<string, string> = { ev: "electric", bev: "electric", phev: "plug_in_hybrid", plug_in: "plug_in_hybrid", plugin_hybrid: "plug_in_hybrid", plug_in_hybrid_electric: "plug_in_hybrid", mild_hybrid: "hybrid", full_hybrid: "hybrid" };

const TOOL_FIELDS: Record<string, string[]> = {
  find_matching_vehicle: ["bodyType", "cpo", "cylinders", "doors", "drivetrain", "electrificationRequirement", "electrificationTypes", "exteriorColor", "interiorColor", "make", "mileageMax", "model", "noAccidents", "oneOwner", "priceFlexibility", "priceMax", "priceMin", "priorityAxis", "radiusMiles", "seatsMinPreference", "state", "transmission", "trimPreference", "trimRequired", "used", "vehicleNeeds", "vehicleType", "vin", "yearMax", "yearMin", "zip"],
  check_vehicle: ["make", "model", "vin", "year"],
  get_edmunds_vehicle_link: ["vin", "make", "model", "year"],
  resolve_dealer_url: ["vin", "make", "model", "year"], // the old name of the link tool (still called by older clients)
  compare_vehicles: ["vins", "zip"],
};

export type NormalizeResult = {
  args: Record<string, unknown>;
  /** harmless repairs (for the log) */
  changes: string[];
  /** inputs that had to be set aside because they could not be used; the reply tells the buyer */
  ignored: string[];
};

const key = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function toNumber(v: string): number | null {
  let s = v.trim().toLowerCase().replace(/[$,\s]/g, "");
  let mult = 1;
  if (/^\d+(\.\d+)?k$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : null;
}

function matchEnum(values: string[], raw: string): string | null {
  const k = key(raw);
  return values.find((v) => key(v) === k) ?? null;
}

/** Repairs the arguments of one tool call. Unknown tools and non-object arguments are returned untouched. */
export function normalizeToolArguments(toolName: string, args: unknown): NormalizeResult {
  const allowed = TOOL_FIELDS[toolName];
  if (!allowed || args == null || typeof args !== "object" || Array.isArray(args)) return { args: (args as Record<string, unknown>) ?? {}, changes: [], ignored: [] };
  const known = new Set(allowed);
  const out: Record<string, unknown> = {};
  const changes: string[] = [];
  const ignored: string[] = [];
  for (const [k, raw] of Object.entries(args as Record<string, unknown>)) {
    if (!known.has(k)) { changes.push(`dropped unknown field ${k}`); ignored.push(`${k} (not an input this tool has)`); continue; }
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) { changes.push(`dropped empty ${k}`); continue; }
    let v: unknown = raw;
    if (NUMBER_FIELDS.has(k)) {
      if (typeof v === "string") {
        const n = toNumber(v);
        if (n !== null) { v = n; changes.push(`${k}: text to number`); }
        else { changes.push(`dropped ${k}: not a number`); ignored.push(`${k} (not a number)`); continue; }
      } else if (typeof v !== "number") { changes.push(`dropped unusable ${k}`); ignored.push(`${k} (not a number)`); continue; }
    } else if (BOOLEAN_FIELDS.has(k)) {
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (["true", "yes", "1"].includes(t)) { v = true; changes.push(`${k}: text to true`); }
        else if (["false", "no", "0"].includes(t)) { v = false; changes.push(`${k}: text to false`); }
        else { changes.push(`dropped ${k}: not true or false`); ignored.push(`${k} (not true or false)`); continue; }
      } else if (typeof v !== "boolean") { changes.push(`dropped unusable ${k}`); continue; }
    } else if (k === "electrificationTypes") {
      const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,]+/) : []).map((x) => String(x));
      const good: string[] = [];
      for (const item of list) {
        const m = matchEnum(ELECTRIFICATION_TYPES, item) ?? ELECTRIFICATION_ALIASES[key(item)] ?? null;
        if (m) { if (!good.includes(m)) good.push(m); } else if (item.trim()) { changes.push(`dropped electrification type ${item}`); ignored.push(`electrification type "${item}" (not recognised)`); }
      }
      if (!good.length) continue;
      if (JSON.stringify(good) !== JSON.stringify(raw)) changes.push("electrificationTypes: repaired");
      v = good;
    } else if (ARRAY_FIELDS.has(k)) {
      if (typeof v === "string") {
        v = k === "vehicleNeeds" ? [v] : v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        changes.push(`${k}: text to list`);
      }
    } else if (ENUMS[k]) {
      const s = typeof v === "string" ? v : String(v);
      const m = matchEnum(ENUMS[k], s);
      if (m) { if (m !== v) changes.push(`${k}: fixed spelling`); v = m; }
      else { changes.push(`dropped ${k}: value not recognised`); ignored.push(`${k} (value "${s.slice(0, 40)}" not recognised)`); continue; }
    } else {
      // plain text fields
      if (Array.isArray(v)) { v = v.filter((x) => typeof x === "string" || typeof x === "number").map(String).join(", "); changes.push(`${k}: list to text`); }
      else if (typeof v === "number") { v = k === "zip" ? String(v).padStart(5, "0") : String(v); changes.push(`${k}: number to text`); }
      else if (typeof v !== "string") { changes.push(`dropped unusable ${k}`); continue; }
    }
    out[k] = v;
  }
  if (out.electrificationRequirement !== undefined && out.electrificationTypes === undefined) {
    delete out.electrificationRequirement;
    changes.push("dropped electrificationRequirement: no electrification types given");
    ignored.push("electrificationRequirement (no electrification types were given)");
  }
  return { args: out, changes, ignored };
}

/** Field names that a validation error message names (for example "priorityAxis: Invalid input, electrificationTypes.0: Invalid input"). */
export function invalidFieldsFromError(toolName: string, errorText: string): string[] {
  const allowed = TOOL_FIELDS[toolName] ?? [];
  const found: string[] = [];
  for (const f of allowed) if (new RegExp(`(^|[\\s,:])${f}(\\.\\d+)?:`).test(errorText) && !found.includes(f)) found.push(f);
  return found;
}

/** One line for the top of the reply when inputs had to be set aside, so the AI and the buyer never think they were applied. */
export function ignoredInputsNote(ignored: string[]): string {
  if (!ignored.length) return "";
  return `Note: these inputs could not be used and were ignored: ${ignored.join("; ")}. The results below do not reflect them.`;
}

/** Puts a note in front of the reply text inside a tools/call response (plain JSON or an event-stream message). */
export function addNoteToMcpResponseText(responseText: string, note: string): string {
  if (!note) return responseText;
  const patch = (obj: any): boolean => {
    const first = obj?.result?.content?.[0];
    if (first && typeof first.text === "string") { first.text = `${note}\n\n${first.text}`; return true; }
    return false;
  };
  const m = responseText.match(/data: (\{.*\})/);
  if (m) {
    try { const obj = JSON.parse(m[1]); if (patch(obj)) return responseText.replace(m[0], () => `data: ${JSON.stringify(obj)}`); } catch { /* fall through */ }
    return responseText;
  }
  try { const obj = JSON.parse(responseText); if (patch(obj)) return JSON.stringify(obj); } catch { /* not JSON */ }
  return responseText;
}
