// Proxies vehicle photos through our own origin so the MCP Apps result-card
// widget (lib/results-card.ts) can declare a single first-party domain in
// its CSP resourceDomains instead of an open-ended allowlist of arbitrary
// dealer/provider photo CDN domains, which can't be enumerated in advance.
//
// Deliberately minimal: GET-only, http(s)-only upstream, capped size/time,
// image-content-type only, long cache since listing photos don't change.
//
// Authorization: this proxy will fetch whatever URL it's given, so it's
// only safe to expose publicly if we restrict it to URLs we ourselves
// generated server-side (see lib/image-proxy-sign.ts). Every request must
// carry a valid HMAC signature over the exact `u` value; there is no
// unsigned fallback.

import { verifyImageUrlSignature } from "@/lib/image-proxy-sign";
import { buildStockPhotoSvg, isStockCode } from "@/lib/stock-photo-svg";
import { sniffImageType, isGenericContentType } from "@/lib/image-sniff";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — generous for a listing photo, bounds abuse
const FETCH_TIMEOUT_MS = 12000;

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get("u");
  const sig = searchParams.get("sig");

  if (!target) {
    return new Response("Missing u param", { status: 400 });
  }
  if (!sig || !verifyImageUrlSignature(target, sig)) {
    return new Response("Missing or invalid signature", { status: 403 });
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

  // One attempt with our own identity; if the host answers with something that is not an image (or refuses us), ONE more attempt with a browser's identity and the host's own address as the
  // referer. Found 23 Oct 2026: imageonthefly.autodatadirect.com, a stock-photo service dealers use for new cars, shows its photo in a browser but answered our proxy with a non-image, so
  // every car using it showed no photo. Hosts that answer normally never see the second request.
  const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const attempt = async (browser: boolean): Promise<Response> =>
    fetch(parsed.toString(), {
      signal: AbortSignal.timeout(browser ? 8000 : FETCH_TIMEOUT_MS),
      headers: browser
        ? { "User-Agent": BROWSER_UA, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", Referer: `${parsed.origin}/` }
        : { "User-Agent": "CarCleverFindMyCar-ImageProxy/1.0", Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
  const usable = (r: Response): boolean => r.ok && !!r.body && ((r.headers.get("content-type") || "").startsWith("image/") || isGenericContentType(r.headers.get("content-type")));
  let upstream: Response;
  try {
    upstream = await attempt(false);
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }
  if (!usable(upstream) && upstream.status !== 404) {
    try {
      const second = await attempt(true);
      if (usable(second)) upstream = second;
    } catch {
      /* keep the first answer */
    }
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error (status ${upstream.status})`, { status: 502 });
  }

  let contentType = upstream.headers.get("content-type") || "";
  const generic = isGenericContentType(contentType);
  if (!contentType.startsWith("image/") && !generic) {
    return new Response(`Upstream did not return an image (status ${upstream.status}, content-type ${contentType.slice(0, 40) || "none"})`, { status: 502 });
  }

  const contentLength = upstream.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    return new Response("Image too large", { status: 502 });
  }

  // Stock photo (23 Oct 2026): the picture is another listing's photo of the same make, model and year, so the label is drawn onto it (lib/stock-photo-svg.ts). The picture is read in
  // full (same 5MB cap) and returned as a small SVG; only plain raster images are embedded, anything else is a 502 and the widget draws its placeholder.
  const stockParam = searchParams.get("stock");
  if (stockParam != null) {
    if (!isStockCode(stockParam)) return new Response("Invalid stock parameter", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const rd = upstream.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { rd.cancel(); return new Response("Image too large", { status: 502 }); }
        chunks.push(value);
      }
    } catch {
      return new Response("Upstream read failed", { status: 502 });
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    const knownType = generic ? sniffImageType(all) : contentType;
    if (!knownType) return new Response(`Upstream did not return an image (status ${upstream.status}, content-type ${contentType.slice(0, 40) || "none"}, not a picture)`, { status: 502 });
    const svg = buildStockPhotoSvg(knownType, all, stockParam);
    if (!svg) return new Response("Upstream did not return a plain image", { status: 502 });
    return new Response(svg, {
      status: 200,
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800" },
    });
  }

  // Stream with a hard byte cap even when content-length is absent/lying.
  const reader = upstream.body.getReader();
  let total = 0;
  // A response with no useful Content-Type (autodatadirect sends none) is a picture only if its first bytes say so: peek the first chunk, then stream it first.
  let held: Uint8Array | null = null;
  if (generic) {
    try {
      const first = await reader.read();
      if (first.done || !first.value) return new Response("Upstream sent no body", { status: 502 });
      const sniffed = sniffImageType(first.value);
      if (!sniffed) { reader.cancel(); return new Response(`Upstream did not return an image (status ${upstream.status}, content-type ${contentType.slice(0, 40) || "none"}, not a picture)`, { status: 502 }); }
      contentType = sniffed; held = first.value;
    } catch {
      return new Response("Upstream read failed", { status: 502 });
    }
  }
  const stream = new ReadableStream({
    async pull(controller) {
      if (held) { total += held.byteLength; controller.enqueue(held); held = null; return; }
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
