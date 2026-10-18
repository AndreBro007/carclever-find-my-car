/**
 * Listing-source mode for the catalogue edition.
 *
 *   LISTING_SOURCE=catalog_db       -> our own catalogue DATABASE (DATABASE_URL). This is the default.
 *   LISTING_SOURCE=edmunds_catalog  -> live Edmunds/Impact catalogue API (not used in production).
 *
 * The third-party listings API and its exhaustion breaker were removed from this
 * edition. An unset or unrecognised value now means the database, so a missing
 * variable can no longer change which output mode the app runs in.
 */
export type ListingSourceMode = "edmunds_catalog" | "catalog_db";

export function configuredMode(): ListingSourceMode {
  const v = (process.env.LISTING_SOURCE ?? "catalog_db").trim().toLowerCase();
  return v === "edmunds_catalog" ? "edmunds_catalog" : "catalog_db";
}
