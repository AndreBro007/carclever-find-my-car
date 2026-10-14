import { NextResponse } from "next/server";
import { catalogDbConfigured, getCatalogPool } from "@/lib/catalog-db-source";

/** Read-only status of the catalogue database: counts, dates and last load time. No VINs, no secrets. */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!catalogDbConfigured()) return NextResponse.json({ configured: false });
  try {
    const db = getCatalogPool();
    const totals = await db.query(`
      SELECT
        count(*)::int AS cars,
        count(*) FILTER (WHERE condition = 'n')::int AS new_cars,
        count(*) FILTER (WHERE condition = 'u')::int AS used_cars,
        count(*) FILTER (WHERE first_seen IS NULL)::int AS cars_without_first_seen,
        count(*) FILTER (WHERE first_seen = current_date)::int AS first_seen_today,
        count(*) FILTER (WHERE price_changed_at >= current_date - 7)::int AS price_changed_last_7_days,
        max(loaded_at) AS last_loaded_at
      FROM listing`);
    const seenByDay = await db.query(`
      SELECT first_seen::text AS day, count(*)::int AS cars FROM listing
      WHERE first_seen IS NOT NULL GROUP BY first_seen ORDER BY first_seen DESC LIMIT 7`);
    const changedByDay = await db.query(`
      SELECT price_changed_at::text AS day, count(*)::int AS cars FROM listing
      WHERE price_changed_at IS NOT NULL GROUP BY price_changed_at ORDER BY price_changed_at DESC LIMIT 7`);
    let searchLog: unknown = "table not created yet (no search logged since switch-on)";
    try {
      searchLog = (await db.query("SELECT count(*)::int AS searches, max(day)::text AS last_day FROM search_log")).rows[0];
    } catch { /* table is created by the first logged search */ }
    let searchByDay: unknown = [];
    let topSearches: unknown = [];
    try {
      searchByDay = (await db.query("SELECT day::text AS day, count(*)::int AS searches, count(*) FILTER (WHERE found = 0)::int AS no_results FROM search_log GROUP BY day ORDER BY day DESC LIMIT 7")).rows;
      topSearches = (await db.query("SELECT make, model, count(*)::int AS searches FROM search_log WHERE day >= current_date - 7 GROUP BY make, model ORDER BY searches DESC LIMIT 10")).rows;
    } catch { /* table is created by the first logged search */ }
    return NextResponse.json({
      configured: true,
      search_log: searchLog,
      search_by_day: searchByDay,
      top_searches_last_7_days: topSearches,
      ...totals.rows[0],
      first_seen_by_day: seenByDay.rows,
      price_changes_by_day: changedByDay.rows,
    });
  } catch {
    return NextResponse.json(
      { configured: true, error: "status unavailable (schema not yet migrated or database unreachable)" },
      { status: 503 },
    );
  }
}
