/** The "Searched:" line (SYS-20261021-036, proposal G). Pure; no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appliedFiltersLine } from "../lib/applied-filters";

test("André's request with condition new: new cars, hybrid required, price strict, radius and ZIP, models, ranking; no correction hint", () => {
  const l = appliedFiltersLine({ used: false, bodyType: "SUV", model: "Highlander, Grand Highlander, RAV4", electrificationTypes: ["hybrid"], electrificationRequirement: "required", priceMax: 70000, priceFlexibility: "strict", zip: "75201", radiusMiles: 100, priorityAxis: "best_for_budget" });
  assert.equal(l, "Searched: new cars; models Highlander, Grand Highlander, RAV4; body style SUV; hybrid required; up to $70,000 (strict); within 100 miles of ZIP 75201; ranked best for budget.");
  assert.ok(!/search again/.test(l));
});

test("condition either says so and tells the AI how to correct it", () => {
  const l = appliedFiltersLine({ model: "RAV4", zip: "75201" });
  assert.match(l, /^Searched: new and used \(condition: either\); models RAV4; within 50 miles of ZIP 75201\./);
  assert.match(l, / If the buyer asked for new or used only, search again with condition set to new or used\.$/);
});

test("used cars, the default 50-mile radius is named, a given radius replaces it", () => {
  assert.match(appliedFiltersLine({ used: true, zip: "90210" }), /^Searched: used cars; within 50 miles of ZIP 90210\.$/);
  assert.match(appliedFiltersLine({ used: true, zip: "90210", radiusMiles: 25 }), /within 25 miles of ZIP 90210/);
});

test("location: state, nationwide, and a ZIP that could not be used", () => {
  assert.match(appliedFiltersLine({ used: false, state: "tx" }), /; state TX\.$/);
  assert.match(appliedFiltersLine({ used: false }), /; nationwide\.$/);
  assert.match(appliedFiltersLine({ used: false, zip: "00000", zipUsable: false }), /; nationwide\.$/);
});

test("electrification: several types, required and preferred", () => {
  assert.match(appliedFiltersLine({ used: false, electrificationTypes: ["hybrid", "plug_in_hybrid"], electrificationRequirement: "required" }), /hybrid or plug-in hybrid required/);
  assert.match(appliedFiltersLine({ used: false, electrificationTypes: ["electric"], electrificationRequirement: "preferred" }), /electric preferred/);
});

test("price, years, mileage, drivetrain, trim, colour, doors, seats and the ranking words", () => {
  const l = appliedFiltersLine({ used: true, make: "Honda", model: "CR-V", priceMin: 20000, priceMax: 30000, priceFlexibility: "flexible", yearMin: 2020, yearMax: 2023, mileageMax: 40000, drivetrain: "AWD", trimRequired: "EX-L", exteriorColor: "white", doors: 4, seatsMinPreference: 5, priorityAxis: "lowest_mileage", zip: "90210" });
  for (const p of ["Honda, models CR-V", "$20,000 to $30,000 (flexible)", "model years 2020 to 2023", "up to 40,000 miles", "drivetrain AWD", "trim EX-L (required)", "exterior white", "4 doors", "at least 5 seats (preferred)", "ranked lowest mileage"]) assert.ok(l.includes(p), p);
  assert.match(appliedFiltersLine({ used: true, yearMin: 2022 }), /model year 2022 or newer/);
  assert.match(appliedFiltersLine({ used: true, yearMax: 2018 }), /model year 2018 or older/);
  assert.match(appliedFiltersLine({ used: true, priceMin: 15000 }), /from \$15,000/);
  assert.match(appliedFiltersLine({ used: true, trimPreference: ["EX", "EX-L"] }), /trim EX, EX-L \(preferred\)/);
});

test("only set fields appear; blanks and odd types never print undefined or NaN", () => {
  const l = appliedFiltersLine({ used: false, make: "  ", model: "", bodyType: undefined, trimRequired: "", zip: "75201", radiusMiles: undefined } as never);
  assert.equal(l, "Searched: new cars; within 50 miles of ZIP 75201.");
  for (const bad of ["undefined", "NaN", "[object"]) assert.ok(!appliedFiltersLine({ used: undefined, model: ["A", "B"] as never, trimRequired: ["X"] as never }).includes(bad));
});
