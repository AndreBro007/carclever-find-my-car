// Review finding 1: a daily refresh must carry a corrected colour, door count, VIN or dealer location into the listing table,
// while rows that did not change are left alone. Needs a real PostgreSQL (TEST_DATABASE_URL); skipped otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";

const DB = process.env.TEST_DATABASE_URL;
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };
const DEALERS: Record<number, [string, string, string, string]> = { 1: ["Test Honda Beverly", "Beverly Hills", "CA", "90210"], 2: ["Test Auto Dallas", "Dallas", "TX", "75201"], 3: ["Test Auto Denver", "Denver", "CO", "80202"] };
type Car = { n: number; color: string; doors: number; dealerZip: string; dealerState: string; vin?: string };
const base = (n: number): Car => ({ n, color: "Blue", doors: 4, dealerZip: "90210", dealerState: "CA" });
const vinFor = (n: number) => `1HGCV1F3${String(n).padStart(2, "0")}A${String(100000 + n)}`.slice(0, 17).replace(/[IOQ]/g, "7");
function line(c: Car): string {
  const vin = c.vin ?? vinFor(c.n); const id = `ld${String(c.n).padStart(30, "0")}`;
  const v: Record<string, string> = { id, title: "t", condition: "used", description: "d", price: "20000.00", image_link: `https://img.example.com/${c.n}.jpg`,
    link: buildTrackingUrl({ id, vin, year: 2022, make: "Honda", model: "Civic" }), availability: "InStock", identifier_exists: "no", dealer_id: "1", dealer_name: DEALERS[1][0], dealer_street: "1 Test St",
    dealer_city: DEALERS[1][1], dealer_state: c.dealerState, dealer_zip: c.dealerZip, dealer_radius: "200 miles", vehicle_vin: vin, vehicle_stock_number: "S", vehicle_year: "2022.00", vehicle_make: "Honda", vehicle_model: "Civic",
    vehicle_series: "LX", vehicle_odometer: "30000.00", vehicle_body: "Sedan", vehicle_door_number: `${c.doors}.00`, vehicle_exterior_color: c.color, vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
}
const feed = (cars: Car[]) => (async function* () { yield FEED_COLUMNS.join("\t"); for (const c of cars) yield line(c); })();

let pool: Pool;
before(async () => { if (!DB) return; pool = new Pool({ connectionString: DB, max: 2 }); await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE"); });
after(async () => { if (!DB) return; await pool.end(); });
const row = async (n: number) => (await pool.query("SELECT vin, doors, ext_color, state, zip, lat, lon, loaded_at FROM listing WHERE id = $1", [`ld${String(n).padStart(30, "0")}`])).rows[0];

test("daily refresh: unchanged rows are left alone; a corrected colour, doors, VIN or location reaches the listing table", opts, async () => {
  const cars = [base(1), base(2), base(3), base(4), base(5)];
  const first = await loadFeed(pool, feed(cars), { minRows: 1 });
  assert.equal(first.inserted, 5);
  const before1 = await row(1), before5 = await row(5);

  // identical feed: nothing is rewritten
  const same = await loadFeed(pool, feed(cars), { minRows: 1 });
  assert.equal(same.updated, 0, "an identical feed must update no rows");
  assert.equal(String((await row(1)).loaded_at), String(before1.loaded_at));

  // only the colour changed on car 1; only the door count on car 2; only the VIN on car 3; only the dealer location on car 4
  const changed = [{ ...cars[0], color: "Red" }, { ...cars[1], doors: 2 }, { ...cars[2], vin: "2HGCV1F3AA9999999" }, { ...cars[3], dealerZip: "75201", dealerState: "TX" }, cars[4]];
  const r = await loadFeed(pool, feed(changed), { minRows: 1 });
  assert.equal(r.updated, 4, "exactly the four changed rows are updated");
  assert.equal((await row(1)).ext_color, "Red");
  assert.equal((await row(2)).doors, 2);
  assert.equal((await row(3)).vin, "2HGCV1F3AA9999999");
  const loc = await row(4);
  assert.equal(loc.state, "TX"); assert.equal(loc.zip, "75201");
  assert.ok(Math.abs(Number(loc.lat) - 32.78) < 0.5 && Math.abs(Number(loc.lon) + 96.8) < 0.5, "coordinates follow the corrected ZIP");
  assert.equal(String((await row(5)).loaded_at), String(before5.loaded_at), "the untouched row was not rewritten");
});
