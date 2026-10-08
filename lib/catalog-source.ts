/**
 * Edmunds Product Feed (Impact Catalog API) as a listing source
 * (spike/edmunds-catalog-mode). Server-side only: holds Impact credentials.
 *
 * Converts catalogue items into the EXISTING AutoDevListing shape so the whole
 * downstream pipeline (verification, ranking, cards, links) is reused unchanged.
 *
 * Feed field mapping. CONFIRMED by the aggregate diagnostic on 2026-10-08 (20-item sample):
 *   Mpn           = VIN (20/20 VIN-shaped)            Text1 = model       Text2 = trim
 *   CurrentPrice  = price                              Category = body style (mixed vocabulary)
 *   Manufacturer  = DEALER name (never the make)       Url = partner tracking link (used as supplied)
 *   NOT present: Make, Year, City, State, Condition populated.
 * INFERRED from value ranges + one cross-check (96819 = Honolulu dealer); re-validated by the
 * diagnostics route (/api/catalog-diag) on every run:
 *   Numeric1 = model year (2011..2024)   Numeric2 = odometer miles (18,226..182,696)
 *   ShippingLabel = dealer ZIP (2760..96819, leading zero dropped)
 * Queryable (HTTP 200): Text1, Category, CurrentPrice, Manufacturer.
 * NOT queryable (HTTP 400): State, City, Year, Make, Condition, Mpn, Numeric1.
 *
 * Silent-degrade rule: any field the feed does not give us becomes undefined
 * (-> null/"unknown" downstream). Nothing here throws to the caller; failures
 * come back as an empty result (or the same `error` string shape Auto.dev uses).
 */
import zipcodes from "zipcodes";
import type { AutoDevListing, ListingsQuery, ListingsResponse } from "./auto-dev-client";

const IMPACT_BASE = "https://api.impact.com";
const REQUEST_TIMEOUT_MS = 8_000;
const FALLBACK_PAGE_SIZE = 20;
const PREFERRED_PAGE_SIZE = 100;
const MAX_MODELS = 5;
const MAX_BANDS = 3;
const MIN_BAND_SPAN = 3_000; // dollars: don't split a narrow price range
const DEFAULT_RADIUS_MILES = 50;
const MIN_LOCAL_RESULTS = 3; // fewer than this inside the radius -> show the nearest instead of nothing
const MAX_LOCAL_FALLBACK = 12;
const TRACKING_HOSTS = new Set(["edmunds.sjv.io"]);
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
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
  if (t.toLowerCase() === "suv") return "SUV"; // proven value; other values simply return empty if absent
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Price bands so one search samples the whole price range instead of an arbitrary slice. */
export function priceBands(q: ListingsQuery): string[][] {
  const hasMax = q.priceMax != null && Number.isFinite(q.priceMax);
  const hasMin = q.priceMin != null && Number.isFinite(q.priceMin) && q.priceMin > 0;
  if (!hasMax) return [hasMin ? [`CurrentPrice >= ${Math.floor(q.priceMin as number)}`] : []];
  const hi = Math.floor(q.priceMax as number);
  const lo = hasMin ? Math.floor(q.priceMin as number) : 0;
  const span = hi - lo;
  if (span < MIN_BAND_SPAN) return [[...(hasMin ? [`CurrentPrice >= ${lo}`] : []), `CurrentPrice <= ${hi}`]];
  const n = Math.min(MAX_BANDS, Math.floor(span / 1500));
  const cuts = Array.from({ length: n - 1 }, (_, i) => Math.round((lo + (span * (i + 1)) / n) / 100) * 100);
  const edges = [lo, ...cuts, hi];
  return edges.slice(0, -1).map((a, i) => {
    const b = edges[i + 1];
    const parts: string[] = [];
    if (i === 0) { if (hasMin) parts.push(`CurrentPrice >= ${a}`); } else parts.push(`CurrentPrice > ${a}`);
    parts.push(`CurrentPrice <= ${b}`);
    return parts;
  });
}

export function buildCatalogQueries(q: ListingsQuery): string[] {
  const bands = priceBands(q);
  const models = (q.model ?? "")
    .split(",")
    .map(safeToken)
    .filter((m): m is string => !!m)
    .slice(0, MAX_MODELS);
  const heads: string[] = [];
  if (models.length > 0) models.forEach((m) => heads.push(`Text1 = '${m}'`));
  else {
    const category = categoryFor(q.bodyType);
    if (category) heads.push(`Category = '${category}'`);
  }
  if (heads.length === 0) {
    // Make / Year / State are not queryable. Only a price-bounded query is possible; make/year are verified locally.
    return q.priceMax != null || (q.priceMin ?? 0) > 0 ? bands.map((b) => b.join(" AND ")).filter(Boolean) : [];
  }
  return heads.flatMap((h) => bands.map((b) => [h, ...b].join(" AND ")));
}

// ---------- normalisation ----------

const KNOWN_MAKES = [
  "Mercedes-Benz", "Land Rover", "Alfa Romeo", "Aston Martin", "Rolls-Royce", "Acura", "Audi", "Bentley", "BMW", "Buick",
  "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Ferrari", "Fiat", "Fisker", "Ford", "Genesis", "GMC", "Honda", "Hummer",
  "Hyundai", "INFINITI", "Infiniti", "Isuzu", "Jaguar", "Jeep", "Kia", "Lamborghini", "Lexus", "Lincoln", "Lotus", "Lucid",
  "Maserati", "Mazda", "McLaren", "Mercury", "MINI", "Mini", "Mitsubishi", "Nissan", "Oldsmobile", "Polestar", "Pontiac",
  "Porsche", "RAM", "Ram", "Rivian", "Saab", "Saturn", "Scion", "smart", "Subaru", "Suzuki", "Tesla", "Toyota", "VinFast",
  "Volkswagen", "Volvo",
];
const MAKE_RES = KNOWN_MAKES.map((m) => ({ make: m, re: new RegExp(`(^|[^A-Za-z])${m.replace(/[-]/g, "[- ]")}(?![A-Za-z])`, "i") }));

export function parseMakeFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const head = name.slice(0, 60);
  for (const { make, re } of MAKE_RES) if (re.test(head)) return make === "Mini" || make === "MINI" ? "MINI" : make === "Ram" || make === "RAM" ? "RAM" : make === "Infiniti" ? "INFINITI" : make;
  return undefined;
}

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
// Photos come from Edmunds' own partner feed (many dealer CDNs) and are only ever fetched through our
// signed image proxy (HMAC over the exact URL, image content-types only, size/time caps), which is HTTPS to the
// user even when the upstream dealer CDN is plain http (3 of 18 sampled photos). Refuse anything that could point inward. Each distinct host is logged once (name only).
function allowedImageUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    if ((p.protocol !== "https:" && p.protocol !== "http:") || p.username || p.password) return undefined;
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

const MAX_YEAR = new Date().getFullYear() + 2;
function plausibleYear(n: number | undefined): number | undefined {
  return n != null && Number.isInteger(n) && n >= 1980 && n <= MAX_YEAR ? n : undefined;
}
function plausibleMiles(n: number | undefined): number | undefined {
  return n != null && Number.isFinite(n) && n >= 0 && n <= 600_000 ? Math.round(n) : undefined;
}
/** Dealer ZIP from ShippingLabel: digits only, 3-5 long (leading zeros were dropped upstream), must be a real US ZIP. */
export function dealerZip(raw: Record<string, unknown>): { zip: string; city: string; state: string } | undefined {
  const s = str(raw.ShippingLabel) ?? (typeof raw.ShippingLabel === "number" ? String(raw.ShippingLabel) : undefined);
  if (!s || !/^\d{3,5}$/.test(s)) return undefined;
  const zip = s.padStart(5, "0");
  const hit = zipcodes.lookup(zip);
  return hit ? { zip, city: hit.city, state: hit.state } : undefined;
}

export function normalizeCatalogItem(rawIn: unknown): AutoDevListing | null {
  if (rawIn == null || typeof rawIn !== "object") return null;
  const raw = rawIn as Record<string, unknown>;
  if (/out\s*of\s*stock/i.test(str(raw.StockAvailability) ?? "")) return null;

  const name = str(raw.Name);
  const nameYear = /^\s*((?:19[89]|20[0-3])\d)\b/.exec(name ?? "")?.[1];
  const year = plausibleYear(nameYear ? Number(nameYear) : undefined) ?? plausibleYear(num(raw.Numeric1)) ?? plausibleYear(num(raw.Year));
  const make = str(raw.Make) ?? parseMakeFromName(name);
  const model = str(raw.Text1);
  if (!model && !make) return null; // nothing identifiable to show
  const geo = dealerZip(raw);

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
      miles: plausibleMiles(num(raw.Numeric2)),
      // used / cpo deliberately left undefined: the feed's Condition is empty. Never inferred from mileage or age.
      city: str(raw.City) ?? geo?.city,
      state: str(raw.State) ?? geo?.state,
      zip: geo?.zip,
      dealer: str(raw.Manufacturer), // feed maps dealer name here
      primaryImage: allowedImageUrl(str(raw.ImageUrl)),
    },
  };
}

// ---------- by-VIN follow-up cache (the catalogue cannot be searched by VIN) ----------

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 800;
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

let pageSize = PREFERRED_PAGE_SIZE; // drops to 20 for good if the API rejects the larger size
export function clearCatalogCacheForTests(): void {
  byVin.clear();
  pageSize = PREFERRED_PAGE_SIZE;
}

// ---------- fetching ----------

type PageResult = { ok: boolean; status: number; items: unknown[]; total: number | null };

async function fetchPage(expression: string, page: number, size: number): Promise<PageResult> {
  const sid = process.env.IMPACT_ACCOUNT_SID!;
  const token = process.env.IMPACT_AUTH_TOKEN!;
  const catalog = process.env.IMPACT_CATALOG_ID!;
  const qs = new URLSearchParams({ Query: expression, PageSize: String(size), Page: String(page) });
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

async function runExpressions(exprs: string[], size: number): Promise<PageResult[]> {
  return Promise.all(exprs.map((e) => fetchPage(e, 1, size)));
}

export function distanceMilesBetween(zipA: string, zipB: string): number | null {
  const d = zipcodes.distance(zipA, zipB);
  return typeof d === "number" && Number.isFinite(d) ? d : null;
}

export async function searchCatalogListings(q: ListingsQuery): Promise<ListingsResponse> {
  const empty: ListingsResponse = { data: [], total: 0, source: "edmunds_catalog" };
  if (!catalogConfigured()) return empty; // silent: facade decides what to do next

  const exprs = buildCatalogQueries(q);
  if (exprs.length === 0) return empty;

  let results = await runExpressions(exprs, pageSize);
  if (pageSize !== FALLBACK_PAGE_SIZE && results.every((r) => !r.ok && r.status === 400)) {
    pageSize = FALLBACK_PAGE_SIZE; // larger page size rejected: fall back once, permanently for this instance
    results = await runExpressions(exprs, pageSize);
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

  const anyOk = results.some((r) => r.ok);
  if (!anyOk) {
    return {
      data: [],
      total: 0,
      source: "edmunds_catalog",
      error: "The vehicle data service returned an error. This is a service issue, not a problem with the search itself.",
    };
  }

  // ----- local ordering: distance from the user's ZIP when we have one, else the requested sort -----
  let localApplied = false;
  let out = data;
  const origin = q.zip && /^\d{5}$/.test(q.zip) ? zipcodes.lookup(q.zip) : undefined;
  if (origin) {
    const withDist = data.map((l) => {
      const dz = l.retailListing?.zip;
      const d = dz ? distanceMilesBetween(q.zip as string, dz) : null;
      if (d != null && l.catalog) l.catalog.distanceMiles = Math.round(d);
      return { l, d };
    });
    const radius = q.radius != null && q.radius > 0 ? q.radius : DEFAULT_RADIUS_MILES;
    const known = withDist.filter((x) => x.d != null).sort((a, b) => (a.d as number) - (b.d as number));
    const unknown = withDist.filter((x) => x.d == null);
    const inside = known.filter((x) => (x.d as number) <= radius);
    const chosen = inside.length >= MIN_LOCAL_RESULTS ? inside : known.slice(0, MAX_LOCAL_FALLBACK);
    if (known.length > 0) {
      out = [...chosen, ...unknown].map((x) => x.l);
      localApplied = true;
    }
  }
  if (!localApplied) {
    const price = (l: AutoDevListing) => l.retailListing?.price ?? Number.POSITIVE_INFINITY;
    const yr = (l: AutoDevListing) => l.vehicle?.year ?? 0;
    if (q.sort === "price.asc") out = [...data].sort((a, b) => price(a) - price(b));
    else if (q.sort === "price.desc") out = [...data].sort((a, b) => (price(b) === Infinity ? -1 : price(b)) - (price(a) === Infinity ? -1 : price(a)));
    else if (q.sort === "year.desc") out = [...data].sort((a, b) => yr(b) - yr(a));
  }

  const totals = results.filter((r) => r.ok).map((r) => r.total);
  const total = totals.every((t) => t != null) ? (totals as number[]).reduce((a, b) => a + b, 0) : null;
  return { data: out, total: total != null && total >= out.length ? total : null, source: "edmunds_catalog", localApplied };
}

// ---------- diagnostics (aggregate-only; used by the key-protected /api/catalog-diag route) ----------

export interface CatalogDiagnostics {
  sampleSize: number;
  fields: Record<string, { populated: number; vinShaped: number; numericRange?: string }>;
  mappingChecks: Record<string, string>;
  textShapes: Record<string, string[]>;
  categoryValues: Record<string, number>;
  imageSchemes: Record<string, number>;
  imageFetchByHost: Record<string, { ok: number; fail: number; statuses: Record<string, number>; contentTypes: Record<string, number>; maxKB: number }>;
  probes: Record<string, string>;
  note: string;
}

const maskShape = (v: unknown, n: number): string =>
  String(v ?? "").slice(0, n).replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/\d/g, "9").replace(/a{2,}/g, "a+").replace(/A{2,}/g, "A+");

export async function diagnoseCatalog(): Promise<CatalogDiagnostics | { error: string }> {
  if (!catalogConfigured()) return { error: "catalogue credentials not configured" };
  const sid = process.env.IMPACT_ACCOUNT_SID!, token = process.env.IMPACT_AUTH_TOKEN!, catalog = process.env.IMPACT_CATALOG_ID!;
  const get = async (expr: string, size: number) => {
    const qs = new URLSearchParams({ Query: expr, PageSize: String(size) });
    try {
      const res = await fetch(`${IMPACT_BASE}/Mediapartners/${sid}/Catalogs/${catalog}/Items?${qs.toString()}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return { status: String(res.status), items: [] as Record<string, unknown>[], total: null as number | null };
      const b = (await res.json()) as { Items?: Record<string, unknown>[]; Total?: unknown };
      return { status: "200", items: b.Items ?? [], total: typeof b.Total === "number" ? b.Total : null };
    } catch {
      return { status: "network/timeout", items: [] as Record<string, unknown>[], total: null as number | null };
    }
  };
  const base = await get("Text1 = 'CR-V' AND CurrentPrice <= 30000", 20);
  const items = base.items;
  const fields: CatalogDiagnostics["fields"] = {};
  const nums: Record<string, number[]> = {};
  const cats: Record<string, number> = {};
  const schemes: Record<string, number> = { https: 0, http: 0, none: 0 };
  const SKIP = new Set(["id", "catalogid", "campaignid", "catalogitemid", "uri", "advertiserid", "mpn", "gtin", "asin"]);
  let yearAgree = 0, yearBoth = 0, milesOk = 0, zipOk = 0, makeParsed = 0, vinInMpn = 0;
  const imageUrls: string[] = [];
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      const f = (fields[k] ??= { populated: 0, vinShaped: 0 });
      const filled = !(v === "" || v == null || (Array.isArray(v) && v.length === 0));
      if (filled) f.populated++;
      if (typeof v === "string") {
        if (VIN_RE.test(v.trim().toUpperCase())) f.vinShaped++;
        const n = Number(v);
        if (v.trim() !== "" && Number.isFinite(n) && !SKIP.has(k.toLowerCase())) (nums[k] ??= []).push(n);
      } else if (typeof v === "number" && !SKIP.has(k.toLowerCase())) (nums[k] ??= []).push(v);
    }
    const c = str(it.Category); if (c) cats[c] = (cats[c] ?? 0) + 1;
    const nm = str(it.Name); const ny = /^\s*((?:19[89]|20[0-3])\d)\b/.exec(nm ?? "")?.[1];
    const n1 = plausibleYear(num(it.Numeric1));
    if (ny && n1 != null) { yearBoth++; if (Number(ny) === n1) yearAgree++; }
    if (plausibleMiles(num(it.Numeric2)) != null) milesOk++;
    if (dealerZip(it)) zipOk++;
    if (parseMakeFromName(nm)) makeParsed++;
    if (VIN_RE.test((str(it.Mpn) ?? "").toUpperCase())) vinInMpn++;
    try { const u = new URL(str(it.ImageUrl) ?? ""); schemes[u.protocol === "https:" ? "https" : "http"]++; imageUrls.push(u.toString()); } catch { schemes.none++; }
  }
  for (const [k, arr] of Object.entries(nums)) if (fields[k]) fields[k].numericRange = `${Math.min(...arr)}..${Math.max(...arr)}`;
  const N = items.length;
  const mappingChecks: Record<string, string> = {
    "Mpn is a VIN": `${vinInMpn}/${N}`,
    "Numeric1 = year in Name": `${yearAgree}/${yearBoth}`,
    "Numeric2 plausible mileage": `${milesOk}/${N}`,
    "ShippingLabel is a real US ZIP": `${zipOk}/${N}`,
    "make parsed from Name": `${makeParsed}/${N}`,
  };
  // Layout only (letters -> a/A, digits -> 9): shows whether these text fields carry a city/state/ZIP without printing any real value.
  const textShapes: Record<string, string[]> = {
    Text3: items.slice(0, 3).map((i) => maskShape(i.Text3, 70)),
    Description: items.slice(0, 2).map((i) => maskShape(i.Description, 110)),
    Name: items.slice(0, 2).map((i) => maskShape(i.Name, 50)),
  };

  // Fetch EVERY sampled photo server-side exactly as our image proxy does, grouped by host.
  const imageFetchByHost: CatalogDiagnostics["imageFetchByHost"] = {};
  await Promise.all(imageUrls.map(async (url) => {
    const host = new URL(url).hostname;
    const h = (imageFetchByHost[host] ??= { ok: 0, fail: 0, statuses: {}, contentTypes: {}, maxKB: 0 });
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "CarCleverFindMyCar-ImageProxy/1.0", Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } });
      const ct = (r.headers.get("content-type") ?? "none").split(";")[0].slice(0, 30);
      const kb = Math.round(Number(r.headers.get("content-length") ?? 0) / 1024);
      h.statuses[String(r.status)] = (h.statuses[String(r.status)] ?? 0) + 1;
      h.contentTypes[ct] = (h.contentTypes[ct] ?? 0) + 1;
      h.maxKB = Math.max(h.maxKB, kb);
      if (r.ok && ct.startsWith("image/")) h.ok++; else h.fail++;
      void r.body?.cancel();
    } catch (e) {
      h.fail++; const k = String((e as Error)?.name ?? "error"); h.statuses[k] = (h.statuses[k] ?? 0) + 1;
    }
  }));

  const hist = (arr: string[]) => { const m: Record<string, number> = {}; for (const a of arr) m[a] = (m[a] ?? 0) + 1; return JSON.stringify(m); };
  const probeDefs: Array<[string, string, (items: Record<string, unknown>[]) => string]> = [
    ["Name ~ '2024' (contains: model year in Name)", "Text1 = 'CR-V' AND Name ~ '2024' AND CurrentPrice <= 30000", (it) => `names starting 2024: ${it.filter((i) => /^\s*2024\b/.test(str(i.Name) ?? "")).length}/${it.length}`],
    ["Name ~ '2022'", "Text1 = 'CR-V' AND Name ~ '2022' AND CurrentPrice <= 30000", (it) => `names starting 2022: ${it.filter((i) => /^\s*2022\b/.test(str(i.Name) ?? "")).length}/${it.length}`],
    ["Text3 ~ 'Beverly Hills' (dealer address contains city?)", "Text1 = 'CR-V' AND Text3 ~ 'Beverly Hills'", (it) => `dealer ZIP3 histogram: ${hist(it.map((i) => (dealerZip(i)?.zip ?? "????").slice(0, 3)))}`],
    ["Text3 ~ 'CA' (dealer address contains state?)", "Text1 = 'CR-V' AND Text3 ~ 'CA'", (it) => `dealer state histogram: ${hist(it.map((i) => dealerZip(i)?.state ?? "?"))}`],
    ["Text3 ~ '90210' (dealer address contains ZIP?)", "Text1 = 'CR-V' AND Text3 ~ '90210'", (it) => `dealer ZIP3 histogram: ${hist(it.map((i) => (dealerZip(i)?.zip ?? "????").slice(0, 3)))}`],
    ["Description ~ 'Los Angeles'", "Text1 = 'CR-V' AND Description ~ 'Los Angeles'", (it) => `dealer state histogram: ${hist(it.map((i) => dealerZip(i)?.state ?? "?"))}`],
    ["OR: Text1 = 'CR-V' OR Text1 = 'RAV4'", "Text1 = 'CR-V' OR Text1 = 'RAV4'", (it) => `models: ${hist(it.map((i) => str(i.Text1) ?? "?"))}`],
    ["IN: Text1 IN ('CR-V','RAV4')", "Text1 IN ('CR-V','RAV4')", (it) => `models: ${hist(it.map((i) => str(i.Text1) ?? "?"))}`],
    ["Manufacturer ~ 'Honda' (dealer name contains)", "Text1 = 'CR-V' AND Manufacturer ~ 'Honda'", (it) => `returned dealers containing Honda: ${it.filter((i) => /honda/i.test(str(i.Manufacturer) ?? "")).length}/${it.length}`],
    ["ShippingLabel = '90210' (expected 400)", "Text1 = 'CR-V' AND ShippingLabel = '90210'", () => ""],
    ["Numeric2 <= 60000 (expected 400)", "Text1 = 'CR-V' AND Numeric2 <= 60000", () => ""],
  ];
  const results = await Promise.all(probeDefs.map(async ([label, expr, summarize]) => {
    const r = await get(expr, 20);
    return [label, r.status === "200" ? `ok: returned ${r.items.length}${r.total != null ? `, total ${r.total}` : ""}${r.items.length ? "; " + summarize(r.items) : ""}` : `HTTP ${r.status}`] as const;
  }));
  const probes: Record<string, string> = Object.fromEntries(results);
  const big = await get("Text1 = 'CR-V' AND CurrentPrice <= 30000", 100);
  probes["PageSize=100"] = big.status === "200" ? `yes (returned ${big.items.length})` : `HTTP ${big.status}`;

  return { sampleSize: N, fields, mappingChecks, textShapes, categoryValues: cats, imageSchemes: schemes, imageFetchByHost, probes, note: "aggregates and layouts only: no VINs, URLs, dealer names, street addresses or credentials" };
}
