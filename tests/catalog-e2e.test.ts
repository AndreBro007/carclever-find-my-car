// End-to-end: the real MCP route in catalogue mode with Auto.dev set to fail loudly.
// Proves (1) zero Auto.dev requests, (2) output passes the registered outputSchema,
// (3) VIN-less / link-less rows degrade silently instead of erroring.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LISTING_SOURCE = "edmunds_catalog";
process.env.IMPACT_ACCOUNT_SID = "sid"; process.env.IMPACT_AUTH_TOKEN = "tok"; process.env.IMPACT_CATALOG_ID = "cat";
process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";

const VIN = "1HGCV1F34MA123456";
const TRACK = "https://edmunds.sjv.io/c/7765200/3949600/52125?u=https%3A%2F%2Fwww.edmunds.com%2Fx";
const mk = (o: Record<string, unknown>) => ({ Text1: "CR-V", Make: "Honda", Year: 2021, Text2: "EX", Category: "SUV", CurrentPrice: "24999",
  Manufacturer: "Acme Honda", City: "Austin", State: "TX", Url: TRACK, ImageUrl: "https://img.edmunds.com/a.jpg", CatalogItemId: "id1", Mpn: VIN, ...o });
const items = [mk({}), mk({ Mpn: "", CatalogItemId: "id2", CurrentPrice: "22500", Year: 2019, Text2: "LX" }), mk({ Mpn: "", CatalogItemId: "id3", Url: "", CurrentPrice: "26000", Year: 2022 })];

test("route in catalogue mode: schema-valid cards, silent degradation, zero Auto.dev calls", async () => {
  let autoDev = 0;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    if (s.includes("api.auto.dev")) { autoDev++; throw new Error("AUTO.DEV MUST NOT BE CALLED"); }
    if (s.includes("api.impact.com")) return new Response(JSON.stringify({ Items: items, Total: 3 }), { status: 200 });
    return new Response("{}", { status: 404 }); // NHTSA etc. unavailable: must not break anything
  }) as typeof fetch;
  const { POST } = await import("../app/[transport]/route");
  const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = async (body: unknown) => {
    const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
    const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const out = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { model: "CR-V", priceMax: 30000, zip: "78701" } } });
  assert.equal(out.error, undefined);
  assert.notEqual(out.result.isError, true);
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.resultsShown, 3);
  assert.equal(sc.meta.serviceError, null);
  assert.equal(sc.meta.scopeNote, "nationwide"); // never claims local when distance can't be applied
  assert.equal(sc.meta.dataNotes.filter((n: string) => /distance|outside the requested/i.test(n)).length, 0); // silent by design
  const ids = sc.results.map((c: { canonicalVehicleId: string }) => c.canonicalVehicleId);
  assert.ok(ids.includes(VIN) && ids.includes("catalog:id2"));
  const noLink = sc.results.find((c: { canonicalVehicleId: string }) => c.canonicalVehicleId === "catalog:id3");
  assert.equal(noLink.links.affiliateUrl, null); assert.ok(noLink.links.affiliateFallbackUrl); // silent: still has a "similar" link
  assert.equal(sc.results[0].condition.inventoryType, "unknown");
  assert.equal(sc.results[0].listing.mileage, null);
  assert.equal(autoDev, 0);
});
