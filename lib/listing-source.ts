/**
 * Listing-source facade (catalogue edition). Same function names and signatures the
 * route already used, now routing only to the catalogue sources: our own database
 * (default) or the live Edmunds/Impact catalogue API.
 */
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { configuredMode } from "./source-mode";
import { getCachedCatalogListing, searchCatalogListings } from "./catalog-source";
import { catalogDbModelFacets, getCatalogDbListing, searchCatalogDbListings } from "./catalog-db-source";

export type ActiveSource = "edmunds_catalog" | "catalog_db";

export function activeSource(): ActiveSource {
  return configuredMode();
}

export async function searchListingsLean(query: ListingsQuery): Promise<ListingsResponse> {
  return activeSource() === "edmunds_catalog" ? searchCatalogListings(query) : searchCatalogDbListings(query);
}

// Catalogue rows are already complete, so "full detail" is the stored row. A miss returns null,
// which the route already treats as a silent lean-row fallback.
export async function getListingByVin(vin: string): Promise<VehicleListing | null> {
  return activeSource() === "edmunds_catalog" ? getCachedCatalogListing(vin) : getCatalogDbListing(vin);
}

export async function searchListingByVinExact(vin: string): Promise<VehicleListing | null> {
  return getListingByVin(vin);
}

export async function getModelFacets(query: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  if (activeSource() === "edmunds_catalog") return []; // no facet endpoint; the correction step simply doesn't fire
  return catalogDbModelFacets(query);
}
