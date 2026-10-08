/**
 * Listing-source mode + Auto.dev exhaustion breaker (spike/edmunds-catalog-mode).
 *
 * Purely additive. Decides WHICH listing source serves a search, without
 * touching any existing Auto.dev code path:
 *   LISTING_SOURCE=auto_dev        -> Auto.dev only (previous behaviour)
 *   LISTING_SOURCE=edmunds_catalog -> Edmunds/Impact catalogue only, ZERO Auto.dev calls
 *   LISTING_SOURCE=auto (default)  -> Auto.dev first; when Auto.dev starts rejecting
 *                                     calls (quota/auth/rate/outage) switch to the
 *                                     catalogue automatically for a cooldown window.
 *
 * With no Impact credentials configured the catalogue is "unavailable" and every
 * mode behaves exactly like auto_dev, so merging this code changes nothing until
 * the credentials are set.
 *
 * The breaker state is per server instance (module scope). That is deliberate:
 * a cold instance spends at most one rejected call learning the state, and
 * rejected calls are not expected to consume allowance.
 */
export type ListingSourceMode = "auto_dev" | "edmunds_catalog" | "auto";

export function configuredMode(): ListingSourceMode {
  const v = (process.env.LISTING_SOURCE ?? "auto").trim().toLowerCase();
  return v === "auto_dev" || v === "edmunds_catalog" ? v : "auto";
}

const QUOTA_COOLDOWN_MS = 15 * 60_000; // 401/402/403: allowance or auth problem
const RATE_COOLDOWN_MS = 2 * 60_000; // 429 and repeated 5xx: short back-off, then re-probe
const SERVER_ERROR_STREAK = 3;

let exhaustedUntil = 0;
let serverErrorStreak = 0;

export type AutoDevOutcomeSignal = { ok: true } | { ok: false; reason: "timeout" | "http" | "network"; status?: number };

export function noteAutoDevOutcome(o: AutoDevOutcomeSignal, now: number = Date.now()): void {
  if (o.ok) {
    serverErrorStreak = 0;
    exhaustedUntil = 0; // a successful call proves Auto.dev is serving again
    return;
  }
  if (o.reason !== "http") return; // timeouts/network blips are not allowance signals
  const s = o.status ?? 0;
  if (s === 401 || s === 402 || s === 403) {
    exhaustedUntil = now + QUOTA_COOLDOWN_MS;
  } else if (s === 429) {
    exhaustedUntil = now + RATE_COOLDOWN_MS;
  } else if (s >= 500) {
    serverErrorStreak += 1;
    if (serverErrorStreak >= SERVER_ERROR_STREAK) exhaustedUntil = now + RATE_COOLDOWN_MS;
  }
  // other 4xx (e.g. 400 bad parameter) are our request's fault, not exhaustion
}

export function autoDevLooksExhausted(now: number = Date.now()): boolean {
  return now < exhaustedUntil;
}

export function resetSourceModeStateForTests(): void {
  exhaustedUntil = 0;
  serverErrorStreak = 0;
}
