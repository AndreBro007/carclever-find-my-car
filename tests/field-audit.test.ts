/**
 * The published input of find_matching_vehicle against our own database (SYS-20261021-047). Every published field has a recorded source; a new field fails this test until it is
 * audited against the database (lib/catalog-db/schema.ts, the Edmunds feed) and added here. The body-style words the tool names are the classes the database stores.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindMatchingVehicleInputCatalog } from "../lib/find-matching-vehicle-input";
import { bodyClassesFor } from "../lib/catalog-db/normalize";

// source of each published field: the database column or feed field, NHTSA, not available (reported as unconfirmed), or behaviour (not data)
const AUDITED: Record<string, string> = {
  vin: "listing.vin", make: "listing.make_key", model: "listing.model_key (and electrified variants)", trimRequired: "listing.trim", trimPreference: "listing.trim (ranking)",
  condition: "listing.condition (n or u; no filter when left out)", bodyType: "listing.body_class", mileageMax: "listing.odometer", doors: "listing.doors",
  priceMin: "listing.price", priceMax: "listing.price", yearMin: "listing.year", yearMax: "listing.year",
  zip: "dealer coordinates", radiusMiles: "dealer coordinates", state: "listing.state (the dealer's)",
  exteriorColor: "listing.ext_color", interiorColor: "listing.int_color",
  drivetrain: "NHTSA decode", seatsMinPreference: "NHTSA decode", electrificationTypes: "NHTSA decode and model or trim wording", electrificationRequirement: "NHTSA decode",
  cpo: "not in the feed: reported as unconfirmed", noAccidents: "not in the feed: reported as unconfirmed", oneOwner: "not in the feed: reported as unconfirmed",
  priorityAxis: "behaviour: ranking", vehicleNeeds: "behaviour: the AI's reading of a need",
};

test("every published field has a recorded source in the database, NHTSA, or behaviour", () => {
  assert.deepEqual(Object.keys(FindMatchingVehicleInputCatalog.shape).sort(), Object.keys(AUDITED).sort());
});

test("the body styles the tool names are exactly the classes the database stores (and each is understood by the search)", () => {
  const named = ["SUV", "Sedan", "Truck", "Hatchback", "Coupe", "Convertible", "Wagon", "Minivan", "Van"];
  const text = String(FindMatchingVehicleInputCatalog.shape.bodyType.description);
  for (const w of named) { assert.ok(text.includes(w), w); assert.ok(bodyClassesFor(w), `${w} maps to a stored class`); }
  const stored = new Set(named.flatMap((w) => bodyClassesFor(w) ?? []));
  for (const c of ["suv", "sedan", "truck", "hatchback", "coupe", "convertible", "wagon", "minivan", "van"]) assert.ok(stored.has(c as never), `class ${c} is reachable`);
  assert.ok(!/Crossover/.test(text.replace("A crossover is an SUV.", "")), "crossover is not a class of its own");
  assert.deepEqual(bodyClassesFor("Crossover"), ["suv"]);
});

test("the condition field uses the database's own two states and no third", () => {
  assert.deepEqual(FindMatchingVehicleInputCatalog.shape.condition.unwrap().options, ["new", "used"]);
});
