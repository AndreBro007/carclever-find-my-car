// Database app: one Edmunds exit at every dead end (closing line, zero results) and nearest-dealer-first among equal match scores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closingExitLine, zeroResultsExitLine, sortByScoreThenDistance, modelLevelLink } from "../lib/dead-end-links";

const dec = (u: string) => decodeURIComponent(u);
const card = (make: string, model: string, inv = "used", vin = "V1", score = 99) => ({ identity: { make, model, vin }, condition: { inventoryType: inv }, ranking: { matchScore: score } });

test("closing line: model-level similar-vehicles link for the best match, used by default and new when the top match is new", () => {
  const u = closingExitLine([card("Toyota", "RAV4")]);
  assert.match(u, /^\n\nNot seeing the right one\? More Toyota RAV4 on Edmunds \(this page is not filtered to your area or price\): https:\/\/edmunds\.sjv\.io\//);
  assert.ok(dec(u).includes("/used-toyota-rav4/")); assert.ok(!dec(u).includes("used-toyota-rav4-")); // model level, not one trim
  assert.ok(dec(closingExitLine([card("Toyota", "RAV4", "new")])).includes("/new-toyota-rav4-for-sale/"));
  assert.equal((u.match(/https:\/\//g) ?? []).length, 1);
});
test("closing line: nothing in other apps, with no cars, or without a make and model", () => {
  assert.equal(closingExitLine([]), "");
  assert.equal(closingExitLine([{ identity: {}, ranking: { matchScore: 1 } }]), "");
  assert.ok(closingExitLine([{ identity: { vin: "x" } }, card("Honda", "CR-V")]).includes("Honda CR-V")); // skips a card without make and model
});
test("zero results: the same exit when one make and one model are named, otherwise nothing", () => {
  const t = zeroResultsExitLine("Toyota", "Supra", undefined);
  assert.match(t, /^\n\nSee all used Toyota Supra on Edmunds \(this page is not filtered to your area, price\): https:\/\/edmunds\.sjv\.io\//); assert.ok(dec(t).includes("/used-toyota-supra/"));
  assert.ok(dec(zeroResultsExitLine("Toyota", "Supra", false)).includes("/new-toyota-supra-for-sale/"));
  assert.equal(zeroResultsExitLine("Toyota", "Supra, RAV4", undefined), ""); assert.equal(zeroResultsExitLine(undefined, "Supra", undefined), "");
  assert.equal(zeroResultsExitLine("Toyota", "", undefined), "");
  assert.ok(modelLevelLink("Land Rover", "Range Rover Sport", false)!.length > 20);
});
test("ordering: higher match score first; among equal scores the nearest dealer first; unknown distance last", () => {
  const cars = [card("A", "a", "used", "far", 99), card("B", "b", "used", "near", 99), card("C", "c", "used", "top-but-far", 100), card("D", "d", "used", "unknown", 99), card("E", "e", "used", "mid", 99)];
  const miles = new Map([["far", 900], ["near", 5], ["top-but-far", 1200], ["mid", 40]]);
  assert.deepEqual(sortByScoreThenDistance(cars, miles).map((c) => c.identity.vin), ["top-but-far", "near", "mid", "far", "unknown"]);
  assert.deepEqual(cars.map((c) => c.identity.vin), ["far", "near", "top-but-far", "unknown", "mid"]); // input untouched
  assert.deepEqual(sortByScoreThenDistance([], new Map()), []);
});
