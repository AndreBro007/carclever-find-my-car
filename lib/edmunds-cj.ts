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
 * Wraps an Edmunds URL with a CJ affiliate click-through link.
 */
export function wrapWithCJ(rawUrl: string): string {
  const encoded = encodeURIComponent(rawUrl);
  return `${CJ_CLICK_DOMAIN}/click-${CJ_PUBLISHER_ID}-${CJ_EDMUNDS_PRODUCT_AD_ID}?url=${encoded}`;
}
