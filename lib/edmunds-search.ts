/**
 * Live Google-search-based confirmation for Edmunds VIN listings.
 *
 * Design source: getcarwise-docs/HANDOFF_EDMUNDS_VIN_SEARCH_EXPERIMENT_20260903.md
 * "Final design decision", corrected 2026-09-03 by Andre: approved for
 * implementation as part of the confirmed design, not merely an experiment.
 *
 * Mechanism chosen: Google Custom Search JSON API (a.k.a. Programmable
 * Search Engine), restricted with `site:edmunds.com` query terms. This is
 * the only practical *live* Google search mechanism available to a
 * server-side Next.js route with normal credentials — scraping Google's own
 * results page directly is against Google's Terms of Service, fragile, and
 * easily blocked, so it was ruled out rather than attempted.
 *
 * CONCRETE BLOCKER (as of 2026-09-03): this Vercel project has no
 * GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX configured yet (not present in
 * .env.example or Vercel's env vars at the time this file was written).
 * Until both are set, isGoogleSearchConfigured() returns false and every
 * exported function here short-circuits to null with zero network calls —
 * lib/link-resolution.ts then falls back to its pre-existing, already-
 * tested default behavior (unconfirmed exact VIN URL, or the category-page
 * fallback), exactly matching production behavior before this file existed.
 * This is a deliberate fail-open design, not a bug: once both env vars are
 * set in Vercel (Project Settings -> Environment Variables) for the
 * relevant environment(s), the live confirmation path activates with no
 * further code change needed.
 *
 * Getting credentials (for whoever sets this up):
 * 1. Create a Programmable Search Engine at
 *    https://programmablesearchengine.google.com — "Search the entire web"
 *    is fine, since every query here already includes `site:edmunds.com`.
 *    This gives you the CX (search engine ID).
 * 2. Enable the "Custom Search API" for a Google Cloud project at
 *    https://console.cloud.google.com and create an API key for it.
 *
 * Cost/volume note (flagging, not blocking): this module can be called up
 * to 2x per shortlisted listing (one exact-VIN query, one targeted fallback
 * query when the first misses) — see lib/link-resolution.ts. The app's
 * BROAD_SHORTLIST_SIZE is 8, so a single tool call can issue up to 16
 * queries in the worst case (every exact-VIN query misses). The Custom
 * Search API's free tier is 100 queries/day; at the worst-case rate that
 * exhausts after roughly 6 real user searches/day. Monitor actual usage
 * once credentials are added rather than assuming the free tier suffices —
 * this may need a paid quota or a per-request cap (e.g. only the first N
 * shortlisted listings) depending on real traffic.
 */

const GOOGLE_CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

// Kept short deliberately: this runs inline in the tool-call path, once per
// shortlisted listing (up to twice each) — a slow/hanging search must not
// meaningfully delay the whole response. Matches the general timeout
// philosophy in lib/auto-dev-client.ts (fail fast, degrade gracefully)
// rather than that file's specific 25s value, which is tuned for a single
// large listings fetch, not N small search queries run per-listing.
const SEARCH_TIMEOUT_MS = 4_000;

export function isGoogleSearchConfigured(): boolean {
  return !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX);
}

interface CseItem {
  link?: string;
}
interface CseResponse {
  items?: CseItem[];
}

/**
 * Runs one Custom Search API query. Never throws — any credential-missing,
 * network, timeout, or non-2xx-response condition returns an empty array
 * so callers can treat "no evidence found" and "search failed" identically
 * (both mean: don't trust this destination, fall through to the next tier).
 */
async function runCseQuery(query: string): Promise<string[]> {
  if (!isGoogleSearchConfigured()) return [];

  const params = new URLSearchParams({
    key: process.env.GOOGLE_CSE_API_KEY!,
    cx: process.env.GOOGLE_CSE_CX!,
    q: query,
    num: "5",
  });

  try {
    const res = await fetch(`${GOOGLE_CSE_ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[edmunds-search] CSE HTTP ${res.status} for query: ${query}`);
      return [];
    }
    const data = (await res.json()) as CseResponse;
    return (data.items ?? []).map((i) => i.link).filter((l): l is string => !!l);
  } catch (err) {
    const isTimeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    console.error(`[edmunds-search] CSE query ${isTimeout ? "timed out" : "failed"}:`, query, err);
    return [];
  }
}

/**
 * Step 1 of the approved design: exact `site:edmunds.com "<VIN>"` search.
 * Returns the matching Edmunds URL if Google's index confirms this VIN's
 * page exists, else null. Never invents or normalizes a URL Google didn't
 * actually return.
 */
export async function confirmExactVinListing(vin: string | undefined): Promise<string | null> {
  const trimmedVin = vin?.trim();
  if (!trimmedVin) return null;

  const links = await runCseQuery(`site:edmunds.com "${trimmedVin}"`);
  const match = links.find(
    (l) => l.toLowerCase().includes("edmunds.com") && l.toLowerCase().includes(trimmedVin.toLowerCase()),
  );
  return match ?? null;
}

/**
 * Step 2 of the approved design: exactly one targeted, non-VIN search using
 * year + make + model + trim + dealer/location, restricted to
 * site:edmunds.com. Per the approved design, this deliberately never adds
 * separate stock-number, price, mileage, or color searches — testing (see
 * getcarwise-docs handoff doc) showed a stock-number addition did not
 * improve discovery, and no other qualifier was ever tested.
 * Returns the first Edmunds URL found, else null.
 */
export async function findTargetedEdmundsFallback(params: {
  year?: number | string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  dealer?: string | null;
  location?: string | null;
}): Promise<string | null> {
  const terms = [params.year, params.make, params.model, params.trim, params.dealer, params.location]
    .filter((t) => t != null && String(t).trim() !== "")
    .map((t) => String(t).trim());

  if (terms.length === 0) return null;

  const query = `site:edmunds.com ${terms.join(" ")}`;
  const links = await runCseQuery(query);
  const match = links.find((l) => l.toLowerCase().includes("edmunds.com"));
  return match ?? null;
}
