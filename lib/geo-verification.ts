/**
 * Geographic radius verification (SYS-20260827) — defense against Auto.dev's
 * own radius filter leaking a listing far outside the requested search
 * radius. Confirmed live: a search for zip 77002 (Houston, TX), 50-mile
 * radius, returned a 2004 Ford F-150 (VIN 1FTPX14504NB68591) reported at
 * "Mike's Auto Inc, Grand Junction, CO" — roughly 900 miles away, already
 * present as Colorado in Auto.dev's own radius-filtered search response
 * (not a stage-2 full-detail drift — see DECISIONS.md for the diagnostic
 * writeup). This module does NOT trust Auto.dev's radius filter as ground
 * truth; it adds one further, deliberately conservative, confirmation-only
 * check on top of it.
 *
 * Design philosophy — "unknown ≠ false", exclude only on confident evidence:
 * this is emphatically NOT a general-purpose geocoder or a fine-grained
 * per-listing distance calculator. It uses two small, static, offline
 * (zero network calls, zero paid service) data sources:
 *
 *   1. STATE_BOUNDS — a generously-padded bounding box per US state/DC.
 *      Used only to compute the MINIMUM possible distance from a search
 *      origin point to ANY point inside a given state. Because it's a
 *      minimum (not an average or a centroid-to-centroid estimate), this
 *      can never produce a false exclusion for a genuine near-border
 *      match: if the search origin is close to a state's border, the
 *      minimum distance to that state is correctly close to zero, so no
 *      exclusion is ever attempted there, regardless of how large the
 *      state's own extent is elsewhere. Exclusion only fires when the
 *      NEAREST possible point in the listing's reported state already
 *      exceeds the effective radius — meaning every point in that state
 *      is confirmed too far, not just the state's average/center.
 *
 *   2. ZIP3_ORIGIN_ANCHORS — a deliberately small, non-exhaustive table of
 *      major-metro 3-digit ZIP prefixes mapped to an approximate
 *      lat/lon anchor. This is NOT nationwide ZIP coverage (that would be
 *      a large embedded dataset, which the task explicitly asked to
 *      avoid unless absolutely necessary — a coarse, minimum-distance,
 *      confirmation-only check does not need that). A search ZIP whose
 *      3-digit prefix isn't in this table simply cannot be verified —
 *      per the "unknown ≠ false" rule, verification is skipped entirely
 *      for that search (no exclusion attempted), never guessed.
 *
 * Modest tolerance (explicitly justified, per the task's own allowance):
 * ZIP3_ORIGIN_ANCHORS gives a metro-area-level approximate origin point,
 * not the exact search ZIP's own centroid — a real search ZIP can be up to
 * roughly 20-30 miles from its 3-digit prefix's anchor point in a large
 * metro area. GEO_TOLERANCE_MILES (20) is subtracted from the computed
 * distance before comparing against the effective radius, so this
 * approximation error can only ever make the check MORE conservative
 * (less likely to exclude), never less — it does not silently turn 50
 * miles into a materially larger radius; it only prevents the anchor's
 * own imprecision from causing an incorrect exclusion right at the
 * boundary. For the confirmed regression case (Houston to Grand Junction,
 * CO — roughly 900 miles apart), this 20-mile tolerance is negligible
 * against the actual margin involved.
 */
import type { AutoDevListing } from "./auto-dev-client";

const GEO_TOLERANCE_MILES = 20;

interface StateBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

// Generously padded (~0.3-0.5° beyond the state's actual extent in most
// cases) so a near-border search origin is never mistakenly measured as
// "confirmed outside" a neighboring state — padding can only make this
// check less aggressive, never more, which is the safe direction per the
// "unknown ≠ false, never guess" requirement. Continental US + AK/HI/DC.
const STATE_BOUNDS: Record<string, StateBounds> = {
  AL: { minLat: 30.0, maxLat: 35.1, minLon: -88.6, maxLon: -84.8 },
  AK: { minLat: 51.0, maxLat: 71.6, minLon: -179.2, maxLon: -129.9 },
  AZ: { minLat: 31.2, maxLat: 37.1, minLon: -114.9, maxLon: -108.9 },
  AR: { minLat: 33.0, maxLat: 36.6, minLon: -94.7, maxLon: -89.6 },
  CA: { minLat: 32.4, maxLat: 42.1, minLon: -124.5, maxLon: -114.1 },
  CO: { minLat: 36.9, maxLat: 41.1, minLon: -109.1, maxLon: -102.0 },
  CT: { minLat: 40.9, maxLat: 42.1, minLon: -73.8, maxLon: -71.7 },
  DE: { minLat: 38.4, maxLat: 39.9, minLon: -75.8, maxLon: -75.0 },
  FL: { minLat: 24.4, maxLat: 31.1, minLon: -87.7, maxLon: -79.9 },
  GA: { minLat: 30.3, maxLat: 35.1, minLon: -85.7, maxLon: -80.7 },
  HI: { minLat: 18.8, maxLat: 22.3, minLon: -160.3, maxLon: -154.7 },
  ID: { minLat: 41.9, maxLat: 49.1, minLon: -117.3, maxLon: -111.0 },
  IL: { minLat: 36.9, maxLat: 42.6, minLon: -91.6, maxLon: -87.0 },
  IN: { minLat: 37.7, maxLat: 41.8, minLon: -88.1, maxLon: -84.7 },
  IA: { minLat: 40.3, maxLat: 43.6, minLon: -96.7, maxLon: -90.1 },
  KS: { minLat: 36.9, maxLat: 40.1, minLon: -102.1, maxLon: -94.5 },
  KY: { minLat: 36.4, maxLat: 39.2, minLon: -89.6, maxLon: -81.9 },
  LA: { minLat: 28.8, maxLat: 33.1, minLon: -94.1, maxLon: -88.7 },
  ME: { minLat: 43.0, maxLat: 47.5, minLon: -71.2, maxLon: -66.8 },
  MD: { minLat: 37.8, maxLat: 39.8, minLon: -79.6, maxLon: -75.0 },
  MA: { minLat: 41.1, maxLat: 43.0, minLon: -73.6, maxLon: -69.8 },
  MI: { minLat: 41.6, maxLat: 48.3, minLon: -90.5, maxLon: -82.1 },
  MN: { minLat: 43.4, maxLat: 49.4, minLon: -97.3, maxLon: -89.4 },
  MS: { minLat: 30.1, maxLat: 35.1, minLon: -91.7, maxLon: -88.0 },
  MO: { minLat: 35.9, maxLat: 40.7, minLon: -95.9, maxLon: -89.0 },
  MT: { minLat: 44.3, maxLat: 49.1, minLon: -116.1, maxLon: -104.0 },
  NE: { minLat: 39.9, maxLat: 43.1, minLon: -104.1, maxLon: -95.3 },
  NV: { minLat: 34.9, maxLat: 42.1, minLon: -120.1, maxLon: -114.0 },
  NH: { minLat: 42.6, maxLat: 45.4, minLon: -72.6, maxLon: -70.6 },
  NJ: { minLat: 38.8, maxLat: 41.4, minLon: -75.7, maxLon: -73.8 },
  NM: { minLat: 31.2, maxLat: 37.1, minLon: -109.2, maxLon: -102.9 },
  NY: { minLat: 40.4, maxLat: 45.1, minLon: -79.9, maxLon: -71.7 },
  NC: { minLat: 33.7, maxLat: 36.7, minLon: -84.4, maxLon: -75.4 },
  ND: { minLat: 45.9, maxLat: 49.1, minLon: -104.1, maxLon: -96.5 },
  OH: { minLat: 38.3, maxLat: 42.0, minLon: -84.9, maxLon: -80.4 },
  OK: { minLat: 33.5, maxLat: 37.1, minLon: -103.1, maxLon: -94.4 },
  OR: { minLat: 41.9, maxLat: 46.4, minLon: -124.7, maxLon: -116.3 },
  PA: { minLat: 39.6, maxLat: 42.4, minLon: -80.6, maxLon: -74.6 },
  RI: { minLat: 41.1, maxLat: 42.1, minLon: -71.9, maxLon: -71.1 },
  SC: { minLat: 32.0, maxLat: 35.3, minLon: -83.5, maxLon: -78.4 },
  SD: { minLat: 42.4, maxLat: 46.1, minLon: -104.1, maxLon: -96.3 },
  TN: { minLat: 34.9, maxLat: 36.8, minLon: -90.4, maxLon: -81.6 },
  TX: { minLat: 25.7, maxLat: 36.6, minLon: -106.7, maxLon: -93.4 },
  UT: { minLat: 36.9, maxLat: 42.1, minLon: -114.1, maxLon: -108.9 },
  VT: { minLat: 42.6, maxLat: 45.1, minLon: -73.5, maxLon: -71.4 },
  VA: { minLat: 36.5, maxLat: 39.5, minLon: -83.7, maxLon: -75.1 },
  WA: { minLat: 45.5, maxLat: 49.1, minLon: -124.9, maxLon: -116.9 },
  WV: { minLat: 37.1, maxLat: 40.7, minLon: -82.7, maxLon: -77.6 },
  WI: { minLat: 42.4, maxLat: 47.2, minLon: -92.9, maxLon: -86.8 },
  WY: { minLat: 40.9, maxLat: 45.1, minLon: -111.2, maxLon: -104.0 },
  DC: { minLat: 38.79, maxLat: 39.0, minLon: -77.13, maxLon: -76.9 },
};

interface OriginAnchor {
  lat: number;
  lon: number;
}

// Deliberately NOT nationwide — a modest set of major-metro 3-digit ZIP
// prefixes, enough to cover the confirmed regression case (Houston, 770)
// and other common large-market searches. A search ZIP whose prefix isn't
// listed here is simply unresolvable — see module doc above for why that
// safely skips verification rather than guessing.
const ZIP3_ORIGIN_ANCHORS: Record<string, OriginAnchor> = {
  "770": { lat: 29.76, lon: -95.36 }, // Houston, TX
  "772": { lat: 29.9, lon: -95.4 }, // Houston, TX (north)
  "752": { lat: 32.78, lon: -96.8 }, // Dallas, TX
  "753": { lat: 32.9, lon: -96.7 }, // Dallas, TX
  "787": { lat: 30.27, lon: -97.74 }, // Austin, TX
  "782": { lat: 29.42, lon: -98.49 }, // San Antonio, TX
  "100": { lat: 40.71, lon: -74.01 }, // New York, NY
  "900": { lat: 34.05, lon: -118.24 }, // Los Angeles, CA
  "606": { lat: 41.88, lon: -87.63 }, // Chicago, IL
  "331": { lat: 25.76, lon: -80.19 }, // Miami, FL
  "981": { lat: 47.61, lon: -122.33 }, // Seattle, WA
  "802": { lat: 39.74, lon: -104.99 }, // Denver, CO
  "850": { lat: 33.45, lon: -112.07 }, // Phoenix, AZ
  "303": { lat: 33.75, lon: -84.39 }, // Atlanta, GA
  "021": { lat: 42.36, lon: -71.06 }, // Boston, MA
  "191": { lat: 39.95, lon: -75.16 }, // Philadelphia, PA
  "482": { lat: 42.33, lon: -83.05 }, // Detroit, MI
  "554": { lat: 44.98, lon: -93.27 }, // Minneapolis, MN
  "972": { lat: 45.52, lon: -122.68 }, // Portland, OR
  "941": { lat: 37.77, lon: -122.42 }, // San Francisco, CA
  "891": { lat: 36.17, lon: -115.14 }, // Las Vegas, NV
  "200": { lat: 38.9, lon: -77.04 }, // Washington, DC
};

// Which state each anchored ZIP3 prefix belongs to — used only for the
// same-state short-circuit below (never exclude a listing reported in the
// same state as the search origin; large in-state distances are a real
// possibility this coarse check deliberately does not attempt to resolve).
const ZIP3_ORIGIN_STATE: Record<string, string> = {
  "770": "TX",
  "772": "TX",
  "752": "TX",
  "753": "TX",
  "787": "TX",
  "782": "TX",
  "100": "NY",
  "900": "CA",
  "606": "IL",
  "331": "FL",
  "981": "WA",
  "802": "CO",
  "850": "AZ",
  "303": "GA",
  "021": "MA",
  "191": "PA",
  "482": "MI",
  "554": "MN",
  "972": "OR",
  "941": "CA",
  "891": "NV",
  "200": "DC",
};

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** Clamps a point into a bounding box, then measures the distance to that
 * clamped point — i.e. the minimum possible distance from (lat, lon) to
 * ANY point inside the box. This is the core of why this check can never
 * falsely exclude a genuine near-border match: it only ever measures the
 * closest edge of the target state, never an average or center. */
function minDistanceToBoundsMiles(lat: number, lon: number, bounds: StateBounds): number {
  const clampedLat = Math.min(Math.max(lat, bounds.minLat), bounds.maxLat);
  const clampedLon = Math.min(Math.max(lon, bounds.minLon), bounds.maxLon);
  return haversineMiles(lat, lon, clampedLat, clampedLon);
}

function resolveZip3Origin(zip: string | null | undefined): { anchor: OriginAnchor; state: string } | null {
  if (!zip) return null;
  const trimmed = String(zip).trim();
  if (!/^\d{5}$/.test(trimmed)) return null;
  const prefix = trimmed.slice(0, 3);
  const anchor = ZIP3_ORIGIN_ANCHORS[prefix];
  const state = ZIP3_ORIGIN_STATE[prefix];
  if (!anchor || !state) return null;
  return { anchor, state };
}

/**
 * Returns true only when there is enough location evidence to CONFIDENTLY
 * determine the listing is outside the effective search radius. Returns
 * false (never excludes) whenever any piece of evidence needed is
 * missing, unresolvable, or ambiguous — per the "unknown ≠ false" rule.
 *
 * @param searchZip the active search's ZIP (effectiveQuery.zip — the
 *   widened value if widening ran, never the original pre-widening zip;
 *   callers must pass the effective query's own zip)
 * @param effectiveRadiusMiles the active search's effective radius
 *   (effectiveQuery.radius — reflects automatic widening, e.g. 50 -> 100,
 *   since callers pass the same effectiveQuery.radius value)
 * @param listingState the listing's own reported retailListing.state
 */
export function isConfirmedOutsideRadius(
  searchZip: string | null | undefined,
  effectiveRadiusMiles: number | null | undefined,
  listingState: string | null | undefined,
): boolean {
  if (!searchZip || effectiveRadiusMiles == null) return false; // no active zip/radius search — nothing to verify

  const origin = resolveZip3Origin(searchZip);
  if (!origin) return false; // search origin unresolvable — never guess

  const state = String(listingState ?? "").trim().toUpperCase();
  if (!state || state.length !== 2) return false; // listing location unknown — never treated as false/out-of-radius

  if (state === origin.state) return false; // same state as search origin — never excluded by this coarse check

  const bounds = STATE_BOUNDS[state];
  if (!bounds) return false; // unrecognized state code — never guess

  const distance = minDistanceToBoundsMiles(origin.anchor.lat, origin.anchor.lon, bounds);
  return distance - GEO_TOLERANCE_MILES > effectiveRadiusMiles;
}
