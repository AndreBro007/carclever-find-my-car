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
 * 2026-09-03 v2 (host-AI-driven verification — see DECISIONS.md
 * SYS-20260903-005; supersedes the v1 same-day design that tried to make
 * this server call the Google Custom Search JSON API directly, which
 * turned out to be closed to new customers — see SYS-20260903-004):
 * the live search is performed by whichever host AI is calling this MCP
 * server, using ITS OWN web-search capability — not a vendor API this
 * server calls out to. resolveLinks() is synchronous again; it takes an
 * optional `hostSearchResult` describing what the host's search found
 * (see HostSearchResult below). No credential, no vendor, no per-query
 * cost on this server. Every case where hostSearchResult is absent or
 * inconclusive fails open to the exact pre-2026-09-03 default behavior —
 * this can only upgrade confidence in the destination, never remove or
 * corrupt it. See app/[transport]/route.ts's `resolve_vehicle_availability`
 * tool for how the host actually supplies this.
 */
import { buildEdmundsUrl, buildEdmundsCategoryUrl, wrapWithCJ } from "./edmunds-cj";
import type { AutoDevListing } from "./auto-dev-client";

/**
 * What the host AI's own web search found for one vehicle, per the required
 * flow: exact `site:edmunds.com "<VIN>"` search first; if that doesn't
 * produce a useful Edmunds result, exactly one fallback search using
 * `site:edmunds.com "<year> <make> <model> <trim>" "<dealer>" "<city/state>"`.
 * Never any other query (no stock/price/mileage/color/listing-date
 * searches) — this type intentionally has no fields for those.
 */
export interface HostSearchResult {
  vinFound: boolean; // did the exact-VIN search return a usable Edmunds result?
  edmundsFound: boolean; // did EITHER search (exact or fallback) find a usable Edmunds result?
  edmundsUrl: string | null; // the Edmunds URL found, if any — raw, not yet CJ-wrapped
  fallbackUsed: boolean; // true if the wider (non-VIN) search is what actually found edmundsUrl
}

export interface LinkResolution {
  affiliateUrl: string | null; // Edmunds destination behind "Check avail."; see checkAvailSource for what it actually points to
  affiliateFallbackUrl: string | null; // Edmunds category link (make/model, +trim when safely known, else +year if used) — live-tested to never dead-end; present whenever make+model are known. Not zip/price-filtered — see module doc. Year and trim are never combined.
  dealerListingUrl: string | null; // direct dealer/marketplace link (e.g. the real, live Carvana vdp link)
  isCarvana: boolean; // true when this listing is confirmed Carvana-sourced — see module doc above
  linkStatus: "both-available" | "edmunds-only" | "dealer-only" | "fallback-only" | "none-available";
  // Which tier affiliateUrl actually came from — diagnostic, doesn't change
  // what's rendered (results-card.ts still always shows "Check avail."):
  // "confirmed-exact"    — host's exact-VIN search confirmed this specific vehicle (the only tier treated as confirmation of THIS vehicle, per design)
  // "targeted-fallback"  — host's wider search found a close-match Edmunds page; useful destination, not a confirmation of this exact vehicle
  // "unconfirmed"        — no hostSearchResult supplied (host hasn't verified yet, or its search failed/timed out), or it ran and found nothing either way — falls open to the deterministic exact-VIN URL on a best-effort basis, exactly matching pre-2026-09-03 behavior
  // "none"               — no exact-VIN URL could even be constructed (Carvana, or missing vin/make/model/year)
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

export function resolveLinks(listing: AutoDevListing, hostSearchResult?: HostSearchResult): LinkResolution {
  const isCarvana = isCarvanaListing(listing);

  const vin = listing.vin;
  const make = listing.vehicle?.make;
  const model = listing.vehicle?.model;
  const year = listing.vehicle?.year;
  const trim = listing.vehicle?.trim;
  const used = listing.retailListing?.used;

  const rawEdmunds = isCarvana ? null : buildEdmundsUrl({ vin, make, model, year });

  let affiliateUrl: string | null = null;
  let checkAvailSource: LinkResolution["checkAvailSource"] = "none";

  if (rawEdmunds) {
    if (hostSearchResult?.vinFound && hostSearchResult.edmundsFound && hostSearchResult.edmundsUrl) {
      // Exact-VIN confirmation — the only tier treated as confirming THIS
      // specific vehicle (per design). Use our own deterministic canonical
      // URL once confirmed, not the host's raw returned URL string — avoids
      // carrying whatever tracking params/URL shape the host's search
      // result happened to include into the actual monetized destination.
      affiliateUrl = wrapWithCJ(rawEdmunds);
      checkAvailSource = "confirmed-exact";
    } else if (hostSearchResult?.edmundsFound && hostSearchResult.edmundsUrl) {
      // Wider/fallback search found a close-match page — a useful
      // destination, but explicitly NOT confirmation of this exact vehicle
      // (design requirement). Must use the host's actual found URL here
      // (not the deterministic exact-VIN URL — that's precisely what
      // wasn't confirmed).
      affiliateUrl = wrapWithCJ(hostSearchResult.edmundsUrl);
      checkAvailSource = "targeted-fallback";
    } else {
      // No hostSearchResult (host hasn't verified this vehicle yet, or its
      // search failed/timed out), or it ran and found nothing either way —
      // fail open to the pre-2026-09-03 default rather than dropping the
      // CTA. This is a deliberate design choice, not a bug: a search
      // failure can only fail to upgrade confidence, never remove the
      // existing CJ-monetized link.
      affiliateUrl = wrapWithCJ(rawEdmunds);
      checkAvailSource = "unconfirmed";
    }
  }
  // else: rawEdmunds is null (Carvana, or missing vin/make/model/year) —
  // affiliateUrl stays null, checkAvailSource stays "none". No exact-VIN
  // URL exists to confirm or fall back from in this case; affiliateUrl
  // relies entirely on affiliateFallbackUrl below.

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
