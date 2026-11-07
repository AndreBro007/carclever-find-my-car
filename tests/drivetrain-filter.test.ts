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

test("the search-level line reports what the VIN data labels, never a mechanical confirmation", () => {
  const w = wantedDriveClasses("AWD")!;
  const w4 = wantedDriveClasses("4WD")!;
  // mixed labels: the approved wording, counts from the shown cars
  assert.equal(drivetrainNote("4WD", ["4WD", "4WD", "4WD", "4WD", "4WD", "4WD", "AWD", "AWD"], w4, 0), "VIN data labels 6 vehicles as 4WD and 2 as AWD. This search includes both. Low-range capability is not verified; confirm it with the dealer if required.");
  assert.equal(drivetrainNote("AWD", ["4WD", "4WD", "4WD", "4WD", "4WD", "4WD", "4WD", "AWD"], w, 0), "VIN data labels 7 vehicles as 4WD and 1 as AWD. This search includes both. Low-range capability is not verified; confirm it with the dealer if required.");
  // one label on all: the same caution, because matching labels do not show low-range capability
  assert.equal(drivetrainNote("AWD", ["AWD", "AWD"], w, 0), "VIN data labels all 2 vehicles as AWD. This search includes both AWD and 4WD. Low-range capability is not verified; confirm it with the dealer if required.");
  assert.equal(drivetrainNote("4WD", ["4WD"], w4, 0), "VIN data labels 1 vehicle as 4WD. This search includes both AWD and 4WD. Low-range capability is not verified; confirm it with the dealer if required.");
  // some cars with no label: counted, marked not confirmed, different-drivetrain cars left out
  const some = drivetrainNote("AWD", ["AWD", null, null], w, 3)!;
  assert.equal(some, "VIN data labels 1 of 3 vehicles as AWD. This search includes both AWD and 4WD. 2 have no drivetrain label in the VIN data and are marked not confirmed. Low-range capability is not verified; confirm it with the dealer if required. Cars the VIN decode shows with a different drivetrain were left out.");
  // none labelled
  const none = drivetrainNote("AWD", [null, ""], w, 0)!;
  assert.equal(none, "VIN data gives no drivetrain label for any of the 2 vehicles shown; they are marked not confirmed. This search includes both AWD and 4WD. Low-range capability is not verified; confirm it with the dealer if required.");
  assert.ok(!/VIN decode has no drivetrain/.test(none)); // no claim about why
  assert.ok(!/filtered/.test(none));
  assert.equal(drivetrainNote("AWD", [], w, 0), null);
  // FWD or RWD requests: the same principle, no low-range sentence
  const wf = wantedDriveClasses("FWD")!;
  assert.equal(drivetrainNote("FWD", ["FWD", "FWD", "FWD"], wf, 0), "VIN data labels all 3 vehicles as FWD.");
  assert.equal(drivetrainNote("FWD,RWD", ["FWD", "RWD", null], wantedDriveClasses("FWD,RWD")!, 0), "VIN data labels 1 vehicle as FWD and 1 as RWD. 1 has no drivetrain label in the VIN data and is marked not confirmed. Ask the dealer to confirm.");
  assert.ok(!/Low-range/.test(drivetrainNote("FWD", ["FWD"], wf, 0)!));
  // the old claim is retired everywhere
  for (const note of [drivetrainNote("AWD", ["AWD", "AWD"], w, 0), drivetrainNote("4WD", ["4WD", "AWD"], w4, 0), drivetrainNote("AWD", [null], w, 0)]) assert.ok(!/confirmed by the VIN decode/.test(note!));
});

test("the note's counts always equal the cars shown and it never names a label that is not on a shown car", () => {
  const w = wantedDriveClasses("4WD")!;
  for (const shown of [["4WD", "AWD", "4WD"], ["AWD", "AWD", "AWD", "AWD"], ["4x4", "All-Wheel Drive", null], ["AWD/All-Wheel Drive", "4WD/4-Wheel Drive/4x4"]]) {
    const note = drivetrainNote("4WD", shown, w, 0)!;
    const four = shown.filter((s) => /4WD|4X4|4-WHEEL/i.test(String(s ?? "")) && !/AWD|ALL[- ]?WHEEL/i.test(String(s ?? ""))).length;
    const awd = shown.filter((s) => /AWD|ALL[- ]?WHEEL/i.test(String(s ?? ""))).length;
    if (four === 0) assert.ok(!/as 4WD/.test(note), note);
    if (awd === 0) assert.ok(!/as AWD/.test(note), note);
    if (four > 0 && awd > 0) assert.ok(note.includes(`${four} vehicle${four === 1 ? "" : "s"} as 4WD and ${awd} as AWD`), note);
  }
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

import { finalizeByDrive } from "../lib/drivetrain-filter";
test("final check: a car now known to have the opposite drivetrain is removed, confirmed cars go first, silent cars follow in order", () => {
  const w = wantedDriveClasses("AWD")!;
  const cars = [{ v: "silent-high-score", d: null }, { v: "fwd-revealed-late", d: "FWD" }, { v: "confirmed-low-score", d: "AWD" }, { v: "silent-2", d: "" }, { v: "confirmed-2", d: "4WD" }];
  const f = finalizeByDrive(cars, (x) => x.d, w);
  assert.deepEqual(f.cards.map((x) => x.v), ["confirmed-low-score", "confirmed-2", "silent-high-score", "silent-2"]);
  assert.equal(f.removed, 1);
  assert.equal(f.allMismatch, false);
});
test("final check: if every car is a known mismatch the list is not emptied, the caller is told", () => {
  const w = wantedDriveClasses("AWD")!;
  const f = finalizeByDrive([{ d: "FWD" }, { d: "RWD" }], (x) => x.d, w);
  assert.equal(f.cards.length, 2); assert.equal(f.removed, 0); assert.equal(f.allMismatch, true);
});
