/**
 * Catalogue DATABASE as a listing source (branch catalog-db/v1). Same four functions the listing-source facade already
 * expects, returning the EXISTING VehicleListing shape so ranking, verification, cards and links are reused unchanged.
 * Server-side only. Needs DATABASE_URL (use a pooled connection string on serverless).
 *
 * Unlike the live-API catalogue source, the feed's own `condition` is available, so `used` is set from the data.
 */
import { Pool } from "pg";
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { buildTrackingUrl, alnumKey, type BodyClass } from "./catalog-db/normalize";
import { modelFacets, allModelNames, trimFacets, rowByVin, searchRows, stockPhotos, type DbRow, type Queryable } from "./catalog-db/search";
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
/** Shared pool for the search log and status page (server-side only). */
export function getCatalogPool(): Pool { return getPool(); }

/** Tests inject their own pool. */
export function setCatalogDbPoolForTests(p: Pool | null): void { pool = p; modelNamesCache = null; }

// All model names, kept for 30 minutes per server instance: the list changes only with the nightly load, and one scan of the table is the cost of finding electrified variants
// for a request that names models but no make (the usual shape when a buyer's need spans several makes).
let modelNamesCache: { at: number; names: string[] } | null = null;
const MODEL_NAMES_TTL_MS = 30 * 60 * 1000;
export async function catalogDbAllModelNames(): Promise<string[]> {
  if (!catalogDbConfigured() && !pool) return [];
  if (modelNamesCache && Date.now() - modelNamesCache.at < MODEL_NAMES_TTL_MS) return modelNamesCache.names;
  try {
    const names = await allModelNames(getPool() as unknown as Queryable);
    modelNamesCache = { at: Date.now(), names };
    return names;
  } catch (e) {
    console.error("[catalog-db] model names failed", (e as Error).message);
    return [];
  }
}

const BODY_LABEL: Record<BodyClass, string> = {
  suv: "SUV", sedan: "Sedan", coupe: "Coupe", hatchback: "Hatchback", convertible: "Convertible",
  wagon: "Wagon", truck: "Pickup", van: "Van", minivan: "Minivan", other: "",
};

export function rowToListing(r: DbRow): VehicleListing {
  const year = r.year ?? undefined;
  const make = r.make, model = r.model;
  const tracking = r.link_override ?? (year ? buildTrackingUrl({ id: r.id, vin: r.vin, year, make, model }) : undefined);
  const label = r.body_class ? BODY_LABEL[r.body_class as BodyClass] : "";
  return {
    vin: r.vin,
    catalog: {
      itemId: r.id, trackingUrl: tracking,
      ...(r.distance != null ? { distanceMiles: Math.round(Number(r.distance)) } : {}),
      ...(r.first_seen ? { firstSeen: String(r.first_seen).slice(0, 10) } : {}),
      ...(r.price_prev != null ? { priceWas: Number(r.price_prev) } : {}),
      ...(r.price_changed_at ? { priceChangedAt: String(r.price_changed_at).slice(0, 10) } : {}),
    },
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
  return null;
}

export const CATALOG_SERVICE_ERROR = "Our car database is on a coffee break.";
const SERVICE_ERROR = CATALOG_SERVICE_ERROR;

export async function searchCatalogDbListings(q: ListingsQuery): Promise<ListingsResponse> {
  if (!catalogDbConfigured() && !pool) return { data: [], total: 0, source: "catalog_db", error: SERVICE_ERROR };
  try {
    const res = await searchRows(getPool() as unknown as Queryable, q, modelsFor(q));
    return { data: res.rows.map(rowToListing), total: res.total, source: "catalog_db", localApplied: res.localApplied };
  } catch {
    return { data: [], total: 0, source: "catalog_db", error: SERVICE_ERROR };
  }
}

/** Review finding 7: "no such VIN" and "the lookup failed" are different answers and must never be mixed up. */
export type VinLookup = { status: "found"; listing: VehicleListing } | { status: "absent" } | { status: "error" };

export async function lookupCatalogDbVin(vin: string): Promise<VinLookup> {
  if (!catalogDbConfigured() && !pool) return { status: "error" };
  try {
    const row = await rowByVin(getPool() as unknown as Queryable, vin);
    return row ? { status: "found", listing: rowToListing(row) } : { status: "absent" };
  } catch {
    return { status: "error" };
  }
}

export async function getCatalogDbListing(vin: string): Promise<VehicleListing | null> {
  const r = await lookupCatalogDbVin(vin);
  return r.status === "found" ? r.listing : null;
}

export async function catalogDbModelFacets(q: ListingsQuery, limit?: number): Promise<Array<{ value: string; count: number }>> {
  if (!catalogDbConfigured() && !pool) return [];
  try {
    return await modelFacets(getPool() as unknown as Queryable, q, limit);
  } catch {
    return [];
  }
}

export async function catalogDbTrimFacets(q: ListingsQuery, limit?: number): Promise<Array<{ value: string; count: number }>> {
  if (!catalogDbConfigured() && !pool) return [];
  try {
    return await trimFacets(getPool() as unknown as Queryable, q, modelsFor(q), limit);
  } catch {
    return [];
  }
}

// ---- Stock photo for a car with no photo of its own (23 Oct 2026; see lib/stock-photo-svg.ts) ----
// A donor is stable between the nightly loads, so it is remembered for 10 minutes per server instance, per make, model, year, colour and trim.
const stockCache = new Map<string, { at: number; photo: { imageUrl: string; colourMatched: boolean } | null }>();
const STOCK_TTL_MS = 10 * 60 * 1000;
export function resetStockPhotoCacheForTests(): void { stockCache.clear(); }

/** A photo of another listing of the same make, model and year for this car, or null. Never throws: any failure means "no stock photo" and the card keeps its placeholder. STOCK_PHOTOS=off switches it off. */
export async function stockPhotoFor(listing: VehicleListing): Promise<{ imageUrl: string; colourMatched: boolean } | null> {
  try {
    if (process.env.STOCK_PHOTOS === "off") return null;
    if (!catalogDbConfigured() && !pool) return null;
    const v = listing.vehicle;
    if (!v?.make || !v?.model || v.year == null || !Number.isFinite(Number(v.year))) return null;
    const req = { vin: listing.vin, makeKey: alnumKey(String(v.make)), modelKey: alnumKey(String(v.model)), year: Number(v.year), color: String(v.exteriorColor ?? "").toLowerCase().trim(), trim: String(v.trim ?? "") };
    const key = `${req.makeKey}|${req.modelKey}|${req.year}|${req.color}|${req.trim}`;
    const hit = stockCache.get(key);
    if (hit && Date.now() - hit.at < STOCK_TTL_MS) return hit.photo;
    const rows = await stockPhotos(getPool() as unknown as Queryable, [req]);
    const photo = rows[0] ? { imageUrl: rows[0].imageUrl, colourMatched: rows[0].colourMatched } : null;
    if (stockCache.size > 500) stockCache.clear();
    stockCache.set(key, { at: Date.now(), photo });
    return photo;
  } catch {
    return null;
  }
}
