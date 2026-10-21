/**
 * Trim matching rules R1 to R8 (SYS-20261021-004). Cases come from the catalogue evidence in
 * getcarwise-docs EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md (real trim names from the feed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimMatches, trimMatchesAny, trimContainsAll, trimContainsAllAny } from "../lib/trim-match";

const E = { electrified: true };

test("R1: exact trim sets stay exact", () => {
  assert.equal(trimMatches("EX", "EX-L"), false);
  assert.equal(trimMatches("EX-L", "EX"), false);
  assert.equal(trimMatches("XLE", "XLE Premium"), false);
  assert.equal(trimMatches("XLE Premium", "XLE"), false);
  assert.equal(trimMatches("XLE", "XLE"), true);
  assert.equal(trimMatches("xle", "XLE"), true);
  assert.equal(trimMatches("AMG GLA 35", "AMG"), false);
  assert.equal(trimMatches("XLT", null), false);
});

test("R2: drivetrain brand words are ignored on both sides", () => {
  assert.equal(trimMatches("GLA 250", "GLA 250 4MATIC"), true);
  assert.equal(trimMatches("GLA 250 4MATIC", "GLA 250"), true);
  assert.equal(trimMatches("AMG GLC 53", "AMG GLC 53 4MATIC+"), true);
  assert.equal(trimMatches("330i", "330i xDrive"), true);
  assert.equal(trimMatches("40i", "xDrive40i"), true);
  assert.equal(trimMatches("xDrive40i", "40i"), true);
  assert.equal(trimMatches("xDrive40i", "xDrive28i"), false);
  assert.equal(trimMatches("30", "30 xDrive"), true);
  assert.equal(trimMatches("Premium Plus", "Premium Plus quattro"), true);
  assert.equal(trimMatches("Technology", "Technology SH-AWD"), true);
  assert.equal(trimMatches("Sport Touring Hybrid", "Sport Touring Hybrid AWD"), true); // unchanged
  assert.equal(trimMatches("GLA 250", "AMG GLA 35 4MATIC"), false);
  assert.equal(trimMatchesAny("GLA 250, AMG GLA 35", "GLA 250 4MATIC"), true);
});

test("R2: engine prefixes are not drivetrain words", () => {
  assert.equal(trimMatches("Premium Plus", "2.0T Premium Plus quattro"), false); // only the R8 tier accepts this
});

test("R3: electrification words are neutral only when an electrified type was requested", () => {
  assert.equal(trimMatches("Sport", "Sport Hybrid"), false);
  assert.equal(trimMatches("Sport Hybrid", "Sport"), false);
  assert.equal(trimMatches("Sport", "Sport Hybrid", E), true);
  assert.equal(trimMatches("Sport Hybrid", "Sport", E), true);
  assert.equal(trimMatches("Sport-L", "Sport-L Hybrid", E), true);
  assert.equal(trimMatches("XLE Hybrid", "XLE", E), true);
  assert.equal(trimMatches("SEL", "Hybrid SEL", E), true);
  assert.equal(trimMatches("SEL", "Hybrid SEL Premium", E), false); // extra real word stays significant
  assert.equal(trimMatches("Limited", "Plug-In Hybrid Limited", E), true);
  assert.equal(trimMatches("XSE", "XSE Prime", E), true);
  assert.equal(trimMatches("Limited", "Limited Hybrid"), false);
});

test("R3: a request made only of electrification words names no trim", () => {
  assert.equal(trimMatches("Hybrid", "Premium", E), true);
  assert.equal(trimMatches("Hybrid", null, E), false);
  assert.equal(trimMatches("Hybrid", "Premium"), false);
  assert.equal(trimMatches("AWD", "Premium"), false); // unchanged: a drivetrain-only word is not a trim
  assert.equal(trimMatches("", "Premium", E), false);
});

test("R8: close trim match (all requested words present, extras allowed)", () => {
  assert.equal(trimContainsAll("Premium Plus", "2.0T Premium Plus quattro"), true);
  assert.equal(trimContainsAll("Premium Plus", "2.0 TFSI Premium Plus quattro"), true);
  assert.equal(trimContainsAll("Premium Plus", "Premium"), false);
  assert.equal(trimContainsAll("XLE", "XLE Premium"), true);
  assert.equal(trimContainsAll("EX", "EX-L"), true); // known, accepted risk: used only when no exact match exists
  assert.equal(trimContainsAll("EX", "LX"), false);
  assert.equal(trimContainsAll("EX", null), false);
  assert.equal(trimContainsAll("Sport", "Sport Hybrid", E), true);
  assert.equal(trimContainsAllAny("LX, Sport", "Sport Touring"), true);
  assert.equal(trimContainsAllAny("", "Sport"), false);
});

test("runtime safety: non-string reported trim does not throw", () => {
  assert.equal(trimMatches("XLT", 1958 as unknown as string), false);
  assert.equal(trimContainsAll("1958", 1958 as unknown as string), true);
});
