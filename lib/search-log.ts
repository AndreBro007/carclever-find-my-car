import { getCatalogPool } from "./catalog-db-source";

/**
 * Privacy-safe search log. ON in test mode (André, Oct 15, 2026: switched on to test; production still to decide).
 * Stores only: day, make, model, price ceiling band, state, and how many cars were found and shown.
 * Never stores ZIP codes, names, IP addresses or VINs.
 */
export const SEARCH_LOG_ENABLED = true;

export function priceBand(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  if (p <= 15000) return "up to 15k";
  if (p <= 25000) return "15k to 25k";
  if (p <= 40000) return "25k to 40k";
  return "over 40k";
}

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = getCatalogPool()
      .query(`CREATE TABLE IF NOT EXISTS search_log (
        id bigserial PRIMARY KEY,
        day date NOT NULL DEFAULT current_date,
        make text, model text, price_band text, state char(2),
        found integer NOT NULL, shown integer NOT NULL)`)
      .then(() => undefined);
  }
  return tableReady;
}

export interface SearchLogEvent {
  make?: string | null;
  model?: string | null;
  priceMax?: number | null;
  state?: string | null;
  found: number;
  shown: number;
}

export async function logSearchEvent(e: SearchLogEvent): Promise<void> {
  if (!SEARCH_LOG_ENABLED) return;
  await ensureTable();
  const st = e.state ? e.state.trim().toUpperCase().slice(0, 2) : null;
  await getCatalogPool().query(
    "INSERT INTO search_log (make, model, price_band, state, found, shown) VALUES ($1, $2, $3, $4, $5, $6)",
    [e.make ?? null, e.model ?? null, priceBand(e.priceMax), st, e.found, e.shown],
  );
}
