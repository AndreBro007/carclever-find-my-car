// The server-calculated Summary line (22 Oct 2026). Offline.
import test from "node:test";
import assert from "node:assert/strict";
import { resultsSummaryLine, type SummaryCard } from "../lib/results-summary";

const car = (make: string, model: string, price: number | null, mileage: number | null, inv: string, extra: Partial<SummaryCard> = {}, year = 2026, trim = ""): SummaryCard =>
  ({ identity: { year, make, model, trim }, listing: { price, mileage }, condition: { inventoryType: inv }, badges: [], ...extra });

test("summary: counts, models in first-appearance order, cheapest, lowest used mileage and price range, all from the listed cars", () => {
  const s = resultsSummaryLine([
    car("Kia", "Niro EV", 31470, 1379, "used", {}, 2026, "Wind"), car("Nissan", "LEAF", 30514, 1258, "used", {}, 2026, "SV+"), car("Kia", "Niro EV", 33000, 900, "used"),
    car("Chevrolet", "Equinox EV", 33192, 6, "used", {}, 2026, "LT 2"),
  ]);
  assert.equal(s, "Summary (calculated by the server from the cars listed below; quote it as it is): 4 cars, 3 models (Kia Niro EV x2, Nissan LEAF, Chevrolet Equinox EV). Cheapest $30,514: 2026 Nissan LEAF SV+. Lowest mileage among the used cars 6 mi: 2026 Chevrolet Equinox EV LT 2. Price range $30,514 to $33,192.");
});
test("summary: one model says 'all <model>'; no used car means no mileage sentence (a new car's 3 miles says nothing)", () => {
  const s = resultsSummaryLine([car("Honda", "CR-V", 41227, 3, "new"), car("Honda", "CR-V", 45100, 5, "new")]);
  assert.match(s, /2 cars, all Honda CR-V\./);
  assert.ok(!/mileage/.test(s));
  assert.match(s, /Cheapest \$41,227: 2026 Honda CR-V\. Price range \$41,227 to \$45,100\./);
});
test("summary: a price flagged as a likely data error is left out of the cheapest and the range", () => {
  const s = resultsSummaryLine([car("A", "X", 100, 10, "used", { badges: ["price-likely-inaccurate"] }), car("A", "X", 20000, 10, "used"), car("A", "X", 25000, 10, "used")]);
  assert.match(s, /Cheapest \$20,000/); assert.match(s, /Price range \$20,000 to \$25,000/); assert.ok(!/\$100\b/.test(s));
});
test("summary: fewer than two cars gets none; no prices or equal prices drop the sentences that would say nothing", () => {
  assert.equal(resultsSummaryLine([]), ""); assert.equal(resultsSummaryLine([car("A", "X", 1, 1, "used")]), "");
  const s = resultsSummaryLine([car("A", "X", null, null, "unknown"), car("B", "Y", null, null, "unknown")]);
  assert.equal(s, "Summary (calculated by the server from the cars listed below; quote it as it is): 2 cars, 2 models (A X, B Y).");
  assert.ok(!/Price range/.test(resultsSummaryLine([car("A", "X", 5000, 1, "used"), car("A", "X", 5000, 2, "used")])), "equal prices: no range");
});
test("summary: ties keep the first car in list order, and thousands are separated for any locale", () => {
  const s = resultsSummaryLine([car("A", "X", 20000, 10, "used", {}, 2024), car("B", "Y", 20000, 10, "used", {}, 2025)]);
  assert.match(s, /Cheapest \$20,000: 2024 A X\./); assert.match(s, /Lowest mileage among the used cars 10 mi: 2024 A X\./);
  assert.match(resultsSummaryLine([car("A", "X", 1234567, 1234, "used"), car("A", "X", 2000000, 2000, "used")]), /\$1,234,567/);
});
