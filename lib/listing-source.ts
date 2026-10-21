/**
 * Listing source for the catalogue edition: our own catalogue database (Edmunds feed loaded nightly).
 * Thin facade so the route keeps its function names.
 */
import type { VehicleListing, ListingsQuery, ListingsResponse } from "./listing-types";
import { catalogDbModelFacets, catalogDbAllModelNames, catalogDbTrimFacets, getCatalogDbListing, lookupCatalogDbVin, searchCatalogDbListings, type VinLookup } from "./catalog-db-source";

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

/** Every model name in the catalogue, cached for 30 minutes (used when a request names models but no make). */
export function getAllModelNames(): Promise<string[]> {
  return catalogDbAllModelNames();
}

/** The model names the database holds for the filters given, most common first. `limit` defaults to 30; route electrified-model lookup asks for all of a make's. */
export function getModelFacets(query: ListingsQuery, limit?: number): Promise<Array<{ value: string; count: number }>> {
  return catalogDbModelFacets(query, limit);
}

/** The trim names the database holds for the asked make and model (any price, nationwide), most common first. `limit` defaults to 12 (the no-match list); route trim resolution asks for all of them. */
export function getTrimFacets(query: ListingsQuery, limit?: number): Promise<Array<{ value: string; count: number }>> {
  return catalogDbTrimFacets(query, limit);
}
