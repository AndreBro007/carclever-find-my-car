// The image proxy's stock-photo mode (23 Oct 2026). Offline: the upstream picture is a stub.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.IMAGE_PROXY_SECRET = "s3cret";
import { signImageUrl } from "../lib/image-proxy-sign";
import { GET } from "../app/api/img-proxy/route";

const RAW = "https://img.example.com/car.jpg";
const body = Uint8Array.from({ length: 800 }, (_, i) => (i * 7) % 251);
const jpeg = Uint8Array.from({ length: 800 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : (i * 7) % 251)); // starts like a real JPEG
const png = Uint8Array.from({ length: 800 }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] : (i * 7) % 251));
let upstream: { ct: string; status?: number; data?: Uint8Array } = { ct: "image/jpeg" };
type Call = { ua: string; referer: string | null };
let calls: Call[] = [];
// A host that behaves differently per identity: set `byIdentity` and it answers a browser identity with the picture and everything else with the `upstream` answer.
let byIdentity = false;
beforeEach(() => { upstream = { ct: "image/jpeg" }; calls = []; byIdentity = false; });
globalThis.fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
  const h = init?.headers ?? {}; calls.push({ ua: h["User-Agent"] ?? "", referer: h["Referer"] ?? null });
  if (byIdentity && (h["User-Agent"] ?? "").startsWith("Mozilla/5.0")) return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response((upstream.data ?? body) as unknown as BodyInit, { status: upstream.status ?? 200, headers: upstream.ct === "" ? {} : { "content-type": upstream.ct } });
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

// ---- a host that sends the picture with NO Content-Type (found 23 Oct 2026: imageonthefly.autodatadirect.com answered "status 200, content-type none") ----
test("a picture sent with no Content-Type is recognised by its first bytes, and served with the right type", async () => {
  upstream = { ct: "", data: jpeg };
  const r = await GET(url());
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/jpeg"); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), jpeg, "every byte arrives, including the first chunk that was peeked at");
  assert.equal(calls.length, 1, "no retry is needed: the host did answer");
});
test("a generic type (application/octet-stream) is treated the same way, and a PNG is served as a PNG", async () => {
  upstream = { ct: "application/octet-stream", data: png };
  const r = await GET(url()); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png"); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), png);
});
test("stock mode too: the watermarked photo is built from a picture that came with no Content-Type", async () => {
  upstream = { ct: "", data: jpeg };
  const r = await GET(url("&stock=1")); assert.equal(r.status, 200); assert.match(r.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  const t = await r.text(); assert.ok(t.includes("data:image/jpeg;base64,")); assert.ok(t.includes(">Stock photo</text>"));
});
test("no Content-Type and bytes that are not a picture is still refused, saying so", async () => {
  upstream = { ct: "", data: new TextEncoder().encode("<html><body>Access denied</body></html>" + " ".repeat(200)) };
  const r = await GET(url()); assert.equal(r.status, 502); assert.equal(await r.text(), "Upstream did not return an image (status 200, content-type none, not a picture)");
  assert.equal((await GET(url("&stock=1"))).status, 502);
  upstream = { ct: "", data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + " ".repeat(200)) };
  assert.equal((await GET(url())).status, 502, "an SVG with no type is never passed on"); assert.equal((await GET(url("&stock=2"))).status, 502);
});
test("a type that says text/html is still believed and retried as before; a stated image type is not sniffed", async () => {
  upstream = { ct: "text/html", data: jpeg }; byIdentity = false;
  assert.equal((await GET(url())).status, 502, "text/html with JPEG bytes is still refused: the header says it is not a picture"); assert.equal(calls.length, 2);
  calls = []; upstream = { ct: "image/png", data: jpeg }; const r = await GET(url()); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png", "a stated image type is passed on as it is"); assert.equal(calls.length, 1);
});
