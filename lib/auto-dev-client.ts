/**
 * Auto.dev API client — Starter tier only (VIN Decode, Listings, Photos).
 *
 * Pattern: AbortSignal.timeout() instead of manual AbortController — this is
 * the flagship app's own Known Issue #8, fixed here from day one rather than
 * ported with the bug (SYS-20260812-002/003).
 */

const AUTO_DEV_BASE_URL = "https://api.auto.dev";
const DEFAULT_TIMEOUT_MS = 10_000;

function apiKey(): string {
  const key = process.env.AUTO_DEV_API_KEY;
  if (!key) {
    console.error("[auto-dev-client] AUTO_DEV_API_KEY is not set in this environment");
    throw new Error("AUTO_DEV_API_KEY is not set");
  }
  return key;
}

async function autoDevFetch<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  try {
    const res = await fetch(`${AUTO_DEV_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[auto-dev-client] ${path} returned ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[auto-dev-client] fetch failed for ${path}:`, err);
    return null;
  }
}

/**
 * Real Auto.dev v2 /listings item shape, confirmed against a live production
 * response (2026-08-13, see DECISIONS.md SYS-20260812 build log) — NOT flat,
 * nests under vehicle.* / retailListing.*, matching the same field-path
 * convention used by the query filter params (vehicle.make, retailListing.price).
 *
 * Confirmed fields (seen in a real response):
 *   vin (top-level), vehicle.{make,model,year,trim,fuel,drivetrain,
 *   transmission,bodyStyle,engine,exteriorColor,interiorColor,squishVin},
 *   retailListing.{price,miles,city,state,dealer,cpo,used,vdp,primaryImage,
 *   carfaxUrl,photoCount}
 *
 * NOT independently confirmed yet (kept optional, unverified against a real
 * response — the sample seen was truncated before these could be checked):
 *   retailListing.zip, retailListing.dealerId, retailListing.titleStatus,
 *   vehicle.series
 */
export interface AutoDevListing {
  vin: string;
  "@id"?: string;
  createdAt?: string;
  vehicle?: {
    make?: string;
    model?: string;
    year?: number;
    trim?: string;
    series?: string; // unconfirmed
    fuel?: string;
    drivetrain?: string;
    transmission?: string;
    bodyStyle?: string;
    engine?: string;
    exteriorColor?: string;
    interiorColor?: string;
    squishVin?: string;
  };
  retailListing?: {
    price?: number;
    miles?: number;
    city?: string;
    state?: string;
    zip?: string; // unconfirmed
    dealer?: string;
    dealerId?: string; // unconfirmed
    cpo?: boolean;
    used?: boolean;
    vdp?: string;
    primaryImage?: string;
    carfaxUrl?: string;
    photoCount?: number; // known unreliable per field-trust registry, don't use for gallery-size prediction
    titleStatus?: string; // unconfirmed
  };
}

export interface ListingsQuery {
  make?: string;
  model?: string;
  bodyType?: string;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  mileageMax?: number;
  zip?: string;
  radius?: number;
  limit?: number;
  // Widened per design doc §2 — all live-verified filterable in STEP3_STATUS.md / redesign doc.
  drivetrain?: string; // AWD, 4WD, FWD, RWD (comma-OR)
  transmission?: string; // Automatic, Manual
  exteriorColor?: string; // Gray, White, Black, Blue, Silver, Red, Green, Brown, Orange, Burgundy, Beige
  cylinders?: number;
  used?: boolean;
  cpo?: boolean;
  state?: string;
  accidentCount?: number; // history.accidentCount — facet-verified filterable
  ownerCount?: number; // history.ownerCount — facet-verified filterable
  sort?: string; // e.g. "price.asc"
  includeFacets?: boolean;
}

export interface ListingsResponse {
  data: AutoDevListing[];
  total: number;
  facets?: Record<string, Array<{ value: string; count: number }>>;
}

export async function searchListings(query: ListingsQuery): Promise<ListingsResponse> {
  const params = new URLSearchParams();

  // Real Auto.dev v2 syntax (confirmed against docs.auto.dev/v2/products/vehicle-listings
  // after a live 400 "Invalid parameter provided: make" — the flat param names below were
  // wrong; real API uses dotted field paths matching the response shape, e.g.
  // vehicle.make=Ford&vehicle.model=mustang, and dash-ranges for numeric fields:
  // retailListing.price=1-30000, vehicle.year=2018-2024. zip/distance ARE flat, unprefixed.
  if (query.make) params.set("vehicle.make", query.make);
  if (query.model) params.set("vehicle.model", query.model);
  if (query.bodyType) params.set("vehicle.bodyStyle", query.bodyType);
  if (query.drivetrain) params.set("vehicle.drivetrain", query.drivetrain);
  if (query.transmission) params.set("vehicle.transmission", query.transmission);
  if (query.exteriorColor) params.set("vehicle.exteriorColor", query.exteriorColor);
  if (query.cylinders != null) params.set("vehicle.cylinders", String(query.cylinders));

  if (query.priceMin != null || query.priceMax != null) {
    params.set("retailListing.price", `${query.priceMin ?? 1}-${query.priceMax ?? 999999}`);
  }
  if (query.yearMin != null || query.yearMax != null) {
    params.set("vehicle.year", `${query.yearMin ?? 1900}-${query.yearMax ?? 2100}`);
  }
  if (query.mileageMax != null) {
    // Bug fix: field is "retailListing.miles", not "retailListing.mileage"
    // — confirmed live in STEP3_STATUS.md ("retailListing.price, retailListing.miles
    // — ranges verified inclusive"). Was silently wrong before this fix.
    params.set("retailListing.miles", `0-${query.mileageMax}`);
  }

  // Strict boolean serialization required — STEP3_STATUS.md found
  // retailListing.used=maybe returns 200 with empty data instead of erroring.
  if (query.used != null) params.set("retailListing.used", query.used ? "true" : "false");
  if (query.cpo != null) params.set("retailListing.cpo", query.cpo ? "true" : "false");
  if (query.state) params.set("retailListing.state", query.state.toUpperCase());

  // Facet-verified filterable, real trust differentiator (design doc §2).
  if (query.accidentCount != null) params.set("history.accidentCount", String(query.accidentCount));
  if (query.ownerCount != null) params.set("history.ownerCount", String(query.ownerCount));

  if (query.zip) params.set("zip", query.zip);
  if (query.radius != null) params.set("distance", String(query.radius)); // "distance", not "radius"
  if (query.sort) params.set("sort", query.sort);

  // NOTE: trim and seats are deliberately NEVER added as query params here —
  // Trust Class B / provider_filter_allowed: false — see SYS-20260812-023/025.

  params.set("limit", String(query.limit ?? 50));
  params.set("includes", query.includeFacets ? "total,facets" : "total");

  const result = await autoDevFetch<ListingsResponse>(`/listings?${params.toString()}`);
  return result ?? { data: [], total: 0 };
}

export interface VinDecodeResult {
  make?: string;
  model?: string;
  year?: number;
  trim?: string;
  engine?: string;
  transmission?: string;
  drivetrain?: string;
  fuelType?: string;
  bodyStyle?: string;
}

export async function decodeVin(vin: string): Promise<VinDecodeResult | null> {
  return autoDevFetch<VinDecodeResult>(`/vin/${encodeURIComponent(vin)}`);
}

export interface PhotosResult {
  photos: string[];
}

export async function getPhotos(vin: string): Promise<PhotosResult | null> {
  return autoDevFetch<PhotosResult>(`/photos/${encodeURIComponent(vin)}`);
}
