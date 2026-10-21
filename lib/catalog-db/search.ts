/**
 * Catalogue database search. Pure SQL building plus execution against anything with a pg-style query().
 * Filters mirror the app's ListingsQuery. Colours are matched here (see colourRegex). Fields the feed cannot answer
 * (transmission, cylinders, accident history, owners) are ignored here and reported as not applied in the reply.
 * Drivetrain is not a column either: it is checked after the search against the VIN decode (lib/drivetrain-filter.ts).
 */
import zipcodes from "zipcodes";
import type { ListingsQuery } from "../listing-types";
import { alnumKey, bodyClassesFor } from "./normalize";

export interface Queryable { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

export interface DbRow {
  id: string; vin: string; year: number | null; make: string; model: string; trim: string | null;
  condition: string | null; price: number | null; odometer: number | null; body_raw: string | null; body_class: string | null;
  doors: number | null; ext_color: string | null; int_color: string | null; dealer_id: number | null; state: string | null; zip: string | null;
  image_url: string | null; link_override: string | null; dealer_name: string | null; dealer_city: string | null; dealer_street: string | null;
  distance: number | null;
  first_seen?: string | null; price_prev?: number | null; price_changed_at?: string | null; // tracking columns (absent until the loader has added them)
}
export interface DbSearchResult { rows: DbRow[]; total: number | null; localApplied: boolean }

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 300;
const TOTAL_CAP = 10_000;
export const DEFAULT_RADIUS_MILES = 50;
export const MIN_LOCAL_RESULTS = 3;
export const MAX_RADIUS = 1000;

const COLOUR_WORDS: Record<string, string[]> = {
  gray: ["gray", "grey", "charcoal", "graphite", "gunmetal"], grey: ["gray", "grey", "charcoal", "graphite", "gunmetal"], silver: ["silver"], white: ["white", "ivory"],
  black: ["black"], blue: ["blue"], red: ["red", "crimson"], green: ["green"], brown: ["brown", "bronze", "chocolate"], orange: ["orange"], yellow: ["yellow"],
  gold: ["gold"], burgundy: ["burgundy", "maroon", "wine"], beige: ["beige", "tan", "sand", "cashmere"], tan: ["tan", "beige", "sand"],
};
/** Regex (PostgreSQL syntax) for a requested colour list, or null. The feed uses marketing names ("Glacier White", "Brooklyn Grey Metallic"), so this matches whole words. */
export function colourRegex(spec: string | undefined): string | null {
  const words = new Set<string>();
  for (const raw of String(spec ?? "").toLowerCase().split(/[,/]/)) {
    const t = raw.trim().replace(/[^a-z ]/g, "");
    if (!t) continue;
    for (const w of COLOUR_WORDS[t] ?? [t]) words.add(w);
  }
  return words.size ? `\\y(${[...words].join("|")})\\y` : null;
}

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

const SELECT_COLS_BASE = `l.id, l.vin, l.year, l.make, l.model, l.trim, l.condition, l.price, l.odometer, l.body_raw, l.body_class, l.doors,
  l.ext_color, l.int_color, l.dealer_id, l.state, l.zip, l.image_url, l.link_override, d.name AS dealer_name, d.city AS dealer_city, d.street AS dealer_street`;
const FROM = `FROM listing l LEFT JOIN dealer d ON d.id = l.dealer_id`;

// Tracking columns (first seen, previous price, price-change date) are created by the loader. The app must work before AND after that
// migration, so it checks once (and again every 5 minutes until they exist) instead of assuming. Dates are read as text (YYYY-MM-DD).
const TRACK_COLS = `, l.first_seen::text AS first_seen, l.price_prev, l.price_changed_at::text AS price_changed_at`;
let SELECT_COLS = SELECT_COLS_BASE;
let trackingChecked = 0;
let trackingPresent = false;
async function ensureTrackingCols(db: Queryable): Promise<void> {
  if (trackingPresent || Date.now() - trackingChecked < 300_000) return;
  trackingChecked = Date.now();
  try {
    const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'listing' AND column_name = 'first_seen' LIMIT 1`);
    trackingPresent = r.rows.length > 0;
  } catch { trackingPresent = false; }
  SELECT_COLS = SELECT_COLS_BASE + (trackingPresent ? TRACK_COLS : "");
}
export function resetTrackingCheckForTests(): void { trackingChecked = 0; trackingPresent = false; SELECT_COLS = SELECT_COLS_BASE; }

function haversine(p: Params, lat: number, lon: number): string {
  const a = p.add(lat), b = p.add(lon);
  return `(3958.8 * 2 * asin(sqrt(power(sin(radians(l.lat - ${a}) / 2), 2) + cos(radians(${a})) * cos(radians(l.lat)) * power(sin(radians(l.lon - ${b}) / 2), 2))))`;
}

export function whereFor(q: ListingsQuery, models: string[] | null, p: Params, opts: { skipModel?: boolean; strictColour?: boolean } = {}): string[] {
  const w: string[] = [];
  if (q.make) w.push(`l.make_key = ${p.add(alnumKey(q.make))}`);
  // A required trim, already resolved to the exact trim strings the database holds (lib/trim-resolution.ts). Cars with no trim stay in so the
  // later checks decide them as before; without this filter a rare trim could fall outside the candidate rows for a popular model.
  if (q.trimIn && q.trimIn.length) w.push(`(l.trim = ANY(${p.add(q.trimIn)}) OR l.trim IS NULL)`);
  if (!opts.skipModel && models && models.length) {
    const keys = models.map(alnumKey).filter(Boolean);
    const extra = (q.electrified?.extraModels ?? []).map(alnumKey).filter(Boolean);
    w.push(extra.length ? `(l.model_key = ANY(${p.add(keys)}) OR l.model_key = ANY(${p.add(extra)}))` : `l.model_key = ANY(${p.add(keys)})`);
  }
  const bodies = bodyClassesFor(q.bodyType) ?? bodyClassesFor(q.vehicleType);
  if (bodies) w.push(`l.body_class = ANY(${p.add(bodies)})`);
  if (q.priceMin != null) w.push(`l.price >= ${p.add(q.priceMin)}`);
  if (q.priceMax != null) w.push(`l.price <= ${p.add(q.priceMax)}`);
  if (q.yearMin != null) w.push(`l.year >= ${p.add(q.yearMin)}`);
  if (q.yearMax != null) w.push(`l.year <= ${p.add(q.yearMax)}`);
  // a new car with no odometer reading is fine for a mileage cap; a used car with none is not
  if (q.mileageMax != null) w.push(`(l.odometer <= ${p.add(q.mileageMax)} OR (l.odometer IS NULL AND l.condition = 'n'))`);
  if (q.used === true) w.push(`l.condition = 'u'`);
  if (q.used === false) w.push(`l.condition = 'n'`);
  if (q.state && /^[A-Za-z]{2}$/.test(q.state)) w.push(`l.state = ${p.add(q.state.toUpperCase())}`);
  if (q.doors != null) w.push(`l.doors = ${p.add(q.doors)}`);
  if (opts.strictColour) { // colour as a real filter (used first; the caller falls back to ranking when too few match)
    const ext = colourRegex(q.exteriorColor), int = colourRegex(q.interiorColor);
    if (ext) w.push(`l.ext_color ~* ${p.add(ext)}`);
    if (int) w.push(`l.int_color ~* ${p.add(int)}`);
  }
  return w;
}

/** Colour is a RANKING boost, not a filter: matching cars sort first so they fall inside the candidate pool; others stay (the per-car colour check still flags a mismatch). */
function colourRank(q: ListingsQuery, p: Params): string {
  const parts: string[] = [];
  const ext = colourRegex(q.exteriorColor), int = colourRegex(q.interiorColor);
  if (ext) parts.push(`(CASE WHEN l.ext_color ~* ${p.add(ext)} THEN 0 ELSE 1 END)`);
  if (int) parts.push(`(CASE WHEN l.int_color ~* ${p.add(int)} THEN 0 ELSE 1 END)`);
  return parts.length ? parts.join(" + ") : "0";
}

/** Electrified request (R4): cars whose model or trim wording matches sort first, so a bounded candidate pool is spent on them. Wording only ranks; nothing is excluded. */
function electrifiedRank(q: ListingsQuery, p: Params): string {
  const e = q.electrified;
  if (!e) return "0";
  const parts: string[] = [];
  const worded = (e.wordedModels ?? []).map(alnumKey).filter(Boolean);
  if (worded.length) parts.push(`l.model_key = ANY(${p.add(worded)})`);
  if (e.trimWording) parts.push(`(l.trim IS NOT NULL AND l.trim ~* ${p.add(e.trimWording)})`);
  for (const k of e.knownHybridOnly ?? []) parts.push(`(l.model_key = ${p.add(k.modelKey)} AND l.year >= ${p.add(k.fromYear)})`);
  return parts.length ? `(CASE WHEN ${parts.join(" OR ")} THEN 0 ELSE 1 END)` : "0";
}

/** The requested priority (cheapest, lowest mileage, newest) goes first in the local search; distance is the tie-break. */
export function localSortFor(sort: string | undefined, priceCap?: number | null): string {
  switch ((sort ?? "").toLowerCase()) {
    case "price.asc": return "(x.odometer IS NULL) ASC, x.price ASC NULLS LAST, ";
    case "mileage.asc": case "miles.asc": return "x.odometer ASC NULLS LAST, ";
    case "year.desc": return "x.year DESC NULLS LAST, ";
    default: return priceCap != null && Number.isFinite(priceCap) && priceCap > 0 ? `(x.price >= ${Math.floor(priceCap * 0.75)}) DESC, x.year DESC NULLS LAST, x.odometer ASC NULLS LAST, ` : ""; // with a ceiling, cars in the top quarter of the budget enter the candidate pool first, newest and lowest mileage first, so cheap nearby cars cannot crowd them out (everything is already inside the asked radius)
  }
}

function orderFor(sort: string | undefined, hasCeiling = false): string {
  switch ((sort ?? "").toLowerCase()) {
    case "price.asc": return "l.price ASC NULLS LAST, l.year DESC NULLS LAST";
    case "price.desc": return "l.price DESC NULLS LAST, l.year DESC NULLS LAST";
    case "year.desc": return "l.year DESC NULLS LAST, l.price ASC NULLS LAST";
    case "mileage.asc": case "miles.asc": return "l.odometer ASC NULLS LAST, l.price ASC NULLS LAST";
    default: return hasCeiling ? "l.year DESC NULLS LAST, l.price DESC NULLS LAST" : "l.year DESC NULLS LAST, l.price ASC NULLS LAST";
  }
}

function limitOf(q: ListingsQuery): number {
  const n = q.limit != null && Number.isFinite(q.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

async function countCapped(db: Queryable, whereSql: string, values: unknown[]): Promise<number | null> {
  const r = await db.query(`SELECT count(*)::int AS n FROM (SELECT 1 ${FROM} ${whereSql} LIMIT ${TOTAL_CAP + 1}) t`, values);
  const n = Number(r.rows[0]?.n ?? 0);
  return n > TOTAL_CAP ? null : n; // null = "more than we count", which the app treats as unknown, never as zero
}

/**
 * Per-model share of the candidate rows when a request names two or more models (SYS-20261021-017, option A). Without it the best-ranked 300 rows can all belong to one model
 * (many new cars at one dealer) and the others never reach the result. A model keeps at most this many of its best-ranked rows, the global order is unchanged, and the total
 * stays at the usual limit. Null (no change at all) for one model or none.
 */
function modelQuota(q: ListingsQuery, models: string[] | null, lim: number): number | null {
  if (!models || models.length === 0) return null;
  const keys = new Set([...models.map(alnumKey), ...(q.electrified?.extraModels ?? []).map(alnumKey)].filter(Boolean));
  if (keys.size < 2) return null;
  return Math.max(60, Math.ceil(lim / keys.size));
}

async function plainSearch(db: Queryable, q: ListingsQuery, models: string[] | null, strict = false): Promise<DbSearchResult> {
  const p = new Params();
  const w = whereFor(q, models, p, { strictColour: strict });
  const whereSql = w.length ? `WHERE ${w.join(" AND ")}` : "";
  const nWhere = p.values.length; // the count query uses only the filter parameters, not the ranking ones added below
  const cr = colourRank(q, p);
  const er = electrifiedRank(q, p);
  const quota = modelQuota(q, models, limitOf(q));
  const ord = `${er === "0" ? "" : er + ", "}${cr === "0" ? "" : cr + ", "}${orderFor(q.sort, q.priceMax != null)}`;
  const rows = quota == null
    ? await db.query(`SELECT ${SELECT_COLS}, NULL::float AS distance ${FROM} ${whereSql} ORDER BY ${ord} LIMIT ${limitOf(q)}`, p.values)
    : await db.query(
        `SELECT x.* FROM (SELECT ${SELECT_COLS}, NULL::float AS distance, ${er} AS elec_rank, ${cr} AS colour_rank, row_number() OVER (PARTITION BY l.model_key ORDER BY ${ord}) AS rn ${FROM} ${whereSql}) x ` +
          `WHERE x.rn <= ${quota} ORDER BY x.elec_rank ASC, x.colour_rank ASC, ${orderFor(q.sort, q.priceMax != null).replace(/\bl\./g, "x.")} LIMIT ${limitOf(q)}`,
        p.values,
      );
  const total = await countCapped(db, whereSql, p.values.slice(0, nWhere));
  return { rows: rows.rows as unknown as DbRow[], total, localApplied: false };
}

async function localSearch(db: Queryable, q: ListingsQuery, models: string[] | null, origin: { lat: number; lon: number }, radius: number, strict = false): Promise<DbSearchResult> {
  const lim = limitOf(q);
  const run = async (r: number | null, limit: number) => {
    const p = new Params();
    const w = whereFor(q, models, p, { strictColour: strict });
    const dist = haversine(p, origin.lat, origin.lon);
    w.push("l.lat IS NOT NULL");
    if (r != null) {
      const dLat = r / 69, dLon = r / (69 * Math.max(Math.cos((origin.lat * Math.PI) / 180), 0.2));
      w.push(`l.lat BETWEEN ${p.add(origin.lat - dLat)} AND ${p.add(origin.lat + dLat)}`, `l.lon BETWEEN ${p.add(origin.lon - dLon)} AND ${p.add(origin.lon + dLon)}`);
    }
    const cr = colourRank(q, p);
    const er = electrifiedRank(q, p);
    const inner = `SELECT ${SELECT_COLS}, ${dist} AS distance, ${cr} AS colour_rank, ${er} AS elec_rank, l.model_key AS model_key ${FROM} WHERE ${w.join(" AND ")}`;
    const ordX = `x.elec_rank ASC, x.colour_rank ASC, ${localSortFor(q.sort, q.priceMax)}x.distance ASC, x.price ASC NULLS LAST`;
    const quota = modelQuota(q, models, limit);
    const within = r != null ? `WHERE x.distance <= ${p.add(r)}` : "";
    const rows = quota == null
      ? await db.query(`SELECT * FROM (${inner}) x ${within} ORDER BY ${ordX} LIMIT ${limit}`, p.values)
      : await db.query(`SELECT x.* FROM (SELECT x.*, row_number() OVER (PARTITION BY x.model_key ORDER BY ${ordX}) AS rn FROM (${inner}) x ${within}) x WHERE x.rn <= ${quota} ORDER BY ${ordX} LIMIT ${limit}`, p.values);
    return rows.rows as unknown as DbRow[];
  };
  // Only the radius the buyer asked for. Never widened here: a thin result is reported, and widening is offered in the reply.
  const rows = await run(radius, lim);
  if (strict) return { rows, total: rows.length < lim ? rows.length : null, localApplied: true }; // strict colour: no "nearest anywhere" fallback, the caller decides
  if (rows.length === 0) return { rows: [], total: 0, localApplied: true }; // nothing within the radius: say so; never show remote cars
  return { rows, total: rows.length < lim ? rows.length : null, localApplied: true };
}

/** A colour request filters only when at least this many cars match; below that it only ranks (so a search is never emptied by colour naming). */
export const MIN_COLOUR_MATCHES = 3;

export async function searchRows(db: Queryable, q: ListingsQuery, models: string[] | null): Promise<DbSearchResult> {
  await ensureTrackingCols(db);
  const origin = q.zip && /^\d{5}$/.test(q.zip) ? zipcodes.lookup(q.zip) : undefined;
  const radius = q.radius != null && q.radius > 0 ? Math.min(q.radius, MAX_RADIUS) : DEFAULT_RADIUS_MILES;
  if (colourRegex(q.exteriorColor) || colourRegex(q.interiorColor)) {
    const strict = origin ? await localSearch(db, q, models, { lat: origin.latitude, lon: origin.longitude }, radius, true) : await plainSearch(db, q, models, true);
    if (strict.rows.length >= MIN_COLOUR_MATCHES) return strict;
  }
  if (origin) return localSearch(db, q, models, { lat: origin.latitude, lon: origin.longitude }, radius);
  return plainSearch(db, q, models);
}

export async function rowByVin(db: Queryable, vin: string): Promise<DbRow | null> {
  await ensureTrackingCols(db);
  const r = await db.query(`SELECT ${SELECT_COLS}, NULL::float AS distance ${FROM} WHERE l.vin = $1 LIMIT 1`, [vin.toUpperCase()]);
  return (r.rows[0] as unknown as DbRow) ?? null;
}

export async function modelFacets(db: Queryable, q: ListingsQuery, limit = 30): Promise<Array<{ value: string; count: number }>> {
  const p = new Params();
  const w = whereFor({ ...q, trimIn: undefined, electrified: undefined }, null, p, { skipModel: true });
  const r = await db.query(`SELECT l.model AS value, count(*)::int AS count ${FROM} ${w.length ? `WHERE ${w.join(" AND ")}` : ""} GROUP BY l.model ORDER BY count DESC, l.model LIMIT ${Math.max(1, Math.floor(limit))}`, p.values);
  return r.rows.map((x) => ({ value: String(x.value), count: Number(x.count) }));
}

/** Every model name in the catalogue, whatever the make. The caller caches it (lib/catalog-db-source.ts); used to find a model's electrified variants when a request names models but no make. */
export async function allModelNames(db: Queryable): Promise<string[]> {
  const r = await db.query("SELECT l.model AS value FROM listing l WHERE l.model IS NOT NULL AND l.model <> '' GROUP BY l.model");
  return r.rows.map((x) => String(x.value));
}

/** The trim names that exist for the asked make and model (any price, nationwide), with counts: lets the AI retry with a real trim name. */
export async function trimFacets(db: Queryable, q: ListingsQuery, models: string[] | null, limit = 12): Promise<Array<{ value: string; count: number }>> {
  const p = new Params();
  const w = whereFor({ ...q, priceMin: undefined, priceMax: undefined, zip: undefined, state: undefined, trimIn: undefined }, models, p);
  w.push("l.trim IS NOT NULL AND l.trim <> ''");
  const r = await db.query(`SELECT l.trim AS value, count(*)::int AS count ${FROM} WHERE ${w.join(" AND ")} GROUP BY l.trim ORDER BY count DESC, l.trim LIMIT ${Math.max(1, Math.floor(limit))}`, p.values);
  return r.rows.map((x) => ({ value: String(x.value), count: Number(x.count) }));
}
