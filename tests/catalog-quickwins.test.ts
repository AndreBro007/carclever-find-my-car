// Quick wins for the database app: colour regex (marketing colour names) and model naming aliases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { colourRegex } from "../lib/catalog-db/search";
import { modelsAgree } from "../lib/nhtsa-specs";

const matches = (spec: string, name: string): boolean => { const r = colourRegex(spec); return !!r && new RegExp(r.replace(/\\y/g, "\\b"), "i").test(name); };

test("colour regex: base colour words match the feed's marketing names as whole words", () => {
  assert.ok(matches("White", "Glacier White")); assert.ok(matches("Black", "Crystal Black Pearl")); assert.ok(matches("Gray", "Brooklyn Grey Metallic"));
  assert.ok(matches("Gray", "Magnetic Gray")); assert.ok(matches("Gray", "Charcoal")); assert.ok(matches("Silver", "Silver Sky Metallic"));
  assert.ok(matches("Blue, Green", "Cypress Green")); assert.ok(matches("Beige", "Sand"));
  assert.ok(!matches("Black", "Glacier White")); assert.ok(!matches("White", "Crystal Black Pearl"));
  assert.ok(!matches("Tan", "Titanium")); assert.ok(!matches("Red", "Tangerine Orange"));
  assert.equal(colourRegex(undefined), null); assert.equal(colourRegex(" , "), null);
});
test("model aliases: the 15 naming differences seen on real listings agree; real differences still conflict", () => {
  assert.ok(modelsAgree("Cooper", "Hardtop", "MINI")); assert.ok(modelsAgree("Cooper", "Clubman", "MINI")); assert.ok(modelsAgree("Cooper", "Countryman", "MINI"));
  assert.ok(modelsAgree("3 Series", "330i", "BMW")); assert.ok(modelsAgree("3 Series", "330e", "BMW")); assert.ok(modelsAgree("5 Series", "M550i", "BMW"));
  assert.ok(modelsAgree("3 Series", "M340i", "BMW")); assert.ok(modelsAgree("C-Class", "C300", "Mercedes-Benz")); assert.ok(modelsAgree("GLC", "GLC300", "Mercedes-Benz"));
  assert.ok(modelsAgree("F-150", "F150")); assert.ok(modelsAgree("RAV4", "RAV4")); assert.ok(modelsAgree("Silverado 1500", "Silverado")); assert.ok(modelsAgree("", "Anything")); assert.ok(modelsAgree("X", ""));
  assert.ok(!modelsAgree("Camry", "Corolla", "Toyota")); assert.ok(!modelsAgree("Accord", "Civic", "Honda")); assert.ok(!modelsAgree("3 Series", "X5", "BMW"));
  assert.ok(!modelsAgree("Cooper", "Hardtop", "Honda")); assert.ok(!modelsAgree("C-Class", "E350", "Mercedes-Benz"));
});
