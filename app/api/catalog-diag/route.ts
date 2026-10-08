// Temporary, key-protected, aggregate-only catalogue diagnostics (spike/edmunds-catalog-mode).
// 404 unless CATALOG_DIAG_KEY is set AND the request carries it. Remove before cutover.
import { diagnoseCatalog } from "@/lib/catalog-source";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const want = process.env.CATALOG_DIAG_KEY;
  const got = new URL(req.url).searchParams.get("k") ?? "";
  const ok = !!want && want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return new Response("Not found", { status: 404 });
  const out = await diagnoseCatalog();
  return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
