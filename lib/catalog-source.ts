/**
 * Edmunds Product Feed (Impact Catalog API) as a listing source
 * (spike/edmunds-catalog-mode). Server-side only: holds Impact credentials.
 *
 * Converts catalogue items into the EXISTING AutoDevListing shape so the whole
 * downstream pipeline (verification, ranking, cards, links) is reused unchanged.
 *
 * Evidence this is built on (getcarwise-docs, C1-C8 + Task #71):
 *   - queryable: Text1 (model, exact match), Category (body style), CurrentPrice,
 *     Manufacturer (= DEALER name, never make). Equality uses a single "=".
 *   - NOT queryable: VIN/Mpn, Condition (empty on sampled items).
 *   - result window 20,000; observed limit 3,000 item requests/hour.
 *   - returned Url is a partner-tracked edmunds.sjv.io link: used as supplied, never re-wrapped.
 *
 * Silent-degrade rule: any field the feed does not give us becomes undefined
 * (-> null/"unknown" downstream). Nothing here throws to the caller; failures
 * come back as an empty result (or the same `error` string shape Auto.dev uses).
 */
import type { AutoDevListing, ListingsQuery, ListingsResponse } from "./auto-dev-client";

const IMPACT_BASE = "https://api.impact.com";
const REQUEST_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 20;
const MAX_PAGES = 2; // 2 x 20 per query keeps the pool useful but bounded
const MAX_MODELS = 5;
const TRACKING_HOSTS = new Set(["edmunds.sjv.io"]);
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
// The VIN is present in the feed but not searchable (ticket #882346). The field it
// lives in is not yet confirmed, so we look in the standard identifier fields and
// accept only a value that is genuinely VIN-shaped. Nothing else is ever put in `vin`.
const VIN_FIELD_CANDIDATES = ["Mpn", "Sku", "CatalogItemId", "Gtin", "Text3", "Vin", "VIN"] as const;

export function catalogConfigured(): boolean {
  return !!(process.env.IMPACT_ACCOUNT_SID && process.env.IMPACT_AUTH_TOKEN && process.env.IMPACT_CATALOG_ID);
}

// ---------- query building (only validated tokens ever reach the expression) ----------

function safeToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > 40) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 .\-+/&]*$/.test(t) ? t : null;
}

function categoryFor(bodyType: string | undefined): string | null {
  const t = safeToken(bodyType);
  if (!t) return null;
  if (t.toLowerCase() === "suv") return "SUV"; // the only category value proven in C1-C8
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); // unproven values simply return empty if absent
}

let yearQuerySupported = true; // flips to false after one 400 so we stop sending it

export function buildCatalogQueries(q: ListingsQuery, opts: { withYear?: boolean } = {}): string[] {
  const price: string[] = [];
  if (q.priceMax != null && Number.isFinite(q.priceMax)) price.push(`CurrentPrice <= ${Math.floor(q.priceMax)}`);
  if (q.priceMin != null && Number.isFinite(q.priceMin) && q.priceMin > 0) price.push(`CurrentPrice >= ${Math.floor(q.priceMin)}`);
  const year: string[] = [];
  if (opts.withYear) {
    if (q.yearMin != null) year.push(`Year >= ${Math.floor(q.yearMin)}`);
    if (q.yearMax != null) year.push(`Year <= ${Math.floor(q.yearMax)}`);
  }
  const extras = [...price, ...year];

  const models = (q.model ?? "")
    .split(",")
    .map(safeToken)
    .filter((m): m is string => !!m)
    .slice(0, MAX_MODELS);
  if (models.length > 0) return models.map((m) => [`Text1 = '${m}'`, ...extras].join(" AND "));

  const category = categoryFor(q.bodyType);
  if (category) return [[`Category = '${category}'`, ...extras].join(" AND ")];

  const make = safeToken(q.make?.split(",")[0]);
  if (make) return [[`Make = '${make}'`, ...extras].join(" AND ")];

  if (price.length > 0) return [extras.join(" AND ")];
  return []; // never send an unconstrained query
}

// ---------- normalisation ----------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[$,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function allowedTrackingUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" && TRACKING_HOSTS.has(p.host) ? u : undefined;
  } catch {
    return undefined;
  }
}
const seenImageHosts = new Set<string>();
// Photos come from Edmunds' own partner feed and are only ever fetched through our signed image
// proxy (HMAC over the exact URL, image content-types only, size/time caps). So rather than guess a
// host allowlist, accept any plain https URL and refuse anything that could point inward.
// Each distinct host is logged once (host name only) so the rule can be tightened from evidence.
function allowedImageUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" || p.username || p.password) return undefined;
    const h = p.hostname.toLowerCase();
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[");
    if (isIp || !h.includes(".") || h === "localhost" || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return undefined;
    if (!seenImageHosts.has(h) && seenImageHosts.size < 25) {
      seenImageHosts.add(h);
      console.info(`[catalog] image host seen: ${h}`);
    }
    return u;
  } catch {
    return undefined;
  }
}

export function detectVin(raw: Record<string, unknown>): string {
  for (const f of VIN_FIELD_CANDIDATES) {
    const v = str(raw[f])?.toUpperCase();
    if (v && VIN_RE.test(v)) return v;
  }
  // Second source: the Edmunds vehicle page inside the tracking link's `u=` destination
  // (".../vin/<VIN>/featured-listing/"). Read from the link only; the link itself is never altered.
  try {
    const dest = new URL(str(raw.Url) ?? "").searchParams.get("u");
    const m = dest ? decodeURIComponent(dest).match(/\/vin\/([A-HJ-NPR-Z0-9]{17})(?:[\/?#]|$)/i) : null;
    if (m) return m[1].toUpperCase();
  } catch {
    /* no usable link: fall through */
  }
  return ""; // genuinely unknown: never substituted with an item id
}

export function normalizeCatalogItem(rawIn: unknown): AutoDevListing | null {
  if (rawIn == null || typeof rawIn !== "object") return null;
  const raw = rawIn as Record<string, unknown>;
  if (/out\s*of\s*stock/i.test(str(raw.StockAvailability) ?? "")) return null;

  // Year: the Year field when present, else a leading 4-digit model year in the item Name
  // (e.g. "2021 Honda CR-V EX"), the same fallback the earlier prototype adapter used.
  const nameYear = /^\s*((?:19[89]|20[0-3])\d)\b/.exec(str(raw.Name) ?? "")?.[1];
  const year = num(raw.Year) ?? (nameYear ? Number(nameYear) : undefined);
  const make = str(raw.Make);
  const model = str(raw.Text1);
  if (!model && !make) return null; // nothing identifiable to show

  return {
    vin: detectVin(raw),
    catalog: {
      itemId: str(raw.CatalogItemId) ?? str(raw.Id),
      trackingUrl: allowedTrackingUrl(str(raw.Url)),
    },
    vehicle: {
      year,
      make,
      model,
      trim: str(raw.Text2),
      bodyStyle: str(raw.Category),
    },
    retailListing: {
      price: num(raw.CurrentPrice),
      // miles / used / cpo deliberately left undefined: not confirmed in the feed.
      city: str(raw.City),
      state: str(raw.State),
      dealer: str(raw.Manufacturer), // feed maps dealer name here
      primaryImage: allowedImageUrl(str(raw.ImageUrl)),
    },
  };
}

// ---------- by-VIN follow-up cache (the catalogue cannot be searched by VIN) ----------

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 400;
const byVin = new Map<string, { at: number; listing: AutoDevListing }>();

function remember(l: AutoDevListing): void {
  if (!l.vin) return;
  if (byVin.size >= CACHE_MAX) byVin.delete(byVin.keys().next().value as string);
  byVin.set(l.vin, { at: Date.now(), listing: l });
}
export function getCachedCatalogListing(vin: string): AutoDevListing | null {
  const hit = byVin.get(vin);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.listing;
}
export function clearCatalogCacheForTests(): void {
  byVin.clear();
  yearQuerySupported = true;
}

// ---------- fetching ----------

type PageResult = { ok: boolean; status: number; items: unknown[]; total: number | null };

async function fetchPage(expression: string, page: number): Promise<PageResult> {
  const sid = process.env.IMPACT_ACCOUNT_SID!;
  const token = process.env.IMPACT_AUTH_TOKEN!;
  const catalog = process.env.IMPACT_CATALOG_ID!;
  const qs = new URLSearchParams({ Query: expression, PageSize: String(PAGE_SIZE), Page: String(page) });
  try {
    const res = await fetch(`${IMPACT_BASE}/Mediapartners/${sid}/Catalogs/${catalog}/Items?${qs.toString()}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, items: [], total: null };
    const body = (await res.json()) as { Items?: unknown[]; Total?: unknown };
    const total = typeof body.Total === "number" && body.Total >= 0 ? body.Total : null; // Impact uses -1 for "none"
    return { ok: true, status: 200, items: Array.isArray(body.Items) ? body.Items : [], total };
  } catch {
    return { ok: false, status: 0, items: [], total: null };
  }
}

async function runExpressions(exprs: string[]): Promise<PageResult[]> {
  const jobs: Promise<PageResult>[] = [];
  for (const e of exprs) for (let p = 1; p <= MAX_PAGES; p++) jobs.push(fetchPage(e, p));
  return Promise.all(jobs);
}

export async function searchCatalogListings(q: ListingsQuery): Promise<ListingsResponse> {
  const empty: ListingsResponse = { data: [], total: 0, source: "edmunds_catalog" };
  if (!catalogConfigured()) return empty; // silent: facade decides what to do next

  const wantYear = yearQuerySupported && (q.yearMin != null || q.yearMax != null);
  let exprs = buildCatalogQueries(q, { withYear: wantYear });
  if (exprs.length === 0) return empty;

  let results = await runExpressions(exprs);
  if (wantYear && results.every((r) => !r.ok && r.status === 400)) {
    yearQuerySupported = false; // Year is not a queryable field: retry once without it, locally verified instead
    exprs = buildCatalogQueries(q, { withYear: false });
    results = await runExpressions(exprs);
  }

  const seen = new Set<string>();
  const data: AutoDevListing[] = [];
  for (const r of results) {
    for (const raw of r.items) {
      const l = normalizeCatalogItem(raw);
      if (!l) continue;
      const key = l.vin || l.catalog?.itemId || l.catalog?.trackingUrl || "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      remember(l);
      data.push(l);
    }
  }

  // Honour the requested sort inside the pool we have (the API offers no sort).
  const price = (l: AutoDevListing) => l.retailListing?.price ?? Number.POSITIVE_INFINITY;
  const yr = (l: AutoDevListing) => l.vehicle?.year ?? 0;
  if (q.sort === "price.asc") data.sort((a, b) => price(a) - price(b));
  else if (q.sort === "price.desc") data.sort((a, b) => (price(b) === Infinity ? -1 : price(b)) - (price(a) === Infinity ? -1 : price(a)));
  else if (q.sort === "year.desc") data.sort((a, b) => yr(b) - yr(a));

  const anyOk = results.some((r) => r.ok);
  if (!anyOk) {
    return {
      data: [],
      total: 0,
      source: "edmunds_catalog",
      error: "The vehicle data service returned an error. This is a service issue, not a problem with the search itself.",
    };
  }
  const totals = results.filter((r) => r.ok).map((r) => r.total);
  const total = totals.every((t) => t != null) ? (totals as number[]).reduce((a, b) => a + b, 0) / MAX_PAGES : null;
  return { data, total: total != null && total >= data.length ? Math.round(total) : null, source: "edmunds_catalog" };
}
