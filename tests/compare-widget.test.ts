// The widget's comparison view (22 Oct 2026, André's option B): a side-by-side table when a tool result carries `comparison` rows (compare_vehicles); every other result keeps the card carousel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildResultsCardHtml, RESULTS_CARD_RESOURCE_URI } from "../lib/results-card";

const car = (n: number, extra: Record<string, unknown> = {}) => ({
  identity: { year: 2026, make: "Toyota", model: "Camry", trim: n === 1 ? "LE" : "SE", vin: `4T1DAACK${n}TU00000${n}` },
  media: { cardImageUrl: `https://carclever-find-my-car.vercel.app/api/img-proxy?u=${n}&s=x` },
  links: { affiliateUrl: `https://edmunds.sjv.io/c/car${n}` },
  listing: { price: 25000 + n, mileage: 1000 * n, city: "Inglewood", state: "CA" },
  ...extra,
});
const rows = [
  { label: "Price", values: ["$26,984", "$30,810"], note: "lowest #1; highest #2; spread $3,826", best: [0] },
  { label: "Mileage", values: ["9,433 mi", "5,555 mi"], best: [1] },
  { label: "Year", values: ["2026", "2026"], note: "same year on every vehicle that reports one" },
  { label: "Interior color", values: [null, "Black"] },
  { label: "Dealer", values: ["Montclair <b>Motors</b>", "South Bay Toyota"] },
];

async function mount(structuredContent: unknown) {
  const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", url: "https://carclever-find-my-car.vercel.app/", pretendToBeVisual: true });
  const w = dom.window as unknown as Window & typeof globalThis;
  const sent: Array<{ method?: string; params?: { url?: string } }> = [];
  w.addEventListener("message", (e: MessageEvent) => { if (e.data && e.data.method) sent.push(e.data); });
  await new Promise((r) => setTimeout(r, 20));
  w.dispatchEvent(new (w as any).MessageEvent("message", { data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } } }));
  await new Promise((r) => setTimeout(r, 20));
  return { doc: w.document, sent, w };
}

test("the widget resource is version 4", () => { assert.equal(RESULTS_CARD_RESOURCE_URI, "ui://carclever-find-my-car/results-card-v4"); });

test("comparison result: a table with one column per vehicle, one row per difference, the best cells marked, unknown shown, no carousel", async () => {
  const { doc } = await mount({ results: [car(1), car(2)], comparison: rows, meta: { corpusSizeApprox: "1.4 million", totalMatches: 2 } });
  assert.ok(doc.querySelector("table.cmp"), "table rendered");
  assert.equal(doc.querySelector(".cc-carousel"), null, "no card carousel");
  assert.match(doc.querySelector(".cc-scale")!.textContent!, /^Comparing 2 vehicles$/);
  assert.match(doc.querySelector(".cc-header-center")!.textContent!, /Stated, not ranked/);
  const heads = [...doc.querySelectorAll("thead th")]; assert.equal(heads.length, 3, "label column plus two vehicles");
  assert.match(heads[1].textContent!, /#1/); assert.match(heads[1].textContent!, /2026 Toyota Camry LE/); assert.match(heads[1].textContent!, /VIN \.\.\.00000?1|VIN \.\.\.\w{6}/);
  assert.match(heads[2].textContent!, /2026 Toyota Camry SE/);
  const body = [...doc.querySelectorAll("tbody tr")]; assert.equal(body.length, rows.length);
  const cellsOf = (label: string) => [...body.find((tr) => tr.querySelector("th")!.textContent === label)!.querySelectorAll("td")];
  assert.deepEqual(cellsOf("Price").map((c) => [c.textContent, c.classList.contains("cmp-best")]), [["$26,984", true], ["$30,810", false]], "lowest price marked");
  assert.deepEqual(cellsOf("Mileage").map((c) => [c.textContent, c.classList.contains("cmp-best")]), [["9,433 mi", false], ["5,555 mi", true]], "lowest mileage marked");
  assert.ok(cellsOf("Year").every((c) => !c.classList.contains("cmp-best")), "equal values are not marked");
  assert.deepEqual(cellsOf("Interior color").map((c) => [c.textContent, c.classList.contains("cmp-unknown")]), [["unknown", true], ["Black", false]]);
  assert.equal(doc.querySelectorAll(".cmp-best").length, 2, "only the two best cells are marked");
  assert.equal(body.find((tr) => tr.querySelector("th")!.textContent === "Price")!.querySelector("th")!.getAttribute("title"), "lowest #1; highest #2; spread $3,826", "the row note is the tooltip");
});

test("comparison result: values are escaped, photos and links come from the card, and the footer names the marks", async () => {
  const { doc } = await mount({ results: [car(1), car(2)], comparison: rows });
  const dealer = [...doc.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("th")!.textContent === "Dealer")!;
  assert.equal(dealer.querySelector("td b"), null, "no markup from a value");
  assert.match(dealer.querySelector("td")!.textContent!, /Montclair <b>Motors<\/b>/, "shown as text");
  const imgs = [...doc.querySelectorAll("img.cmp-photo")] as HTMLImageElement[]; assert.equal(imgs.length, 2);
  assert.match(imgs[0].getAttribute("src")!, /img-proxy\?u=1/); assert.equal(imgs[0].getAttribute("onerror"), "this.remove()");
  assert.match(doc.querySelector(".cc-footer")!.textContent!, /lowest price, lowest mileage, newest year, shortest distance/);
  assert.match(doc.querySelector(".cc-footer-right")!.textContent!, /Edmunds affiliate links/);
});

test("comparison result: a title click opens that car's listing through the host, not inside the widget", async () => {
  const { doc, sent } = await mount({ results: [car(1), car(2)], comparison: rows });
  const links = [...doc.querySelectorAll("th.cmp-col a.cc-title-link")] as HTMLAnchorElement[]; assert.equal(links.length, 2);
  links[1].dispatchEvent(new (doc.defaultView as any).MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  const open = sent.filter((m) => m.method === "ui/open-link"); assert.equal(open.length, 1); assert.equal(open[0].params!.url, "https://edmunds.sjv.io/c/car2");
});

test("a car without a link or a photo still gets a column; four vehicles fit; a fifth is ignored", async () => {
  const bare = { identity: { year: 2025, make: "Honda", model: "CR-V", trim: "EX", vin: "7FARS6H66VE003382" } };
  const r4 = { label: "Price", values: ["$1", "$2", "$3", "$4"], best: [0] };
  const { doc } = await mount({ results: [car(1), car(2), bare, car(1), car(2)], comparison: [r4] });
  const heads = [...doc.querySelectorAll("thead th")]; assert.equal(heads.length, 5, "label plus four vehicles");
  assert.equal(heads[3].querySelector("a"), null, "no link when the card has none"); assert.equal(heads[3].querySelector("img"), null, "no photo element without a photo");
  assert.match(heads[3].textContent!, /2025 Honda CR-V EX/);
});

test("controls: search results keep the card carousel; one car or empty comparison rows do not trigger the table", async () => {
  const search = await mount({ results: [car(1), car(2)], meta: { corpusSizeApprox: "1.4 million", totalMatches: 2 } });
  assert.ok(search.doc.querySelector(".cc-carousel"), "carousel for a search"); assert.equal(search.doc.querySelector("table.cmp"), null);
  assert.match(search.doc.querySelector(".cc-scale")!.textContent!, /Scan 1\.4 million/);
  const one = await mount({ results: [car(1)], comparison: rows }); assert.equal(one.doc.querySelector("table.cmp"), null, "one car: cards"); assert.ok(one.doc.querySelector(".cc-carousel"));
  const empty = await mount({ results: [car(1), car(2)], comparison: [] }); assert.equal(empty.doc.querySelector("table.cmp"), null, "no rows: cards"); assert.ok(empty.doc.querySelector(".cc-carousel"));
});
