/**
 * Electrified wording and models (SYS-20261021-004, R3 and R4). Names come from the real feed evidence
 * (getcarwise-docs EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md). Pure tests always run; the database tests need TEST_DATABASE_URL.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { electrifiedModelsFor, electrificationTypesOf, trimWordingRegex, stripElectrificationWords } from "../lib/electrified-models";
import { SCHEMA_SQL } from "../lib/catalog-db/schema";
import { searchCatalogDbListings, setCatalogDbPoolForTests } from "../lib/catalog-db-source";

const FEED = ["RAV4", "RAV4 Hybrid", "RAV4 Plug-In Hybrid", "RAV4 Prime", "Camry", "Camry Hybrid", "Accord", "Accord Hybrid", "Accord Crosstour", "Prius", "Prius Prime",
  "Prius Plug-In Hybrid", "Blazer", "Blazer EV", "Equinox", "Equinox EV", "CR-V", "CR-V Hybrid", "HUMMER EV", "Outlander", "Outlander PHEV", "GLC-Class", "GLC Electric"];

test("types from wording: plug-in wins over hybrid, hybrid alone is hybrid, EV and Electric are electric", () => {
  assert.deepEqual([...electrificationTypesOf("RAV4 Hybrid")], ["hybrid"]);
  assert.deepEqual([...electrificationTypesOf("RAV4 Plug-In Hybrid")], ["plug_in_hybrid"]);
  assert.deepEqual([...electrificationTypesOf("RAV4 Prime")], ["plug_in_hybrid"]);
  assert.deepEqual([...electrificationTypesOf("Outlander PHEV")], ["plug_in_hybrid"]);
  assert.deepEqual([...electrificationTypesOf("Blazer EV")], ["electric"]);
  assert.deepEqual([...electrificationTypesOf("GLC Electric")], ["electric"]);
  assert.equal(electrificationTypesOf("RAV4").size, 0);
  assert.equal(electrificationTypesOf("EV6").size, 0); // a model code, not the word
});

test("R4: a base model finds its electrified variants of the requested type only", () => {
  assert.deepEqual(electrifiedModelsFor(["RAV4"], FEED, ["hybrid"]), { variants: ["RAV4 Hybrid"], worded: ["RAV4 Hybrid"] });
  assert.deepEqual(electrifiedModelsFor(["RAV4"], FEED, ["plug_in_hybrid"]).variants.sort(), ["RAV4 Plug-In Hybrid", "RAV4 Prime"]);
  assert.deepEqual(electrifiedModelsFor(["RAV4"], FEED, ["hybrid", "plug_in_hybrid"]).variants.sort(), ["RAV4 Hybrid", "RAV4 Plug-In Hybrid", "RAV4 Prime"]);
  assert.deepEqual(electrifiedModelsFor(["Accord"], FEED, ["hybrid"]).variants, ["Accord Hybrid"]); // not Accord Crosstour
  assert.deepEqual(electrifiedModelsFor(["Blazer"], FEED, ["electric"]).variants, ["Blazer EV"]);
  assert.deepEqual(electrifiedModelsFor(["GLC-Class"], FEED, ["electric"]).variants, ["GLC Electric"]);
  assert.deepEqual(electrifiedModelsFor(["CR-V"], FEED, ["hybrid"]).variants, ["CR-V Hybrid"]);
  assert.deepEqual(electrifiedModelsFor(["Camry"], FEED, ["electric"]).variants, []);
});

test("R4: spelling differences across years are one family (Prime and Plug-In Hybrid)", () => {
  const r = electrifiedModelsFor(["RAV4 Prime"], FEED, ["plug_in_hybrid"]);
  assert.deepEqual(r.variants, ["RAV4 Plug-In Hybrid"]);
  assert.deepEqual(r.worded.sort(), ["RAV4 Plug-In Hybrid", "RAV4 Prime"]);
  assert.deepEqual(electrifiedModelsFor(["Prius"], FEED, ["plug_in_hybrid"]).variants.sort(), ["Prius Plug-In Hybrid", "Prius Prime"]);
});

test("R4: a variant the AI named itself is worded but not repeated as an extra", () => {
  assert.deepEqual(electrifiedModelsFor(["RAV4 Hybrid"], FEED, ["hybrid"]), { variants: [], worded: ["RAV4 Hybrid"] });
});

test("R4: a broad search (no model) lists every model name with matching wording as worded", () => {
  const r = electrifiedModelsFor([], FEED, ["electric"]);
  assert.deepEqual(r.variants, []);
  assert.deepEqual(r.worded.sort(), ["Blazer EV", "Equinox EV", "GLC Electric", "HUMMER EV"].sort());
});

test("no types, no work; the trim wording regex follows the types", () => {
  assert.deepEqual(electrifiedModelsFor(["RAV4"], FEED, []), { variants: [], worded: [] });
  assert.equal(trimWordingRegex([]), "");
  assert.equal(trimWordingRegex(["hybrid"]), "\\y(hybrid)\\y");
  assert.match(trimWordingRegex(["plug_in_hybrid", "electric"]), /plug\[\^a-z0-9\]\*in\|phev\|prime\|electric\|ev/);
  assert.equal(stripElectrificationWords("Sport-L Hybrid").trim(), "Sport-L");
});

const DB = process.env.TEST_DATABASE_URL;
describe("electrified search in a real database", { skip: DB ? false : "TEST_DATABASE_URL not set" }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: DB, max: 2 });
    await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
    await pool.query(SCHEMA_SQL);
    setCatalogDbPoolForTests(pool);
    let batch = 0;
    const ins = (n: number, year: number, make: string, model: string, trim: string | null, price0: number) =>
      pool.query(
        `INSERT INTO listing (id, vin, year, make, make_key, model, model_key, trim, condition, price, odometer, body_class, state, zip, lat, lon)
         SELECT $1 || g, lpad(($1 || g)::text, 17, 'X'), $2, $3, lower(regexp_replace($3, '[^A-Za-z0-9]', '', 'g')), $4,
                lower(regexp_replace($4, '[^A-Za-z0-9]', '', 'g')), $5, 'u', $6 + g, 30000, 'suv', 'CA', '90210', 34.09, -118.41
         FROM generate_series(1, $7::int) g`,
        [`b${++batch}-`, year, make, model, trim, price0, n],
      );
    await ins(400, 2023, "Toyota", "RAV4", "XLE", 20000); // plain RAV4: newer and cheaper, would fill the whole 300-row pool
    await ins(3, 2020, "Toyota", "RAV4 Hybrid", "XLE", 33000);
    await ins(2, 2021, "Toyota", "RAV4 Prime", "SE", 41000);
    await ins(3, 2020, "Toyota", "RAV4", "LE Hybrid", 32000); // base model, wording in the trim
    await ins(2, 2020, "Toyota", "Camry Hybrid", "LE", 25000);
  });
  after(async () => { setCatalogDbPoolForTests(null); await pool.end(); });

  const ELEC = { extraModels: ["RAV4 Hybrid"], wordedModels: ["RAV4 Hybrid"], trimWording: trimWordingRegex(["hybrid"]) };

  test("without the electrified field the plain RAV4 fills the pool and the variants never show (today's weakness)", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4" });
    assert.equal(r.data.length, 300);
    assert.ok(r.data.every((l) => l.vehicle?.model === "RAV4" && l.vehicle?.trim === "XLE"));
  });

  test("with it: the variant model is searched too, and worded cars (model or trim) come first, then the rest", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4", electrified: ELEC });
    const first6 = r.data.slice(0, 6).map((l) => `${l.vehicle?.model}|${l.vehicle?.trim}`).sort();
    assert.deepEqual(first6, ["RAV4 Hybrid|XLE", "RAV4 Hybrid|XLE", "RAV4 Hybrid|XLE", "RAV4|LE Hybrid", "RAV4|LE Hybrid", "RAV4|LE Hybrid"]);
    assert.equal(r.data.length, 300);
    assert.ok(!r.data.some((l) => l.vehicle?.model === "RAV4 Prime"), "a plug-in variant is not searched for a hybrid request");
    assert.ok(!r.data.some((l) => l.vehicle?.model === "Camry Hybrid"), "other models are not searched");
  });

  test("wording only ranks: the unworded cars are still there for the NHTSA check", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4", electrified: ELEC });
    assert.ok(r.data.slice(6).every((l) => l.vehicle?.trim === "XLE" && l.vehicle?.model === "RAV4"));
  });

  test("it also works with a ZIP (the local search)", async () => {
    const r = await searchCatalogDbListings({ make: "Toyota", model: "RAV4", zip: "90210", radius: 50, electrified: ELEC });
    assert.equal(r.localApplied, true);
    assert.equal(r.data.slice(0, 6).filter((l) => /Hybrid/.test(`${l.vehicle?.model} ${l.vehicle?.trim}`)).length, 6);
  });
});
