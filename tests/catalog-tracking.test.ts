// "Just added" and "Price dropped": first-seen date and price changes recorded by the daily merge, honest rules for showing them, and an app that
// works both before and after the loader has added the columns. Synthetic feed only (no partner data in this public repository).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { searchCatalogDbListings, getCatalogDbListing, setCatalogDbPoolForTests } from "../lib/catalog-db-source";
import { resetTrackingCheckForTests } from "../lib/catalog-db/search";
import { freshnessSignals, freshnessTextLine, JUST_ADDED_DAYS, PRICE_DROP_DAYS, PRICE_DROP_MIN } from "../lib/catalog-output";

// ---------- pure rules: always run ----------
const NOW = new Date("2026-10-20T10:00:00Z");
describe("freshness rules (no database)", () => {
  test("just added: within 3 days of first seen, never later, never in the future, never without a date", () => {
    assert.equal(JUST_ADDED_DAYS, 3);
    for (const [d, want] of [["2026-10-20", true], ["2026-10-17", true], ["2026-10-16", undefined], ["2026-10-21", undefined], [undefined, undefined]] as const)
      assert.equal(freshnessSignals({ firstSeen: d }, 30000, NOW).justAdded, want, String(d));
  });
  test("price dropped: at least $100 down, changed within 7 days; a rise, a tiny drop, an old change or missing data show nothing", () => {
    assert.equal(PRICE_DROP_DAYS, 7); assert.equal(PRICE_DROP_MIN, 100);
    assert.deepEqual(freshnessSignals({ priceWas: 32990, priceChangedAt: "2026-10-18" }, 31790, NOW).priceDrop, { amount: 1200, was: 32990, on: "2026-10-18" });
    assert.ok(freshnessSignals({ priceWas: 20100, priceChangedAt: "2026-10-20" }, 20000, NOW).priceDrop); // exactly $100 counts
    for (const [was, on, price] of [[20000, "2026-10-18", 20050], [20000, "2026-10-18", 21000], [20000, "2026-10-12", 18000], [20000, "2026-10-21", 18000], [undefined, "2026-10-18", 18000]] as const)
      assert.equal(freshnessSignals({ priceWas: was as number | undefined, priceChangedAt: on }, price, NOW).priceDrop, undefined, JSON.stringify([was, on, price]));
    assert.deepEqual(freshnessSignals(undefined, 1000, NOW), {}); assert.deepEqual(freshnessSignals({ priceWas: 5000, priceChangedAt: "2026-10-19" }, null, NOW), {});
  });
  test("text line: honest wording, both signals together, nothing in other apps or when neither applies", () => {
    const c = { detail: { justAdded: true, priceDrop: { amount: 1200, was: 32990, on: "2026-10-18" } } };
    assert.equal(freshnessTextLine(c, true), "\n   Just added to the listings · Price dropped $1,200 (was $32,990, changed Oct 18)");
    assert.equal(freshnessTextLine({ detail: { justAdded: true } }, true), "\n   Just added to the listings");
    assert.equal(freshnessTextLine(c, false), ""); assert.equal(freshnessTextLine({ detail: {} }, true), ""); assert.equal(freshnessTextLine(null, true), "");
    assert.ok(!/new on the market|brand new|hot deal|act now|hurry/i.test(freshnessTextLine(c, true)));
  });
});

// ---------- the loader and the app, against a real PostgreSQL ----------
const HEADER = FEED_COLUMNS.join("\t");
const DEALER = { name: "Test Honda Beverly", street: "1 Test St", city: "Beverly Hills", state: "CA", zip: "90210" };
const vinFor = (n: number): string => `1HGCM82633A${String(100000 + n).slice(-6)}`;
function line(n: number, price: number): string {
  const vin = vinFor(n), id = `01${vin}`.toLowerCase().padEnd(32, "0").slice(0, 32);
  const vals: Record<string, string> = {
    id, title: "2022 Honda Civic", condition: "used", description: "2022 Honda Civic for sale", price: price.toFixed(2), image_link: `https://img.example.com/${id}.jpg`,
    link: buildTrackingUrl({ id, vin, year: 2022, make: "Honda", model: "Civic" }), availability: "InStock", identifier_exists: "no", dealer_id: "1",
    dealer_name: DEALER.name, dealer_street: DEALER.street, dealer_city: DEALER.city, dealer_state: DEALER.state, dealer_zip: DEALER.zip, dealer_radius: "200 miles",
    vehicle_vin: vin, vehicle_stock_number: "S1", vehicle_year: "2022.00", vehicle_make: "Honda", vehicle_model: "Civic", vehicle_series: "EX",
    vehicle_odometer: "40000.00", vehicle_body: "Sedan", vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black",
  };
  return FEED_COLUMNS.map((k) => vals[k] ?? "").join("\t");
}
async function* asLines(lines: string[]): AsyncIterable<string> { for (const l of lines) yield l; }
const feed = (cars: Array<[number, number]>): string[] => [HEADER, ...cars.map(([n, p]) => line(n, p))];

const DB = process.env.TEST_DATABASE_URL;
describe("tracking in the loader and the app (real PostgreSQL)", { skip: DB ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: Pool; let today = "";
  before(async () => {
    pool = new Pool({ connectionString: DB, max: 2 });
    await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
    setCatalogDbPoolForTests(pool); resetTrackingCheckForTests();
  });
  after(async () => { setCatalogDbPoolForTests(null); resetTrackingCheckForTests(); await pool.end(); });
  const row = async (n: number) => (await pool.query("SELECT first_seen::text AS fs, price, price_prev, price_changed_at::text AS pc FROM listing WHERE vin = $1", [vinFor(n)])).rows[0];

  test("the first load into an empty database marks nothing as new", async () => {
    today = (await pool.query("SELECT current_date::text AS d")).rows[0].d;
    const rep = await loadFeed(pool, asLines(feed([[1, 20000], [2, 30000], [3, 25000]])));
    assert.equal(rep.inserted, 3);
    for (const n of [1, 2, 3]) { const r = await row(n); assert.equal(r.fs, null); assert.equal(r.price_prev, null); assert.equal(r.pc, null); }
  });
  test("a later load: a new car gets today as first seen, a price drop is recorded, unchanged and old cars stay unknown", async () => {
    const rep = await loadFeed(pool, asLines(feed([[1, 19000], [2, 30000], [4, 40000]])), { keepRatio: 0 }); // car 3 removed, car 4 new, car 1 cheaper
    assert.equal(rep.inserted, 1); assert.equal(rep.updated, 1); assert.equal(rep.deleted, 1);
    const d = await row(4); assert.equal(d.fs, today);
    const a = await row(1); assert.equal(a.price, 19000); assert.equal(a.price_prev, 20000); assert.equal(a.pc, today); assert.equal(a.fs, null);
    const b = await row(2); assert.equal(b.fs, null); assert.equal(b.price_prev, null); assert.equal(b.pc, null);
  });
  test("the app reads the dates as text and the rules turn them into the two signals", async () => {
    const dl = await getCatalogDbListing(vinFor(4)); assert.equal(dl?.catalog?.firstSeen, today);
    const al = await getCatalogDbListing(vinFor(1)); assert.equal(al?.catalog?.priceWas, 20000); assert.equal(al?.catalog?.priceChangedAt, today);
    assert.equal(freshnessSignals(dl?.catalog, dl?.retailListing?.price).justAdded, true);
    assert.deepEqual(freshnessSignals(al?.catalog, al?.retailListing?.price).priceDrop, { amount: 1000, was: 20000, on: today });
    const s = await searchCatalogDbListings({ make: "Honda", model: "Civic", zip: "90210", radius: 50 });
    assert.ok(s.data.length >= 3); assert.ok(s.data.some((l: any) => l.catalog?.firstSeen === today));
  });
  test("reloading the same data changes nothing; a later rise keeps the previous price", async () => {
    const same = await loadFeed(pool, asLines(feed([[1, 19000], [2, 30000], [4, 40000]])), { keepRatio: 0 });
    assert.equal(same.inserted, 0); assert.equal(same.updated, 0);
    const a = await row(1); assert.equal(a.price_prev, 20000); assert.equal(a.pc, today);
    await loadFeed(pool, asLines(feed([[1, 19500], [2, 30000], [4, 40000]])), { keepRatio: 0 });
    const a2 = await row(1); assert.equal(a2.price, 19500); assert.equal(a2.price_prev, 19000);
    assert.equal(freshnessSignals({ priceWas: 19000, priceChangedAt: today }, 19500).priceDrop, undefined); // a rise is never shown
  });
  test("the app still works when the loader has not added the columns yet, and picks them up afterwards", async () => {
    await pool.query("ALTER TABLE listing DROP COLUMN first_seen, DROP COLUMN price_prev, DROP COLUMN price_changed_at"); resetTrackingCheckForTests();
    const s = await searchCatalogDbListings({ make: "Honda", model: "Civic", zip: "90210", radius: 50 });
    assert.ok(s.data.length >= 3); assert.equal(s.data[0].catalog?.firstSeen, undefined);
    const one = await getCatalogDbListing(vinFor(1)); assert.ok(one); assert.equal(one!.catalog?.priceWas, undefined);
    await loadFeed(pool, asLines(feed([[1, 19500], [2, 30000], [4, 40000], [5, 22000]])), { keepRatio: 0 }); // runs the schema, which adds the columns
    resetTrackingCheckForTests();
    const five = await getCatalogDbListing(vinFor(5)); assert.equal(five?.catalog?.firstSeen, today);
  });
});

// ---------- the card pills (real card, jsdom) ----------
async function renderPills(detail: Record<string, unknown>) {
  const { buildResultsCardHtml } = await import("../lib/results-card");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom; await new Promise((r) => setTimeout(r, 200));
  const results = [{
    identity: { vin: "1FTEW2KP9TKE60601", year: 2024, make: "Kia", model: "Seltos", trim: "EX" }, condition: { inventoryType: "used", used: true },
    powertrain: { drivetrain: "FWD" }, listing: { price: 21000, mileage: 9000, dealer: "Test Dealer", city: "Austin", state: "TX" }, media: { cardImageUrl: null },
    detail: { exteriorColor: "Blue", ...detail }, ranking: { matchScore: 100 }, links: { affiliateUrl: null, affiliateFallbackUrl: null, isCarvana: false, linkStatus: "none-available" }, badges: [], intentConfirmations: [],
  }];
  window.postMessage({ method: "ui/notifications/tool-result", params: { structuredContent: { meta: { corpusSizeApprox: "1.4 million", totalMatches: 1 }, results } } }, "*");
  await new Promise((r) => setTimeout(r, 200));
  return window.document;
}
describe("card pills", () => {
  test("Just added and Price down render with their numbers, in the same badge row", async () => {
    const doc = await renderPills({ justAdded: true, priceDrop: { amount: 1200, was: 32990, on: "2026-10-18" } });
    const pills = [...doc.querySelectorAll(".cc-fresh")]; assert.equal(pills.length, 2);
    assert.equal(pills[0].textContent, "Just added"); assert.ok(pills[0].classList.contains("is-new"));
    assert.equal(pills[1].textContent, "Price down $1,200"); assert.ok(pills[1].classList.contains("is-drop"));
    assert.equal(pills[0].parentElement, pills[1].parentElement);
  });
  test("each pill alone, and no pill when the server sends neither", async () => {
    assert.equal((await renderPills({ justAdded: true })).querySelectorAll(".cc-fresh").length, 1);
    assert.equal((await renderPills({ priceDrop: { amount: 500, was: 9000, on: "2026-10-18" } })).querySelector(".cc-fresh")!.textContent, "Price down $500");
    assert.equal((await renderPills({})).querySelectorAll(".cc-fresh").length, 0);
    assert.equal((await renderPills({ justAdded: false })).querySelectorAll(".cc-fresh").length, 0);
  });
  test("only a real positive number is ever printed (no injection through the amount)", async () => {
    for (const bad of ["<img src=x onerror=alert(1)>", "1200", null, 0, -50, {}]) {
      const doc = await renderPills({ priceDrop: { amount: bad, was: 1, on: "x" } });
      assert.equal(doc.querySelectorAll(".cc-fresh").length, 0, JSON.stringify(bad)); assert.equal(doc.querySelector('img[src="x"], [onerror]'), null, "no injected element"); assert.ok(!doc.body.innerHTML.includes("onerror=alert"), "the payload text must not appear unescaped");
    }
  });
});
