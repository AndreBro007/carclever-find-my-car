// Colour in the database search: a real filter when at least 3 cars match, otherwise only a ranking boost (never an empty result).
// Uses its own temporary database on the TEST_DATABASE_URL server so it cannot disturb the other database tests.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { SCHEMA_SQL } from "../lib/catalog-db/schema";
import { searchRows, MIN_COLOUR_MATCHES } from "../lib/catalog-db/search";

const DB = process.env.TEST_DATABASE_URL;
describe("catalogue db: colour search (real PostgreSQL)", { skip: DB ? false : "TEST_DATABASE_URL not set" }, () => {
  let admin: Pool, pool: Pool; const name = "cq_" + Math.random().toString(36).slice(2, 10);
  before(async () => {
    admin = new Pool({ connectionString: DB, max: 1 }); await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(DB!); u.pathname = "/" + name; pool = new Pool({ connectionString: u.toString(), max: 2 }); await pool.query(SCHEMA_SQL);
    let n = 0;
    const add = (color: string, miles: number) => { n++; const lat = 41.8781 + miles / 69; // north of Chicago
      return pool.query(`INSERT INTO listing (id, vin, year, make, make_key, model, model_key, condition, price, odometer, body_class, ext_color, int_color, state, zip, lat, lon)
        VALUES ($1,$2,2023,'Honda','honda','CR-V','crv','u',20000,10000,'suv',$3,'Black','IL','60601',$4,-87.6298)`, ["id" + n, "1HGCM82633A" + String(100000 + n), color, lat]); };
    for (const [c, m] of [["Glacier White", 5], ["Glacier White", 8], ["Magnetic Gray", 10], ["Crystal Black Pearl", 20], ["Agate Black Metallic", 25], ["Ebony Black", 30], ["Platinum White Pearl", 35]] as const) await add(c, m);
  });
  after(async () => { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); });
  const q = (extra: object) => ({ make: "Honda", zip: "60601", radius: 100, limit: 50, ...extra });
  test("3 or more matches: colour is a real filter and the nearest match comes first", async () => {
    const r = await searchRows(pool, q({ exteriorColor: "Black" }), ["CR-V"]);
    assert.deepEqual(r.rows.map((x: any) => x.ext_color), ["Crystal Black Pearl", "Agate Black Metallic", "Ebony Black"]);
    assert.ok(MIN_COLOUR_MATCHES <= 3);
  });
  test("fewer than 3 matches: nothing is emptied, matching cars are ranked first", async () => {
    const r = await searchRows(pool, q({ exteriorColor: "Gray" }), ["CR-V"]);
    assert.equal(r.rows.length, 7); assert.equal((r.rows[0] as any).ext_color, "Magnetic Gray");
  });
  test("a colour nobody has: all cars still come back, in the normal nearest-first order", async () => {
    const r = await searchRows(pool, q({ exteriorColor: "Purple" }), ["CR-V"]);
    assert.equal(r.rows.length, 7); assert.equal((r.rows[0] as any).ext_color, "Glacier White");
  });
  test("no colour requested: unchanged nearest-first order", async () => {
    const r = await searchRows(pool, q({}), ["CR-V"]);
    assert.deepEqual(r.rows.map((x: any) => x.ext_color).slice(0, 3), ["Glacier White", "Glacier White", "Magnetic Gray"]);
  });
  test("white matches by the marketing names (Glacier White, Platinum White Pearl)", async () => {
    const r = await searchRows(pool, q({ exteriorColor: "White" }), ["CR-V"]);
    assert.deepEqual(r.rows.map((x: any) => x.ext_color), ["Glacier White", "Glacier White", "Platinum White Pearl"]);
  });
  test("no ZIP: the same rules apply nationwide", async () => {
    const r = await searchRows(pool, { make: "Honda", limit: 50, exteriorColor: "Black" }, ["CR-V"]);
    assert.equal(r.rows.length, 3); assert.ok(r.rows.every((x: any) => /black/i.test(x.ext_color)));
  });
});

// Regression: an ORDER BY with the constant 0 is read by PostgreSQL as a column position and fails. The no-colour no-ZIP path must still sort.
import { colourRegex } from "../lib/catalog-db/search";
test("no colour and no ZIP: the plain search still sorts (constant ORDER BY term is not emitted)", { skip: DB ? false : "TEST_DATABASE_URL not set" }, async () => {
  const admin = new Pool({ connectionString: DB, max: 1 }); const nm = "cq_" + Math.random().toString(36).slice(2, 10); await admin.query(`CREATE DATABASE ${nm}`);
  const u = new URL(DB!); u.pathname = "/" + nm; const p = new Pool({ connectionString: u.toString(), max: 1 });
  try {
    await p.query(SCHEMA_SQL);
    await p.query(`INSERT INTO listing (id, vin, year, make, make_key, model, model_key, condition, price, body_class, state) VALUES ('a','1HGCM82633A100001',2020,'Honda','honda','Civic','civic','u',15000,'sedan','CA'),('b','1HGCM82633A100002',2024,'Honda','honda','Civic','civic','u',25000,'sedan','CA')`);
    const r = await searchRows(p, { make: "Honda", limit: 10 }, ["Civic"]);
    assert.deepEqual(r.rows.map((x: any) => x.year), [2024, 2020]); // year.desc is the default order
    assert.equal(colourRegex(undefined), null);
  } finally { await p.end(); await admin.query(`DROP DATABASE IF EXISTS ${nm}`); await admin.end(); }
});
