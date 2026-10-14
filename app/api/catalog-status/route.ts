import { NextResponse } from "next/server";
import { catalogDbConfigured, getCatalogPool } from "@/lib/catalog-db-source";

/** Read-only status of the catalogue database: counts and last load time. No VINs, no secrets. */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!catalogDbConfigured()) return NextResponse.json({ configured: false });
  try {
    const { rows } = await getCatalogPool().query(`
      SELECT
        count(*)::int AS cars,
        count(*) FILTER (WHERE condition = 'n')::int AS new_cars,
        count(*) FILTER (WHERE condition = 'u')::int AS used_cars,
        count(*) FILTER (WHERE first_seen = current_date)::int AS first_seen_today,
        count(*) FILTER (WHERE price_changed_at >= current_date - 7)::int AS price_changed_last_7_days,
        min(first_seen) AS first_load_date,
        max(loaded_at) AS last_loaded_at
      FROM listing`);
    return NextResponse.json({ configured: true, ...rows[0] });
  } catch {
    return NextResponse.json(
      { configured: true, error: "status unavailable (schema not yet migrated or database unreachable)" },
      { status: 503 },
    );
  }
}
