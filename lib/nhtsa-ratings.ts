/**
 * NHTSA 5-Star Safety Rating (NCAP) lookup, per MODEL YEAR variant, never per car.
 * api.nhtsa.gov/SafetyRatings: (1) list the variants of year/make/model, (2) read each variant's OverallRating.
 * Unknown is never shown as bad: not rated, failed lookups and variants that disagree (with no way to pick) give no label.
 */
const BASE = "https://api.nhtsa.gov/SafetyRatings";
const TIMEOUT_MS = 2_500;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VARIANTS = 8;
const MAX_CACHE = 2000;

export interface NhtsaRating { overall: 1 | 2 | 3 | 4 | 5 }
type Variant = { desc: string; rating: number | null; recalls: number | null };
const cache = new Map<string, { t: number; variants: Variant[] }>();
export function resetNhtsaRatingCacheForTests(): void { cache.clear(); }

/** Colour tone of the card pill: each star level has its own colour (5 green, 4 light green, 3 yellow, 2 amber, 1 red). */
export function ratingTone(n: number): "green" | "lime" | "yellow" | "amber" | "red" {
  return n >= 5 ? "green" : n === 4 ? "lime" : n === 3 ? "yellow" : n === 2 ? "amber" : "red";
}

const rows = (j: any): any[] => (Array.isArray(j?.Results) ? j.Results : Array.isArray(j?.results) ? j.results : []);
async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const parseRating = (v: unknown): number | null => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
};

async function loadVariants(year: string, make: string, model: string): Promise<Variant[] | null> {
  const key = `${year}|${make}|${model}`.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.variants;
  const list = await getJson(`${BASE}/modelyear/${encodeURIComponent(year)}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}?format=json`);
  if (list == null) return null; // lookup failed: do not cache
  const found = rows(list).filter((x) => x?.VehicleId != null).slice(0, MAX_VARIANTS);
  const variants = await Promise.all(found.map(async (x): Promise<Variant | null> => {
    const d = await getJson(`${BASE}/VehicleId/${encodeURIComponent(String(x.VehicleId))}?format=json`);
    if (d == null) return null;
    const row = rows(d)[0];
    const rc = Number(row?.RecallsCount);
    return { desc: String(row?.VehicleDescription ?? x.VehicleDescription ?? ""), rating: parseRating(row?.OverallRating), recalls: row?.RecallsCount != null && Number.isFinite(rc) && rc >= 0 ? rc : null };
  }));
  if (variants.some((v) => v === null)) return null; // a variant lookup failed: incomplete, do not cache
  const done = variants as Variant[];
  if (cache.size >= MAX_CACHE) { const k = cache.keys().next().value; if (k !== undefined) cache.delete(k); }
  cache.set(key, { t: Date.now(), variants: done });
  return done;
}

/** Picks one value across variants: all agree -> that value; else the variants matching this car\'s drive type if they agree; else unknown (null). */
function pick(vs: Variant[], get: (v: Variant) => number | null, driveType?: string | null): number | null {
  const have = vs.filter((v) => get(v) != null);
  if (have.length === 0) return null;
  if (new Set(have.map((v) => get(v))).size === 1) return get(have[0]);
  if (driveType) {
    const re = new RegExp(`\\b${driveType === "4WD" ? "(4WD|4X4)" : driveType}\\b`, "i");
    const m = have.filter((v) => re.test(v.desc));
    if (m.length > 0 && new Set(m.map((v) => get(v))).size === 1) return get(m[0]);
  }
  return null;
}

export interface NhtsaModelYearSafety { overall: NhtsaRating["overall"] | null; recallCampaigns: number | null }

/** Rating and recall-campaign count for this model year, from the same two NHTSA calls. Null when the model year is not in NHTSA's list or the lookup failed. */
export async function lookupModelYearSafety(year: unknown, make: unknown, model: unknown, driveType?: string | null): Promise<NhtsaModelYearSafety | null> {
  const y = String(year ?? "").trim(), mk = String(make ?? "").trim(), md = String(model ?? "").trim();
  if (!/^\d{4}$/.test(y) || !mk || !md) return null;
  const variants = await loadVariants(y, mk, md);
  if (!variants || variants.length === 0) return null;
  const overall = pick(variants, (v) => v.rating, driveType) as NhtsaRating["overall"] | null;
  const recallCampaigns = pick(variants, (v) => v.recalls, driveType);
  return overall == null && recallCampaigns == null ? null : { overall, recallCampaigns };
}

export async function lookupOverallRating(year: unknown, make: unknown, model: unknown, driveType?: string | null): Promise<NhtsaRating | null> {
  const r = await lookupModelYearSafety(year, make, model, driveType);
  return r?.overall != null ? { overall: r.overall } : null;
}

/** Adds `rating` to each decode result (in parallel, within a time budget). Never throws; a slow or failed lookup leaves the result unrated. */
export async function attachNhtsaRatings<T extends { modelYear: string | null; make: string | null; model: string | null; specs?: { driveType: string | null } } | null | undefined>(
  results: T[], budgetMs = 3_500,
): Promise<Array<(T extends null | undefined ? never : T & { rating?: NhtsaRating | null; recallCampaigns?: number | null }) | null | undefined>> {
  const one = async (r: T) => {
    if (!r) return r as any;
    const safety = await Promise.race([
      lookupModelYearSafety(r.modelYear, r.make, r.model, r.specs?.driveType ?? null),
      new Promise<null>((res) => setTimeout(() => res(null), budgetMs)),
    ]).catch(() => null);
    if (!safety) return r;
    return { ...r, ...(safety.overall != null ? { rating: { overall: safety.overall } } : {}), ...(safety.recallCampaigns != null ? { recallCampaigns: safety.recallCampaigns } : {}) };
  };
  return Promise.all(results.map(one));
}
