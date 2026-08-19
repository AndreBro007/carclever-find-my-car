// Proxies vehicle photos through our own origin so the MCP Apps result-card
// widget (lib/results-card.ts) can declare a single first-party domain in
// its CSP resourceDomains instead of an open-ended allowlist of arbitrary
// dealer/Auto.dev photo CDN domains, which can't be enumerated in advance.
//
// Deliberately minimal: GET-only, http(s)-only upstream, capped size/time,
// image-content-type only, long cache since listing photos don't change.

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — generous for a listing photo, bounds abuse
const FETCH_TIMEOUT_MS = 8000;

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get("u");

  if (!target) {
    return new Response("Missing u param", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new Response("Unsupported protocol", { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "CarCleverFindMyCar-ImageProxy/1.0" },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream error", { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    return new Response("Upstream did not return an image", { status: 502 });
  }

  const contentLength = upstream.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    return new Response("Image too large", { status: 502 });
  }

  // Stream with a hard byte cap even when content-length is absent/lying.
  const reader = upstream.body.getReader();
  let total = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > MAX_BYTES) {
        controller.error(new Error("Image exceeded size cap"));
        reader.cancel();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}
