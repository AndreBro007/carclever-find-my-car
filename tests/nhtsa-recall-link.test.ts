// NHTSA free VIN recall lookup on used-car cards (replaces the Carfax link slot) plus the guidance for the buyer: check for open recalls, then
// contact the dealer. Plain government link (no affiliate wrapper); nothing is fetched from NHTSA per car.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nhtsaRecallCheckUrl, nhtsaLinkField, recallCheckFootnote, recallCheckLine, addRecallCheckStep, NHTSA_RECALLS_URL } from "../lib/nhtsa-links";
import { clipRecallText } from "../lib/nhtsa-recalls-client";

const VIN = "1GKS1AKD8NR363035"; // the example André tested
describe("link builder", () => {
  test("builds the exact link André tested; upper-cases; rejects anything that is not a valid 17-character VIN", () => {
    assert.equal(nhtsaRecallCheckUrl(VIN), "https://www.nhtsa.gov/recalls?vymm=1GKS1AKD8NR363035"); assert.equal(NHTSA_RECALLS_URL, "https://www.nhtsa.gov/recalls");
    assert.equal(nhtsaRecallCheckUrl(" 1gks1akd8nr363035 "), "https://www.nhtsa.gov/recalls?vymm=1GKS1AKD8NR363035");
    for (const bad of ["", null, undefined, "1GKS1AKD8NR36303", "1GKS1AKD8NR3630355", "1GKS1AKD8NR36303I", "1GKS1AKD8NR36303O", "1GKS1AKD8NR36303Q", "SHORT", "1GKS1AKD8NR36303 5"]) assert.equal(nhtsaRecallCheckUrl(bad as any), null, String(bad));
  });
  test("it is a plain NHTSA link: no affiliate wrapper and no Shared ID", () => {
    const u = nhtsaRecallCheckUrl(VIN)!; assert.ok(u.startsWith("https://www.nhtsa.gov/")); assert.ok(!/sjv\.io|sharedid|anrdoezrs|u=/i.test(u));
  });
  test("the card field exists only for USED cars in the database app", () => {
    assert.deepEqual(nhtsaLinkField(VIN, true), { nhtsaRecallCheckUrl: `https://www.nhtsa.gov/recalls?vymm=${VIN}` });
    assert.deepEqual(nhtsaLinkField(VIN, false), {}); assert.deepEqual(nhtsaLinkField("bad", true), {});
  });
});

const used = { condition: { inventoryType: "used" }, links: { nhtsaRecallCheckUrl: `https://www.nhtsa.gov/recalls?vymm=${VIN}` } };
const fresh = { condition: { inventoryType: "new" }, links: {} };
describe("guidance wording", () => {
  test("list footnote: how to check ANY listed car, then contact the dealer, honest about what the lookup covers", () => {
    const t = recallCheckFootnote([used, fresh]);
    for (const must of ["open (unrepaired) recalls", "NHTSA's free VIN lookup", "https://www.nhtsa.gov/recalls?vymm=<the car's VIN>", "participating manufacturers", "already repaired"]) assert.ok(t.includes(must), must);
    // The dealer and history-report advice lives in the one closing line of the reply; the recall paragraph does not repeat it (SYS-20261021-026, F2).
    for (const gone of ["call or email the dealer", "vehicle history report", "many dealers provide one free"]) assert.ok(!t.includes(gone), gone);
    assert.ok(!/carfax|all recalls|no recalls|safe to buy|guarantee/i.test(t));
    assert.equal(recallCheckFootnote([fresh]), ""); assert.equal(recallCheckFootnote([]), "");
  });
  test("single-car line carries that car's own link; nothing for new cars or other apps", () => {
    const t = recallCheckLine(used); assert.ok(t.includes(`https://www.nhtsa.gov/recalls?vymm=${VIN}`) && t.includes("THIS car") && t.includes("already repaired"));
    assert.ok(!t.includes("call or email the dealer") && !t.includes("vehicle history report"), "the dealer and history advice is in the reply's own next steps, not repeated in the recall line (SYS-20261021-028)");
    assert.equal(recallCheckLine(fresh), ""); assert.equal(recallCheckLine(null), "");
  });
  test("Buyer Check next steps gain one step for used cars; the object is otherwise untouched", () => {
    const bc = { outcome: "verify_before_proceeding", goodSigns: ["x"], concerns: [], needsVerification: [], nextSteps: ["Have a pre-purchase inspection done."] };
    const out = addRecallCheckStep(bc, used); assert.equal(out.nextSteps.length, 2); assert.equal(out.nextSteps[0], bc.nextSteps[0]); assert.ok(out.nextSteps[1].includes(`vymm=${VIN}`) && /NHTSA/.test(out.nextSteps[1]) && !/dealer|history report/.test(out.nextSteps[1]));
    assert.equal(out.outcome, bc.outcome); assert.equal(bc.nextSteps.length, 1); // input not mutated
    assert.equal(addRecallCheckStep(bc, fresh), bc);
  });
});

describe("clipping real NHTSA text", () => {
  test("short text stays, long text is cut at a word boundary with an ellipsis, nulls stay null", () => {
    assert.equal(clipRecallText("Fuel pump may fail.", 240), "Fuel pump may fail."); assert.equal(clipRecallText(null), null); assert.equal(clipRecallText(undefined), null);
    const long = "Toyota Motor Engineering & Manufacturing (Toyota) is recalling certain 2023-2024 Toyota Venza, 2023-2025 RAV4 Prime, RAV4, Highlander, GR Corolla, Crown, 2024-2025 Lexus TX, LS, Toyota Tacoma, Grand Highlander, and 2025 Lexus RX, Toyota Crown Signia, Camry vehicles. Due to an error in the instrument panel software at vehicle startup, the instrument panel may fail to display vehicle speed, brake system warning lights and more.";
    const c = clipRecallText(long, 240)!; assert.ok(c.length <= 241 && c.endsWith("…") && long.startsWith(c.slice(0, -1).trimEnd())); assert.ok(!c.slice(0, -1).endsWith(" "));
    assert.equal(clipRecallText("a   b\n c", 50), "a b c");
  });
});

describe("the card (real render, jsdom)", () => {
  async function render(links: Record<string, unknown>, detail: Record<string, unknown> = {}) {
    const { buildResultsCardHtml } = await import("../lib/results-card"); const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(buildResultsCardHtml(), { runScripts: "dangerously", resources: "usable", url: "https://carclever-find-my-car.vercel.app/" });
    const { window } = dom; await new Promise((r) => setTimeout(r, 200));
    const results = [{ identity: { vin: VIN, year: 2022, make: "GMC", model: "Terrain", trim: "SLE" }, condition: { inventoryType: "used", used: true }, powertrain: { drivetrain: "AWD" },
      listing: { price: 21000, mileage: 39000, dealer: "Test Dealer", city: "Austin", state: "TX" }, media: { cardImageUrl: null }, detail: { exteriorColor: "Blue", ...detail },
      ranking: { matchScore: 100 }, links: { affiliateUrl: "https://edmunds.sjv.io/c/1/2/3?u=x&sharedid=mcpapp", affiliateFallbackUrl: "https://edmunds.sjv.io/c/1/2/3?u=y&sharedid=mcpapp", isCarvana: false, linkStatus: "both-available", ...links }, badges: [], intentConfirmations: [] }];
    window.postMessage({ method: "ui/notifications/tool-result", params: { structuredContent: { meta: { corpusSizeApprox: "1.4 million", totalMatches: 1 }, results } } }, "*");
    await new Promise((r) => setTimeout(r, 200)); return window.document;
  }
  test("a used car with the field shows the recall-check link next to the dealer name, wired like the old Carfax link", async () => {
    const doc = await render({ nhtsaRecallCheckUrl: `https://www.nhtsa.gov/recalls?vymm=${VIN}` });
    const b = doc.querySelector(".cc-dealer-row .cc-carfax-link") as HTMLElement; assert.ok(b, "recall link must render in the dealer row");
    assert.ok(b.textContent!.startsWith("Recall check")); assert.equal(b.getAttribute("data-url"), `https://www.nhtsa.gov/recalls?vymm=${VIN}`); assert.match(b.getAttribute("title")!, /unrepaired recall/);
    assert.equal(doc.querySelector(".cc-dealer")!.textContent, "Test Dealer"); assert.equal(doc.querySelectorAll(".cc-cta-btn").length, 2); // the two Edmunds buttons are unchanged
  });
  test("no field, no link; and the link never carries Carfax wording", async () => {
    const doc = await render({}); assert.equal(doc.querySelector(".cc-carfax-link"), null); assert.ok(doc.querySelector(".cc-card")!.textContent!.length > 20); assert.ok(!doc.querySelector(".cc-card")!.textContent!.includes("Carfax"), "no Carfax wording on the card");
  });
  test("a hostile value cannot break out of the attribute", async () => {
    const doc = await render({ nhtsaRecallCheckUrl: 'https://www.nhtsa.gov/x" onmouseover="alert(1)' });
    const b = doc.querySelector(".cc-carfax-link")!; assert.ok(!b.hasAttribute("onmouseover")); assert.equal(doc.querySelector("[onmouseover]"), null);
  });
});
