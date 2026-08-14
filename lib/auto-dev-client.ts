/**
 * Auto.dev API client — Starter tier only (VIN Decode, Listings, Photos).
 *
 * Pattern: AbortSignal.timeout() instead of manual AbortController — this is
 * the flagship app's own Known Issue #8, fixed here from day one rather than
 * ported with the bug (SYS-20260812-002/003).
 */

const AUTO_DEV_BASE_URL = "https://api.auto.dev";
const DEFAULT_TIMEOUT_MS = 25_000; // was 10s — real logs show fetch failing with [Error [Timeout...
  // for plain make+model queries; 10s was too short, not a param/query bug.

function apiKey(): string {
  const key = process.env.AUTO_DEV_API_KEY;
  if (!key) {
    console.error("[auto-dev-client] AUTO_DEV_API_KEY is not set in this environment");
    throw new Error("AUTO_DEV_API_KEY is not set");
  }
  return key;
}

/**
 * Result wrapper so a transport failure is never confused with a genuine
 * empty result. Previously both collapsed to `null` -> `{data: [], total: 0}`,
 * which made timeouts look identical to "no cars matched" and produced actively
 * wrong user advice ("try relaxing your constraints") when the real problem was
 * that the request never completed.
 */
export type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "timeout" | "http" | "network"; status?: number };

async function autoDevFetch<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchOutcome<T>> {
  try {
    const res = await fetch(`${AUTO_DEV_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[auto-dev-client] ${path} returned ${res.status}: ${body.slice(0, 300)}`);
      return { ok: false, reason: "http", status: res.status };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    const isTimeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    console.error(`[auto-dev-client] fetch failed for ${path}:`, err);
    return { ok: false, reason: isTimeout ? "timeout" : "network" };
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
    type?: string; // finer than bodyStyle: Crossover/SUV/Sedan/Wagon/Minivan/Performance-Sports/Hybrid/Hatchback/Coupe/Luxury/Electric
    doors?: number;
    cylinders?: number;
    confidence?: unknown; // real field, unresearched — parsed for visibility, not yet used
    style?: unknown; // observed in schema audit — meaning unconfirmed, investigating
    condition?: unknown; // speculative: possible new/used/demo/certified signal
  };
  baseInvoice?: unknown; // observed in schema audit, location in tree unconfirmed — investigating
  baseMsrp?: unknown;
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
  // Trust Class C (auto_dev.field_trust_registry.yaml): "discover broadly, then
  // verify locally or cross-API" — never a query filter, only a post-search
  // verification/display signal. Confirmed real via live projection test
  // (PROJPARITY-004-select): present in 27/30 sampled rows in that run, but
  // STEP3_STATUS.md's broader 300-row sample found history null in 53% of
  // rows — presence varies, absence is common and must never be read as clean.
  history?: {
    accidents?: boolean;
    accidentCount?: number;
    ownerCount?: number;
    oneOwner?: boolean;
    usageType?: string;
    personalUse?: boolean; // distinct field from usageType per live capture data; not yet surfaced anywhere
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
  interiorColor?: string;
  vehicleType?: string; // vehicle.type — finer than bodyType, e.g. Crossover vs SUV
  doors?: number;
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
  /** Set when the request genuinely failed — distinct from "no cars matched". */
  error?: string;
  /** Set when results came back but via a reduced fallback request. */
  degraded?: string;
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
  if (query.interiorColor) params.set("vehicle.interiorColor", query.interiorColor);
  if (query.vehicleType) params.set("vehicle.type", query.vehicleType);
  if (query.doors != null) params.set("vehicle.doors", String(query.doors));
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
  // cpo NOT sent as a query filter — CPO-001 (field_trust_registry): "cpo=false
  // is definitive proof of non-CPO" is explicitly forbidden logic. Same fix
  // pattern as history: disclosed per result (route.ts cpoEvidenceState), never
  // used to include/exclude. Real bug found in field audit, SYS-20260812-051.
  if (query.state) params.set("retailListing.state", query.state.toUpperCase());

  // Facet-verified filterable, real trust differentiator (design doc §2).
  // history.accidentCount/ownerCount confirmed real field names (real captured
  // response: FILTER-COMPLETE-001), but history is null in 53% of sampled rows
  // (STEP3_STATUS.md). Hard-filtering on a field missing half the time would
  // silently exclude valid unknown-history cars — violates the "unknown != false"
  // principle already established. Removed as query filters; handled as
  // post-search display/ranking signal instead (see route.ts, not implemented yet).

  if (query.zip) params.set("zip", query.zip);
  if (query.radius != null) params.set("distance", String(query.radius)); // "distance", not "radius"
  if (query.sort) params.set("sort", query.sort);

  // NOTE: trim and seats are deliberately NEVER added as query params here —
  // Trust Class B / provider_filter_allowed: false — see SYS-20260812-023/025.

  // Per-plan caps (docs): Starter 20, Growth 100, Scale 500. Requests above the
  // cap silently clamp — so asking for 100 is safe on any plan and simply
  // returns fewer rows on Starter. Currently on Growth, so 100 is the real pool.
  params.set("limit", String(query.limit ?? 100));

  // "total" is only returned when ?includes=total is passed (docs: "Total count").
  // Restored unconditionally — the earlier narrowQuery gating was based on an
  // unproven "exact count is expensive" hypothesis that was never tested, and it
  // left totalMatches wrong for every non-narrow query.
  params.set("includes", query.includeFacets ? "total,facets" : "total");

  const outcome = await autoDevFetch<ListingsResponse>(`/listings?${params.toString()}`);
  if (outcome.ok) {
    // TEMPORARY diagnostic (Aug 14): full raw dump of the first row to observe
    // unconfirmed fields (style, baseInvoice, baseMsrp, any new/used/demo/
    // condition signal beyond retailListing.used) - remove after one real check.
    if (outcome.data.data?.[0]) {
      console.error("[DIAG-RAW-ROW]", JSON.stringify(outcome.data.data[0]));
    }
    return { data: outcome.data.data ?? [], total: outcome.data.total ?? 0, facets: outcome.data.facets };
  }

  // Degrade rather than fail outright: on a timeout, retry once with a smaller,
  // cheaper request (fewer rows, no count) so the user still gets usable results
  // during the API slowness we've repeatedly observed, instead of an empty answer.
  if (outcome.reason === "timeout") {
    const retryParams = new URLSearchParams(params);
    retryParams.set("limit", "25");
    retryParams.delete("includes");
    const retry = await autoDevFetch<ListingsResponse>(`/listings?${retryParams.toString()}`, 15_000);
    if (retry.ok) {
      return {
        data: retry.data.data ?? [],
        total: retry.data.total ?? 0,
        degraded: "The vehicle data service was slow, so this search used a smaller result set than usual.",
      };
    }
  }

  return {
    data: [],
    total: 0,
    error:
      outcome.reason === "timeout"
        ? "The vehicle data service didn't respond in time. This is a temporary service issue, not a problem with the search itself — trying again usually works."
        : `The vehicle data service returned an error${outcome.status ? ` (${outcome.status})` : ""}. This is a service issue, not a problem with the search itself.`,
  };
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

/**
 * Paid VIN decode. NO LONGER used in the search path — replaced by local
 * vin-anatomy verification (design doc §5), which cut 5 API calls per search.
 * Retained for single-vehicle drill-down, where one extra call is justified.
 */
export async function decodeVin(vin: string): Promise<VinDecodeResult | null> {
  const outcome = await autoDevFetch<VinDecodeResult>(`/vin/${encodeURIComponent(vin)}`);
  return outcome.ok ? outcome.data : null;
}

export interface PhotosResult {
  photos: string[];
}

export async function getPhotos(vin: string): Promise<PhotosResult | null> {
  const outcome = await autoDevFetch<PhotosResult>(`/photos/${encodeURIComponent(vin)}`);
  return outcome.ok ? outcome.data : null;
}
