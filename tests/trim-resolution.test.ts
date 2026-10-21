/**
 * Trim resolution (SYS-20261021-004, R1 and R8): the route lists the trims the database really holds, picks the ones that satisfy a required trim,
 * and searches for exactly those strings. Pure tests always run; the database tests need TEST_DATABASE_URL.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { resolveRequiredTrims } from "../lib/trim-resolution";
import { SCHEMA_SQL } from "../lib/catalog-db/schema";
import { searchCatalogDbListings, catalogDbTrimFacets, setCatalogDbPoolForTests } from "../lib/catalog-db-source";

const t = (...v: string[]) => v.map((value) => ({ value }));

test("exact tier: R1 and R2 decide, not substring luck", () => {
  assert.deepEqual(resolveRequiredTrims("EX", t("EX", "EX-L", "Touring")), { tier: "exact", trims: ["EX"] });
  assert.deepEqual(resolveRequiredTrims("GLA 250", t("GLA 250", "GLA 250 4MATIC", "AMG GLA 35")), { tier: "exact", trims: ["GLA 250", "GLA 250 4MATIC"] });
  assert.deepEqual(resolveRequiredTrims("XLE", t("XLE Premium", "LE")).tier, "close"); // no plain XLE exists
  assert.deepEqual(resolveRequiredTrims("xLE", t("XLE", "XLE Premium")), { tier: "exact", trims: ["XLE"] });
  assert.deepEqual(resolveRequiredTrims("AMG GLA 35, AMG GLA 45", t("AMG GLA 35", "AMG GLA 45", "GLA 250")), { tier: "exact", trims: ["AMG GLA 35", "AMG GLA 45"] });
});

test("close tier (R8): only when nothing matches exactly, and it lists what it found", () => {
  assert.deepEqual(resolveRequiredTrims("Premium Plus", t("2.0T Premium Plus quattro", "Premium")), { tier: "close", trims: ["2.0T Premium Plus quattro"] });
  assert.deepEqual(resolveRequiredTrims("EX", t("EX-L", "LX")), { tier: "close", trims: ["EX-L"] }); // the accepted risk, labelled in the reply
  assert.deepEqual(resolveRequiredTrims("Premium Plus", t("Premium Plus", "2.0T Premium Plus")), { tier: "exact", trims: ["Premium Plus"] });
});

test("none: nothing matches, empty or missing input", () => {
  assert.deepEqual(resolveRequiredTrims("Raptor", t("XLT", "Lariat")), { tier: "none", trims: [] });
  assert.deepEqual(resolveRequiredTrims("", t("XLT")), { tier: "none", trims: [] });
  assert.deepEqual(resolveRequiredTrims(undefined, t("XLT")), { tier: "none", trims: [] });
  assert.deepEqual(resolveRequiredTrims("XLT", []), { tier: "none", trims: [] });
});

test("electrified requests make hybrid words neutral (R3)", () => {
  assert.deepEqual(resolveRequiredTrims("Sport-L", t("Sport-L Hybrid", "Sport", "Touring Hybrid"), { electrified: true }), { tier: "exact", trims: ["Sport-L Hybrid"] });
  assert.deepEqual(resolveRequiredTrims("Sport", t("Sport Hybrid", "Sport")).trims, ["Sport"]);
});

const DB = process.env.TEST_DATABASE_URL;
describe("trim resolution against a real database", { skip: DB ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: DB, max: 2 });
    await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
    await pool.query(SCHEMA_SQL);
    setCatalogDbPoolForTests(pool);
    let batch = 0;
    const ins = (n: number, year: number, make: string, model: string, trim: string | null, price0: number) =>
      pool.query(
        `INSERT INTO listing (id, vin, year, make, make_key, model, model_key, trim, condition, price, odometer, body_class, state, zip)
         SELECT $1 || g, lpad(($1 || g)::text, 17, 'X'), $2, $3, lower(regexp_replace($3, '[^A-Za-z0-9]', '', 'g')), $4,
                lower(regexp_replace($4, '[^A-Za-z0-9]', '', 'g')), $5, 'u', $6 + g, 30000, 'suv', 'CA', '90210'
         FROM generate_series(1, $7::int) g`,
        [`b${++batch}-`, year, make, model, trim, price0, n],
      );
    await ins(400, 2022, "Toyota", "RAV4", "XLE", 20000); // newer and cheaper: fills the first 300 rows
    await ins(3, 2021, "Toyota", "RAV4", "TRD Off-Road", 40000); // rare trim, older, dearer: outside the first 300 rows
    await ins(2, 2021, "Toyota", "RAV4", null, 25000);
    await ins(3, 2022, "Mercedes-Benz", "GLA-Class", "GLA 250 4MATIC", 30000);
    await ins(2, 2022, "Mercedes-Benz", "GLA-Class", "AMG GLA 35", 45000);
    await ins(2, 2022, "Audi", "A4", "2.0T Premium Plus quattro", 35000);
    for (let i = 1; i <= 15; i++) await ins(1, 2022, "Ford", "Fusion", `Trim${String(i).padStart(2, "0")}`, 10000 + i);
  });
  after(async () => { setCatalogDbPoolForTests(null); await pool.end(); });

  test("without the filter a rare trim falls outside the 300 candidate rows (the weakness this fixes)", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4" });
    assert.equal(r.data.length, 300);
    assert.equal(r.data.filter((l) => l.vehicle?.trim === "TRD Off-Road").length, 0);
  });

  test("with trimIn the database returns that trim, plus cars with no trim for the later checks", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4", trimIn: ["TRD Off-Road"] });
    assert.equal(r.data.filter((l) => l.vehicle?.trim === "TRD Off-Road").length, 3);
    assert.equal(r.data.filter((l) => !l.vehicle?.trim).length, 2);
    assert.equal(r.data.filter((l) => l.vehicle?.trim === "XLE").length, 0);
    assert.equal(r.data.length, 5);
  });

  test("the trim list ignores trimIn, ignores price, and returns every trim when asked", async () => {
    const q = { make: "Ford", model: "Fusion", priceMax: 5000, trimIn: ["Trim01"] };
    assert.equal((await catalogDbTrimFacets(q)).length, 12); // the no-match list stays at 12
    assert.equal((await catalogDbTrimFacets(q, 2000)).length, 15); // resolution needs them all
  });

  test("resolution on real trim lists: R2 exact, R8 close", async () => {
    const gla = await catalogDbTrimFacets({ make: "Mercedes-Benz", model: "GLA-Class" }, 2000);
    assert.deepEqual(resolveRequiredTrims("GLA 250", gla), { tier: "exact", trims: ["GLA 250 4MATIC"] });
    const audi = await catalogDbTrimFacets({ make: "Audi", model: "A4" }, 2000);
    assert.deepEqual(resolveRequiredTrims("Premium Plus", audi), { tier: "close", trims: ["2.0T Premium Plus quattro"] });
    const rav = await catalogDbTrimFacets({ make: "Toyota", model: "RAV4" }, 2000);
    assert.deepEqual(resolveRequiredTrims("TRD Off-Road", rav).trims, ["TRD Off-Road"]);
  });
});
