/**
 * Listing source for the catalogue edition: our own catalogue database (Edmunds feed loaded nightly).
 * Thin facade so the route keeps its function names.
 */
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { catalogDbModelFacets, catalogDbTrimFacets, getCatalogDbListing, lookupCatalogDbVin, searchCatalogDbListings, type VinLookup } from "./catalog-db-source";

export function searchListingsLean(query: ListingsQuery): Promise<ListingsResponse> {
  return searchCatalogDbListings(query);
}

export function getListingByVin(vin: string): Promise<VehicleListing | null> {
  return getCatalogDbListing(vin);
}

export function searchListingByVinExact(vin: string): Promise<VehicleListing | null> {
  return getCatalogDbListing(vin);
}

/** Found, absent or failed: the three tools that look a VIN up use this so a database failure is never reported as "not listed". */
export function lookupListingByVin(vin: string): Promise<VinLookup> {
  return lookupCatalogDbVin(vin);
}

export function getModelFacets(query: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  return catalogDbModelFacets(query);
}

export function getTrimFacets(query: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  return catalogDbTrimFacets(query);
}
