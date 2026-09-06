/**
 * Link resolution — every result gets a live-tested-reliable path to
 * Edmunds/CJ revenue, plus the real dealer/marketplace link where usable.
 *
 * Design (2026-08-17, DECISIONS.md SYS-20260817-001/002): a VIN-specific
 * Edmunds featured-listing link can be dead (sold/delisted, or the listing
 * was never in Edmunds' own feed) with no predictable field to catch it in
 * advance. For every case, every result also gets an Edmunds category-search
 * fallback link (make/model, no VIN) that live-testing confirmed never
 * dead-ends, even for a rare/discontinued model with zero local inventory
 * (Edmunds auto-expands the search radius). This is the safety net that
 * actually closes the user-trust gap, independent of whether the primary
 * link happens to still resolve.
 *
 * Fallback precision (2026-08-23/24, see lib/edmunds-cj.ts buildEdmundsCategoryUrl
 * for the full live-test writeup): the fallback is condition-aware
 * (used/new) and prefers trim when safely known, falling back to year for
 * USED when trim is missing/unsafe, or the bare make/model otherwise. Year
 * and trim are never combined — confirmed live-tested and broken in every
 * shape tried. The fallback does NOT filter by the user's location or
 * price ceiling — Edmunds ignores both the `zip` and `price` query
 * parameters on this URL shape.
 *
 * CPO (2026-09-03, SYS-20260903-011): a known-CPO listing routes to the
 * dedicated `used-certified-pre-owned-{make}-{model}` tier regardless of
 * the close/loose distinction below — no confirmed trim-level CPO URL
 * shape exists on Edmunds, so trim is never combined with CPO.
 *
 * 2026-09-04 (SYS-20260904-002 — supersedes SYS-20260903-005 through -013,
 * the host-AI-driven live-search design): that design worked and was
 * verified live, but cost 85-100 seconds per search — the live search
 * phase alone was 55-60% of total time, with no way to reduce it (the host
 * can only run one search at a time). Direct browser verification (not
 * proxied through Google search, which was found to significantly
 * undercount real hits — see DECISIONS.md SYS-20260904-001) established
 * real hit rates of ~77% for Used vehicles and ~15-23% for New — a large
 * enough gap to justify a fully deterministic, condition-aware design with
 * zero live search, approved by both Andre and ChatGPT (business-strategy
 * review) after reviewing the full data:
 *
 *   - Used vehicles: "Check avail." uses the exact-VIN URL (may 404 — same
 *     risk that has always existed; softened by Edmunds' own auto-populated
 *     similar-vehicles grid on a dead page, confirmed live and consistent,
 *     plus our own "View similar"). "View similar" uses the close
 *     (trim-specific) category URL — an upgrade from always-loose.
 *   - New vehicles: no exact-VIN attempt at all (the ~15-23% hit rate
 *     doesn't justify presenting it as if it might work). "Check avail."
 *     uses the close (trim-specific) category URL instead. "View similar"
 *     uses the loose (bare make/model) category URL.
 *   - Carvana listings: treated identically to New (same close/loose split)
 *     rather than the previous null-Check-avail single-button experience —
 *     Carvana's exact-VIN link is confirmed 100% dead (a stronger, already-
 *     established fact, not a probabilistic one), so it's at least as safe
 *     a candidate for this treatment as New vehicles are.
 *
 * resolveLinks() is fully synchronous with zero network dependency of any
 * kind — this server does not call out to Edmunds, Google, or any search
 * vendor at request time.
 */
import { buildEdmundsUrl, buildEdmundsCategoryUrl, wrapWithCJ } from "./edmunds-cj";
import type { AutoDevListing } from "./auto-dev-client";

export interface LinkResolution {
  affiliateUrl: string | null; // Edmunds destination behind "Check avail."; see checkAvailSource for which tier
  affiliateFallbackUrl: string | null; // Edmunds destination behind "View similar"; see module doc for close vs. loose
  dealerListingUrl: string | null; // direct dealer/marketplace link (e.g. the real, live Carvana vdp link) — never routed to as a user-facing link, kept for internal diagnostics only
  isCarvana: boolean; // true when this listing is confirmed Carvana-sourced — see module doc above
  linkStatus: "both-available" | "edmunds-only" | "dealer-only" | "fallback-only" | "none-available";
  // Which tier affiliateUrl actually came from — diagnostic, doesn't change
  // what's rendered (results-card.ts still always shows "Check avail."):
  // "exact" — Used vehicle, the deterministic exact-VIN URL (may 404, same risk as always)
  // "close" — New or Carvana, the trim-specific category URL (no exact-VIN attempt made at all)
  // "none"  — no destination could be constructed (missing make/model)
  checkAvailSource: "exact" | "close" | "none";
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

export function resolveLinks(listing: AutoDevListing): LinkResolution {
  const isCarvana = isCarvanaListing(listing);

  const vin = listing.vin;
  const make = listing.vehicle?.make;
  const model = listing.vehicle?.model;
  const year = listing.vehicle?.year;
  const trim = listing.vehicle?.trim;
  const used = listing.retailListing?.used;
  const cpo = listing.retailListing?.cpo === true;

  // New is only ever true on an explicit `used === false` — unknown/missing
  // stays on the Used path (matches buildEdmundsCategoryUrl's own existing
  // "isUsed = opts?.used !== false" default). Carvana always takes the
  // New/close-loose path regardless of its own used flag, per the design
  // above.
  const treatAsNewOrCarvana = isCarvana || used === false;

  let affiliateUrl: string | null = null;
  let checkAvailSource: LinkResolution["checkAvailSource"] = "none";

  if (treatAsNewOrCarvana) {
    // Check avail. -> close (trim-specific) category URL. No exact-VIN
    // attempt at all for this branch — see module doc for why.
    const rawClose = buildEdmundsCategoryUrl({ make, model, year, trim }, { used, cpo });
    if (rawClose) {
      affiliateUrl = wrapWithCJ(rawClose);
      checkAvailSource = "close";
    }
  } else {
    // Used: Check avail. -> exact-VIN deterministic URL. May 404 — this is
    // the same risk that has always existed on this path, softened by
    // Edmunds' own similar-vehicles grid on a dead page plus our own
    // View similar sitting right next to it.
    const rawEdmunds = buildEdmundsUrl({ vin, make, model, year });
    if (rawEdmunds) {
      affiliateUrl = wrapWithCJ(rawEdmunds);
      checkAvailSource = "exact";
    }
  }

  // View similar (affiliateFallbackUrl): close (trim-specific) for Used —
  // a genuine upgrade from the always-loose category link this used to be.
  // Loose (bare make/model) for New/Carvana, since Check avail. on that
  // path is already the close tier — View similar must be a genuinely
  // wider alternative sitting next to it, not a near-duplicate.
  const rawFallback = treatAsNewOrCarvana
    ? buildEdmundsCategoryUrl({ make, model }, { used, cpo })
    : buildEdmundsCategoryUrl({ make, model, year, trim }, { used, cpo });
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
