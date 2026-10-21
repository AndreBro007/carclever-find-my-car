// The loader's body-class inference against a real PostgreSQL (SYS-20261021-047): a car the feed does not classify takes the class of its make and model when the other cars of that
// model agree (at least 5 classified, at least 80% in one class); otherwise it stays unclassified; classified cars are never touched; a second load changes nothing.
// Synthetic cars only; the labels are real ones from the Neon audit. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl, normalizeBodyClass } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";

const DB = process.env.TEST_DATABASE_URL;
type R = { make: string; model: string; body: string };
const ROWS: R[] = [];
const add = (n: number, make: string, model: string, body: string) => { for (let i = 0; i < n; i++) ROWS.push({ make, model, body }); };
add(6, "Toyota", "RAV4", "Sport Utility"); add(2, "Toyota", "RAV4", ""); add(1, "Toyota", "RAV4", "XLE");                    // consensus suv: 3 inferred
add(5, "Honda", "Civic", "Sedan"); add(5, "Honda", "Civic", "Coupe"); add(1, "Honda", "Civic", "");                          // 50/50: stays empty
add(3, "Acme", "Zed", "SUV"); add(1, "Acme", "Zed", "");                                                                      // under 5 classified: stays empty
add(10, "Honda", "Passport", "Sport Utility"); add(2, "Honda", "Passport", "Car");                                            // "Car" is no body style: 2 inferred
add(6, "BMW", "X5", "Sports Activity Vehicle"); add(1, "BMW", "X5", "");                                                      // the label is an SUV by rule; the empty one is inferred
add(8, "Ford", "F-150", "Pickup"); add(1, "Ford", "F-150", "4WD CREW");                                                       // 1 inferred truck
const EXPECT_INFERRED = 3 + 2 + 1 + 1;

function line(r: R, n: number): string {
  const vin = `1HGCM826${String(n).padStart(9, "0")}`; const id = `bci${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `2024 ${r.make} ${r.model}`, condition: "used", description: "d", price: "30000.00", image_link: `https://img.example.com/${n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: 2024, make: r.make, model: r.model }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: "Test Dealer",
    dealer_street: "1 Test St", dealer_city: "Dallas", dealer_state: "TX", dealer_zip: "75201", dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: "2024.00",
    vehicle_make: r.make, vehicle_model: r.model, vehicle_series: "Base", vehicle_odometer: "20000.00", vehicle_body: r.body, vehicle_door_number: "4.00", vehicle_exterior_color: "Blue", vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const r of ROWS) yield line(r, n++); }

let pool: Pool;
before(async () => { if (!DB) return; pool = new Pool({ connectionString: DB, max: 2 }); await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE"); });
after(async () => { if (!DB) return; await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const classOf = async (make: string, model: string): Promise<Array<string | null>> =>
  (await pool.query("SELECT body_class, body_raw FROM listing WHERE make = $1 AND model = $2 ORDER BY id", [make, model])).rows.map((r) => r.body_class);

test("the label Sports Activity Vehicle is an SUV by rule (pure)", () => {
  assert.equal(normalizeBodyClass("Sports Activity Vehicle"), "suv");
  assert.equal(normalizeBodyClass("Sport Activity Vehicle"), "suv");
  assert.equal(normalizeBodyClass("Car"), "other");
  assert.equal(normalizeBodyClass("XLE"), "other");
  assert.equal(normalizeBodyClass(""), null);
});

test("cars with no body class take their model's class when the model's cars agree; otherwise they stay empty", opts, async () => {
  const rep = await loadFeed(pool, lines());
  assert.equal(rep.bodyClassInferred, EXPECT_INFERRED);
  assert.ok((await classOf("Toyota", "RAV4")).every((c) => c === "suv"), "empty and XLE RAV4 cars become suv");
  assert.deepEqual((await classOf("Honda", "Civic")).filter((c) => c === null).length, 1, "a 50/50 model is not guessed");
  assert.equal((await classOf("Honda", "Civic")).filter((c) => c === "sedan").length, 5);
  assert.equal((await classOf("Honda", "Civic")).filter((c) => c === "coupe").length, 5);
  assert.deepEqual((await classOf("Acme", "Zed")).filter((c) => c === null).length, 1, "fewer than 5 classified cars is not enough");
  assert.ok((await classOf("Honda", "Passport")).every((c) => c === "suv"), "Car becomes suv");
  assert.ok((await classOf("BMW", "X5")).every((c) => c === "suv"), "Sports Activity Vehicle by rule, the empty one by model");
  assert.equal((await classOf("Ford", "F-150")).filter((c) => c === "truck").length, 9, "4WD CREW becomes truck");
});

test("cars the feed classified are never changed, and the raw label is kept as it came", opts, async () => {
  const r = await pool.query("SELECT body_class, body_raw FROM listing WHERE make = 'Honda' AND model = 'Civic' AND body_raw = 'Coupe'");
  assert.ok(r.rows.length === 5 && r.rows.every((x) => x.body_class === "coupe"));
  const x = await pool.query("SELECT body_class, body_raw FROM listing WHERE make = 'Toyota' AND model = 'RAV4' AND body_raw = 'XLE'");
  assert.deepEqual(x.rows, [{ body_class: "suv", body_raw: "XLE" }]);
});

test("a second load of the same feed changes nothing", opts, async () => {
  const rep = await loadFeed(pool, lines());
  assert.equal(rep.inserted, 0); assert.equal(rep.updated, 0); assert.equal(rep.deleted, 0);
  assert.equal(rep.bodyClassInferred, EXPECT_INFERRED);
});
