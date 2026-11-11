// Run: npx tsx --test tests/vehicle-assessment-wording.test.ts
// André's approved wording (11 Nov 2026, lines L1 to L10): every "still unknown", not-listed and link line points the buyer to the dealer, a history report and
// Edmunds similar listings, and no line tells the buyer the data is "not live stock". The data shape (version 1) and the existing questions are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildAssessment, renderAssessment, type CatalogueFacts, type AssessmentStatus } from "../lib/vehicle-assessment";

const VIN = "19XFC2F51GE044879";
const FACTS: CatalogueFacts = { price: 15590, mileage: 111987, dealer: "Carvana - Oklahoma City", city: "Oklahoma City", state: "OK", zip: "73102", used: true, rowChangedAt: "2026-11-07" };
const mk = (status: AssessmentStatus, facts: CatalogueFacts | null = null, extra: object = {}) => buildAssessment({ vin: VIN, status, title: "2016 Honda Civic LX", decodeConfirmed: true, facts, seller: null, ...extra } as never);
const listed = mk("listed", FACTS), notListed = mk("not_listed"), unavailable = mk("catalogue_unavailable"), identityOnly = mk("identity_only");

test("L1 and L7: availability is confirmed with the dealer; a car not in our listings points to Edmunds similar listings and the dealer", () => {
  assert.ok(listed.unknowns.includes("Whether it's still available: confirm with the dealer before you visit."));
  assert.ok(notListed.unknowns.includes("Whether it's for sale elsewhere: check similar listings on Edmunds and ask the dealer."));
});

test("L2 and L3: history, price and recall repair are asked of the dealer, with a history report; the listed car is also pointed to the Edmunds listing", () => {
  assert.ok(listed.unknowns.includes("Vehicle history, accidents, ownership and condition: check the Edmunds listing and ask the dealer for a full vehicle history report. Total price with fees and whether any recall was repaired: ask the dealer to confirm in writing."));
  const l3 = "Vehicle history and condition: ask the dealer for a full history report, and check the listing for one. Total price with fees and recall repairs: confirm with the dealer in writing.";
  for (const a of [notListed, unavailable, identityOnly]) assert.ok(a.unknowns.includes(l3));
  assert.ok(!listed.unknowns.concat(notListed.unknowns).some((u) => /Edmunds listing has the history|includes a history report/i.test(u)), "no promise that an Edmunds listing carries a history report");
});

test("L4: the listing note says when it was updated and to check with the dealer; the other notes have no 'not live stock' either", () => {
  assert.equal(listed.catalogue.snapshotNote, "Our listing was last updated 2026-11-07. Check with the dealer that it's still available.");
  assert.equal(mk("listed", { ...FACTS, rowChangedAt: null } as never).catalogue.snapshotNote, "Check with the dealer that it's still available.");
  assert.equal(notListed.catalogue.snapshotNote, "Not found in our listings, so there is no listing to compare. Check similar listings on Edmunds, and confirm availability with the dealer.");
});

test("L8 and L9: the link notes (text version) point to the dealer and to similar listings; L10: similar listings may be at other dealers", () => {
  assert.equal(listed.continuation.note, "Check availability opens this car on Edmunds. The dealer can confirm it's still for sale.");
  assert.equal(notListed.continuation.note, "We don't have a link to this exact car. View similar listings shows other cars of this make and model on Edmunds (not this exact car), useful for comparing while you confirm with the dealer.");
  assert.equal(listed.alternatives.note, "Similar listings are different cars and may be at different dealers.");
  assert.match(renderAssessment(listed), /Check with the dealer that it's still available\./);
});

test("no user-facing line says the data is 'not live stock' or 'a periodic feed snapshot' any more", () => {
  for (const a of [listed, notListed, unavailable, identityOnly]) {
    const text = JSON.stringify([a.unknowns, a.catalogue.snapshotNote, a.continuation.note, a.alternatives.note, a.dealerQuestions]) + renderAssessment(a);
    assert.ok(!/not live stock|periodic feed snapshot/i.test(text), a.status);
  }
});

test("dealer questions: availability, price in writing, odometer, history report and service records, recalls, inspection, test drive; the data shape is still version 1", () => {
  const q = listed.dealerQuestions;
  assert.equal(q[3], "Can you send a full vehicle history report (accidents, owners, title) and any service records?");
  assert.ok(q.includes("Can I book a test drive, and can you hold the car until then?"));
  assert.equal(q[q.length - 1], "Can I book a test drive, and can you hold the car until then?");
  assert.equal(q.length, 7); assert.equal(listed.version, 1);
  assert.ok(q[1].includes("in writing"), "the price question already asks for the price in writing");
  const withStoreConflict = buildAssessment({ vin: VIN, status: "listed", title: "x", decodeConfirmed: true, facts: FACTS, seller: { dealer: "Other Dealer" } } as never);
  assert.equal(withStoreConflict.dealerQuestions.length, 8, "all eight fit (the cap is eight)");
});

test("the module file matches its manifest (wording version 2)", () => {
  const src = readFileSync(new URL("../lib/vehicle-assessment.ts", import.meta.url));
  const m = JSON.parse(readFileSync(new URL("../lib/vehicle-assessment.manifest.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${src.length}\0`), src])).digest("hex"), m.gitBlobSha1);
  assert.equal(src.length, m.byteLength); assert.ok(/wording version 2/.test(m.origin));
});
