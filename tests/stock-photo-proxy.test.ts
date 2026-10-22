// The image proxy's stock-photo mode (23 Oct 2026). Offline: the upstream picture is a stub.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.IMAGE_PROXY_SECRET = "s3cret";
import { signImageUrl } from "../lib/image-proxy-sign";
import { GET } from "../app/api/img-proxy/route";

const RAW = "https://img.example.com/car.jpg";
const body = Uint8Array.from({ length: 800 }, (_, i) => (i * 7) % 251);
let upstream: { ct: string; status?: number; data?: Uint8Array } = { ct: "image/jpeg" };
type Call = { ua: string; referer: string | null };
let calls: Call[] = [];
// A host that behaves differently per identity: set `byIdentity` and it answers a browser identity with the picture and everything else with the `upstream` answer.
let byIdentity = false;
beforeEach(() => { upstream = { ct: "image/jpeg" }; calls = []; byIdentity = false; });
globalThis.fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
  const h = init?.headers ?? {}; calls.push({ ua: h["User-Agent"] ?? "", referer: h["Referer"] ?? null });
  if (byIdentity && (h["User-Agent"] ?? "").startsWith("Mozilla/5.0")) return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response((upstream.data ?? body) as unknown as BodyInit, { status: upstream.status ?? 200, headers: { "content-type": upstream.ct } });
}) as typeof fetch;
const url = (extra = "", raw = RAW, sig = signImageUrl(raw)) => new Request(`http://localhost/api/img-proxy?u=${encodeURIComponent(raw)}&sig=${sig}${extra}`);

test("without the stock parameter nothing changes: the picture comes back as it is", async () => {
  const r = await GET(url());
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), body);
});
test("stock=2: a labelled SVG with the photo inside, cached like any photo", async () => {
  const r = await GET(url("&stock=2"));
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(r.headers.get("cache-control") ?? "", /max-age=86400/);
  const t = await r.text();
  assert.ok(t.includes("Stock photo · colour may differ")); assert.ok(t.includes(Buffer.from(body).toString("base64")));
});
test("stock=1 and stock=3 carry their own labels", async () => {
  assert.ok((await (await GET(url("&stock=1"))).text()).includes(">Stock photo</text>"));
  assert.ok((await (await GET(url("&stock=3"))).text()).includes(">Stock photo · not this car</text>"));
});
test("an unknown stock value is refused, and the signature is still required", async () => {
  assert.equal((await GET(url("&stock=9"))).status, 400);
  assert.equal((await GET(url("&stock=<svg>"))).status, 400);
  assert.equal((await GET(url("&stock=1", RAW, "deadbeef"))).status, 403);
  assert.equal((await GET(new Request(`http://localhost/api/img-proxy?u=${encodeURIComponent(RAW)}&stock=1`))).status, 403);
});
test("stock mode refuses an upstream SVG, a non-image, an upstream error and an oversized picture", async () => {
  upstream = { ct: "image/svg+xml" }; assert.equal((await GET(url("&stock=1"))).status, 502);
  upstream = { ct: "text/html" }; assert.equal((await GET(url("&stock=1"))).status, 502);
  upstream = { ct: "image/jpeg", status: 404 }; assert.equal((await GET(url("&stock=1"))).status, 502);
  upstream = { ct: "image/jpeg", data: new Uint8Array(5 * 1024 * 1024 + 10) }; assert.equal((await GET(url("&stock=1"))).status, 502);
  upstream = { ct: "image/jpeg", data: new Uint8Array(20) }; assert.equal((await GET(url("&stock=1"))).status, 502, "a 20-byte body is not a photo");
});

// ---- a host that refuses our identity (found 23 Oct 2026: imageonthefly.autodatadirect.com answered the proxy with a non-image while a browser got the photo) ----
test("a host that answers our identity with a non-image gets ONE more attempt as a browser, with its own address as the referer, and then works", async () => {
  upstream = { ct: "text/html" }; byIdentity = true;
  const r = await GET(url());
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/jpeg"); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), body);
  assert.equal(calls.length, 2); assert.ok(calls[0].ua.startsWith("CarCleverFindMyCar-ImageProxy")); assert.ok(calls[1].ua.startsWith("Mozilla/5.0")); assert.equal(calls[1].referer, "https://img.example.com/");
});
test("the same retry works in stock mode, so the watermarked photo appears", async () => {
  upstream = { ct: "text/html" }; byIdentity = true;
  const r = await GET(url("&stock=1")); assert.equal(r.status, 200); assert.ok((await r.text()).includes(">Stock photo</text>")); assert.equal(calls.length, 2);
});
test("a refused host (403) is retried the same way", async () => {
  upstream = { ct: "text/plain", status: 403 }; byIdentity = true;
  assert.equal((await GET(url())).status, 200); assert.equal(calls.length, 2);
});
test("a host that answers normally is asked once; a missing picture (404) is not retried", async () => {
  await GET(url()); assert.equal(calls.length, 1);
  calls = []; upstream = { ct: "text/html", status: 404 }; assert.equal((await GET(url())).status, 502); assert.equal(calls.length, 1, "404 is final");
});
test("a host that refuses both identities is a 502 that says what it answered", async () => {
  upstream = { ct: "text/html" };
  const r = await GET(url()); assert.equal(r.status, 502); assert.equal(calls.length, 2);
  assert.equal(await r.text(), "Upstream did not return an image (status 200, content-type text/html)");
  calls = []; upstream = { ct: "text/plain", status: 403 };
  assert.equal(await (await GET(url())).text(), "Upstream error (status 403)");
});
