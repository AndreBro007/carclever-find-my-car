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
 *
 * Fallback precision (2026-08-23/24, see lib/edmunds-cj.ts buildEdmundsCategoryUrl
 * for the full live-test writeup): the fallback is condition-aware
 * (used/new) and prefers trim when safely known (both conditions
 * confirmed live to genuinely narrow the destination), falling back to
 * year for USED (also confirmed) when trim is missing/unsafe, or the
 * bare make/model otherwise. Year and trim are never combined — confirmed
 * live-tested and broken in every shape tried. The fallback does NOT
 * filter by the user's location or price ceiling — live testing confirmed
 * Edmunds ignores both the `zip` and `price` query parameters on this URL
 * shape, so those are never sent. Any user-facing text describing this
 * fallback must not claim it narrows to the user's area or budget.
 *
 * 2026-09-03 addition (Andre-approved live confirmation, see
 * lib/edmunds-search.ts for the full design/blocker/cost writeup):
 * resolveLinks() is now async. Before trusting the deterministic exact-VIN
 * URL, it optionally runs a live Google Custom Search confirmation (if
 * GOOGLE_CSE_API_KEY/GOOGLE_CSE_CX are configured) and, if that misses,
 * one targeted non-VIN search (year+make+model+trim+dealer/location only —
 * never stock/price/mileage/color). Every failure mode (missing
 * credentials, network error, timeout, no results) fails open to the
 * exact pre-2026-09-03 behavior — this addition can only upgrade
 * confidence in the destination, never remove or corrupt it.
 */
import { buildEdmundsUrl, buildEdmundsCategoryUrl, wrapWithCJ } from "./edmunds-cj";
import { confirmExactVinListing, findTargetedEdmundsFallback, isGoogleSearchConfigured } from "./edmunds-search";
import type { AutoDevListing } from "./auto-dev-client";

export interface LinkResolution {
  affiliateUrl: string | null; // Edmunds destination behind "Check avail."; see checkAvailSource for what it actually points to
  affiliateFallbackUrl: string | null; // Edmunds category link (make/model, +trim when safely known, else +year if used) — live-tested to never dead-end; present whenever make+model are known. Not zip/price-filtered — see module doc. Year and trim are never combined.
  dealerListingUrl: string | null; // direct dealer/marketplace link (e.g. the real, live Carvana vdp link)
  isCarvana: boolean; // true when this listing is confirmed Carvana-sourced — see module doc above
  linkStatus: "both-available" | "edmunds-only" | "dealer-only" | "fallback-only" | "none-available";
  // 2026-09-03 addition (Andre-approved live Google-search confirmation,
  // see lib/edmunds-search.ts): which tier affiliateUrl actually came from.
  // "unconfirmed" means Google Search wasn't configured, or ran but found
  // no evidence either way — affiliateUrl is then the deterministic exact
  // VIN URL used on a best-effort basis, exactly matching pre-2026-09-03
  // behavior. This field is diagnostic only; it does not change what's
  // rendered (results-card.ts still shows "Check avail." either way).
  checkAvailSource: "confirmed-exact" | "targeted-fallback" | "unconfirmed" | "none";
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

export async function resolveLinks(listing: AutoDevListing): Promise<LinkResolution> {
  const isCarvana = isCarvanaListing(listing);

  const vin = listing.vin;
  const make = listing.vehicle?.make;
  const model = listing.vehicle?.model;
  const year = listing.vehicle?.year;
  const trim = listing.vehicle?.trim;
  const used = listing.retailListing?.used;
  const dealer = listing.retailListing?.dealer;
  const location = [listing.retailListing?.city, listing.retailListing?.state].filter(Boolean).join(", ") || null;

  const rawEdmunds = isCarvana ? null : buildEdmundsUrl({ vin, make, model, year });

  // 2026-09-03 (Andre-approved, see lib/edmunds-search.ts module doc for
  // the credential blocker and cost/volume notes): live confirmation of
  // the exact VIN listing, with one targeted non-VIN fallback search when
  // the exact one isn't confirmed. Every branch below fails open to the
  // pre-existing default (unconfirmed exact URL, or null) — a Google
  // Search outage or missing credential can never remove or corrupt the
  // existing CJ-monetized destination, only fail to upgrade its confidence.
  let affiliateUrl: string | null = null;
  let checkAvailSource: LinkResolution["checkAvailSource"] = "none";

  if (rawEdmunds && isGoogleSearchConfigured()) {
    const confirmedUrl = await confirmExactVinListing(vin);
    if (confirmedUrl) {
      // Use our own deterministic URL once Google confirms it's indexed,
      // not Google's returned URL string — avoids trusting Google's own
      // URL shape/tracking params for the actual monetized destination.
      affiliateUrl = wrapWithCJ(rawEdmunds);
      checkAvailSource = "confirmed-exact";
    } else {
      const targetedUrl = await findTargetedEdmundsFallback({ year, make, model, trim, dealer, location });
      if (targetedUrl) {
        affiliateUrl = wrapWithCJ(targetedUrl);
        checkAvailSource = "targeted-fallback";
      } else {
        // Neither search found evidence either way — fail open to the
        // pre-existing default rather than dropping the CTA.
        affiliateUrl = wrapWithCJ(rawEdmunds);
        checkAvailSource = "unconfirmed";
      }
    }
  } else if (rawEdmunds) {
    // Google Search not configured — exact pre-2026-09-03 behavior,
    // zero regression.
    affiliateUrl = wrapWithCJ(rawEdmunds);
    checkAvailSource = "unconfirmed";
  }

  const rawFallback = buildEdmundsCategoryUrl(
    { make, model, year, trim },
    { used },
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

  return { affiliateUrl, affiliateFallbackUrl, dealerListingUrl, isCarvana, linkStatus, checkAvailSource };
}
