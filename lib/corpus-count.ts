/**
 * Corpus count cache — total inventory count from one unfiltered call, cached 24h.
 * Ported near-verbatim from the flagship app's confirmed real implementation
 * (server.ts corpusCountCache block, see reference/source-exports).
 *
 * TODO before relying on this in production: the flagship's real fallback
 * string is "4.4 million", but a live search response captured the same day
 * showed corpus_total: 3,606,438 (~3.6M) in its metadata. Unclear whether
 * that field measures something narrower (e.g. a specific query's matched
 * pool) or the fallback is stale. Verify before trusting the fallback value
 * — see DECISIONS.md SYS-20260812-021.
 */

import { configuredMode } from "./source-mode";
import { catalogConfigured } from "./catalog-source";

let corpusCountCache: { count: number; timestamp: number } | null = null;
const CORPUS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Formatted corpus count string used in the tool description.
// Pre-populated at startup via a background fetch; falls back if unavailable.
let corpusCountForDescription = "several million"; // deliberately vaguer than the flagship's "4.4 million" until the discrepancy above is resolved

export function getCorpusCountForDescription(): string {
  // spike/edmunds-catalog-mode: when the catalogue is the source, describe the catalogue (1.35M items at last check).
  if (configuredMode() === "edmunds_catalog" && catalogConfigured()) return "about 1.3 million";
  return corpusCountForDescription;
}

export function getCorpusCountCache() {
  return corpusCountCache;
}

async function refreshCorpusCount() {
  try {
    const apiKey = process.env.AUTO_DEV_API_KEY;
    if (!apiKey) return;
    const res = await fetch("https://api.auto.dev/listings?limit=1&includes=total", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return;
    const json: any = await res.json();
    const total = typeof json?.total === "number" ? json.total : null;
    if (total !== null) {
      corpusCountCache = { count: total, timestamp: Date.now() };
      const rounded = Math.round(total / 100000) / 10;
      corpusCountForDescription = `${rounded} million`;
    }
  } catch {
    /* silent — fallback value remains */
  }
}

export function initCorpusCount() {
  // spike/edmunds-catalog-mode: this refresh spends one Auto.dev call per cold start purely for a
  // cosmetic header number. Off unless CORPUS_COUNT_REFRESH=true, so no allowance is spent on it.
  if (process.env.CORPUS_COUNT_REFRESH !== "true") return;
  if (!corpusCountCache || Date.now() - corpusCountCache.timestamp > CORPUS_CACHE_TTL) {
    void refreshCorpusCount();
  }
}
