/**
 * Catalogue database search. Pure SQL building plus execution against anything with a pg-style query().
 * Filters mirror the app's ListingsQuery. Fields the feed cannot answer (drivetrain, transmission, colours,
 * accident history, owners) are ignored silently, exactly like the earlier catalogue source.
 */
import zipcodes from "zipcodes";
import type { ListingsQuery } from "../auto-dev-client";
import { alnumKey, bodyClassesFor } from "./normalize";

export interface Queryable { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

export interface DbRow {
  id: string; vin: string; year: number | null; make: string; model: string; trim: string | null;
  condition: string | null; price: number | null; odometer: number | null; body_raw: string | null; body_class: string | null;
  doors: number | null; ext_color: string | null; int_color: string | null; dealer_id: number | null; state: string | null; zip: string | null;
  image_url: string | null; link_override: string | null; dealer_name: string | null; dealer_city: string | null; dealer_street: string | null;
  distance: number | null;
}
export interface DbSearchResult { rows: DbRow[]; total: number | null; localApplied: boolean }

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const TOTAL_CAP = 10_000;
export const DEFAULT_RADIUS_MILES = 50;
export const MIN_LOCAL_RESULTS = 3;
export const MAX_LOCAL_FALLBACK = 12;
const MAX_RADIUS = 1000;

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

const SELECT_COLS = `l.id, l.vin, l.year, l.make, l.model, l.trim, l.condition, l.price, l.odometer, l.body_raw, l.body_class, l.doors,
  l.ext_color, l.int_color, l.dealer_id, l.state, l.zip, l.image_url, l.link_override, d.name AS dealer_name, d.city AS dealer_city, d.street AS dealer_street`;
const FROM = `FROM listing l LEFT JOIN dealer d ON d.id = l.dealer_id`;

function haversine(p: Params, lat: number, lon: number): string {
  const a = p.add(lat), b = p.add(lon);
  return `(3958.8 * 2 * asin(sqrt(power(sin(radians(l.lat - ${a}) / 2), 2) + cos(radians(${a})) * cos(radians(l.lat)) * power(sin(radians(l.lon - ${b}) / 2), 2))))`;
}

export function whereFor(q: ListingsQuery, models: string[] | null, p: Params, opts: { skipModel?: boolean } = {}): string[] {
  const w: string[] = [];
  if (q.make) w.push(`l.make_key = ${p.add(alnumKey(q.make))}`);
  if (!opts.skipModel && models && models.length) w.push(`l.model_key = ANY(${p.add(models.map(alnumKey).filter(Boolean))})`);
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
  return w;
}

function orderFor(sort: string | undefined): string {
  switch ((sort ?? "").toLowerCase()) {
    case "price.asc": return "l.price ASC NULLS LAST, l.year DESC NULLS LAST";
    case "price.desc": return "l.price DESC NULLS LAST, l.year DESC NULLS LAST";
    case "year.desc": return "l.year DESC NULLS LAST, l.price ASC NULLS LAST";
    case "mileage.asc": case "miles.asc": return "l.odometer ASC NULLS LAST, l.price ASC NULLS LAST";
    default: return "l.year DESC NULLS LAST, l.price ASC NULLS LAST";
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

async function plainSearch(db: Queryable, q: ListingsQuery, models: string[] | null): Promise<DbSearchResult> {
  const p = new Params();
  const w = whereFor(q, models, p);
  const whereSql = w.length ? `WHERE ${w.join(" AND ")}` : "";
  const rows = await db.query(`SELECT ${SELECT_COLS}, NULL::float AS distance ${FROM} ${whereSql} ORDER BY ${orderFor(q.sort)} LIMIT ${limitOf(q)}`, p.values);
  const total = await countCapped(db, whereSql, p.values);
  return { rows: rows.rows as unknown as DbRow[], total, localApplied: false };
}

async function localSearch(db: Queryable, q: ListingsQuery, models: string[] | null, origin: { lat: number; lon: number }, radius: number): Promise<DbSearchResult> {
  const lim = limitOf(q);
  const run = async (r: number | null, limit: number) => {
    const p = new Params();
    const w = whereFor(q, models, p);
    const dist = haversine(p, origin.lat, origin.lon);
    w.push("l.lat IS NOT NULL");
    if (r != null) {
      const dLat = r / 69, dLon = r / (69 * Math.max(Math.cos((origin.lat * Math.PI) / 180), 0.2));
      w.push(`l.lat BETWEEN ${p.add(origin.lat - dLat)} AND ${p.add(origin.lat + dLat)}`, `l.lon BETWEEN ${p.add(origin.lon - dLon)} AND ${p.add(origin.lon + dLon)}`);
    }
    const inner = `SELECT ${SELECT_COLS}, ${dist} AS distance ${FROM} WHERE ${w.join(" AND ")}`;
    const rows = await db.query(`SELECT * FROM (${inner}) x ${r != null ? `WHERE x.distance <= ${p.add(r)}` : ""} ORDER BY x.distance ASC, x.price ASC NULLS LAST LIMIT ${limit}`, p.values);
    return rows.rows as unknown as DbRow[];
  };
  let rows = await run(radius, lim);
  let used = radius;
  if (rows.length < MIN_LOCAL_RESULTS && radius < MAX_RADIUS) {
    const wider = Math.min(radius * 4, MAX_RADIUS);
    rows = await run(wider, lim); used = wider;
  }
  if (rows.length < MIN_LOCAL_RESULTS) rows = await run(null, MAX_LOCAL_FALLBACK); // nearest anywhere, never nothing
  if (rows.length === 0) return plainSearch(db, q, models); // no coordinates for any match: fall back to nationwide order
  return { rows, total: rows.length < lim ? rows.length : null, localApplied: true };
}

export async function searchRows(db: Queryable, q: ListingsQuery, models: string[] | null): Promise<DbSearchResult> {
  const origin = q.zip && /^\d{5}$/.test(q.zip) ? zipcodes.lookup(q.zip) : undefined;
  if (origin) {
    const radius = q.radius != null && q.radius > 0 ? Math.min(q.radius, MAX_RADIUS) : DEFAULT_RADIUS_MILES;
    return localSearch(db, q, models, { lat: origin.latitude, lon: origin.longitude }, radius);
  }
  return plainSearch(db, q, models);
}

export async function rowByVin(db: Queryable, vin: string): Promise<DbRow | null> {
  const r = await db.query(`SELECT ${SELECT_COLS}, NULL::float AS distance ${FROM} WHERE l.vin = $1 LIMIT 1`, [vin.toUpperCase()]);
  return (r.rows[0] as unknown as DbRow) ?? null;
}

export async function modelFacets(db: Queryable, q: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  const p = new Params();
  const w = whereFor(q, null, p, { skipModel: true });
  const r = await db.query(`SELECT l.model AS value, count(*)::int AS count ${FROM} ${w.length ? `WHERE ${w.join(" AND ")}` : ""} GROUP BY l.model ORDER BY count DESC, l.model LIMIT 30`, p.values);
  return r.rows.map((x) => ({ value: String(x.value), count: Number(x.count) }));
}
