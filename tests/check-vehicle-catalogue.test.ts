// check_vehicle in the database app: accurate description and VIN note (no accident/CPO history), top-level title, output shaped like the search tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogCheckVehicleDescription, CHECK_VEHICLE_DESCRIPTION_EDITS } from "../lib/catalog-output";
import { titleCaseMake } from "../lib/vin-not-listed";

const src = readFileSync("app/[transport]/route.ts", "utf8");
const i = src.indexOf('"check_vehicle",\n    {');
const block = src.slice(i, i + 9000);
test("check_vehicle is registered with a top-level title and wraps its description for the database variant", () => {
  assert.match(block, /title: "Check Vehicle",/); assert.match(block, /description: catalogCheckVehicleDescription\(/);
  assert.match(block, /annotations: \{ title: "Check Vehicle"/);
});
test("description variant: the two Auto.dev-era phrases are replaced, nothing else changes, only in database mode", () => {
  const m = /description: catalogCheckVehicleDescription\(\s*"((?:[^"\\]|\\.)*)"\)/.exec(block); assert.ok(m, "description literal must be found");
  const base = m![1].replace(/\\'/g, "'");
  for (const [from] of CHECK_VEHICLE_DESCRIPTION_EDITS) assert.ok(base.includes(from), "base must contain: " + from.slice(0, 50));
  const prev = process.env.LISTING_SOURCE;
  try {
    process.env.LISTING_SOURCE = "auto_dev"; assert.equal(catalogCheckVehicleDescription(base), base);
    process.env.LISTING_SOURCE = "catalog_db"; const v = catalogCheckVehicleDescription(base);
    let expected = base; for (const [from, to] of CHECK_VEHICLE_DESCRIPTION_EDITS) expected = expected.replace(from, () => to);
    assert.equal(v, expected); assert.ok(!/accident\/CPO history|option A/.test(v)); assert.ok(/no accident or certification history/.test(v));
  } finally { if (prev === undefined) delete process.env.LISTING_SOURCE; else process.env.LISTING_SOURCE = prev; }
});
test("VIN note and result shaping are wired for database mode", () => {
  assert.match(block, /catalogOutputActive\(\) \? " and next steps" : ", accident\/CPO history"/);
  assert.match(src, /const buyerCheck = addRecallCheckStep\(shapeBuyerCheckForCatalog\(buildBuyerCheck\(card, recall\)\), card\)/);
  assert.match(src, /const checkVehicleResults = shapeCardsForSource\(\[cardWithBuyerCheck\]\)/);
  assert.match(src, /shapeCardsForSource\(\[identityCard\]\)/); assert.match(src, /shapeCardsForSource\(\[noVinCard\]\)/);
});

test("recall lines no longer repeat the word Recalls (the labels already carry it) and makes are shown in normal case", () => {
  assert.ok(!/lines\.push\(`Recalls: \$\{/.test(src)); assert.ok(!/`Recalls: \$\{recall\.label\}`/.test(src));
  assert.equal(titleCaseMake("TOYOTA"), "Toyota"); assert.equal(titleCaseMake("LAND ROVER"), "Land Rover"); assert.equal(titleCaseMake("MERCEDES-BENZ"), "Mercedes-Benz");
  assert.equal(titleCaseMake("BMW"), "BMW"); assert.equal(titleCaseMake("GMC"), "GMC"); assert.equal(titleCaseMake("rolls-royce"), "Rolls-Royce"); assert.equal(titleCaseMake(" Ford "), "Ford");
});
