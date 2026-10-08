import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogQueries, normalizeCatalogItem, detectVin, searchCatalogListings, clearCatalogCacheForTests, diagnoseCatalog, parseMakeFromName, priceBands, dealerZip, yearsToQuery, nearbyCities } from "../lib/catalog-source";
import { searchListingsLean, getListingByVin, searchListingByVinExact, getModelFacets, activeSource } from "../lib/listing-source";
import { resetSourceModeStateForTests, noteAutoDevOutcome, autoDevLooksExhausted } from "../lib/source-mode";
import { resolveLinks } from "../lib/link-resolution";
import { getAppOrigin } from "../lib/results-card";

const VIN = "1HGCV1F34MA123456";
const TRACK = "https://edmunds.sjv.io/c/7765200/3949600/52125?u=https%3A%2F%2Fwww.edmunds.com%2Fx";
const item = (o: Record<string, unknown> = {}) => ({
  Name: "2021 Honda CR-V EX", Text1: "CR-V", Text2: "EX", Category: "SUV", CurrentPrice: "24999",
  Numeric1: "2021", Numeric2: "41234", ShippingLabel: "78701", // Austin TX
  Manufacturer: "Acme Honda", Url: TRACK, ImageUrl: "https://cdn.inventoryrsc.com/a.jpg", CatalogItemId: "abc123", Mpn: VIN, ...o,
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

test("queries: one per model year (newest first) per model; only queryable fields; never unconstrained", () => {
  const q = buildCatalogQueries({ model: "CR-V", priceMax: 30000 }, );
  assert.equal(q.length, 10);
  assert.equal(q[0], `Text1 = 'CR-V' AND Name ~ '${new Date().getFullYear() + 1}' AND CurrentPrice <= 30000`);
  assert.ok(q.every((e) => e.startsWith("Text1 = 'CR-V' AND Name ~ '") && e.endsWith("CurrentPrice <= 30000")));
  assert.equal(buildCatalogQueries({ model: "CR-V,RAV4,Camry,Accord", priceMax: 30000 }).length, 30); // capped at 3 models
  assert.deepEqual(yearsToQuery({ yearMin: 2020, yearMax: 2022 }), [2022, 2021, 2020]); // explicit range honoured
  assert.equal(yearsToQuery({ yearMin: 1950 }).length, 12); // bounded
  assert.ok(buildCatalogQueries({ bodyType: "suv", priceMax: 25000 })[0].startsWith("Category = 'SUV' AND Name ~ '"));
  assert.deepEqual(buildCatalogQueries({ model: "x' OR 1=1 --" }), []);
  assert.deepEqual(buildCatalogQueries({}), []);
  for (const e of buildCatalogQueries({ model: "CR-V", priceMax: 30000, make: "Honda", zip: "78701" })) assert.ok(!/Make|State|City|Condition|Numeric|ShippingLabel/.test(e), e); // unqueryable fields never sent
  // price-only (no model/body style): price bands, since no head to anchor year queries
  assert.deepEqual(priceBands({ priceMin: 10000, priceMax: 30000 }).map((b) => b.join(" AND ")), ["CurrentPrice >= 10000 AND CurrentPrice <= 16700", "CurrentPrice > 16700 AND CurrentPrice <= 23300", "CurrentPrice > 23300 AND CurrentPrice <= 30000"]);
  assert.equal(buildCatalogQueries({ priceMax: 30000 }).length, 3);
});

test("make is parsed from the item Name (feed has no Make field)", () => {
  assert.equal(parseMakeFromName("2021 Honda CR-V EX"), "Honda");
  assert.equal(parseMakeFromName("2019 Mercedes-Benz GLC 300"), "Mercedes-Benz");
  assert.equal(parseMakeFromName("2018 Land Rover Discovery"), "Land Rover");
  assert.equal(parseMakeFromName("2020 Ram 1500"), "RAM");
  assert.equal(parseMakeFromName("2020 Mystery Car"), undefined);
});

test("feed mapping: Numeric1=year, Numeric2=miles, ShippingLabel=dealer ZIP (leading zero restored); implausible values dropped", () => {
  const l = normalizeCatalogItem(item({ Name: "Honda CR-V EX", ShippingLabel: "2760", Numeric1: "2016", Numeric2: "98765" }))!;
  assert.equal(l.vehicle?.year, 2016); assert.equal(l.vehicle?.make, "Honda"); assert.equal(l.retailListing?.miles, 98765);
  assert.equal(l.retailListing?.zip, "02760"); assert.equal(l.retailListing?.state, "MA"); assert.equal(l.retailListing?.city, "North Attleboro");
  const bad = normalizeCatalogItem(item({ Name: "Honda CR-V EX", Numeric1: "7", Numeric2: "99999999", ShippingLabel: "abc" }))!;
  assert.equal(bad.vehicle?.year, undefined); assert.equal(bad.retailListing?.miles, undefined); assert.equal(bad.retailListing?.zip, undefined);
  assert.equal(dealerZip({ ShippingLabel: "00000" }), undefined); // not a real ZIP
  assert.equal(normalizeCatalogItem(item({ Name: "2019 Honda CR-V LX", Numeric1: "2021" }))!.vehicle?.year, 2019); // explicit year in Name wins
});

test("normalise: VIN only from a VIN-shaped identifier field; never an item id", () => {
  assert.equal(normalizeCatalogItem(item())!.vin, VIN);
  assert.equal(normalizeCatalogItem(item({ Mpn: "NOTAVIN", CatalogItemId: "abc123" }))!.vin, "");
  assert.equal(detectVin({ Mpn: "1HGCV1F34MA12345" }), ""); // 16 chars
  const dest = encodeURIComponent(`https://www.edmunds.com/honda/cr-v/2021/vin/${VIN}/featured-listing/`);
  assert.equal(detectVin({ Url: `https://edmunds.sjv.io/c/1/2/3?prodsku=x&u=${dest}` }), VIN); // VIN from the link destination
  assert.equal(detectVin({ Url: TRACK }), ""); // link without a VIN
  const l = normalizeCatalogItem(item({ Mpn: "" }))!;
  assert.equal(l.catalog?.itemId, "abc123");
  assert.equal(l.retailListing?.used, undefined); // condition never inferred (not from mileage or age)
  assert.equal(l.retailListing?.cpo, undefined);
  assert.equal(l.retailListing?.miles, 41234); // Numeric2, validated range
});

test("normalise: year falls back to the item Name when Year is missing; never invented", () => {
  assert.equal(normalizeCatalogItem(item({ Numeric1: "", Name: "2019 Honda CR-V LX" }))!.vehicle?.year, 2019);
  assert.equal(normalizeCatalogItem(item({ Numeric1: "2022", Name: "2019 Honda CR-V LX" }))!.vehicle?.year, 2019); // explicit text in Name wins
  assert.equal(normalizeCatalogItem(item({ Numeric1: "2022", Name: "Honda CR-V LX" }))!.vehicle?.year, 2022); // else Numeric1
  assert.equal(normalizeCatalogItem(item({ Numeric1: "", Name: "Honda CR-V LX" }))!.vehicle?.year, undefined); // never invented
});

test("normalise: bad tracking host / image host dropped, out-of-stock dropped, junk rejected", () => {
  assert.equal(normalizeCatalogItem(item({ Url: "https://evil.example/x" }))!.catalog?.trackingUrl, undefined);
  const img = (u: string) => normalizeCatalogItem(item({ ImageUrl: u }))!.retailListing?.primaryImage;
  assert.equal(img("https://media.ed.edmunds-media.com/a.jpg"), "https://media.ed.edmunds-media.com/a.jpg"); // any normal https host is fine
  assert.equal(img("http://dealer-cdn.example.com/a.jpg"), "http://dealer-cdn.example.com/a.jpg"); // plain-http dealer CDNs are fetched via our HTTPS proxy
  for (const bad of ["ftp://img.edmunds.com/a.jpg", "https://127.0.0.1/a.jpg", "https://10.0.0.5/a.jpg", "https://[::1]/a.jpg", "https://localhost/a.jpg", "https://db.internal/a.jpg", "https://user:pw@img.edmunds.com/a.jpg", "https://nodots/a.jpg"]) {
    assert.equal(img(bad), undefined, bad); // refuse anything that could point inward or leak credentials
  }
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

test("page size: 100 rejected -> falls back to 20 once and still returns results", async () => {
  const sizes: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url)); sizes.push(u.searchParams.get("PageSize") ?? "");
    if (u.searchParams.get("PageSize") === "100") return new Response("too big", { status: 400 });
    return new Response(JSON.stringify({ Items: [item()], Total: 1 }), { status: 200 });
  }) as typeof fetch;
  const r = await searchCatalogListings({ priceMax: 30000 }); // price-only plan uses the 100-size bands
  assert.equal(r.data.length, 1); assert.ok(sizes.includes("100") && sizes.includes("20"));
  sizes.length = 0; await searchCatalogListings({ priceMax: 30000 });
  assert.ok(!sizes.includes("100")); // remembered
});

test("distance: nearest first, outside-radius dropped, dealers with unknown ZIP kept last; scope reported as local", async () => {
  const rows = [
    item({ CatalogItemId: "far", Mpn: "1HGCV1F34MA000001", ShippingLabel: "10001", Name: "2021 Honda CR-V EX" }),   // New York
    item({ CatalogItemId: "near", Mpn: "1HGCV1F34MA000002", ShippingLabel: "78702", Name: "2021 Honda CR-V EX" }),  // Austin
    item({ CatalogItemId: "mid", Mpn: "1HGCV1F34MA000003", ShippingLabel: "78660", Name: "2021 Honda CR-V EX" }),   // Pflugerville
    item({ CatalogItemId: "mid2", Mpn: "1HGCV1F34MA000004", ShippingLabel: "78664", Name: "2021 Honda CR-V EX" }),  // Round Rock
    item({ CatalogItemId: "nozip", Mpn: "1HGCV1F34MA000005", ShippingLabel: "", Name: "2021 Honda CR-V EX" }),
  ];
  stubFetch({ items: rows });
  const r = await searchCatalogListings({ model: "CR-V", priceMax: 30000, zip: "78701", radius: 50 });
  const ids = r.data.map((l) => l.catalog?.itemId);
  assert.equal(r.localApplied, true);
  assert.deepEqual(ids.slice(0, 3).sort(), ["mid", "mid2", "near"]); assert.equal(ids[0], "near");
  assert.ok(!ids.includes("far")); assert.equal(ids[ids.length - 1], "nozip");
  assert.ok((r.data[0].catalog?.distanceMiles ?? 99) <= 5);
  // too few inside the radius -> show the nearest anyway instead of nothing
  stubFetch({ items: [rows[0], rows[4]] });
  const sparse = await searchCatalogListings({ model: "CR-V", zip: "78701", radius: 25 });
  assert.equal(sparse.data[0].catalog?.itemId, "far");
  // no ZIP -> no local ordering claimed
  stubFetch({ items: rows });
  assert.equal((await searchCatalogListings({ model: "CR-V", priceMax: 30000 })).localApplied, false);
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

test("widget origin: production unchanged; preview uses explicit override only when set", () => {
  const saved = { e: process.env.VERCEL_ENV, o: process.env.NEXT_PUBLIC_WIDGET_ORIGIN, b: process.env.VERCEL_BRANCH_URL };
  try {
    process.env.VERCEL_ENV = "preview"; process.env.VERCEL_BRANCH_URL = "branch.example.vercel.app";
    delete process.env.NEXT_PUBLIC_WIDGET_ORIGIN;
    assert.equal(getAppOrigin(), "https://branch.example.vercel.app");
    process.env.NEXT_PUBLIC_WIDGET_ORIGIN = "https://test.example.app";
    assert.equal(getAppOrigin(), "https://test.example.app");
    process.env.VERCEL_ENV = "production";
    assert.equal(getAppOrigin(), "https://test.example.app"); // production still honours its own explicit origin as before
  } finally {
    for (const [k, v] of [["VERCEL_ENV", saved.e], ["NEXT_PUBLIC_WIDGET_ORIGIN", saved.o], ["VERCEL_BRANCH_URL", saved.b]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("diagnostics: aggregates only (no VIN, URL, dealer or credential values), reports queryability", async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, " ");
    if (u.includes("ShippingLabel =") || u.includes("Numeric2")) return new Response("Unknown search field name", { status: 400 });
    if (u.includes("inventoryrsc")) return new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response(JSON.stringify({ Items: [item()], Total: 1 }), { status: 200 });
  }) as typeof fetch;
  const d = await diagnoseCatalog();
  assert.ok(!("error" in d));
  const out = JSON.stringify(d);
  for (const secret of [VIN, TRACK, "Acme Honda", "tok", "abc123", "inventoryrsc.com/a.jpg"]) assert.ok(!out.includes(secret), `leaked: ${secret}`);
  assert.equal((d as { probes: Record<string, string> }).probes["ShippingLabel = '90210' (expected 400)"], "HTTP 400");
  assert.ok((d as { mappingChecks: Record<string, string> }).mappingChecks["ShippingLabel is a real US ZIP"].startsWith("1/1"));
  const textLayout = JSON.stringify((d as { textShapes: unknown }).textShapes); assert.ok(!/Acme|Honda|Austin|78701/.test(textLayout), "layouts must not echo real values");
  assert.ok((d as { fields: Record<string, { vinShaped: number }> }).fields.Mpn.vinShaped === 1);
});

test("local plan: nearest big cities' dealers (Description ~ city) plus a few newest national years; unchanged without a ZIP", () => {
  const cities = nearbyCities("90210", 5);
  assert.equal(cities.length, 5); assert.ok(cities.includes("Los Angeles"), cities.join(","));
  const plan = buildCatalogQueries({ model: "CR-V", priceMax: 30000, zip: "90210", radius: 100 });
  assert.equal(plan.length, 5 + 4);
  assert.ok(plan.slice(0, 5).every((e) => /^Text1 = 'CR-V' AND Description ~ '[A-Za-z .\-]+' AND CurrentPrice <= 30000$/.test(e)), plan[0]);
  assert.ok(plan.slice(5).every((e) => /Name ~ '20\d\d'/.test(e)));
  assert.equal(buildCatalogQueries({ model: "CR-V,RAV4", priceMax: 30000, zip: "90210" }).length, 2 * 3 + 2 * 4); // fewer cities when several models
  assert.equal(buildCatalogQueries({ model: "CR-V", priceMax: 30000, zip: "00000" }).length, 10); // unknown ZIP: national years as before
  assert.equal(buildCatalogQueries({ model: "CR-V", priceMax: 30000, zip: "90210", radius: 500 }).length, 10); // very wide radius: national
  assert.equal(buildCatalogQueries({ model: "CR-V", priceMax: 30000 }).length, 10);
  assert.deepEqual(nearbyCities("abcde", 5), []);
});
