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
  if (!key) throw new Error("AUTO_DEV_API_KEY is not set");
  return key;
}

async function autoDevFetch<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  try {
    const res = await fetch(`${AUTO_DEV_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
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
  if (query.make) params.set("make", query.make);
  if (query.model) params.set("model", query.model);
  if (query.bodyType) params.set("body_type", query.bodyType);
  if (query.priceMin != null) params.set("price_min", String(query.priceMin));
  if (query.priceMax != null) params.set("price_max", String(query.priceMax));
  if (query.yearMin != null) params.set("year_min", String(query.yearMin));
  if (query.yearMax != null) params.set("year_max", String(query.yearMax));
  if (query.mileageMax != null) params.set("mileage_max", String(query.mileageMax));
  if (query.zip) params.set("zip", query.zip);
  if (query.radius != null) params.set("radius", String(query.radius));
  params.set("limit", String(query.limit ?? 50));

  // NOTE: trim and seats are deliberately NEVER added as query params here —
  // Trust Class B / provider_filter_allowed: false — see SYS-20260812-023/025.

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
