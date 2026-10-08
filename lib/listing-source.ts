/**
 * Listing-source facade (spike/edmunds-catalog-mode). Same four function names and
 * signatures the route already imported from auto-dev-client, so the route needs
 * only an import swap. Existing Auto.dev code is untouched and is still what runs
 * unless the mode (or the exhaustion breaker) says otherwise.
 */
import * as autoDev from "./auto-dev-client";
import type { AutoDevListing, ListingsQuery, ListingsResponse } from "./auto-dev-client";
import { autoDevLooksExhausted, configuredMode } from "./source-mode";
import { catalogConfigured, getCachedCatalogListing, searchCatalogListings } from "./catalog-source";

export type ActiveSource = "auto_dev" | "edmunds_catalog";

export function activeSource(): ActiveSource {
  const mode = configuredMode();
  if (mode === "edmunds_catalog") return catalogConfigured() ? "edmunds_catalog" : "auto_dev";
  if (mode === "auto" && autoDevLooksExhausted() && catalogConfigured()) return "edmunds_catalog";
  return "auto_dev";
}

export async function searchListingsLean(query: ListingsQuery): Promise<ListingsResponse> {
  if (activeSource() === "edmunds_catalog") return searchCatalogListings(query);
  const primary = await autoDev.searchListingsLean(query);
  // Auto mode: if Auto.dev just failed (or flagged itself exhausted) try the catalogue
  // for THIS request too, so the user never sees the outage.
  if (configuredMode() === "auto" && catalogConfigured() && (primary.error || autoDevLooksExhausted())) {
    const fallback = await searchCatalogListings(query);
    if (fallback.data.length > 0) return fallback;
  }
  return primary;
}

// Catalogue rows are already complete, so "full detail" in catalogue mode is the cached row.
// A miss returns null, which the route already treats as a silent lean-row fallback.
export async function getListingByVin(vin: string): Promise<AutoDevListing | null> {
  if (activeSource() === "edmunds_catalog") return getCachedCatalogListing(vin);
  return autoDev.getListingByVin(vin);
}

export async function searchListingByVinExact(vin: string): Promise<AutoDevListing | null> {
  if (activeSource() === "edmunds_catalog") return getCachedCatalogListing(vin);
  return autoDev.searchListingByVinExact(vin);
}

export async function getModelFacets(query: ListingsQuery): Promise<Array<{ value: string; count: number }>> {
  if (activeSource() === "edmunds_catalog") return []; // no facet endpoint; correction step simply doesn't fire
  return autoDev.getModelFacets(query);
}
