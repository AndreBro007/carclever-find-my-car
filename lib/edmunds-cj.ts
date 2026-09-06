// CJ Affiliate constants for Edmunds
export const CJ_CLICK_DOMAIN = 'https://www.anrdoezrs.net';
export const CJ_PUBLISHER_ID = '101637236';
export const CJ_EDMUNDS_PRODUCT_AD_ID = '17033607';
export const EDMUNDS_BASE = 'https://www.edmunds.com';

/**
 * Converts a vehicle make/model string into a URL-safe slug.
 * - null/undefined/empty input ? ""
 * - Lowercase and trim
 * - Whitespace (one or more) ? single hyphen
 * - Strip apostrophes
 * - Strip any character that is not a-z, 0-9, or hyphen
 * - Collapse multiple consecutive hyphens to one
 * - Trim leading/trailing hyphens
 *
 * String(input) wrapper (real bug found 2026-08-16, crashed live on a
 * Porsche 911 search): rare/varied vehicles from an unanchored search can
 * have make/model come back as a non-string type despite the parameter type
 * declaring string — TypeScript's compile-time check can't catch a runtime
 * data anomaly. Same bug class already found and fixed in diversity.ts,
 * post-verify.ts, and match-score.ts this same week (2026-08-14/15) — this
 * was the one remaining unguarded .toLowerCase() call site.
 */
export function slugify(input: string | null | undefined): string {
  if (input == null || input === '') return '';
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/'/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds an Edmunds featured-listing URL for a given vehicle.
 * Returns null if any required field is missing or unusable.
 */
export function buildEdmundsUrl(vehicle: {
  vin?: string;
  make?: string;
  model?: string;
  year?: number | string;
}): string | null {
  const vin = vehicle.vin?.trim();
  if (!vin) return null;

  const makeSlug = slugify(vehicle.make);
  if (!makeSlug) return null;

  const modelSlug = slugify(vehicle.model);
  if (!modelSlug) return null;

  if (vehicle.year == null) return null;

  return `${EDMUNDS_BASE}/${makeSlug}/${modelSlug}/${vehicle.year}/vin/${vin}/featured-listing/`;
}

/**
 * Builds an Edmunds category-search URL for a make/model — no VIN, never
 * dereferences one specific record. Confirmed live-tested 2026-08-17
 * (DECISIONS.md SYS-20260817-001): unlike the VIN-specific featured-listing
 * URL, this page does not 404/dead-end even for a rare, low-volume,
 * discontinued model with zero comparable local inventory — Edmunds itself
 * auto-expands the search radius (confirmed: a 2016 Audi A3 Sportback
 * e-tron query, whose VIN link was fully dead with zero fallback content,
 * still returned 56 real nationwide listings via this URL shape).
 *
 * Precedence, per live-tested URL shapes only (2026-08-23/24 investigation,
 * no new API calls used to build this):
 * 1. TRIM, when present and safely representable (see isSafeTrimForSlug()
 *    below) — confirmed live for both conditions:
 *    - USED: `/used-{make}-{model}-{trim}/` (e.g. used-chevrolet-tahoe-ls/,
 *      used-chevrolet-tahoe-high-country/, used-chevrolet-tahoe-z71/ — all
 *      three independently confirmed: the "Trim" filter chip matched, every
 *      visible listing was that trim, and unrelated trims never appeared)
 *    - NEW: `/new-{make}-{model}-{trim}-for-sale/` (e.g.
 *      new-chevrolet-tahoe-ls-for-sale/ — same confirmation)
 * 2. USED, no safe trim: `/used-{year}-{make}-{model}/` when year is known
 *    (confirmed live to genuinely filter by year), else
 *    `/used-{make}-{model}/`.
 * 3. NEW, no safe trim: `/new-{make}-{model}-for-sale/`.
 *
 * YEAR AND TRIM ARE NEVER COMBINED — confirmed live-tested and BROKEN
 * (2026-08-24 investigation): `/used-2026-chevrolet-tahoe-ls/` 404s;
 * `/used-chevrolet-tahoe-ls-2026/` also 404s (and silently redirects to a
 * wrong URL that misparses "tahoe-ls" as the model); `?year=2026` added to
 * a working trim slug, and `?trim=LS` added to a working year slug, both
 * silently corrupt the year to "2025-2025" in Edmunds' own Applied Filters
 * panel and return 0 listings — while the page title deceptively still
 * says "2026". No combination of year+trim tested returned real,
 * correctly-filtered inventory. This function must never construct a URL
 * containing both.
 *
 * isSafeTrimForSlug(): only alphanumeric "words" separated by single
 * spaces/hyphens (e.g. "LS", "High Country", "Z71", "AMG GLA 35") are
 * treated as trim-safe. Anything containing other punctuation (slashes,
 * ampersands, parentheses, etc.) falls through to the year/no-trim
 * fallback instead — deliberately no speculative normalization beyond the
 * existing slugify(), since no live-tested evidence exists for how
 * Edmunds' slug parser handles punctuation-heavy trim names.
 *
 * No `zip` or `price` query parameters — REMOVED (2026-08-23) after live
 * testing confirmed Edmunds silently ignores both on this SEO
 * category-page shape: fetching `/used-ford-f-150/?zip=75001&price=0-45000`
 * returned nationwide results anchored to a default location (not zip
 * 75001) with prices far above the stated ceiling ($94,559 seen against a
 * $45,000 cap), and the same was true with `?price=` alone or combined
 * with a genuinely-working location slug. Location filtering that
 * actually works requires a city/state slug (e.g. `-dallas-tx`), which
 * requires a ZIP→city/state resolution step this codebase does not have —
 * out of scope for this fix. Never re-add zip/price query params to this
 * function without fresh live confirmation they do something.
 *
 * Returns null only if make/model can't be slugified at all.
 */
function isSafeTrimForSlug(trim: string): boolean {
  return /^[A-Za-z0-9]+([ -][A-Za-z0-9]+)*$/.test(trim.trim());
}

export function buildEdmundsCategoryUrl(
  vehicle: { make?: string; model?: string; year?: number; trim?: string },
  opts?: { used?: boolean; cpo?: boolean },
): string | null {
  const makeSlug = slugify(vehicle.make);
  if (!makeSlug) return null;

  const modelSlug = slugify(vehicle.model);
  if (!modelSlug) return null;

  // CPO (2026-09-03, Andre live-test finding): live-confirmed real URL
  // shape, make/model granularity ONLY — `used-certified-pre-owned-
  // {make}-{model}/` (e.g. https://www.edmunds.com/used-certified-pre-owned-
  // hyundai-kona/). No confirmed trim- or year-specific CPO shape exists —
  // searching for one (e.g. `...-hyundai-kona-sel-sport/`) redirected back
  // to the plain make/model CPO page, so this deliberately does not try to
  // combine cpo with trim/year the way the non-CPO tiers below do.
  //
  // When a listing is known CPO, this takes priority over the used/new
  // branch below and over trim, regardless of `opts.used` (CPO is
  // inherently a used-vehicle program). Real reason this exists: live
  // testing found that routing a confirmed-CPO, near-zero-mileage vehicle
  // to the plain `used-{make}-{model}-{trim}/` page (a) labels a
  // certified/delivery-mileage vehicle as generic "used" when we
  // specifically know it's CPO, and (b) Edmunds' own `used-` pages mix
  // in non-CPO used listings alongside CPO ones — the dedicated CPO URL
  // is a materially different, more precise destination, not just
  // cosmetic. Only applied when `opts.cpo === true` (i.e. our own data
  // confirms CPO) — never inferred or guessed from anything else.
  if (opts?.cpo === true) {
    return `${EDMUNDS_BASE}/used-certified-pre-owned-${makeSlug}-${modelSlug}/`;
  }

  const isUsed = opts?.used !== false; // default true — matches prior behavior when condition is unknown

  const rawTrim = vehicle.trim?.trim();
  const trimSlug = rawTrim && isSafeTrimForSlug(rawTrim) ? slugify(rawTrim) : "";

  if (!isUsed) {
    return trimSlug
      ? `${EDMUNDS_BASE}/new-${makeSlug}-${modelSlug}-${trimSlug}-for-sale/`
      : `${EDMUNDS_BASE}/new-${makeSlug}-${modelSlug}-for-sale/`;
  }

  if (trimSlug) {
    return `${EDMUNDS_BASE}/used-${makeSlug}-${modelSlug}-${trimSlug}/`;
  }

  if (vehicle.year != null) {
    return `${EDMUNDS_BASE}/used-${vehicle.year}-${makeSlug}-${modelSlug}/`;
  }
  return `${EDMUNDS_BASE}/used-${makeSlug}-${modelSlug}/`;
}

/**
 * Wraps an Edmunds URL with a CJ affiliate click-through link.
 */
export function wrapWithCJ(rawUrl: string): string {
  const encoded = encodeURIComponent(rawUrl);
  return `${CJ_CLICK_DOMAIN}/click-${CJ_PUBLISHER_ID}-${CJ_EDMUNDS_PRODUCT_AD_ID}?url=${encoded}`;
}
