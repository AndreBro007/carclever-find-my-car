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

export interface AutoDevListing {
  vin: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  series?: string;
  price?: number;
  mileage?: number;
  zip?: string;
  city?: string;
  state?: string;
  fuel?: string;
  drivetrain?: string;
  transmission?: string;
  bodyStyle?: string;
  used?: boolean;
  cpo?: boolean;
  dealerName?: string;
  dealerId?: string;
  carfaxUrl?: string;
  vdp?: string;
  primaryImage?: string;
  [key: string]: unknown; // Auto.dev returns more fields than we type explicitly — preserve raw access
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
}

export interface ListingsResponse {
  data: AutoDevListing[];
  total: number;
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
  if (query.bodyType) params.set("vehicle.bodyStyle", query.bodyType); // NOT independently confirmed against docs — verify against a live response before relying on this filter

  if (query.priceMin != null || query.priceMax != null) {
    params.set("retailListing.price", `${query.priceMin ?? 1}-${query.priceMax ?? 999999}`);
  }
  if (query.yearMin != null || query.yearMax != null) {
    params.set("vehicle.year", `${query.yearMin ?? 1900}-${query.yearMax ?? 2100}`);
  }
  if (query.mileageMax != null) {
    params.set("retailListing.mileage", `0-${query.mileageMax}`); // dash-range pattern assumed consistent with price/year — NOT independently confirmed, verify against a live response
  }

  if (query.zip) params.set("zip", query.zip);
  if (query.radius != null) params.set("distance", String(query.radius)); // "distance", not "radius"

  // NOTE: trim and seats are deliberately NEVER added as query params here —
  // Trust Class B / provider_filter_allowed: false — see SYS-20260812-023/025.

  params.set("limit", String(query.limit ?? 50));

  const result = await autoDevFetch<ListingsResponse>(`/listings?${params.toString()}`);

  // TEMPORARY diagnostic: confirm the real shape of a returned item before trusting
  // AutoDevListing's flat-field assumptions. Remove once verified (SYS-20260812 build log).
  if (result?.data?.[0]) {
    console.error("[auto-dev-client] DIAGNOSTIC first item shape:", JSON.stringify(result.data[0]).slice(0, 800));
  }

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
