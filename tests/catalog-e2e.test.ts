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

test("route with the REAL feed shape (no Make/Year/City/State): make from Name, mileage, dealer city from ZIP, two buttons, local scope", async () => {
  const feed = (o: Record<string, unknown>) => ({ Name: "2021 Honda CR-V EX", Text1: "CR-V", Text2: "EX", Category: "SUV", CurrentPrice: "24999", Numeric1: "2021", Numeric2: "41234",
    ShippingLabel: "78702", Manufacturer: "Acme Honda", Url: TRACK, ImageUrl: "https://cdn.inventoryrsc.com/a.jpg", CatalogItemId: "r1", Mpn: VIN, ...o });
  const rows = [feed({}), feed({ CatalogItemId: "r2", Mpn: "1HGCV1F34MA000002", ShippingLabel: "10001", Name: "2019 Honda CR-V LX", Numeric1: "2019", CurrentPrice: "18000" }),
    feed({ CatalogItemId: "r3", Mpn: "1HGCV1F34MA000003", ShippingLabel: "78660", Name: "2020 Honda CR-V LX", Numeric1: "2020", CurrentPrice: "21000" }),
    feed({ CatalogItemId: "r4", Mpn: "1HGCV1F34MA000004", ShippingLabel: "78664", Name: "2022 Honda CR-V Sport", Numeric1: "2022", CurrentPrice: "26000" })];
  let autoDev = 0;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    if (s.includes("api.auto.dev")) { autoDev++; throw new Error("AUTO.DEV MUST NOT BE CALLED"); }
    if (s.includes("api.impact.com")) return new Response(JSON.stringify({ Items: rows, Total: 4 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { POST } = await import("../app/[transport]/route");
  const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = async (body: unknown) => { const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) })); const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t); };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const out = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_matching_vehicle", arguments: { model: "CR-V", priceMax: 30000, zip: "78701", radiusMiles: 50 } } });
  assert.notEqual(out.result.isError, true);
  const sc = out.result.structuredContent;
  assert.equal(sc.meta.scopeNote, "local");
  const first = sc.results[0];
  assert.equal(first.identity.make, "Honda");
  assert.equal(first.listing.mileage, 41234);
  assert.equal(first.listing.city, "Austin"); assert.equal(first.listing.state, "TX");
  assert.ok(first.links.affiliateUrl && first.links.affiliateFallbackUrl, "both buttons: Check avail. + View similar");
  assert.ok(!sc.results.some((c: { identity: { year: number } }) => c.identity.year === 2019), "New York dealer is outside the 50-mile radius");
  assert.equal(autoDev, 0);
});

test("card: no condition label when condition is unknown; known conditions still labelled", async () => {
  const { buildResultsCardHtml } = await import("../lib/results-card");
  const { JSDOM } = await import("jsdom");
  const render = async (condition: unknown) => {
    const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", url: "https://carclever-oai-test.getcarwise.app/" });
    await new Promise((r) => setTimeout(r, 150));
    const card = { identity: { vin: "", year: 2024, make: "Honda", model: "CR-V", trim: "EX" }, condition, powertrain: {}, listing: { price: 20000, mileage: null, dealer: "D", city: "Austin", state: "TX" },
      media: { cardImageUrl: null }, detail: {}, ranking: { matchScore: 90 }, links: { affiliateUrl: "https://edmunds.sjv.io/x", affiliateFallbackUrl: "https://edmunds.sjv.io/y", dealerListingUrl: null, linkStatus: "both-available" }, badges: [], intentConfirmations: [], risk: { tier: "unknown" } };
    dom.window.postMessage({ method: "ui/notifications/tool-result", params: { structuredContent: { meta: { corpusSizeApprox: "1.3 million", totalMatches: 1 }, results: [card] } } }, "*");
    await new Promise((r) => setTimeout(r, 200));
    return dom.window.document;
  };
  const unknown = await render({ inventoryType: "unknown", used: null, cpo: null });
  assert.equal(unknown.querySelector(".cc-type"), null, "no pill at all for unknown");
  assert.ok(unknown.querySelector(".cc-title-link"), "card still renders");
  const used = await render({ inventoryType: "used", used: true, cpo: false });
  assert.equal(used.querySelector(".cc-type")?.textContent?.trim(), "USED");
  const cpo = await render({ inventoryType: "used", used: true, cpo: true });
  assert.equal(cpo.querySelector(".cc-type")?.textContent?.trim(), "CPO");
});
