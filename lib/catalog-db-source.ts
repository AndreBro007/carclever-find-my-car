/**
 * Catalogue DATABASE as a listing source (branch catalog-db/v1). Same four functions the listing-source facade already
 * expects, returning the EXISTING AutoDevListing shape so ranking, verification, cards and links are reused unchanged.
 * Server-side only. Needs DATABASE_URL (use a pooled connection string on serverless).
 *
 * Unlike the live-API catalogue source, the feed's own `condition` is available, so `used` is set from the data.
 */
import { Pool } from "pg";
import type { AutoDevListing, ListingsQuery, ListingsResponse } from "./auto-dev-client";
import { classModels } from "./vehicle-class";
import { buildTrackingUrl, type BodyClass } from "./catalog-db/normalize";
import { modelFacets, rowByVin, searchRows, type DbRow, type Queryable } from "./catalog-db/search";
import { cleanConnectionString } from "./catalog-db/conn";

export function catalogDbConfigured(): boolean {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim() !== "";
}

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    // query_timeout is enforced by the driver itself. (statement_timeout would be sent as a startup parameter, which a pooled
    // connection through PgBouncer can reject.)
    pool = new Pool({ connectionString: cleanConnectionString(process.env.DATABASE_URL), max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 6_000, query_timeout: 8_000 });
    pool.on("error", () => { /* an idle client dropped; the next query reconnects */ });
  }
  return pool;
}
/** Tests inject their own pool. */
let asOfCache: { t: number; v: string | undefined } | null = null;
export function setCatalogDbPoolForTests(p: Pool | null): void { pool = p; asOfCache = null; }

/** ISO time of the last successful daily load (cached 10 minutes); undefined if unknown. Never throws. */
export async function getCatalogDataAsOf(): Promise<string | undefined> {
  if (asOfCache && Date.now() - asOfCache.t < 10 * 60_000) return asOfCache.v;
  try {
    const r = await getPool().query("SELECT value FROM catalog_meta WHERE key = 'last_load'");
    const v = r.rows[0]?.value;
    asOfCache = { t: Date.now(), v: typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined };
    return asOfCache.v;
  } catch { return undefined; }
}

/** A sentence for the AI when the data is more than 48 hours old; null when fresh or unknown. */
export function dataStaleNote(asOf: string | undefined, nowMs: number = Date.now()): string | null {
  if (!asOf) return null;
  const t = Date.parse(asOf);
  if (Number.isNaN(t) || nowMs - t <= 48 * 3_600_000) return null;
  return `Listings were last refreshed on ${new Date(t).toISOString().slice(0, 10)}; availability and prices may have changed since.`;
}

const BODY_LABEL: Record<BodyClass, string> = {
  suv: "SUV", sedan: "Sedan", coupe: "Coupe", hatchback: "Hatchback", convertible: "Convertible",
  wagon: "Wagon", truck: "Pickup", van: "Van", minivan: "Minivan", other: "",
};

export function rowToListing(r: DbRow): AutoDevListing {
  const year = r.year ?? undefined;
  const make = r.make, model = r.model;
  const tracking = r.link_override ?? (year ? buildTrackingUrl({ id: r.id, vin: r.vin, year, make, model }) : undefined);
  const label = r.body_class ? BODY_LABEL[r.body_class as BodyClass] : "";
  return {
    vin: r.vin,
    catalog: { itemId: r.id, trackingUrl: tracking, ...(r.distance != null ? { distanceMiles: Math.round(Number(r.distance)) } : {}) },
    vehicle: {
      year, make, model,
      trim: r.trim ?? undefined,
      bodyStyle: label || r.body_raw || undefined,
      exteriorColor: r.ext_color ?? undefined,
      interiorColor: r.int_color ?? undefined,
      doors: r.doors ?? undefined,
    },
    retailListing: {
      price: r.price ?? undefined,
      miles: r.odometer ?? undefined,
      city: r.dealer_city ?? undefined,
      state: r.state ?? undefined,
      zip: r.zip ?? undefined,
      dealer: r.dealer_name ?? undefined,
      dealerId: r.dealer_id != null ? String(r.dealer_id) : undefined,
      used: r.condition === "u" ? true : r.condition === "n" ? false : undefined,
      primaryImage: r.image_url ?? undefined,
    },
  };
}

function modelsFor(q: ListingsQuery): string[] | null {
  const given = (q.model ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (given.length) return given;
  if (q.classHint) return classModels(q.classHint, { make: q.make, priceMax: q.priceMax, priceMin: q.priceMin });
  return null;
}

const SERVICE_ERROR = "The vehicle data service returned an error. This is a service issue, not a problem with the search itself.";

export async function searchCatalogDbListings(q: ListingsQuery): Promise<ListingsResponse> {
  if (!catalogDbConfigured() && !pool) return { data: [], total: 0, source: "catalog_db" };
  try {
    const res = await searchRows(getPool() as unknown as Queryable, q, modelsFor(q));
    return { data: res.rows.map(rowToListing), total: res.total, source: "catalog_db", localApplied: res.localApplied };
  } catch {
    return { data: [], total: 0, source: "catalog_db", error: SERVICE_ERROR };
  }
}

export async function getCatalogDbListing(vin: string): Promise<AutoDevListing | null> {
  if (!catalogDbConfigured() && !pool) return null;
  try {
    const row = await rowByVin(getPool() as unknown as Queryable, vin);
    return row ? rowToListing(row) : null;
  } catch {
    return null;
  }
}

export async function catalogDbModelFacets(q: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  if (!catalogDbConfigured() && !pool) return [];
  try {
    return await modelFacets(getPool() as unknown as Queryable, q);
  } catch {
    return [];
  }
}
