// Vehicle investigation in check_vehicle's reply text (release 4, 11 Nov 2026). Run: npx tsx --test tests/vehicle-investigation-block.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { investigationBlock, recallListLines } from "../lib/vehicle-investigation-block";
import { readingLinkFor, tradeInLink, reviewUrlFor, guideKindFor, VERIFIED_REVIEW_PAGES, GUIDE_URLS } from "../lib/vehicle-investigation-links";
import { setSharedIdPlatformProvider, sharedIdTag } from "../lib/shared-id-context";

const NOW = new Date("2026-11-11T00:00:00Z");
const listed = () => investigationBlock({ status: "listed", vin: "2HKRS4H24SH442431", title: "2025 Honda CR-V LX", decodeConfirmed: true, titleFromCatalogue: true, facts: { price: 26584, mileage: 9734, dealer: "California Motors Direct Montclair", city: "Montclair", state: "CA", zip: null, used: true, rowChangedAt: null }, vehicle: { year: 2025, make: "Honda", model: "CR-V" }, used: true, now: NOW }).join("\n");
const notListed = () => investigationBlock({ status: "not_listed", vin: "1HGCM82633A004352", title: "2003 Honda Accord EX-V6", decodeConfirmed: true, vehicle: { year: 2003, make: "Honda", model: "Accord" }, now: NOW }).join("\n");
const failed = () => investigationBlock({ status: "catalogue_unavailable", vin: "1HGCM82633A004352", title: "2003 Honda Accord EX-V6", decodeConfirmed: true, vehicle: { year: 2003, make: "Honda", model: "Accord" }, now: NOW }).join("\n");
const typed = (y = 2024, mk = "Honda", md = "CR-V") => investigationBlock({ status: "identity_only", vin: null, title: `${y} ${mk} ${md}`, decodeConfirmed: false, vehicle: { year: y, make: mk, model: md }, now: NOW }).join("\n");

test("listed car: readiness line, still unknown, 7 questions, the Edmunds availability note, one reading link (used guide), one trade-in link", () => {
  const b = listed();
  assert.match(b, /^\nBefore you contact the dealer:\nConfirmed: 2025 Honda CR-V LX\. Still to confirm with the dealer: 7 things\. Contact the dealer to confirm\.\nStill unknown:/);
  assert.match(b, /- Whether it's still available: confirm with the dealer before you visit\./);
  assert.match(b, /1\) Is this exact car \(VIN 2HKRS4H24SH442431\) available right now, and at which store can I see it\?/); assert.match(b, /7\) Can I book a test drive, and can you hold the car until then\?/);
  assert.match(b, /Edmunds: Check availability opens this car on Edmunds\. The dealer can confirm it's still for sale\./);
  assert.equal((b.match(/Share these two links with the buyer:\nHelpful reading: .*\nReplacing a car\?/g) ?? []).length, 1, "the label comes right before the two links");
  assert.equal((b.match(/Helpful reading:/g) ?? []).length, 1); assert.match(b, /Helpful reading: Edmunds used-car buying guide: https:\/\/edmunds\.sjv\.io\//);
  assert.equal((b.match(/Replacing a car\?/g) ?? []).length, 1);
});
test("not in the catalogue: the similar-vehicles note says it is not this exact car; lookup failed: says nothing about inventory and asks for the VIN; neither claims a listing", () => {
  const n = notListed(); assert.match(n, /Confirmed: 2003 Honda Accord EX-V6\./); assert.match(n, /the checked catalogue has no record of it/); assert.match(n, /Edmunds: We don't have a link to this exact car\..*\(not this exact car\)/);
  const f = failed(); assert.match(f, /Whether this VIN is listed: the catalogue did not answer, so nothing here says anything about inventory\./); assert.match(f, /1\) Can you give me the VIN for this exact car so it can be checked\?/); assert.ok(!/^Edmunds: /m.test(f), "no Edmunds availability line when there is no link to offer");
});
test("make, model and year only: the identity is NOT called confirmed; the VIN is asked for; a verified model year gets its review link with the not-a-check note", () => {
  const t = typed(); assert.match(t, /Identity as given: 2024 Honda CR-V \(no VIN, so not confirmed\)\. Still to confirm with the dealer: 7 things\./); assert.ok(!/Confirmed:/.test(t));
  assert.match(t, /\nFor a full check of this exact car, please share its VIN \(on the listing, the dashboard or the driver's door jamb\)\.\n/, "the buyer is asked for the VIN");
  for (const b of [listed(), notListed(), failed()]) assert.ok(!/please share its VIN/.test(b), "a VIN was already given: no request");
  assert.match(t, /Which specific car this is: no VIN was given, so there is no listing check\./); assert.match(t, /1\) Can you give me the VIN for this exact car so it can be checked\?/);
  assert.match(t, /Helpful reading: Edmunds 2024 Honda CR-V review: https:\/\/edmunds\.sjv\.io\/.*\(A model-year review, not a check of this car\.\)/);
});
test("never a verdict, score, valuation or old wording: none of those words appear in any block", () => {
  for (const b of [listed(), notListed(), failed(), typed(), typed(2023, "Toyota", "Camry")]) {
    assert.ok(!/good buy|worth|verdict|score|safe to buy|not live stock|CarClever Test|valuation/i.test(b), b.slice(0, 200));
  }
});
test("every Edmunds link goes through Impact with a Shared ID; no raw Edmunds address; the legacy tag when the platform is unknown, platform and role tags otherwise", () => {
  setSharedIdPlatformProvider(null);
  const b = listed(); const urls = b.match(/https?:\/\/\S+/g) ?? [];
  assert.equal(urls.length, 2, "one reading link and one trade-in link");
  for (const u of urls) { assert.match(u, /^https:\/\/edmunds\.sjv\.io\/c\/7765200\/(3949600|3949601)\/52125/); assert.match(u, /sharedid=mcpapp(\b|$)/); }
  assert.ok(!/https:\/\/www\.edmunds\.com\//.test(b.replace(/%3A%2F%2Fwww\.edmunds\.com/g, "")), "no raw Edmunds address outside the encoded destination");
  setSharedIdPlatformProvider(() => "claude");
  try {
    assert.equal(sharedIdTag("review"), "mcpclaudereview"); assert.equal(sharedIdTag("guide"), "mcpclaudeguide"); assert.equal(sharedIdTag("tradein"), "mcpclaudetradein");
    const c = typed(); assert.match(c, /sharedid=mcpclaudereview/); assert.match(c, /sharedid=mcpclaudetradein/);
    assert.match(notListed(), /sharedid=mcpclaudeguide/);
  } finally { setSharedIdPlatformProvider(null); }
});
test("review links only for the six opened pages; everything else gets the buying guide; the new-or-used rule", () => {
  assert.equal(VERIFIED_REVIEW_PAGES.size, 6);
  assert.equal(reviewUrlFor({ year: 2023, make: "Toyota", model: "RAV4 Hybrid" }), "https://www.edmunds.com/toyota/rav4-hybrid/2023/");
  assert.equal(reviewUrlFor({ year: 2019, make: "BMW", model: "3 Series" }), "https://www.edmunds.com/bmw/3-series/2019/");
  assert.equal(reviewUrlFor({ year: 2021, make: "Chevrolet", model: "Silverado 1500" }), "https://www.edmunds.com/chevrolet/silverado-1500/2021/");
  assert.equal(reviewUrlFor({ year: 2023, make: "Toyota", model: "RAV4" }), null, "RAV4 is not RAV4 Hybrid"); assert.equal(reviewUrlFor({ year: 2025, make: "Honda", model: "CR-V" }), null); assert.equal(reviewUrlFor({ year: null, make: "Honda", model: "CR-V" }), null);
  assert.equal(guideKindFor(true, 2030, NOW), "used"); assert.equal(guideKindFor(false, 2010, NOW), "new"); assert.equal(guideKindFor(null, 2026, NOW), "new"); assert.equal(guideKindFor(undefined, 2027, NOW), "new"); assert.equal(guideKindFor(undefined, 2025, NOW), "used");
  assert.match(readingLinkFor({ vehicle: { year: 2026, make: "Kia", model: "Seltos" }, used: undefined, now: NOW }).text, /new-car buying guide/);
  assert.match(decodeURIComponent(readingLinkFor({ vehicle: { year: 2020, make: "Kia", model: "Seltos" }, used: undefined, now: NOW }).url), /how-to-buy-a-used-car\.html/);
  assert.equal(GUIDE_URLS.used, "https://www.edmunds.com/car-buying/how-to-buy-a-used-car.html"); assert.match(tradeInLink().url, /^https:\/\/edmunds\.sjv\.io\/c\/7765200\/3949601\/52125\?sharedid=mcpapp$/);
});
test("recall list (listed cars): newest first, at most ten, the total says how many NHTSA returned, a malformed entry still counts, nothing when there are none", () => {
  const mk = (n: number, d: string | null) => ({ campaignNumber: `${20 + n}V${String(100 + n).padStart(3, "0")}000`, component: "FUEL SYSTEM, GASOLINE:DELIVERY", summary: "Honda is recalling certain vehicles. The fuel pump may fail, causing a stall.", consequence: null, remedy: null, reportReceivedDate: d, parkIt: false, parkOutSide: false });
  const campaigns = [...Array.from({ length: 11 }, (_, i) => mk(i, `0${(i % 9) + 1}/05/20${10 + i}`)), mk(99, null)];
  const lines = recallListLines({ state: "found", count: 12, severeCount: 0, campaigns } as never, 2024);
  assert.match(lines[0], /Recall campaigns NHTSA lists for this model year \(2024\): 12 in total, the newest 10 shown\./); assert.match(lines[0], /may not apply to this car/); assert.equal(lines.length, 11);
  assert.match(lines[1], /^- 3[0-9]V-1\d\d · .+ 20(1[0-9]|2[0-9]) · Fuel system, gasoline: The fuel pump may fail, causing a stall\.$/);
  const years = lines.slice(1).map((l) => Number((l.match(/20\d\d/) ?? ["0"])[0])); assert.deepEqual(years, [...years].sort((a, b) => b - a), "newest first");
  assert.deepEqual(recallListLines({ state: "none", count: 0, campaigns: [] } as never, 2024), []); assert.deepEqual(recallListLines(null, 2024), []);
});
test("the reply block is wired into all four check_vehicle paths and adds no structured field", () => {
  const src = readFileSync("app/[transport]/route.ts", "utf8");
  assert.equal((src.match(/investigationBlock\(\{/g) ?? []).length, 3, "not listed or lookup failed (one place), listed, make+model+year only");
  assert.match(src, /status: inventoryLookupFailed \? "catalogue_unavailable" : "not_listed"/); assert.match(src, /status: "listed", vin: listing\.vin/); assert.match(src, /status: "identity_only", vin: null/);
  assert.match(src, /lines\.push\(\.\.\.recallListLines\(recall, listing\.vehicle\?\.year \?\? null\)\)/);
  assert.ok(!/lines\.push\(["`]Before you contact/.test(src), "the words live in the builder, not in the route");
});
