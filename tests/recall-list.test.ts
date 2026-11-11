// MCP copy (R4 vehicle investigation, 11 Nov 2026): only the PURE tests of the website file; the website-only fetch and page tests were left out. Run: npx tsx --test tests/recall-list.test.ts
// The "Many recalls on record" list: shaped from NHTSA's own campaign list (the same response that gives the count), newest first,
// plain wording, never more than ten lines, and a malformed entry still counts so the list and the count agree.
import test from "node:test";
import assert from "node:assert/strict";
import { campaignLabel, reportedOn, componentLabel, shortSummary, defectSummary, recallListFor, MAX_SHOWN } from "../lib/recall-list";

test("campaign number: 16V725000 is written 16V-725, as in NHTSA's reports; odd values are kept short, missing stays missing", () => {
  assert.equal(campaignLabel("16V725000"), "16V-725"); assert.equal(campaignLabel("25v911000"), "25V-911"); assert.equal(campaignLabel("24E035001"), "24E-035");
  assert.equal(campaignLabel("SOMETHING-ODD-AND-VERY-LONG-INDEED"), "SOMETHING-ODD-AND-VE"); assert.equal(campaignLabel(""), null); assert.equal(campaignLabel(null), null); assert.equal(campaignLabel(5), null);
});

test("date: NHTSA writes day/month/year; 11/10/2016 is October 2016, 19/12/2023 is December 2023; unreadable dates give nothing, never a wrong month", () => {
  assert.deepEqual(reportedOn("11/10/2016"), { label: "Oct 2016", sort: 20161011 }); assert.deepEqual(reportedOn("19/12/2023"), { label: "Dec 2023", sort: 20231219 });
  assert.deepEqual(reportedOn("09/02/2016"), { label: "Feb 2016", sort: 20160209 });
  for (const bad of ["2016-10-11", "31/13/2020", "00/05/2020", "11/10/1800", "", null, 20161011, "11/10"]) assert.deepEqual(reportedOn(bad), { label: null, sort: 0 }, String(bad));
});

test("component: first part, sentence case", () => {
  assert.equal(componentLabel("PARKING BRAKE"), "Parking brake"); assert.equal(componentLabel("ENGINE AND ENGINE COOLING:ENGINE"), "Engine and engine cooling");
  assert.equal(componentLabel("FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP"), "Fuel system, gasoline"); assert.equal(componentLabel(""), null); assert.equal(componentLabel(undefined), null);
});

test("summary: whitespace collapsed, short ones unchanged, long ones cut at a word with an ellipsis, never longer than about 150 characters", () => {
  assert.equal(shortSummary("  Honda   is\nrecalling cars. "), "Honda is recalling cars.");
  const long = "Honda is recalling certain vehicles ".repeat(12); const s = shortSummary(long)!;
  assert.ok(s.length <= 151 && s.endsWith("…") && !/\s…$/.test(s), s); assert.equal(shortSummary(""), null); assert.equal(shortSummary(42), null);
});

test("defect line: the first 'is recalling certain ...' sentence (which vehicles) is skipped so the line names the problem; a single sentence is kept whole", () => {
  const real = "Honda (American Honda Motor Co.) is recalling certain model year 2016 Honda Civic two door and four door 1.5L turbo and 2.0L vehicles. The electric parking brake (EPB) may not engage after the ignition is turned off, increasing the risk of a rollaway.";
  assert.equal(defectSummary(real), "The electric parking brake (EPB) may not engage after the ignition is turned off, increasing the risk of a rollaway.");
  assert.equal(defectSummary("American Honda Motor Co. (Honda) is recalling certain 2016 Civic vehicles. The headlight may fail."), "The headlight may fail.", "'Co. (Honda)' is not a sentence end");
  const one = "Honda is recalling certain vehicles because the fuel pump may fail."; assert.equal(defectSummary(one), one);
  const noRecalling = "The sensor may fail. It may cause a crash."; assert.equal(defectSummary(noRecalling), noRecalling, "only a leading 'recalling' sentence is skipped");
  const longDefect = "Honda is recalling certain vehicles. " + "The sensor may not work correctly ".repeat(12); const d = defectSummary(longDefect)!; assert.ok(d.length <= 151 && d.endsWith("…") && d.startsWith("The sensor"));
  assert.equal(defectSummary(""), null); assert.equal(defectSummary(undefined), null);
});

test("a malformed entry still counts (the list and the count always agree) and shows with blanks, never invented text", () => {
  const l = recallListFor([{}, null, "x", { NHTSACampaignNumber: "21V001000", ReportReceivedDate: "05/03/2021" }]);
  assert.equal(l.total, 4); assert.equal(l.items.length, 4); assert.equal(l.items[0].id, "21V-001");
  assert.deepEqual(l.items[1], { id: null, when: null, component: null, summary: null });
});

