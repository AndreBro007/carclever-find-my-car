// NHTSA 5-star rating: lookup rules (mocked network), colour per level, and the real card pill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupOverallRating, attachNhtsaRatings, ratingTone, resetNhtsaRatingCacheForTests } from "../lib/nhtsa-ratings";

type Route = (url: string) => unknown | null | "hang";
function mockFetch(route: Route) {
  const real = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url)); const r = route(String(url));
    if (r === "hang") return new Promise(() => {});
    return r == null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r };
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; resetNhtsaRatingCacheForTests(); } };
}
const list = (vs: Array<[number, string]>) => ({ Count: vs.length, Results: vs.map(([id, d]) => ({ VehicleId: id, VehicleDescription: d })) });
const rate = (id: number, d: string, r: string) => ({ Count: 1, Results: [{ VehicleId: id, VehicleDescription: d, OverallRating: r }] });
const one = (m: ReturnType<typeof mockFetch>) => m.restore();

test("tone: each star level has its own colour (5 green, 4 light green, 3 yellow, 2 amber, 1 red)", () => {
  assert.deepEqual([5, 4, 3, 2, 1].map(ratingTone), ["green", "lime", "yellow", "amber", "red"]);
});
test("all variants agree -> that rating", async () => {
  const m = mockFetch((u) => u.includes("/modelyear/") ? list([[1, "2020 Toyota RAV4 SUV FWD"], [2, "2020 Toyota RAV4 SUV AWD"]]) : u.includes("VehicleId/1") ? rate(1, "2020 Toyota RAV4 SUV FWD", "5") : rate(2, "2020 Toyota RAV4 SUV AWD", "5"));
  try { assert.deepEqual(await lookupOverallRating("2020", "TOYOTA", "RAV4", null), { overall: 5 }); } finally { one(m); }
});
test("variants disagree: the car's drive type picks the variant, otherwise no label", async () => {
  const route: Route = (u) => u.includes("/modelyear/") ? list([[1, "2019 Ford Explorer SUV FWD"], [2, "2019 Ford Explorer SUV AWD"]]) : u.includes("VehicleId/1") ? rate(1, "2019 Ford Explorer SUV FWD", "4") : rate(2, "2019 Ford Explorer SUV AWD", "5");
  const m = mockFetch(route);
  try {
    assert.deepEqual(await lookupOverallRating("2019", "FORD", "Explorer", "AWD"), { overall: 5 });
    assert.deepEqual(await lookupOverallRating("2019", "FORD", "Explorer", "FWD"), { overall: 4 });
    assert.equal(await lookupOverallRating("2019", "FORD", "Explorer", null), null); // cannot pick: say nothing
    assert.equal(await lookupOverallRating("2019", "FORD", "Explorer", "RWD"), null);
  } finally { one(m); }
});
test("not rated, no variants, or a bad year/make/model -> no label", async () => {
  const m = mockFetch((u) => u.includes("/modelyear/") ? list([[1, "2025 X"]]) : rate(1, "2025 X", "Not Rated"));
  try {
    assert.equal(await lookupOverallRating("2025", "X", "Y", null), null);
    assert.equal(await lookupOverallRating("abc", "X", "Y", null), null);
    assert.equal(await lookupOverallRating("2025", "", "Y", null), null);
  } finally { one(m); }
  const e = mockFetch(() => list([]));
  try { assert.equal(await lookupOverallRating("2025", "X", "Z", null), null); } finally { one(e); }
});
test("a failed lookup is not cached; a good one is cached for the next search", async () => {
  let fail = true;
  const m = mockFetch((u) => fail ? null : u.includes("/modelyear/") ? list([[1, "2021 Kia Telluride SUV AWD"]]) : rate(1, "2021 Kia Telluride SUV AWD", "5"));
  try {
    assert.equal(await lookupOverallRating("2021", "Kia", "Telluride", null), null);
    fail = false;
    assert.deepEqual(await lookupOverallRating("2021", "Kia", "Telluride", null), { overall: 5 });
    const n = m.calls.length;
    assert.deepEqual(await lookupOverallRating("2021", "kia", "telluride", null), { overall: 5 }); // case-insensitive key
    assert.equal(m.calls.length, n); // served from cache
  } finally { one(m); }
});
test("attachNhtsaRatings: adds the rating, passes null through, and a hanging lookup never blocks", async () => {
  const m = mockFetch((u) => u.includes("/modelyear/") ? list([[1, "2022 Honda CR-V SUV AWD"]]) : rate(1, "2022 Honda CR-V SUV AWD", "5"));
  try {
    const r = { modelYear: "2022", make: "HONDA", model: "CR-V", specs: { driveType: "AWD" } };
    const out: any[] = await attachNhtsaRatings([r, null]);
    assert.deepEqual(out[0].rating, { overall: 5 }); assert.equal(out[1], null);
  } finally { one(m); }
  const h = mockFetch(() => "hang");
  try {
    const t = Date.now();
    const out: any[] = await attachNhtsaRatings([{ modelYear: "2023", make: "A", model: "B" }], 60);
    assert.ok(Date.now() - t < 1000); assert.equal(out[0].rating, undefined);
  } finally { one(h); }
});

async function renderCard(stars: number | undefined) {
  const { buildResultsCardHtml } = await import("../lib/results-card");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  const { window } = dom; await new Promise((r) => setTimeout(r, 200));
  const results = [{
    identity: { vin: "1FTEW2KP9TKE60601", year: 2024, make: "Kia", model: "Seltos", trim: "EX" }, condition: { inventoryType: "used", used: true },
    powertrain: { drivetrain: "FWD" }, listing: { price: 21000, mileage: 9000, dealer: "Test Dealer", city: "Austin", state: "TX" }, media: { cardImageUrl: null },
    detail: stars === undefined ? { exteriorColor: "Blue" } : { exteriorColor: "Blue", nhtsaOverallRating: stars },
    ranking: { matchScore: 100 }, links: { affiliateUrl: null, affiliateFallbackUrl: null, isCarvana: false, linkStatus: "none-available" }, badges: [], intentConfirmations: [],
  }];
  window.postMessage({ method: "ui/notifications/tool-result", params: { structuredContent: { meta: { corpusSizeApprox: "1.4 million", totalMatches: 1 }, results } } }, "*");
  await new Promise((r) => setTimeout(r, 200));
  return window.document;
}
for (const [stars, tone] of [[5, "green"], [4, "lime"], [3, "yellow"], [2, "amber"], [1, "red"]] as const) {
  test(`card pill: ${stars} stars -> ${tone}`, async () => {
    const doc = await renderCard(stars);
    const pill = doc.querySelector(".cc-rate");
    assert.ok(pill, "rating pill must render"); assert.ok(pill!.classList.contains("is-" + tone), `class ${pill!.className}`);
    assert.match(pill!.textContent ?? "", new RegExp(`${stars} NHTSA`));
  });
}
test("card pill: no rating -> no pill (unknown is not shown as bad)", async () => {
  const doc = await renderCard(undefined);
  assert.equal(doc.querySelector(".cc-rate"), null);
});

// Real NHTSA response shapes, pasted by André on Oct 13, 2026 (2013 Acura RDX list + variant, 2020 Toyota RAV4 list).
// The two RAV4 RATINGS below are SYNTHETIC (only their layout is real); the 2013 RDX variants really are "Not Rated".
const realRdxList = { Count: 2, Message: "Results returned successfully", Results: [{ VehicleDescription: "2013 Acura RDX SUV 4WD", VehicleId: 7731 }, { VehicleDescription: "2013 Acura RDX SUV FWD", VehicleId: 7520 }] };
const realVariant = (id: number, desc: string, overall: string) => ({ Count: 1, Message: "Results returned successfully", Results: [{
  OverallRating: overall, OverallFrontCrashRating: "Not Rated", FrontCrashDriversideRating: "Not Rated", FrontCrashPassengersideRating: "Not Rated", OverallSideCrashRating: "Not Rated",
  RolloverRating: "Not Rated", RolloverPossibility: 0.0, NHTSAElectronicStabilityControl: "Standard", NHTSAForwardCollisionWarning: "No", NHTSALaneDepartureWarning: "No",
  ComplaintsCount: 162, RecallsCount: 3, InvestigationCount: 1, ModelYear: 2013, Make: "ACURA", Model: "RDX", VehicleDescription: desc, VehicleId: id }] });
const realRavList = { Count: 2, Message: "Results returned successfully", Results: [{ VehicleDescription: "2020 Toyota RAV4 SUV FWD", VehicleId: 14726 }, { VehicleDescription: "2020 Toyota RAV4 SUV AWD", VehicleId: 14693 }] };

test("real response shapes: a 'Not Rated' model year gives no label (2013 Acura RDX)", async () => {
  const m = mockFetch((u) => u.includes("/modelyear/2013/make/ACURA/model/RDX") ? realRdxList : u.includes("VehicleId/7731") ? realVariant(7731, "2013 Acura RDX SUV 4WD", "Not Rated") : u.includes("VehicleId/7520") ? realVariant(7520, "2013 Acura RDX SUV FWD", "Not Rated") : null);
  try {
    assert.equal(await lookupOverallRating("2013", "ACURA", "RDX", "FWD"), null);
    assert.equal(await lookupOverallRating("2013", "ACURA", "RDX", null), null);
  } finally { one(m); }
});
test("real response shapes: 2020 RAV4 list (FWD and AWD variants) with the real field layout and string ratings", async () => {
  const m = mockFetch((u) => u.includes("/modelyear/2020/make/TOYOTA/model/RAV4") ? realRavList : u.includes("VehicleId/14726") ? realVariant(14726, "2020 Toyota RAV4 SUV FWD", "5") : u.includes("VehicleId/14693") ? realVariant(14693, "2020 Toyota RAV4 SUV AWD", "4") : null);
  try {
    assert.deepEqual(await lookupOverallRating("2020", "TOYOTA", "RAV4", "FWD"), { overall: 5 });
    assert.deepEqual(await lookupOverallRating("2020", "TOYOTA", "RAV4", "AWD"), { overall: 4 });
    assert.equal(await lookupOverallRating("2020", "TOYOTA", "RAV4", null), null); // variants disagree, drive type unknown
  } finally { one(m); }
});

test("recall campaigns: real layout (RecallsCount) is read; the car's drive type picks the variant when counts differ; 'Not Rated' still gives the count", async () => {
  const { lookupModelYearSafety } = await import("../lib/nhtsa-ratings");
  const v = (id: number, desc: string, recalls: number) => ({ Count: 1, Results: [{ OverallRating: "Not Rated", RecallsCount: recalls, ComplaintsCount: 5, VehicleDescription: desc, VehicleId: id }] });
  const m = mockFetch((u) => u.includes("/modelyear/2013/") ? realRdxList : u.includes("VehicleId/7731") ? v(7731, "2013 Acura RDX SUV 4WD", 3) : v(7520, "2013 Acura RDX SUV FWD", 3));
  try {
    assert.deepEqual(await lookupModelYearSafety("2013", "ACURA", "RDX", null), { overall: null, recallCampaigns: 3 }); // all variants agree
  } finally { one(m); }
  const d = mockFetch((u) => u.includes("/modelyear/2020/") ? realRavList : u.includes("VehicleId/14726") ? v(14726, "2020 Toyota RAV4 SUV FWD", 2) : v(14693, "2020 Toyota RAV4 SUV AWD", 4));
  try {
    assert.deepEqual(await lookupModelYearSafety("2020", "TOYOTA", "RAV4", "AWD"), { overall: null, recallCampaigns: 4 });
    assert.equal(await lookupModelYearSafety("2020", "TOYOTA", "RAV4", null), null); // counts differ, drive unknown: say nothing
  } finally { one(d); }
});
