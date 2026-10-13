import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import zipcodes from "zipcodes";
import { FEED_COLUMNS, alnumKey, bodyClassesFor, buildTrackingUrl, headerIndex, makeSlug, modelSlug, normalizeBodyClass, parseRow } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { rowToListing, searchCatalogDbListings, getCatalogDbListing, catalogDbModelFacets, setCatalogDbPoolForTests } from "../lib/catalog-db-source";
import { SCHEMA_SQL } from "../lib/catalog-db/schema";
import { cleanConnectionString } from "../lib/catalog-db/conn";

// ---------- synthetic feed (NO real partner data is committed to this public repository) ----------
const HEADER = FEED_COLUMNS.join("\t");
const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
let seq = 0;
const fakeVin = (): string => { seq++; let s = ""; let n = seq * 7919; for (let i = 0; i < 17; i++) { s += VIN_CHARS[n % VIN_CHARS.length]; n = Math.floor(n / 3) + 11 * (i + 1) + seq; } return s; };

interface Car { id?: string; vin?: string; year: number; make: string; model: string; series?: string; cond: "new" | "used"; price: number; odo?: number | ""; body: string; dealer: number; link?: string; availability?: string }
const DEALERS: Record<number, { name: string; street: string; city: string; state: string; zip: string }> = {
  1: { name: "Test Honda Beverly", street: "1 Test St", city: "Beverly Hills", state: "CA", zip: "90210" },
  2: { name: "Test Auto Los Angeles", street: "2 Test St", city: "Los Angeles", state: "CA", zip: "90001" },
  3: { name: "Test Motors Austin", street: "3 Test St", city: "Austin", state: "TX", zip: "78701" },
  4: { name: "Test Cars Boston", street: "4 Test St", city: "Boston", state: "MA", zip: "02108" },
  5: { name: "Test Trucks New York", street: "5 Test St", city: "New York", state: "NY", zip: "10001" },
};
function feedLine(c: Car): string {
  const d = DEALERS[c.dealer];
  const vin = c.vin ?? fakeVin();
  const id = c.id ?? `${String(c.dealer).padStart(2, "0")}${vin}`.toLowerCase().padEnd(32, "0").slice(0, 32);
  const link = c.link ?? buildTrackingUrl({ id, vin, year: c.year, make: c.make, model: c.model });
  const vals: Record<string, string> = {
    id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: `${c.year} ${c.make} ${c.model} for sale`, price: c.price.toFixed(2),
    image_link: `https://img.example.com/${id}.jpg`, link, availability: c.availability ?? "InStock", identifier_exists: "no", dealer_id: String(c.dealer),
    dealer_name: d.name, dealer_street: d.street, dealer_city: d.city, dealer_state: d.state, dealer_zip: d.zip, dealer_radius: "200 miles",
    vehicle_vin: vin, vehicle_stock_number: "S1", vehicle_year: `${c.year}.00`, vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.series ?? "",
    vehicle_odometer: c.odo === undefined ? "40000.00" : c.odo === "" ? "" : `${c.odo}.00`, vehicle_body: c.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black",
  };
  return FEED_COLUMNS.map((k) => vals[k]).join("\t");
}
const CARS: Car[] = [
  { year: 2022, make: "Honda", model: "Civic", series: "EX-L", cond: "used", price: 24000, odo: 32000, body: "Hatchback", dealer: 1 },
  { year: 2026, make: "Honda", model: "Civic", series: "Sport", cond: "new", price: 28000, odo: 5, body: "Sedan", dealer: 1 },
  { year: 2021, make: "Honda", model: "Civic", cond: "used", price: 19000, odo: 51000, body: "4dr Car", dealer: 2 },
  { year: 2024, make: "Honda", model: "CR-V", cond: "used", price: 31000, odo: 12000, body: "Sport Utility", dealer: 2 },
  { year: 2019, make: "Honda", model: "Civic", cond: "used", price: 15000, odo: 80000, body: "Sedan", dealer: 3 },
  { year: 2023, make: "Toyota", model: "Corolla", cond: "used", price: 20000, odo: 20000, body: "Sedan", dealer: 3 },
  { year: 2022, make: "Ford", model: "F-150", cond: "used", price: 38000, odo: 30000, body: "Crew Cab Pickup", dealer: 3 },
  { year: 2025, make: "Ford", model: "F-150", cond: "new", price: 52000, odo: "", body: "Truck", dealer: 5 },
  { year: 2020, make: "Land Rover", model: "Range Rover Sport", cond: "used", price: 45000, odo: 41000, body: "4WD Sport Utility Vehicles", dealer: 5 },
  { year: 2024, make: "Volkswagen", model: "ID.4", cond: "used", price: 29000, odo: 9000, body: "SUV", dealer: 4 },
  { year: 2018, make: "Honda", model: "Civic", cond: "used", price: 14000, odo: 90000, body: "Sedan", dealer: 4 },
  { year: 2024, make: "Honda", model: "Civic", cond: "used", price: 26000, odo: 15000, body: "Sedan", dealer: 5 },
];
// one row whose tracking link does not follow the standard rule
const OVERRIDE_LINK = "https://edmunds.sjv.io/c/7765200/3913681/52125?prodsku=ovr&u=https%3A%2F%2Fwww.edmunds.com%2Fspecial%2Fpage&intsrc=CATF_34070";
const OVERRIDE_CAR: Car = { id: "override0000000000000000000000ab", year: 2023, make: "Honda", model: "Accord", cond: "used", price: 27000, odo: 20000, body: "Sedan", dealer: 1, link: OVERRIDE_LINK };
const BAD_VIN = feedLine({ year: 2020, make: "Honda", model: "Fit", cond: "used", price: 10000, body: "Hatchback", dealer: 1, vin: "SHORT" });
const NO_MAKE = feedLine({ year: 2020, make: "", model: "X", cond: "used", price: 10000, body: "Sedan", dealer: 1 });
const SOLD = feedLine({ year: 2020, make: "Honda", model: "Pilot", cond: "used", price: 30000, body: "SUV", dealer: 1, availability: "OutOfStock" });

async function* asLines(lines: string[]): AsyncIterable<string> { for (const l of lines) yield l; }
const fullFeed = (): string[] => [HEADER, ...CARS.map(feedLine), feedLine(OVERRIDE_CAR), BAD_VIN, NO_MAKE, SOLD];

// ---------- pure functions: always run ----------
describe("catalogue db: pure normalisation", () => {
  test("body labels collapse into classes", () => {
    const t: Array<[string, string | null]> = [
      ["SUV", "suv"], ["Sport Utility", "suv"], ["4WD Sport Utility Vehicles", "suv"], ["4D Sport Utility", "suv"], ["Crossover", "suv"],
      ["Sedan", "sedan"], ["4dr Car", "sedan"], ["4-door Mid-Size Passenger Car", "sedan"], ["4D Sedan", "sedan"],
      ["Truck", "truck"], ["TRUCK", "truck"], ["Crew Cab Pickup", "truck"], ["4WD Standard Pickup Trucks", "truck"], ["CrewMax", "truck"],
      ["Minivan/Van", "minivan"], ["Mini-van, Passenger", "minivan"], ["2WD Minivans", "minivan"], ["Cargo Van", "van"], ["Cargo Vans", "van"], ["Passenger Van", "van"],
      ["Hatchback", "hatchback"], ["Convertible", "convertible"], ["Coupe", "coupe"], ["2dr Car", "coupe"], ["Wagon", "wagon"], ["Small Wagon", "wagon"],
      ["Car", "other"], ["HYBRID AWD", "other"], ["", null],
    ];
    for (const [raw, want] of t) assert.equal(normalizeBodyClass(raw), want, `label ${JSON.stringify(raw)}`);
  });
  test("a body request maps to the right classes", () => {
    assert.deepEqual(bodyClassesFor("SUV"), ["suv"]);
    assert.deepEqual(bodyClassesFor("Pickup truck"), ["truck"]);
    assert.deepEqual(bodyClassesFor("sedan, coupe")?.sort(), ["coupe", "sedan"]);
    assert.equal(bodyClassesFor(undefined), null);
  });
  test("tracking-link slugs: make keeps spaces, model uses hyphens and keeps dots", () => {
    assert.equal(makeSlug("Land Rover"), "land rover");
    assert.equal(modelSlug("Range Rover Sport"), "range-rover-sport");
    assert.equal(modelSlug("ID.4"), "id.4");
    const u = buildTrackingUrl({ id: "abc", vin: "1HGCM82633A004352", year: 2003, make: "Honda", model: "Accord" });
    assert.ok(u.startsWith("https://edmunds.sjv.io/c/7765200/3913681/52125?prodsku=abc&u="));
    assert.ok(decodeURIComponent(u).includes("/honda/accord/2003/vin/1HGCM82633A004352/featured-listing/"));
  });
  test("keys ignore punctuation and case", () => { assert.equal(alnumKey("CR-V"), alnumKey("cr v")); assert.equal(alnumKey("F-150"), "f150"); });
  test("a feed with a missing column is rejected", () => { assert.throws(() => headerIndex("id\ttitle"), /missing column/); });
  test("parseRow: skips unusable rows with a reason and keeps null for unknown numbers", () => {
    const idx = headerIndex(HEADER);
    const skip = (l: string) => { const r = parseRow(l.split("\t"), idx); return "skip" in r ? r.skip : "ok"; };
    assert.equal(skip(BAD_VIN), "bad vin"); assert.equal(skip(NO_MAKE), "no make or model"); assert.equal(skip(SOLD), "out of stock");
    const r = parseRow(feedLine({ year: 2025, make: "Ford", model: "F-150", cond: "new", price: 52000, odo: "", body: "Truck", dealer: 5 }).split("\t"), idx);
    assert.ok("row" in r); if ("row" in r) { assert.equal(r.row.odometer, null); assert.equal(r.row.condition, "n"); assert.equal(r.row.dealerZip, "10001"); assert.equal(r.row.linkOverride, null); }
    const o = parseRow(feedLine(OVERRIDE_CAR).split("\t"), idx); assert.ok("row" in o && o.row.linkOverride === OVERRIDE_LINK);
  });
  test("hosted connection strings: channel_binding is dropped, everything else is kept", () => {
    const raw = "postgresql://user:p%40ss@ep-x-pooler.db.example.com/neondb?sslmode=require&channel_binding=require";
    const out = cleanConnectionString(raw) ?? "";
    assert.ok(!out.includes("channel_binding")); assert.ok(out.includes("sslmode=verify-full")); assert.ok(out.includes("p%40ss@ep-x-pooler"));
    assert.equal(cleanConnectionString("  "), undefined); assert.equal(cleanConnectionString(undefined), undefined);
    assert.equal(cleanConnectionString("not a url"), "not a url");
  });
  test("feed header: a byte-order mark is tolerated, and a wrong file is named in the error", () => {
    assert.ok(headerIndex("\uFEFF" + FEED_COLUMNS.join("\t")).id === 0);
    assert.throws(() => headerIndex(["Unique Merchant SKU", "Product Name", "Product URL"].join("\t")), /missing column "id".*Unique Merchant SKU/);
  });
  test("a 4-digit ZIP regains its leading zero", () => {
    const idx = headerIndex(HEADER); const cols = feedLine(CARS[0]).split("\t"); cols[idx["dealer_zip"]] = "2108";
    const r = parseRow(cols, idx); assert.ok("row" in r && r.row.dealerZip === "02108");
  });
});

// ---------- database: runs when TEST_DATABASE_URL is set ----------
const DB = process.env.TEST_DATABASE_URL;
describe("catalogue db: load and search (real PostgreSQL)", { skip: DB ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: DB, max: 2 });
    await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
    setCatalogDbPoolForTests(pool);
  });
  after(async () => { setCatalogDbPoolForTests(null); await pool.end(); });

  test("loads the feed: counts, skipped reasons, dealer table, link overrides", async () => {
    const rep = await loadFeed(pool, asLines(fullFeed()));
    assert.equal(rep.parsed, CARS.length + 1);
    assert.equal(rep.inserted, CARS.length + 1);
    assert.deepEqual(rep.skipped, { "bad vin": 1, "no make or model": 1, "out of stock": 1 });
    assert.equal(Number((await pool.query("SELECT count(*) FROM dealer")).rows[0].count), 5);
    assert.equal(Number((await pool.query("SELECT count(*) FROM listing WHERE link_override IS NOT NULL")).rows[0].count), 1);
    assert.equal((await pool.query("SELECT zip FROM dealer WHERE id = 4")).rows[0].zip, "02108");
  });

  test("local search: only nearby dealers, nearest first, with distances", async () => {
    const r = await searchCatalogDbListings({ make: "Honda", model: "Civic", zip: "90210", radius: 50 });
    assert.equal(r.source, "catalog_db"); assert.equal(r.localApplied, true);
    assert.ok(r.data.length >= 3);
    for (const l of r.data) assert.ok(["CA"].includes(l.retailListing?.state ?? ""), "only California dealers within 50 miles");
    const d = r.data.map((l) => l.catalog?.distanceMiles ?? 9999); assert.deepEqual([...d].sort((a, b) => a - b), d);
    assert.equal(r.data[0].retailListing?.zip, "90210");
  });

  test("when too few are nearby the search widens, and never returns nothing", async () => {
    const r = await searchCatalogDbListings({ make: "Ford", model: "F-150", zip: "90210", radius: 25 });
    assert.ok(r.data.length >= 2); assert.ok(r.data.every((l) => l.vehicle?.model === "F-150"));
  });

  test("a leading-zero ZIP (Boston) works", async () => {
    const r = await searchCatalogDbListings({ make: "Honda", model: "Civic", zip: "02108", radius: 30 });
    assert.ok(r.data.length >= 1); assert.equal(r.data[0].retailListing?.state, "MA");
  });

  test("filters: condition, price, year, mileage, body, state", async () => {
    const used = await searchCatalogDbListings({ make: "Honda", model: "Civic", used: true });
    assert.ok(used.data.length >= 4 && used.data.every((l) => l.retailListing?.used === true));
    const fresh = await searchCatalogDbListings({ make: "Honda", model: "Civic", used: false });
    assert.equal(fresh.data.length, 1); assert.equal(fresh.data[0].retailListing?.used, false);
    const cheap = await searchCatalogDbListings({ make: "Honda", model: "Civic", priceMax: 20000, yearMin: 2019 });
    assert.ok(cheap.data.every((l) => (l.retailListing?.price ?? 0) <= 20000 && (l.vehicle?.year ?? 0) >= 2019));
    const lowMiles = await searchCatalogDbListings({ mileageMax: 10000 });
    assert.ok(lowMiles.data.every((l) => l.retailListing?.miles == null ? l.retailListing?.used === false : l.retailListing.miles <= 10000));
    const trucks = await searchCatalogDbListings({ bodyType: "Pickup" });
    assert.ok(trucks.data.length === 2 && trucks.data.every((l) => l.vehicle?.model === "F-150"));
    assert.ok(trucks.data.every((l) => l.vehicle?.bodyStyle === "Pickup"));
    const tx = await searchCatalogDbListings({ state: "tx" });
    assert.ok(tx.data.length === 3 && tx.data.every((l) => l.retailListing?.state === "TX"));
  });

  test("sorting and model lists", async () => {
    const asc = await searchCatalogDbListings({ make: "Honda", model: "Civic", sort: "price.asc" });
    const prices = asc.data.map((l) => l.retailListing?.price ?? 0); assert.deepEqual([...prices].sort((a, b) => a - b), prices);
    const two = await searchCatalogDbListings({ model: "Corolla, CR-V" });
    assert.deepEqual(new Set(two.data.map((l) => l.vehicle?.model)), new Set(["Corolla", "CR-V"]));
    const loose = await searchCatalogDbListings({ model: "crv" });
    assert.equal(loose.data.length, 1);
  });

  test("VIN lookup works, and tracking links are rebuilt or taken from the stored exception", async () => {
    const any = (await pool.query("SELECT vin, id FROM listing WHERE link_override IS NULL LIMIT 1")).rows[0];
    const l = await getCatalogDbListing(any.vin);
    assert.ok(l); assert.equal(l?.vin, any.vin);
    assert.ok(l?.catalog?.trackingUrl?.includes(`prodsku=${any.id}`));
    const o = (await pool.query("SELECT vin FROM listing WHERE link_override IS NOT NULL")).rows[0];
    assert.equal((await getCatalogDbListing(o.vin))?.catalog?.trackingUrl, OVERRIDE_LINK);
    assert.equal(await getCatalogDbListing("00000000000000000"), null);
  });

  test("model facets count models for the current filters", async () => {
    const f = await catalogDbModelFacets({ make: "Honda" });
    const m = Object.fromEntries(f.map((x) => [x.value, x.count]));
    assert.equal(m["Civic"], 6); assert.equal(m["CR-V"], 1); assert.equal(m["Accord"], 1);
  });

  test("distance columns exist for every dealer ZIP the loader could resolve", async () => {
    const r = await pool.query("SELECT count(*) FILTER (WHERE lat IS NULL)::int AS missing FROM listing");
    assert.equal(r.rows[0].missing, 0);
    assert.ok(zipcodes.lookup("90210"));
  });

  test("the next day's feed: price change, new car and sold car are merged in one go", async () => {
    const next = CARS.map((c) => ({ ...c })); next[0] = { ...next[0], price: 23000 };
    const lines = [HEADER, ...next.slice(0, -1).map(feedLine), feedLine({ year: 2025, make: "Kia", model: "Soul", cond: "new", price: 21000, body: "Hatchback", dealer: 2 }), feedLine(OVERRIDE_CAR)];
    // the f(next) rows get new random VINs, so keep the first car's VIN and id stable
    const stable = feedLine({ ...CARS[0], price: 23000, vin: (await pool.query("SELECT vin FROM listing WHERE make = 'Honda' AND model = 'Civic' AND year = 2022")).rows[0].vin.trim(), id: (await pool.query("SELECT id FROM listing WHERE make = 'Honda' AND model = 'Civic' AND year = 2022")).rows[0].id });
    const keep = (await pool.query("SELECT id, vin, year, make, model FROM listing")).rows;
    assert.ok(keep.length > 5);
    const rep = await loadFeed(pool, asLines([HEADER, stable, feedLine({ year: 2025, make: "Kia", model: "Soul", cond: "new", price: 21000, body: "Hatchback", dealer: 2 }), feedLine(OVERRIDE_CAR), ...lines.slice(1, 1)]), { keepRatio: 0 });
    assert.equal(rep.inserted, 1); assert.equal(rep.updated, 1); assert.ok(rep.deleted >= keep.length - 2);
    assert.equal(Number((await pool.query("SELECT price FROM listing WHERE make = 'Honda' AND model = 'Civic' AND year = 2022")).rows[0].price), 23000);
  });

  test("safety floor: a truncated feed is refused and changes nothing", async () => {
    await loadFeed(pool, asLines(fullFeed()), { keepRatio: 0 }); // restore the full set
    const before = Number((await pool.query("SELECT count(*) FROM listing")).rows[0].count);
    await assert.rejects(() => loadFeed(pool, asLines([HEADER, feedLine(CARS[0])])), /refusing to merge/);
    await assert.rejects(() => loadFeed(pool, asLines([])), /feed was empty/);
    assert.equal(Number((await pool.query("SELECT count(*) FROM listing")).rows[0].count), before);
  });

  test("test mode: loading every 2nd car keeps a half-size set and says what it left out", async () => {
    const rep = await loadFeed(pool, asLines(fullFeed()), { sampleEvery: 2, keepRatio: 0 });
    assert.equal(rep.skipped["not in sample"], 8);
    assert.equal(rep.parsed, 6);
    assert.equal(Number((await pool.query("SELECT count(*) FROM listing")).rows[0].count), 6);
    await assert.rejects(() => loadFeed(pool, asLines(fullFeed()), { sampleEvery: 5 }), /refusing to merge/); // a sample can never replace a bigger stored set
  });

  test("a database error becomes the same quiet service error as the other sources", async () => {
    const broken = new Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
    setCatalogDbPoolForTests(broken);
    const r = await searchCatalogDbListings({ make: "Honda" });
    assert.ok(r.error && r.data.length === 0);
    setCatalogDbPoolForTests(pool); await broken.end().catch(() => {});
  });

  test("rowToListing carries the feed's own condition (used or new) and never invents a mileage", () => {
    const l = rowToListing({ id: "x", vin: "A".repeat(17), year: 2026, make: "Honda", model: "Civic", trim: null, condition: "n", price: 1, odometer: null, body_raw: "Sedan", body_class: "sedan", doors: 4, ext_color: null, int_color: null, dealer_id: 9, state: "CA", zip: "90210", image_url: null, link_override: null, dealer_name: "D", dealer_city: "C", dealer_street: null, distance: 12.4 });
    assert.equal(l.retailListing?.used, false); assert.equal(l.retailListing?.miles, undefined); assert.equal(l.catalog?.distanceMiles, 12); assert.equal(l.vehicle?.bodyStyle, "Sedan");
  });
});
void SCHEMA_SQL;
