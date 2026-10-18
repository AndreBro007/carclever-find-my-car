/**
 * Listing source for the catalogue edition: our own catalogue database (Edmunds feed loaded nightly).
 * Thin facade so the route keeps its function names.
 */
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { catalogDbModelFacets, getCatalogDbListing, searchCatalogDbListings } from "./catalog-db-source";

export function searchListingsLean(query: ListingsQuery): Promise<ListingsResponse> {
  return searchCatalogDbListings(query);
}

export function getListingByVin(vin: string): Promise<VehicleListing | null> {
  return getCatalogDbListing(vin);
}

export function searchListingByVinExact(vin: string): Promise<VehicleListing | null> {
  return getCatalogDbListing(vin);
}

export function getModelFacets(query: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  return catalogDbModelFacets(query);
}
