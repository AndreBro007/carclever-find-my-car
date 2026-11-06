import { getCatalogPool } from "@/lib/catalog-db-source";
import { ensureUsageTables, runUsageRetention } from "@/lib/usage-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Daily retention for usage events (Phase C P6): raw rows older than 90 days are rolled into usage_daily_summary and deleted; summaries older than 24 months are deleted.
 * Protected by CRON_SECRET (Vercel sends it as a bearer token to scheduled jobs). With no CRON_SECRET set the endpoint refuses every request, so it is inert until set deliberately.
 * The whole run is one transaction, so a failed run changes nothing and a repeat is safe.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  const client = await getCatalogPool().connect();
  try {
    await ensureUsageTables();
    const result = await runUsageRetention(client);
    return Response.json({ ok: true, ...result });
  } catch {
    return Response.json({ ok: false, error: "retention failed; nothing was changed" }, { status: 500 });
  } finally {
    client.release();
  }
}
