// The image proxy's stock-photo mode (23 Oct 2026). Offline: the upstream picture is a stub.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.IMAGE_PROXY_SECRET = "s3cret";
import { signImageUrl } from "../lib/image-proxy-sign";
import { GET } from "../app/api/img-proxy/route";

const RAW = "https://img.example.com/car.jpg";
const body = Uint8Array.from({ length: 800 }, (_, i) => (i * 7) % 251);
let upstream: { ct: string; status?: number; data?: Uint8Array } = { ct: "image/jpeg" };
beforeEach(() => { upstream = { ct: "image/jpeg" }; });
globalThis.fetch = (async () => new Response((upstream.data ?? body) as unknown as BodyInit, { status: upstream.status ?? 200, headers: { "content-type": upstream.ct } })) as typeof fetch;
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
