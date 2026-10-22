// The loader's body-class inference against a real PostgreSQL (SYS-20261021-047, tightened in SYS-20261022-055 after review finding BA22-05).
// A car with no body class takes the class of the cars of the same make, model and MODEL YEAR (and the same DOOR COUNT when it has one) when at least 3 of them are classified and at least 95% agree;
// a car with no door count takes a class only when all doors agree. Mixed models and years without evidence stay unclassified; classified cars are never touched; a second load changes nothing.
// Synthetic cars only; the labels are real ones from the Neon audit. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl, normalizeBodyClass } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";

const DB = process.env.TEST_DATABASE_URL;
type R = { make: string; model: string; body: string; year: number; doors: number | null; tag: string };
const ROWS: R[] = [];
const add = (n: number, make: string, model: string, body: string, year: number, doors: number | null, tag = "c") => { for (let i = 0; i < n; i++) ROWS.push({ make, model, body, year, doors, tag }); };
const one = (tag: string, make: string, model: string, body: string, year: number, doors: number | null) => ROWS.push({ make, model, body, year, doors, tag });
// consensus within one model year and door count: all three unknown RAV4s become suv (the no-doors one by the model year alone)
add(6, "Toyota", "RAV4", "Sport Utility", 2025, 4); one("rav-u1", "Toyota", "RAV4", "", 2025, 4); one("rav-u2", "Toyota", "RAV4", "XLE", 2025, 4); one("rav-u3", "Toyota", "RAV4", "", 2025, null);
// ChatGPT's case BA22-05: 80% sedan, 20% coupe in one year. Only the four-door unknown, which has eight four-door sedans behind it, is classified.
add(8, "Honda", "Civic", "Sedan", 2018, 4); add(2, "Honda", "Civic", "Coupe", 2018, 2);
one("civ-u1", "Honda", "Civic", "", 2018, 2);      // two doors: only two classified two-door cars, under 3: stays empty
one("civ-u2", "Honda", "Civic", "", 2018, 4);      // four doors: eight sedans: sedan
one("civ-u3", "Honda", "Civic", "", 2018, null);   // no doors: the year is 80/20: stays empty
one("civ-u4", "Honda", "Civic", "", 2008, 2); one("civ-u5", "Honda", "Civic", "", 2008, 4);   // a year with no classified cars gives no evidence
add(2, "Honda", "Accord", "Sedan", 2024, 4); one("acc-u", "Honda", "Accord", "", 2024, 4);   // only 2 classified cars: stays empty
add(5, "Honda", "Passport", "Sport Utility", 2024, 4); add(2, "Honda", "Passport", "Car", 2024, 4, "pas-u");   // "Car" is no body style: inferred
add(4, "BMW", "X5", "Sports Activity Vehicle", 2023, 4); one("x5-u", "BMW", "X5", "", 2023, null);            // the label is an SUV by rule; the unknown by the model year
add(3, "Ford", "F-150", "Pickup", 2022, 4); one("f1-u", "Ford", "F-150", "4WD CREW", 2022, 4);               // exactly 3 classified: inferred truck
add(18, "Ford", "Mustang", "Coupe", 2021, 2); add(2, "Ford", "Mustang", "Convertible", 2021, 2); one("mus-u", "Ford", "Mustang", "", 2021, 2);   // 90/10: stays empty
add(19, "Ford", "Mustang", "Coupe", 2020, 2); add(1, "Ford", "Mustang", "Convertible", 2020, 2); one("mus-v", "Ford", "Mustang", "", 2020, 2);   // 95/5 exactly: coupe
// R2-03 (ChatGPT round 2): 100 four-door sedans and 3 two-door coupes in one year: the unknown-door car stays empty (the door groups disagree) although 100/103 is above 95%;
// the unknown cars with a door count still take their own door group's class.
add(100, "Loa", "Lo", "Sedan", 2026, 4); add(3, "Loa", "Lo", "Coupe", 2026, 2);
one("lo-u", "Loa", "Lo", "", 2026, null); one("lo-v", "Loa", "Lo", "", 2026, 4); one("lo-w", "Loa", "Lo", "", 2026, 2);
// all door groups agree (sedan with four and with two doors): the unknown-door car is a sedan
add(50, "Sed", "Se", "Sedan", 2026, 4); add(4, "Sed", "Se", "Sedan", 2026, 2); one("se-u", "Sed", "Se", "", 2026, null);
const EXPECT: Record<string, string | null> = { "rav-u1": "suv", "rav-u2": "suv", "rav-u3": "suv", "civ-u1": null, "civ-u2": "sedan", "civ-u3": null, "civ-u4": null, "civ-u5": null, "acc-u": null,
  "pas-u": "suv", "x5-u": "suv", "f1-u": "truck", "mus-u": null, "mus-v": "coupe", "lo-u": null, "lo-v": "sedan", "lo-w": "coupe", "se-u": "sedan" };
const EXPECT_INFERRED = 3 + 1 + 2 + 1 + 1 + 1 + 2 + 1;

function line(r: R, n: number): string {
  const vin = `1HGCM826${String(n).padStart(9, "0")}`; const id = `bci${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${r.year} ${r.make} ${r.model}`, condition: "used", description: "d", price: "30000.00", image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: r.year, make: r.make, model: r.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: `${r.year}.00`,
    vehicle_make: r.make, vehicle_model: r.model, vehicle_series: r.tag, vehicle_odometer: "20000.00", vehicle_body: r.body, vehicle_door_number: r.doors == null ? "" : `${r.doors}.00`, vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const r of ROWS) yield line(r, n++); }

let pool: Pool;
before(async () => { if (!DB) return; pool = new Pool({ connectionString: DB, max: 2 }); await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE"); });
after(async () => { if (!DB) return; await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const classOfTag = async (tag: string): Promise<Array<string | null>> => (await pool.query("SELECT body_class FROM listing WHERE trim = $1 ORDER BY id", [tag])).rows.map((r) => r.body_class);

test("the label Sports Activity Vehicle is an SUV by rule (pure)", () => {
  assert.equal(normalizeBodyClass("Sports Activity Vehicle"), "suv");
  assert.equal(normalizeBodyClass("Sport Activity Vehicle"), "suv");
  assert.equal(normalizeBodyClass("Car"), "other");
  assert.equal(normalizeBodyClass("XLE"), "other");
  assert.equal(normalizeBodyClass(""), null);
});

test("each unknown car gets the class its own model year and door count support, and no other", opts, async () => {
  const rep = await loadFeed(pool, lines());
  for (const [tag, want] of Object.entries(EXPECT)) { const got = await classOfTag(tag); assert.ok(got.length >= 1, tag); assert.ok(got.every((c) => c === want), `${tag}: wanted ${want}, got ${JSON.stringify(got)}`); }
  assert.equal(rep.bodyClassInferred, EXPECT_INFERRED);
});

test("BA22-05: an 80/20 sedan and coupe model never turns an unknown two-door car or an older-generation car into a sedan", opts, async () => {
  for (const tag of ["civ-u1", "civ-u3", "civ-u4", "civ-u5"]) assert.deepEqual(await classOfTag(tag), [null], tag);
});

test("R2-03: an unknown-door car is not classified when the door groups of its model year disagree, however lopsided the overall split", opts, async () => {
  await loadFeed(pool, lines());
  assert.deepEqual(await classOfTag("lo-u"), [null]); assert.deepEqual(await classOfTag("lo-v"), ["sedan"]); assert.deepEqual(await classOfTag("lo-w"), ["coupe"]); assert.deepEqual(await classOfTag("se-u"), ["sedan"]);
});

test("cars the feed classified are never changed, and the raw label is kept as it came", opts, async () => {
  const c = await pool.query("SELECT body_class FROM listing WHERE make = 'Honda' AND model = 'Civic' AND trim = 'c'");
  assert.equal(c.rows.filter((r) => r.body_class === "sedan").length, 8); assert.equal(c.rows.filter((r) => r.body_class === "coupe").length, 2);
  const x = await pool.query("SELECT body_class, body_raw FROM listing WHERE trim = 'rav-u2'"); assert.deepEqual(x.rows, [{ body_class: "suv", body_raw: "XLE" }]);
});

test("a second load of the same feed changes nothing", opts, async () => {
  const rep = await loadFeed(pool, lines());
  assert.equal(rep.inserted, 0); assert.equal(rep.updated, 0); assert.equal(rep.deleted, 0); assert.equal(rep.bodyClassInferred, EXPECT_INFERRED);
});
