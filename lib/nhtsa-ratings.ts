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
type Variant = { desc: string; rating: number | null };
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
    return { desc: String(rows(d)[0]?.VehicleDescription ?? x.VehicleDescription ?? ""), rating: parseRating(rows(d)[0]?.OverallRating) };
  }));
  if (variants.some((v) => v === null)) return null; // a variant lookup failed: incomplete, do not cache
  const done = variants as Variant[];
  if (cache.size >= MAX_CACHE) { const k = cache.keys().next().value; if (k !== undefined) cache.delete(k); }
  cache.set(key, { t: Date.now(), variants: done });
  return done;
}

export async function lookupOverallRating(year: unknown, make: unknown, model: unknown, driveType?: string | null): Promise<NhtsaRating | null> {
  const y = String(year ?? "").trim(), mk = String(make ?? "").trim(), md = String(model ?? "").trim();
  if (!/^\d{4}$/.test(y) || !mk || !md) return null;
  const variants = await loadVariants(y, mk, md);
  const rated = (variants ?? []).filter((v) => v.rating != null);
  if (rated.length === 0) return null;
  const set = new Set(rated.map((v) => v.rating));
  if (set.size === 1) return { overall: rated[0].rating as NhtsaRating["overall"] };
  if (driveType) { // variants disagree: use the variant that matches this car's drive type, else say nothing
    const m = rated.filter((v) => new RegExp(`\\b${driveType === "4WD" ? "(4WD|4X4)" : driveType}\\b`, "i").test(v.desc));
    if (m.length > 0 && new Set(m.map((v) => v.rating)).size === 1) return { overall: m[0].rating as NhtsaRating["overall"] };
  }
  return null;
}

/** Adds `rating` to each decode result (in parallel, within a time budget). Never throws; a slow or failed lookup leaves the result unrated. */
export async function attachNhtsaRatings<T extends { modelYear: string | null; make: string | null; model: string | null; specs?: { driveType: string | null } } | null | undefined>(
  results: T[], budgetMs = 3_500,
): Promise<Array<(T extends null | undefined ? never : T & { rating?: NhtsaRating | null }) | null | undefined>> {
  const one = async (r: T) => {
    if (!r) return r as any;
    const rating = await Promise.race([
      lookupOverallRating(r.modelYear, r.make, r.model, r.specs?.driveType ?? null),
      new Promise<null>((res) => setTimeout(() => res(null), budgetMs)),
    ]).catch(() => null);
    return rating ? { ...r, rating } : r;
  };
  return Promise.all(results.map(one));
}
