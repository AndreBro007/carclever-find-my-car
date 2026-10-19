/**
 * Catalogue DATABASE as a listing source (branch catalog-db/v1). Same four functions the listing-source facade already
 * expects, returning the EXISTING VehicleListing shape so ranking, verification, cards and links are reused unchanged.
 * Server-side only. Needs DATABASE_URL (use a pooled connection string on serverless).
 *
 * Unlike the live-API catalogue source, the feed's own `condition` is available, so `used` is set from the data.
 */
import { Pool } from "pg";
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { buildTrackingUrl, type BodyClass } from "./catalog-db/normalize";
import { modelFacets, trimFacets, rowByVin, searchRows, type DbRow, type Queryable } from "./catalog-db/search";
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
export function setCatalogDbPoolForTests(p: Pool | null): void { pool = p; }

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

export async function catalogDbModelFacets(q: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  if (!catalogDbConfigured() && !pool) return [];
  try {
    return await modelFacets(getPool() as unknown as Queryable, q);
  } catch {
    return [];
  }
}

export async function catalogDbTrimFacets(q: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  if (!catalogDbConfigured() && !pool) return [];
  try {
    return await trimFacets(getPool() as unknown as Queryable, q, modelsFor(q));
  } catch {
    return [];
  }
}
