/**
 * Link resolution — every result gets a live-tested-reliable path to
 * Edmunds/CJ revenue, plus the real dealer/marketplace link where usable.
 *
 * Design (2026-08-17, DECISIONS.md SYS-20260817-001/002): a VIN-specific
 * Edmunds featured-listing link can be dead (sold/delisted, or the listing
 * was never in Edmunds' own feed) with no predictable field to catch it in
 * advance — except one hard exception: Carvana. Live-tested 10/10 Carvana
 * listings, 100% dead on Edmunds every time (Carvana is a direct-to-consumer
 * seller with no reason to appear in a competing franchise-dealer affiliate
 * feed) — so a Carvana VIN link is never even constructed.
 *
 * For every other case, rather than trying to predict which VIN links will
 * be dead (no reliable signal found — confidence score and vdp domain type
 * were both tested and ruled out), every result also gets an Edmunds
 * category-search fallback link (make/model, no VIN) that live-testing
 * confirmed never dead-ends, even for a rare/discontinued model with zero
 * local inventory (Edmunds auto-expands the search radius). This is the
 * safety net that actually closes the user-trust gap, independent of
 * whether the primary VIN link happens to still resolve.
 */
import { buildEdmundsUrl, buildEdmundsCategoryUrl, wrapWithCJ } from "./edmunds-cj";
import type { AutoDevListing } from "./auto-dev-client";

export interface LinkResolution {
  affiliateUrl: string | null; // Edmunds VIN-specific link; null if unusable OR known-dead (Carvana)
  affiliateFallbackUrl: string | null; // Edmunds category link — live-tested to never dead-end; present whenever make+model are known
  dealerListingUrl: string | null; // direct dealer/marketplace link (e.g. the real, live Carvana vdp link)
  isCarvana: boolean; // true when this listing is confirmed Carvana-sourced — see module doc above
  linkStatus: "both-available" | "edmunds-only" | "dealer-only" | "fallback-only" | "none-available";
}

// Known-bad URL patterns worth dropping without even attempting a request —
// cheap, obvious cases (SYS-20260812-016/021/024).
const OBVIOUSLY_BROKEN_PATTERNS = [/^$/, /^javascript:/i, /provider-transport/i];

function looksObviouslyBroken(url: string | undefined): boolean {
  if (!url) return true;
  return OBVIOUSLY_BROKEN_PATTERNS.some((p) => p.test(url));
}

function isCarvanaListing(listing: AutoDevListing): boolean {
  const dealer = (listing.retailListing?.dealer ?? "").toLowerCase();
  const vdp = (listing.retailListing?.vdp ?? "").toLowerCase();
  return dealer === "carvana" || vdp.includes("carvana.com");
}

/**
 * @param priceMax optional — the user's own stated search budget (not a
 *   specific listing's price), used only to shape the category-fallback URL.
 *   Omit when unknown; the fallback still works fine unfiltered.
 */
export function resolveLinks(listing: AutoDevListing, priceMax?: number): LinkResolution {
  const isCarvana = isCarvanaListing(listing);

  const rawEdmunds = isCarvana
    ? null
    : buildEdmundsUrl({
        vin: listing.vin,
        make: listing.vehicle?.make,
        model: listing.vehicle?.model,
        year: listing.vehicle?.year,
      });
  const affiliateUrl = rawEdmunds ? wrapWithCJ(rawEdmunds) : null;

  const rawFallback = buildEdmundsCategoryUrl(
    { make: listing.vehicle?.make, model: listing.vehicle?.model },
    { zip: listing.retailListing?.zip ?? undefined, priceMax },
  );
  const affiliateFallbackUrl = rawFallback ? wrapWithCJ(rawFallback) : null;

  const dealerUrlRaw = listing.retailListing?.vdp;
  const dealerListingUrl = looksObviouslyBroken(dealerUrlRaw) ? null : dealerUrlRaw ?? null;

  let linkStatus: LinkResolution["linkStatus"];
  if (affiliateUrl && dealerListingUrl) linkStatus = "both-available";
  else if (affiliateUrl) linkStatus = "edmunds-only";
  else if (dealerListingUrl) linkStatus = "dealer-only";
  else if (affiliateFallbackUrl) linkStatus = "fallback-only";
  else linkStatus = "none-available";

  return { affiliateUrl, affiliateFallbackUrl, dealerListingUrl, isCarvana, linkStatus };
}
