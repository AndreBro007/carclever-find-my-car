// R4-7 card v5 (11 Nov 2026; André approved the design with the exact text): real jsdom renders of each change. Run: npx tsx --test tests/card-v5.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESULTS_CARD_RESOURCE_URI, RESULTS_CARD_LEGACY_RESOURCE_URIS } from "../lib/results-card";

async function render(structuredContent: unknown) {
  const { buildResultsCardHtml } = await import("../lib/results-card");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
  await new Promise((r) => setTimeout(r, 150));
  dom.window.postMessage({ method: "ui/notifications/tool-result", params: { structuredContent } }, "*");
  await new Promise((r) => setTimeout(r, 150));
  return dom.window.document;
}
const car = (i: number, over: Record<string, unknown> = {}) => ({
  identity: { vin: `1FTEW2KP9TKE6${String(i).padStart(4, "0")}`, year: 2027, make: "Kia", model: "Seltos", trim: "EX" }, condition: { inventoryType: "used", used: true, cpo: false }, powertrain: { drivetrain: "FWD" },
  listing: { price: 31899, mileage: 102, dealer: "Test Dealer", city: "Cerritos", state: "CA" }, media: { cardImageUrl: null }, body: { bodyStyle: "SUV", vehicleType: null, doors: 4 },
  detail: { carfaxUrl: null, exteriorColor: "Silver", interiorColor: "Black", fuelTypeDisplay: "Gasoline" }, ranking: { matchScore: 100 },
  links: { affiliateUrl: "https://example.com/a", affiliateFallbackUrl: "https://example.com/b", dealerListingUrl: null, isCarvana: false, linkStatus: "ok" }, badges: [], intentConfirmations: [], risk: { tier: "unknown" }, ...over,
});
const meta = (extra: Record<string, unknown> = {}) => ({ corpusSizeApprox: "1.4 million", totalMatches: 221, dataNotes: [], scopeNote: "local", serviceError: null, ...extra });
const footerMore = (d: Document) => d.querySelector(".cc-footer-more")?.textContent ?? null;

test("(address) the card is v5; v4 and v3 stay readable", () => {
  assert.equal(RESULTS_CARD_RESOURCE_URI, "ui://carclever-find-my-car/results-card-v5");
  assert.deepEqual([...RESULTS_CARD_LEGACY_RESOURCE_URIS], ["ui://carclever-find-my-car/results-card-v4", "ui://carclever-find-my-car/results-card-v3"]);
});
test("(e) the card shows 12 cars with the header '12 shown' (was 'Top 8 of 12 shown')", async () => {
  const d = await render({ meta: meta(), results: Array.from({ length: 12 }, (_, i) => car(i)) });
  assert.equal(d.querySelectorAll("#cc-carousel > article").length, 12); assert.equal(d.querySelector(".cc-header-center")?.textContent, "12 shown");
});
test("(a) footer: unchanged when nothing more is ready; 'View similar ↗ or ask for more in the chat' when the reply carries the marker or a show-more reply can add more", async () => {
  const plain = await render({ meta: meta(), results: [car(1)] });
  assert.equal(footerMore(plain), "More: View similar \u2197");
  const hinted = await render({ meta: meta({ dataNotes: ["[more] More cars are available for this search. Reference abcdefghjkmn."] }), results: [car(1)] });
  assert.equal(footerMore(hinted), "View similar \u2197 or ask for more in the chat");
  const more = await render({ meta: meta(), results: [car(1)], continuation: { canAdd: 3 } });
  assert.equal(footerMore(more), "View similar \u2197 or ask for more in the chat");
  const done = await render({ meta: meta(), results: [car(1)], continuation: { canAdd: 0 } });
  assert.equal(footerMore(done), "More: View similar \u2197", "nothing left to add: the old line");
  const other = await render({ meta: meta({ dataNotes: ["Some other note"] }), results: [car(1)] });
  assert.equal(footerMore(other), "More: View similar \u2197", "only the marked entry counts");
});
test("(c) one compact extra line under the place line: exterior, interior, body style; always, with or without a photo; parts not held are left out", async () => {
  const d = await render({ meta: meta(), results: [car(1), car(2, { detail: { carfaxUrl: null, exteriorColor: "Blue", interiorColor: null } }), car(3, { body: { bodyStyle: null }, detail: { exteriorColor: "Unknown", interiorColor: "Tan" } }), car(4, { media: { cardImageUrl: "https://example.com/p.jpg" } })] });
  const lines = [...d.querySelectorAll(".cc-extra")].map((x) => x.textContent);
  assert.deepEqual(lines, ["Silver \u00b7 Black interior \u00b7 SUV", "Blue \u00b7 SUV", "Tan interior", "Silver \u00b7 Black interior \u00b7 SUV"]);
  assert.ok(!/Silver/.test(d.querySelector(".cc-facts")?.textContent ?? ""), "the colour is no longer repeated in the place line");
});
test("(b) compare view: the legend line under the table, only when the table has a safety or recall row", async () => {
  const rows = [{ label: "Price", values: ["$1", "$2"], best: [0] }, { label: "Safety rating (model yr)", values: ["5", "4"] }];
  const d = await render({ meta: meta(), results: [car(1), car(2)], comparison: rows });
  assert.equal(d.querySelector(".cc-legend")?.textContent, "Safety rating and recalls are for the model year, not this specific car.");
  const d2 = await render({ meta: meta(), results: [car(1), car(2)], comparison: [{ label: "Price", values: ["$1", "$2"] }] });
  assert.equal(d2.querySelector(".cc-legend"), null);
});
test("(d) identity-only replies: header left by case, middle 'Identity only'", async () => {
  const idCar = (vin: string) => car(1, { identity: { vin, year: 2020, make: "Ford", model: "Escape", trim: null }, listing: { price: null } });
  const notListed = await render({ meta: meta({ scopeNote: "vin_lookup", totalMatches: 0 }), results: [idCar("1FMUK7DH1TGB16836")] });
  assert.equal(notListed.querySelector(".cc-scale")?.textContent, "VIN not in the checked catalogue"); assert.equal(notListed.querySelector(".cc-header-center")?.textContent, "Identity only");
  const unavailable = await render({ meta: meta({ scopeNote: "vin_lookup", totalMatches: 0, serviceError: "The catalogue could not be read." }), results: [idCar("1FMUK7DH1TGB16836")] });
  assert.equal(unavailable.querySelector(".cc-scale")?.textContent, "Catalogue check unavailable");
  const noVin = await render({ meta: meta({ scopeNote: "vin_lookup", totalMatches: 0 }), results: [idCar("")] });
  assert.equal(noVin.querySelector(".cc-scale")?.textContent, "Identity only, no listing checked");
  const normal = await render({ meta: meta(), results: [car(1)] });
  assert.equal(normal.querySelector(".cc-scale")?.textContent, "Scan 1.4 million \u2192 221 found", "a normal search keeps its header");
});
