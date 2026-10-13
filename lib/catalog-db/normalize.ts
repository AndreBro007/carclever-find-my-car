/**
 * Catalogue database: row parsing and normalisation (pure functions, no I/O).
 *
 * Input is the Edmunds "Advertiser Submitted Format" product feed (tab-separated, 27 columns):
 *   id title condition description price image_link link availability identifier_exists dealer_id dealer_name
 *   dealer_street dealer_city dealer_state dealer_zip dealer_radius vehicle_vin vehicle_stock_number vehicle_year
 *   vehicle_make vehicle_model vehicle_series vehicle_odometer vehicle_body vehicle_door_number
 *   vehicle_exterior_color vehicle_interior_color
 * Verified on a 13,964-row sample (Oct 2026): every row has 27 columns; condition, VIN, make, model, year, price,
 * dealer city/state/ZIP are never blank; model spelling is consistent; body style has ~200 raw labels.
 */

export type BodyClass = "suv" | "sedan" | "coupe" | "hatchback" | "convertible" | "wagon" | "truck" | "van" | "minivan" | "other";

export const FEED_COLUMNS = [
  "id", "title", "condition", "description", "price", "image_link", "link", "availability", "identifier_exists",
  "dealer_id", "dealer_name", "dealer_street", "dealer_city", "dealer_state", "dealer_zip", "dealer_radius",
  "vehicle_vin", "vehicle_stock_number", "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_series",
  "vehicle_odometer", "vehicle_body", "vehicle_door_number", "vehicle_exterior_color", "vehicle_interior_color",
] as const;

export interface CatalogRow {
  id: string;
  vin: string;
  year: number | null;
  make: string;
  makeKey: string;
  model: string;
  modelKey: string;
  trim: string | null;
  condition: "n" | "u" | null;
  price: number | null;
  odometer: number | null;
  bodyRaw: string | null;
  bodyClass: BodyClass | null;
  doors: number | null;
  extColor: string | null;
  intColor: string | null;
  dealerId: number | null;
  dealerName: string | null;
  dealerStreet: string | null;
  dealerCity: string | null;
  dealerState: string | null;
  dealerZip: string | null;
  imageUrl: string | null;
  /** Full tracking link, stored ONLY when the standard rule below does not reproduce it exactly (about 1% of rows). */
  linkOverride: string | null;
}

const VIN_RE = /^[A-Z0-9]{17}$/;
const TRACKING_PREFIX = "https://edmunds.sjv.io/c/7765200/3913681/52125";
const MAX_YEAR = new Date().getFullYear() + 2;

/** Lower-case letters and digits only: used for make/model matching ("CR-V" and "crv" are the same key). */
export function alnumKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const toNum = (v: string | undefined): number | null => {
  const t = (v ?? "").trim().replace(/[$,]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** ~200 raw body labels -> a handful of classes. Order matters (vans and trucks before SUVs; "Utility Truck" is a truck). */
export function normalizeBodyClass(raw: string | null | undefined): BodyClass | null {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return null;
  if (/\bmini-?\s?vans?\b|\bminivans?\b/.test(s)) return "minivan";
  if (/\bvans?\b/.test(s)) return "van";
  if (/pickup|truck|crew ?cab|double cab|extended cab|regular cab|quad cab|crewmax|supercrew|king cab|super cab|access cab|\bcab\b/.test(s)) return "truck";
  if (/sport utility|\bsuv\b|crossover|\butility\b|\bsav\b|multi-?purpose/.test(s)) return "suv";
  if (/hatchback|liftback/.test(s)) return "hatchback";
  if (/convertible|roadster|cabriolet|spyder|spider/.test(s)) return "convertible";
  if (/wagon|estate/.test(s)) return "wagon";
  if (/coupe|\b2dr\b|2-door|2 door|\b2d\b/.test(s)) return "coupe";
  if (/sedan|\b4dr\b|4-door|4 door|\b4d\b|saloon/.test(s)) return "sedan";
  return "other";
}

/** Map the app's free-text body request (bodyType / vehicleType) to stored classes. */
export function bodyClassesFor(request: string | undefined): BodyClass[] | null {
  const s = (request ?? "").toLowerCase().trim();
  if (!s) return null;
  const out = new Set<BodyClass>();
  for (const part of s.split(/[,/|]/).map((x) => x.trim()).filter(Boolean)) {
    if (/suv|sport utility|crossover|utility/.test(part)) out.add("suv");
    else if (/sedan|saloon/.test(part)) out.add("sedan");
    else if (/coupe/.test(part)) out.add("coupe");
    else if (/hatch/.test(part)) out.add("hatchback");
    else if (/convertible|roadster/.test(part)) out.add("convertible");
    else if (/wagon/.test(part)) out.add("wagon");
    else if (/pickup|truck/.test(part)) out.add("truck");
    else if (/mini-?van/.test(part)) out.add("minivan");
    else if (/van/.test(part)) { out.add("van"); out.add("minivan"); }
  }
  return out.size ? [...out] : null;
}

// Edmunds URL slugs, verified against the real feed: the make keeps its spaces ("land rover", "aston martin"),
// the model turns spaces into hyphens and keeps dots ("range-rover-sport", "id.4").
export const makeSlug = (make: string): string => make.toLowerCase().trim().replace(/[^a-z0-9 .\-]/g, "").replace(/\s+/g, " ");
export const modelSlug = (model: string): string => model.toLowerCase().trim().replace(/[^a-z0-9 .\-]/g, "").replace(/\s+/g, "-");

export function buildTrackingUrl(p: { id: string; vin: string; year: number; make: string; model: string }): string {
  const dest = `https://www.edmunds.com/${makeSlug(p.make)}/${modelSlug(p.model)}/${p.year}/vin/${p.vin}/featured-listing/?utm_matchtype=inventory`;
  return `${TRACKING_PREFIX}?prodsku=${p.id}&u=${encodeURIComponent(dest)}&intsrc=CATF_34070`;
}

function plausibleImage(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    if ((p.protocol !== "https:" && p.protocol !== "http:") || p.username || p.password) return null;
    const h = p.hostname.toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || !h.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return null;
    return u;
  } catch {
    return null;
  }
}

export type ParseResult = { row: CatalogRow } | { skip: string };

/** Parse one tab-split line (columns already split). Never throws; returns a reason when the row is unusable. */
export function parseRow(cols: string[], idx: Record<string, number>): ParseResult {
  const g = (name: string): string | undefined => cols[idx[name]];
  const id = clean(g("id"));
  const vin = (clean(g("vehicle_vin")) ?? "").toUpperCase();
  const make = clean(g("vehicle_make"));
  const model = clean(g("vehicle_model"));
  if (!id) return { skip: "no id" };
  if (!VIN_RE.test(vin)) return { skip: "bad vin" };
  if (!make || !model) return { skip: "no make or model" };
  if (/out\s*of\s*stock/i.test(g("availability") ?? "")) return { skip: "out of stock" };

  const yearN = toNum(g("vehicle_year"));
  const year = yearN != null && Number.isInteger(yearN) && yearN >= 1980 && yearN <= MAX_YEAR ? yearN : null;
  const priceN = toNum(g("price"));
  const price = priceN != null && priceN > 0 && priceN < 5_000_000 ? Math.round(priceN) : null;
  const odoN = toNum(g("vehicle_odometer"));
  const odometer = odoN != null && odoN >= 0 && odoN <= 600_000 ? Math.round(odoN) : null;
  const cond = (clean(g("condition")) ?? "").toLowerCase();
  const condition: "n" | "u" | null = cond === "new" ? "n" : cond === "used" ? "u" : null;
  const doorsN = toNum(g("vehicle_door_number"));
  const doors = doorsN != null && doorsN >= 1 && doorsN <= 6 ? Math.round(doorsN) : null;
  const dealerIdN = toNum(g("dealer_id"));
  const zipRaw = clean(g("dealer_zip"));
  const dealerZip = zipRaw && /^\d{3,5}$/.test(zipRaw) ? zipRaw.padStart(5, "0") : null;
  const stateRaw = (clean(g("dealer_state")) ?? "").toUpperCase();
  const bodyRaw = clean(g("vehicle_body"));

  let linkOverride: string | null = null;
  const link = clean(g("link"));
  if (link && year != null && link.startsWith(TRACKING_PREFIX)) {
    if (link !== buildTrackingUrl({ id, vin, year, make, model })) linkOverride = link;
  } else if (link && link.startsWith("https://edmunds.sjv.io/")) {
    linkOverride = link;
  }

  return {
    row: {
      id, vin, year, make, makeKey: alnumKey(make), model, modelKey: alnumKey(model),
      trim: clean(g("vehicle_series")), condition, price, odometer,
      bodyRaw, bodyClass: normalizeBodyClass(bodyRaw), doors,
      extColor: clean(g("vehicle_exterior_color")), intColor: clean(g("vehicle_interior_color")),
      dealerId: dealerIdN != null && Number.isInteger(dealerIdN) ? dealerIdN : null,
      dealerName: clean(g("dealer_name")), dealerStreet: clean(g("dealer_street")), dealerCity: clean(g("dealer_city")),
      dealerState: /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null, dealerZip,
      imageUrl: plausibleImage(clean(g("image_link"))), linkOverride,
    },
  };
}

export function headerIndex(headerLine: string): Record<string, number> {
  const clean = headerLine.replace(/^\uFEFF/, "").replace(/\r$/, "");
  const cols = clean.split("\t").map((c) => c.trim());
  const idx: Record<string, number> = {};
  cols.forEach((c, i) => { idx[c] = i; });
  for (const need of FEED_COLUMNS) {
    // The message names the header's own column names (no car data) so a wrong file is easy to recognise.
    if (!(need in idx)) throw new Error(`feed header is missing column "${need}" (the header has ${cols.length} columns and begins: ${cols.slice(0, 6).join(" | ").slice(0, 160)})`);
  }
  return idx;
}
