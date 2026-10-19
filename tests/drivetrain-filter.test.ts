import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { classifyDriveType, wantedDriveClasses, judgeDrive, partitionByDrive, drivetrainNote } from "../lib/drivetrain-filter";
import { buildQualifierAccounting } from "../lib/qualifier-accounting";
import { buildResultsCardHtml } from "../lib/results-card";

test("decoded drivetrain texts are classified", () => {
  assert.equal(classifyDriveType("AWD/All-Wheel Drive"), "awd4");
  assert.equal(classifyDriveType("4WD/4-Wheel Drive/4x4"), "awd4");
  assert.equal(classifyDriveType("4WD"), "awd4");
  assert.equal(classifyDriveType("FWD/Front-Wheel Drive"), "fwd");
  assert.equal(classifyDriveType("RWD/Rear-Wheel Drive"), "rwd");
  assert.equal(classifyDriveType("4x2"), "two");
  for (const v of [null, undefined, "", "   ", "Not Applicable", "banana"]) assert.equal(classifyDriveType(v as string | null | undefined), "unknown");
});

test("a request is turned into the drivetrains it accepts; nothing recognised means nothing is applied", () => {
  assert.deepEqual([...wantedDriveClasses("AWD")!], ["awd4"]);
  assert.deepEqual([...wantedDriveClasses("AWD, 4WD")!], ["awd4"]);
  assert.deepEqual([...wantedDriveClasses("fwd,rwd")!].sort(), ["fwd", "rwd"]);
  assert.deepEqual([...wantedDriveClasses("2WD")!].sort(), ["fwd", "rwd"]);
  assert.equal(wantedDriveClasses("banana"), null);
  assert.equal(wantedDriveClasses(""), null);
  assert.equal(wantedDriveClasses(undefined), null);
});

test("judging a car: a different drivetrain is a mismatch, a silent decode is never a mismatch", () => {
  const awd = wantedDriveClasses("AWD")!, fwd = wantedDriveClasses("FWD")!;
  assert.equal(judgeDrive("AWD/All-Wheel Drive", awd), "match");
  assert.equal(judgeDrive("4WD", awd), "match");
  assert.equal(judgeDrive("FWD/Front-Wheel Drive", awd), "mismatch");
  assert.equal(judgeDrive("4x2", awd), "mismatch");
  assert.equal(judgeDrive(null, awd), "unknown");
  assert.equal(judgeDrive("", fwd), "unknown");
  assert.equal(judgeDrive("FWD", fwd), "match");
  assert.equal(judgeDrive("RWD", fwd), "mismatch");
  assert.equal(judgeDrive("4x2", fwd), "unknown"); // two-wheel drive does not say front or rear
});

test("partition keeps order, puts confirmed and silent cars in separate groups and counts the dropped ones", () => {
  const cars = [{ v: "a", d: "FWD" }, { v: "b", d: null }, { v: "c", d: "AWD" }, { v: "d", d: "4WD" }, { v: "e", d: "" }, { v: "f", d: "RWD" }];
  const p = partitionByDrive(cars, (x) => x.d, wantedDriveClasses("AWD")!);
  assert.deepEqual(p.confirmed.map((x) => x.v), ["c", "d"]);
  assert.deepEqual(p.unknown.map((x) => x.v), ["b", "e"]);
  assert.equal(p.excluded, 2);
});

test("the search-level line says what is and is not confirmed", () => {
  const w = wantedDriveClasses("AWD")!;
  assert.match(drivetrainNote("AWD", ["AWD", "4WD"], w, 0)!, /confirmed by the VIN decode on all 2 shown/);
  assert.match(drivetrainNote("AWD", ["AWD", null, null], w, 3)!, /confirmed on 1 of 3 shown \(listed first\).*not confirmed.*different drivetrain were left out.*Ask the dealer/);
  const none = drivetrainNote("AWD", [null, ""], w, 0)!;
  assert.match(none, /could not be confirmed on any of these: the VIN decode has no drivetrain for them/);
  assert.ok(!/filtered/.test(none));
  assert.equal(drivetrainNote("AWD", [], w, 0), null);
});

test("accounting never claims a drivetrain filter that did not run", () => {
  const rwd = buildQualifierAccounting({ drivetrain: "RWD" } as never).find((e) => e.requested === "drivetrain")!;
  assert.ok(!/filtered on/.test(rwd.applied));
  assert.match(rwd.applied, /checked against the VIN decode.*cannot show are kept after the confirmed ones and marked not confirmed/);
  const bad = buildQualifierAccounting({ drivetrain: "banana" } as never).find((e) => e.requested === "drivetrain")!;
  assert.equal(bad.tier, "disclosed_not_filtered");
  assert.match(bad.applied, /^not applied as a filter/);
  const listing = buildQualifierAccounting({ drivetrain: "AWD", vin: "1HGCM82633A004352" } as never).find((e) => e.requested === "drivetrain")!;
  assert.match(listing.applied, /^checked against this listing/);
});

test("the card says the search did not complete when the data service failed, Invalid VIN for a bad VIN, and the plain text otherwise", () => {
  const html = buildResultsCardHtml();
  const i = html.indexOf("function render(structuredContent){");
  assert.ok(i > 0);
  let depth = 0, j = i, started = false;
  for (; j < html.length; j++) { const ch = html[j]; if (ch === "{") { depth++; started = true; } else if (ch === "}") { depth--; if (started && depth === 0) break; } }
  const fn = html.slice(i, j + 1);
  const run = (sc: unknown) => { const box: { out: string } = { out: "" }; const ctx = { document: { getElementById: () => ({ set innerHTML(v: string) { box.out = v; } }) }, sc }; vm.createContext(ctx); vm.runInContext(fn + "; render(sc);", ctx); return box.out; };
  assert.match(run({ results: [], meta: { scopeNote: "nationwide", serviceError: "database unavailable" } }), /The vehicle search did not complete\. Please try again in a moment\./);
  assert.match(run({ results: [], meta: { scopeNote: "vin_invalid", serviceError: null } }), /Invalid VIN\. Check the characters and try again\./);
  assert.match(run({ results: [], meta: { scopeNote: "nationwide", serviceError: null } }), /No matching vehicles to show\./);
  assert.match(run({}), /No matching vehicles to show\./);
});
