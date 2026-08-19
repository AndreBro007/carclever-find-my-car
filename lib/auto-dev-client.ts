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
    seats?: number; // real response field ("Seating capacity") — confirmed absent from Vehicle Filters, response-only. Was never even parsed before 2026-08-15, despite seatsMinPreference being collected as input and doing nothing.
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
  /**
   * `null` means Auto.dev returned results but omitted `total` — confirmed
   * live (2026-08-19) that `vehicle.doors` as a filter causes Auto.dev to
   * drop `total` from the response entirely, even though `data` is correct.
   * Previously coerced to `0` here, which route.ts then presented as a false
   * "0 matched" alongside real results. Must stay distinct from a genuine 0.
   */
  total: number | null;
  // Real shape confirmed live (2026-08-15): each facet group is a dict of
  // "Label (count)" strings mapped to a ready-made drill-down URL — NOT the
  // clean {value,count}[] this type previously assumed. e.g.
  // facets.models === { "MX-5 Miata (130)": "https://api.auto.dev/listings?...", ... }
  // Use parseFacetGroup() below to get clean {value,count} pairs from this.
  facets?: Record<string, Record<string, string>>;
  /** Set when the request genuinely failed — distinct from "no cars matched". */
  error?: string;
  /** Set when results came back but via a reduced fallback request. */
  degraded?: string;
}

/**
 * Parses a raw facet group ({"MX-5 Miata (130)": url, ...}) into clean
 * {value, count} pairs, sorted by count descending. The "(count)" suffix is
 * always present in real responses (confirmed 2026-08-15); a key without a
 * parseable count is skipped rather than guessed at.
 */
export function parseFacetGroup(
  group: Record<string, string> | undefined,
): Array<{ value: string; count: number }> {
  if (!group) return [];
  const parsed: Array<{ value: string; count: number }> = [];
  for (const key of Object.keys(group)) {
    const match = key.match(/^(.*)\s\((\d+)\)$/);
    if (!match) continue;
    parsed.push({ value: match[1].trim(), count: Number(match[2]) });
  }
  return parsed.sort((a, b) => b.count - a.count);
}

function buildListingsParams(query: ListingsQuery): URLSearchParams {
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
    params.set("retailListing.miles", `0-${query.mileageMax}`);
  }

  if (query.used != null) params.set("retailListing.used", query.used ? "true" : "false");
  if (query.state) params.set("retailListing.state", query.state.toUpperCase());

  if (query.zip) params.set("zip", query.zip);
  if (query.radius != null) params.set("distance", String(query.radius));
  if (query.sort) params.set("sort", query.sort);

  // NOTE: trim, seats, cpo deliberately never sent as query params — Trust
  // Class B/C, not safe hard filters (SYS-20260812-023/025/047/051).

  params.set("limit", String(query.limit ?? 100));
  return params;
}

export async function searchListings(query: ListingsQuery): Promise<ListingsResponse> {
  const params = buildListingsParams(query);
  params.set("includes", query.includeFacets ? "total,facets" : "total");

  const outcome = await autoDevFetch<ListingsResponse>(`/listings?${params.toString()}`);
  if (outcome.ok) {
    return {
      data: outcome.data.data ?? [],
      total: typeof outcome.data.total === "number" ? outcome.data.total : null,
      facets: outcome.data.facets,
    };
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

/**
 * Lean primary search using ?select= (design doc §5 / two-stage design,
 * SYS-20260812-060). Requests only the fields actually needed for filtering,
 * diversity, and initial scoring — vin/year/make/model/trim/price/miles,
 * plus bodyStyle/type (added SYS-20260816-052, needed at this stage so the
 * body-style hard-exclude filter has real data to check against before
 * candidates are even selected for the shortlist, not just after the stage-2
 * refetch) — for a smaller/faster payload across the full candidate pool.
 *
 * ?select= flattens the response to dot-keyed properties (confirmed in docs,
 * SYS-20260812-057) — adapted back into the normal nested AutoDevListing
 * shape here, so every downstream function (diversity, match-score,
 * post-verify) works completely unchanged, unaware select was ever used.
 *
 * Full detail for the eventual shortlist is fetched separately via
 * getListingByVin() (parallel, path-form endpoint) — confirmed working,
 * exact, and fast (4.66s for 5 VINs), SYS-20260812-060.
 */
const LEAN_SELECT_FIELDS =
  "vehicle.vin,vehicle.year,vehicle.make,vehicle.model,vehicle.trim,vehicle.bodyStyle,vehicle.type,retailListing.price,retailListing.miles";

interface LeanRow {
  "vehicle.vin"?: string;
  "vehicle.year"?: number;
  "vehicle.make"?: string;
  "vehicle.model"?: string;
  "vehicle.trim"?: string;
  "vehicle.bodyStyle"?: string;
  "vehicle.type"?: string;
  "retailListing.price"?: number;
  "retailListing.miles"?: number;
}

function leanRowToListing(row: LeanRow): AutoDevListing | null {
  if (!row["vehicle.vin"]) return null; // can't use a candidate with no VIN
  return {
    vin: row["vehicle.vin"],
    vehicle: {
      year: row["vehicle.year"],
      make: row["vehicle.make"],
      model: row["vehicle.model"],
      trim: row["vehicle.trim"],
      bodyStyle: row["vehicle.bodyStyle"],
      type: row["vehicle.type"],
    },
    retailListing: {
      price: row["retailListing.price"],
      miles: row["retailListing.miles"],
    },
  };
}

export async function searchListingsLean(query: ListingsQuery): Promise<ListingsResponse> {
  const params = buildListingsParams(query);
  params.set("select", LEAN_SELECT_FIELDS);
  params.set("includes", "total"); // facets never needed for the lean pass

  const outcome = await autoDevFetch<{ data: LeanRow[]; total?: number }>(`/listings?${params.toString()}`);
  if (outcome.ok) {
    const listings = (outcome.data.data ?? [])
      .map(leanRowToListing)
      .filter((l): l is AutoDevListing => l !== null);
    // Second Auto.dev total-metadata bug (SYS-20260819-007): with a zip +
    // year-range + multi-word model together, Auto.dev returns a genuine
    // but wrong total (0, or lower than the real row count) rather than
    // omitting the field. total < actual rows is logically impossible for
    // a real count, so treat it the same as the missing-field case: unknown.
    const rawTotal = typeof outcome.data.total === "number" ? outcome.data.total : null;
    const total = rawTotal != null && rawTotal < listings.length ? null : rawTotal;
    return {
      data: listings,
      total,
    };
  }

  if (outcome.reason === "timeout") {
    const retryParams = new URLSearchParams(params);
    retryParams.set("limit", "25");
    retryParams.delete("includes");
    const retry = await autoDevFetch<{ data: LeanRow[] }>(`/listings?${retryParams.toString()}`, 15_000);
    if (retry.ok) {
      const listings = (retry.data.data ?? [])
        .map(leanRowToListing)
        .filter((l): l is AutoDevListing => l !== null);
      return {
        data: listings,
        total: 0,
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

/**
 * Fetches the real model-name vocabulary for a make (facets), used ONLY as a
 * fallback when a specific make+model search returns zero results — never
 * called on a normal/successful search, so this adds no latency to the
 * common case (design doc §4, live-verified 2026-08-15).
 *
 * Deliberately drops `model` from the query and requests limit=1 — we only
 * need the facets, not any rows, so this is a cheap, minimal call. Real
 * confirmed finding: facets come back EMPTY on the exact zero-result query
 * itself (nothing matched, nothing to facet over) — they only populate at
 * a broader anchor level, which is why model must be dropped here rather
 * than resent alongside includes=facets on the original query.
 */
export async function getModelFacets(
  query: ListingsQuery,
): Promise<Array<{ value: string; count: number }>> {
  const broaderQuery: ListingsQuery = { ...query, model: undefined, limit: 1 };
  const params = buildListingsParams(broaderQuery);
  params.set("includes", "facets");

  const outcome = await autoDevFetch<{ facets?: Record<string, Record<string, string>> }>(
    `/listings?${params.toString()}`,
    10_000, // Fixed 2026-08-16: this is a tiny limit=1, facets-only request — the
    // full 25s DEFAULT_TIMEOUT_MS meant for real search calls left a worst-case
    // chain of primary search (25s) + this facet lookup (25s) + corrective
    // re-search (25s) = 75s, exceeding Vercel's 60s maxDuration. Same failure
    // mode as the real Aug 12 loosening-ladder timeout incident. 10s is ample
    // for this call (every real run completed in ~5s during Aug 15 testing).
  );
  if (!outcome.ok) return [];
  return parseFacetGroup(outcome.data.facets?.models);
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
/**
 * Single-listing lookup via the PATH-form endpoint (/listings/{vin}), distinct
 * from the query-param `vin=` we confirmed does NOT support comma-OR
 * (SYS-20260812-058). Docs describe this specifically as "returns a single
 * specific listing" - the intended mechanism for "give me this exact car."
 */
export async function getListingByVin(vin: string): Promise<AutoDevListing | null> {
  const outcome = await autoDevFetch<{ data: AutoDevListing }>(`/listings/${encodeURIComponent(vin)}`);
  return outcome.ok ? outcome.data.data : null;
}

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
