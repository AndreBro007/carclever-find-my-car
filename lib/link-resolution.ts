/**
 * Link resolution — Edmunds primary (reliable, revenue-earning), dealer link
 * secondary (known unreliable, attempted and silently dropped if broken).
 * Right-sized per SYS-20260812-024: no elaborate URL-001 classification
 * subsystem, since the dealer link is a convenience, not the safeguard.
 */
import { buildEdmundsUrl, wrapWithCJ } from "./edmunds-cj";
import type { AutoDevListing } from "./auto-dev-client";

export interface LinkResolution {
  affiliateUrl: string | null;
  dealerListingUrl: string | null;
  linkStatus: "both-available" | "edmunds-only" | "dealer-only" | "none-available";
}

// Known-bad URL patterns worth dropping without even attempting a request —
// cheap, obvious cases (SYS-20260812-016/021/024).
const OBVIOUSLY_BROKEN_PATTERNS = [/^$/, /^javascript:/i, /provider-transport/i];

function looksObviouslyBroken(url: string | undefined): boolean {
  if (!url) return true;
  return OBVIOUSLY_BROKEN_PATTERNS.some((p) => p.test(url));
}

export function resolveLinks(listing: AutoDevListing): LinkResolution {
  const rawEdmunds = buildEdmundsUrl({
    vin: listing.vin,
    make: listing.make,
    model: listing.model,
    year: listing.year,
  });
  const affiliateUrl = rawEdmunds ? wrapWithCJ(rawEdmunds) : null;

  const dealerUrl = typeof listing.vdp === "string" ? listing.vdp : undefined;
  const dealerListingUrl = looksObviouslyBroken(dealerUrl) ? null : dealerUrl ?? null;

  let linkStatus: LinkResolution["linkStatus"];
  if (affiliateUrl && dealerListingUrl) linkStatus = "both-available";
  else if (affiliateUrl) linkStatus = "edmunds-only";
  else if (dealerListingUrl) linkStatus = "dealer-only";
  else linkStatus = "none-available";

  return { affiliateUrl, dealerListingUrl, linkStatus };
}
