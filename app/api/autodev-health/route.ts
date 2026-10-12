// Ops health probe for the Auto.dev data API.
// Returns 404 unless AUTODEV_HEALTH_TOKEN is set AND the request carries it in the x-health-token header.
// Makes ONE Auto.dev /listings call (limit=1) using the key held in this project's environment and returns only
// the status, the plan/usage/rate-limit headers and row counts. It never returns the key or the request URL.
// The last result is cached for 10 minutes per server instance, so repeated calls cannot burn the allowance;
// pass ?fresh=1 (with the token) to force a new call.
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; body: Record<string, unknown> } | null = null;

function tokenOk(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    if (/^(x-usage-|x-ratelimit-|x-current-plan|x-required-plan|retry-after)/i.test(name)) out[name] = value;
  });
  return out;
}

export async function GET(req: Request): Promise<Response> {
  const want = process.env.AUTODEV_HEALTH_TOKEN;
  const got = req.headers.get("x-health-token") ?? "";
  if (!want || !got || !tokenOk(got, want)) return new Response("Not found", { status: 404 });

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    return json({ ...cache.body, cached: true, cacheAgeSec: Math.round((Date.now() - cache.at) / 1000) });
  }

  const key = process.env.AUTO_DEV_API_KEY;
  if (!key) return json({ ok: false, keyPresent: false, note: "AUTO_DEV_API_KEY is not set in this project" });

  const started = Date.now();
  const redact = (s: string) => s.split(key).join("[redacted]");
  try {
    const res = await fetch("https://api.auto.dev/listings?vehicle.make=Honda&limit=1", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: { data?: unknown; total?: unknown; code?: unknown; error?: unknown; message?: unknown; requestId?: unknown; currentPlan?: unknown } | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const body: Record<string, unknown> = {
      ok: res.ok,
      status: res.status,
      keyPresent: true,
      ms: Date.now() - started,
      checkedAt: new Date().toISOString(),
      headers: pickHeaders(res.headers),
      rows: Array.isArray(parsed?.data) ? (parsed?.data as unknown[]).length : null,
      total: typeof parsed?.total === "number" ? parsed.total : null,
      error: res.ok
        ? null
        : {
            code: parsed?.code ?? null,
            message: redact(String(parsed?.error ?? parsed?.message ?? text)).slice(0, 300),
            requestId: parsed?.requestId ?? null,
            currentPlan: parsed?.currentPlan ?? null,
          },
    };
    cache = { at: Date.now(), body };
    return json({ ...body, cached: false });
  } catch (e) {
    return json({ ok: false, keyPresent: true, status: null, ms: Date.now() - started, error: { code: "NETWORK", message: (e as Error).name } });
  }
}
