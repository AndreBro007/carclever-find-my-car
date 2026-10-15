import { NextResponse } from "next/server";
import { catalogDbConfigured, getCatalogPool } from "@/lib/catalog-db-source";

/**
 * Read-only status of the catalogue database: counts, dates and searches. Counts only: no VINs, no secrets.
 * HTML by default for people; add ?format=json for machines. Never indexed by search engines.
 */
export const dynamic = "force-dynamic";
const NO_INDEX = { "x-robots-tag": "noindex, nofollow" };

type Rows = Record<string, unknown>[];

async function collect(): Promise<Record<string, unknown>> {
  if (!catalogDbConfigured()) return { configured: false };
  const db = getCatalogPool();
  try {
    const totals = (await db.query(`
      SELECT
        count(*)::int AS cars,
        count(*) FILTER (WHERE condition = 'n')::int AS new_cars,
        count(*) FILTER (WHERE condition = 'u')::int AS used_cars,
        count(*) FILTER (WHERE first_seen IS NULL)::int AS cars_from_first_load,
        count(*) FILTER (WHERE first_seen = current_date)::int AS first_seen_today,
        count(*) FILTER (WHERE price_changed_at >= current_date - 7)::int AS price_changed_last_7_days,
        max(loaded_at) AS last_loaded_at
      FROM listing`)).rows[0];
    const seenByDay = (await db.query(`SELECT first_seen::text AS day, count(*)::int AS cars FROM listing
      WHERE first_seen IS NOT NULL GROUP BY first_seen ORDER BY first_seen DESC LIMIT 7`)).rows;
    const changedByDay = (await db.query(`SELECT price_changed_at::text AS day, count(*)::int AS cars FROM listing
      WHERE price_changed_at IS NOT NULL GROUP BY price_changed_at ORDER BY price_changed_at DESC LIMIT 7`)).rows;
    let searchTotals: Record<string, unknown> | string = "not created yet (no search logged since switch-on)";
    let searchByDay: Rows = [];
    let topSearches: Rows = [];
    try {
      searchTotals = (await db.query("SELECT count(*)::int AS searches, max(day)::text AS last_day FROM search_log")).rows[0];
      searchByDay = (await db.query("SELECT day::text AS day, count(*)::int AS searches, count(*) FILTER (WHERE found = 0)::int AS no_results FROM search_log GROUP BY day ORDER BY day DESC LIMIT 7")).rows;
      topSearches = (await db.query("SELECT make, model, count(*)::int AS searches FROM search_log WHERE day >= current_date - 7 GROUP BY make, model ORDER BY searches DESC LIMIT 10")).rows;
    } catch { /* the search log table is created by the first logged search */ }
    let loadRuns: Record<string, unknown>[] = [];
    try {
      loadRuns = (await db.query("SELECT started_at::text AS started_at, trigger, run_id FROM load_log ORDER BY started_at DESC LIMIT 5")).rows;
    } catch { /* load_log is written by the daily job; empty until the first run */ }
    return { configured: true, ...totals, load_runs: loadRuns, first_seen_by_day: seenByDay, price_changes_by_day: changedByDay,
      search_totals: searchTotals, search_by_day: searchByDay, top_searches_last_7_days: topSearches };
  } catch {
    return { configured: true, error: "status unavailable (schema not yet migrated or database unreachable)" };
  }
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const num = (v: unknown): string => (typeof v === "number" ? v.toLocaleString("en-GB") : esc(v));

function table(headers: string[], rows: Rows, keys: string[]): string {
  if (rows.length === 0) return "<p class=\"muted\">No rows yet.</p>";
  return "<table><thead><tr>" + headers.map((h) => `<th>${esc(h)}</th>`).join("") + "</tr></thead><tbody>" +
    rows.map((r) => "<tr>" + keys.map((k) => `<td>${num(r[k])}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
}

function html(d: Record<string, unknown>): string {
  const body = d.configured === false
    ? "<p>Catalogue database not configured.</p>"
    : d.error
      ? `<p>${esc(d.error)}</p>`
      : `
<h2>Database</h2>
<table class="kv">
  <tr><th>Cars listed</th><td>${num(d.cars)}</td></tr>
  <tr><th>New</th><td>${num(d.new_cars)}</td></tr>
  <tr><th>Used</th><td>${num(d.used_cars)}</td></tr>
  <tr><th>Last load (UTC)</th><td>${esc(d.last_loaded_at)}</td></tr>
</table>
<h2>Changes from daily loads</h2>
<table class="kv">
  <tr><th>Cars first seen today</th><td>${num(d.first_seen_today)}</td></tr>
  <tr><th>Price changes in the last 7 days</th><td>${num(d.price_changed_last_7_days)}</td></tr>
  <tr><th>Cars from the first load (no first-seen date)</th><td>${num(d.cars_from_first_load)}</td></tr>
</table>
<h3>First seen, by day</h3>
${table(["Day", "Cars"], (d.first_seen_by_day as Rows) ?? [], ["day", "cars"])}
<h3>Price changes, by day</h3>
${table(["Day", "Cars"], (d.price_changes_by_day as Rows) ?? [], ["day", "cars"])}
<h2>Daily job runs (latest 5)</h2>
${table(["Started (UTC)", "Trigger", "Run ID"], (d.load_runs as Rows) ?? [], ["started_at", "trigger", "run_id"])}
<h2>Searches (search log, test mode)</h2>
<p>${typeof d.search_totals === "string" ? esc(d.search_totals) : `Total: ${num((d.search_totals as Record<string, unknown>)?.searches)}, last day: ${esc((d.search_totals as Record<string, unknown>)?.last_day)}`}</p>
<h3>By day</h3>
${table(["Day", "Searches", "No results"], (d.search_by_day as Rows) ?? [], ["day", "searches", "no_results"])}
<h3>Top searches, last 7 days</h3>
${table(["Make", "Model", "Searches"], (d.top_searches_last_7_days as Rows) ?? [], ["make", "model", "searches"])}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalogue status (test)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1b1f24;line-height:1.4}
h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-bottom:1px solid #d8dee4;padding-bottom:4px} h3{font-size:14px;margin:16px 0 6px;color:#57606a}
table{border-collapse:collapse;width:100%;margin:4px 0} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eaeef2;font-size:14px}
table:not(.kv) th{background:#f6f8fa} table.kv th{width:60%;font-weight:500;color:#57606a}
.muted,.note{color:#57606a;font-size:13px} td{font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Catalogue database status <span class="muted">(test)</span></h1>
${body}
<p class="note">Counts only: no VINs or secrets. Machine-readable version: add <code>?format=json</code> to this address.</p>
</body></html>`;
}

export async function GET(request: Request) {
  const data = await collect();
  if (new URL(request.url).searchParams.get("format") === "json") {
    return NextResponse.json(data, { headers: NO_INDEX });
  }
  return new Response(html(data), { headers: { "content-type": "text/html; charset=utf-8", ...NO_INDEX } });
}
