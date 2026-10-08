import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogQueries, normalizeCatalogItem, detectVin, searchCatalogListings, clearCatalogCacheForTests } from "../lib/catalog-source";
import { searchListingsLean, getListingByVin, searchListingByVinExact, getModelFacets, activeSource } from "../lib/listing-source";
import { resetSourceModeStateForTests, noteAutoDevOutcome, autoDevLooksExhausted } from "../lib/source-mode";
import { resolveLinks } from "../lib/link-resolution";

const VIN = "1HGCV1F34MA123456";
const TRACK = "https://edmunds.sjv.io/c/7765200/3949600/52125?u=https%3A%2F%2Fwww.edmunds.com%2Fx";
const item = (o: Record<string, unknown> = {}) => ({
  Text1: "CR-V", Make: "Honda", Year: 2021, Text2: "EX", Category: "SUV", CurrentPrice: "24999",
  Manufacturer: "Acme Honda", City: "Austin", State: "TX", Url: TRACK, ImageUrl: "https://img.edmunds.com/a.jpg",
  CatalogItemId: "abc123", Mpn: VIN, ...o,
});

const realFetch = globalThis.fetch;
let autoDevCalls = 0;
let impactCalls = 0;
function stubFetch(opts: { autoDevStatus?: number; items?: unknown[]; impactStatus?: number } = {}) {
  autoDevCalls = 0; impactCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.auto.dev")) { autoDevCalls++; return new Response("blocked", { status: opts.autoDevStatus ?? 500 }); }
    if (u.includes("api.impact.com")) {
      impactCalls++;
      if (opts.impactStatus) return new Response("x", { status: opts.impactStatus });
      return new Response(JSON.stringify({ Items: opts.items ?? [item()], Total: (opts.items ?? [item()]).length }), { status: 200 });
    }
    throw new Error("unexpected fetch " + u);
  }) as typeof fetch;
}
beforeEach(() => {
  process.env.IMPACT_ACCOUNT_SID = "sid"; process.env.IMPACT_AUTH_TOKEN = "tok"; process.env.IMPACT_CATALOG_ID = "cat";
  process.env.AUTO_DEV_API_KEY = "k"; delete process.env.LISTING_SOURCE;
  resetSourceModeStateForTests(); clearCatalogCacheForTests();
});
afterEach(() => { globalThis.fetch = realFetch; });

test("queries: model+price, multi-model, category, sanitising, unconstrained", () => {
  assert.deepEqual(buildCatalogQueries({ model: "CR-V", priceMax: 30000 }), ["Text1 = 'CR-V' AND CurrentPrice <= 30000"]);
  assert.equal(buildCatalogQueries({ model: "CR-V,RAV4,Camry" }).length, 3);
  assert.deepEqual(buildCatalogQueries({ bodyType: "suv", priceMax: 25000 }), ["Category = 'SUV' AND CurrentPrice <= 25000"]);
  assert.deepEqual(buildCatalogQueries({ model: "x' OR 1=1 --" }), []);
  assert.deepEqual(buildCatalogQueries({}), []);
  assert.deepEqual(buildCatalogQueries({ model: "CR-V", yearMin: 2020 }, { withYear: true }), ["Text1 = 'CR-V' AND Year >= 2020"]);
});

test("normalise: VIN only from a VIN-shaped identifier field; never an item id", () => {
  assert.equal(normalizeCatalogItem(item())!.vin, VIN);
  assert.equal(normalizeCatalogItem(item({ Mpn: "NOTAVIN", CatalogItemId: "abc123" }))!.vin, "");
  assert.equal(detectVin({ Mpn: "1HGCV1F34MA12345" }), ""); // 16 chars
  const l = normalizeCatalogItem(item({ Mpn: "" }))!;
  assert.equal(l.catalog?.itemId, "abc123");
  assert.equal(l.retailListing?.used, undefined); // condition never inferred
  assert.equal(l.retailListing?.miles, undefined);
});

test("normalise: bad tracking host / image host dropped, out-of-stock dropped, junk rejected", () => {
  assert.equal(normalizeCatalogItem(item({ Url: "https://evil.example/x" }))!.catalog?.trackingUrl, undefined);
  assert.equal(normalizeCatalogItem(item({ ImageUrl: "https://evil.example/a.jpg" }))!.retailListing?.primaryImage, undefined);
  assert.equal(normalizeCatalogItem(item({ StockAvailability: "OutOfStock" })), null);
  assert.equal(normalizeCatalogItem(null), null);
  assert.equal(normalizeCatalogItem({}), null);
});

test("catalogue mode: ZERO Auto.dev requests across search, detail, exact-VIN and facets (failing Auto.dev mock)", async () => {
  process.env.LISTING_SOURCE = "edmunds_catalog";
  stubFetch({ autoDevStatus: 500 });
  const r = await searchListingsLean({ model: "CR-V", priceMax: 30000, limit: 100 });
  assert.ok(r.data.length > 0); assert.equal(r.source, "edmunds_catalog");
  assert.equal((await getListingByVin(VIN))?.vin, VIN);
  assert.equal(await getListingByVin("1HGCV1F34MA999999"), null);
  assert.equal(await searchListingByVinExact(VIN).then((x) => x?.vin), VIN);
  assert.deepEqual(await getModelFacets({ model: "CR-V" }), []);
  assert.equal(autoDevCalls, 0);
  assert.ok(impactCalls > 0);
});

test("auto mode: Auto.dev rejects (429) -> same request is served by catalogue, later requests skip Auto.dev", async () => {
  stubFetch({ autoDevStatus: 429 });
  assert.equal(activeSource(), "auto_dev");
  const r1 = await searchListingsLean({ model: "CR-V", priceMax: 30000 });
  assert.equal(r1.source, "edmunds_catalog"); assert.ok(r1.data.length > 0);
  assert.equal(autoDevCalls, 1);
  assert.equal(autoDevLooksExhausted(), true); assert.equal(activeSource(), "edmunds_catalog");
  await searchListingsLean({ model: "CR-V" });
  assert.equal(autoDevCalls, 1); // breaker open: no further Auto.dev calls
});

test("auto mode: 403/402 also trip the breaker; plain 400 does not", () => {
  noteAutoDevOutcome({ ok: false, reason: "http", status: 400 }); assert.equal(autoDevLooksExhausted(), false);
  noteAutoDevOutcome({ ok: false, reason: "timeout" }); assert.equal(autoDevLooksExhausted(), false);
  noteAutoDevOutcome({ ok: false, reason: "http", status: 402 }); assert.equal(autoDevLooksExhausted(), true);
  noteAutoDevOutcome({ ok: true }); assert.equal(autoDevLooksExhausted(), false);
});

test("no catalogue credentials: every mode behaves like Auto.dev (nothing changes until configured)", async () => {
  delete process.env.IMPACT_AUTH_TOKEN; process.env.LISTING_SOURCE = "edmunds_catalog";
  assert.equal(activeSource(), "auto_dev");
  stubFetch({ autoDevStatus: 500 });
  const r = await searchListingsLean({ model: "CR-V" });
  assert.ok(r.error); assert.equal(impactCalls, 0);
});

test("catalogue failure is an error, not 'no cars'; empty result is empty", async () => {
  process.env.LISTING_SOURCE = "edmunds_catalog";
  stubFetch({ impactStatus: 503 });
  assert.ok((await searchCatalogListings({ model: "CR-V" })).error);
  stubFetch({ items: [] });
  const e = await searchCatalogListings({ model: "CR-V" });
  assert.equal(e.error, undefined); assert.equal(e.data.length, 0);
});

test("year filter unsupported (all 400) -> retried once without it", async () => {
  let calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = decodeURIComponent(String(url)); calls.push(u);
    if (u.includes("Year >=")) return new Response("Unknown search field name: Year", { status: 400 });
    return new Response(JSON.stringify({ Items: [item()], Total: 1 }), { status: 200 });
  }) as typeof fetch;
  const r = await searchCatalogListings({ model: "CR-V", yearMin: 2020 });
  assert.equal(r.data.length, 1);
  assert.ok(calls.some((c) => !c.includes("Year >=")));
});

test("links: catalogue tracking URL used exactly as supplied (not re-wrapped); VIN-less rows still get a link", () => {
  const withVin = resolveLinks(normalizeCatalogItem(item())!);
  assert.equal(withVin.affiliateUrl, TRACK); assert.equal(withVin.checkAvailSource, "exact");
  assert.ok(withVin.affiliateFallbackUrl);
  const noVin = resolveLinks(normalizeCatalogItem(item({ Mpn: "" }))!);
  assert.equal(noVin.affiliateUrl, TRACK); assert.notEqual(noVin.linkStatus, "none-available");
  const noTrack = resolveLinks(normalizeCatalogItem(item({ Mpn: "", Url: "" }))!);
  assert.equal(noTrack.affiliateUrl, null); assert.equal(noTrack.linkStatus, "fallback-only"); // silent degrade, still has a "similar" link
});
