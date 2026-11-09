// Group 2, item 5 (9 Nov 2026): stock-photo line, the NHTSA no-answer count and the capped drivetrain no-match sentence. Run: npx tsx --test tests/honest-notes.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { stockPhotoNote, noAnswerNote, cappedDrivetrainNoMatchNote } from "../lib/honest-notes";
import { decodeNhtsaElectrification, runWithNhtsaLedger, nhtsaNoAnswerCount, resetNhtsaCacheForTests, resetNhtsaDiagnosticsForTests } from "../lib/nhtsa-client";

test("stock photo line: counts only pictures carrying the stock marker; singular and plural; nothing when none", () => {
  const own = "https://x/api/img-proxy?u=a&sig=b", stock = "https://x/api/img-proxy?u=a&sig=b&stock=u";
  assert.equal(stockPhotoNote([own, own, own]), null);
  assert.equal(stockPhotoNote([]), null);
  assert.equal(stockPhotoNote([null, undefined, own]), null);
  assert.equal(stockPhotoNote([own, stock, own, own]), "1 of these 4 photos is a stock picture of the same model, not the actual car (the picture says so).");
  assert.equal(stockPhotoNote([stock, stock, own, null, stock]), "3 of these 5 photos are stock pictures of the same model, not the actual cars (the pictures say so).");
});
test("no-answer line: singular, plural, nothing at zero or for a bad number", () => {
  assert.equal(noAnswerNote(0), null); assert.equal(noAnswerNote(-2), null); assert.equal(noAnswerNote(Number.NaN), null);
  assert.equal(noAnswerNote(1), "1 car could not be checked because NHTSA's VIN service did not answer; it is not counted here. Trying again shortly may show more.");
  assert.equal(noAnswerNote(5), "5 cars could not be checked because NHTSA's VIN service did not answer; they are not counted here. Trying again shortly may show more.");
});
test("capped drivetrain no-match sentence: counts the cars checked, mentions the cars that could not be checked, and only suggests dropping a strict order when one was used", () => {
  assert.equal(cappedDrivetrainNoMatchNote("AWD", 32, 0, true), " 32 cars were checked against the requested drivetrain (AWD) and none had it. The search checks a limited number of the best-ranked candidates, so adding model names, or dropping the strict cheapest, newest or lowest-mileage order, can reach cars it did not check.");
  assert.equal(cappedDrivetrainNoMatchNote("4WD", 10, 2, false), " 12 cars were checked against the requested drivetrain (4WD) and none had it (2 could not be checked). The search checks a limited number of the best-ranked candidates, so adding model names can reach cars it did not check.");
  assert.match(cappedDrivetrainNoMatchNote("AWD", 1, 0, false)!, /^ 1 car was checked/);
  assert.equal(cappedDrivetrainNoMatchNote("AWD", 0, 0, true), null); assert.equal(cappedDrivetrainNoMatchNote("", 5, 0, true), null);
});

const realFetch = globalThis.fetch, realWarn = console.warn; const lines: string[] = [];
beforeEach(() => { lines.length = 0; resetNhtsaCacheForTests(); resetNhtsaDiagnosticsForTests(); console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); }; });
afterEach(() => { globalThis.fetch = realFetch; console.warn = realWarn; });
test("no-answer count equals the failures that are not decode_error, read from the same ledger as the log line", async () => {
  // two VINs get no answer (HTTP 503), one gets an answer that does not decode cleanly, one is healthy
  const plan: Record<string, () => Response> = {
    A1: () => new Response("", { status: 503 }), A2: () => new Response("", { status: 503 }),
    A3: () => new Response(JSON.stringify({ Results: [{ ErrorCode: "7", Make: "", Model: "" }] }), { status: 200 }),
    A4: () => new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", EngineCylinders: "4", FuelTypePrimary: "Gasoline" }] }), { status: 200 }),
  };
  globalThis.fetch = (async (url: unknown) => plan[String(url).match(/A\d/)![0]]()) as typeof fetch;
  let count = -1;
  await runWithNhtsaLedger(async () => { for (const v of ["A1", "A2", "A3", "A4"]) await decodeNhtsaElectrification(`1HGCM82633${v}00435`.slice(0, 17).padEnd(17, "0").replace(/^(.{10}).{2}/, `$1${v}`), "Honda", "Accord", 4); count = nhtsaNoAnswerCount(); });
  const line = lines.find((l) => l.startsWith("[nhtsa-failures]"))!;
  const failures = JSON.parse(line.slice("[nhtsa-failures] ".length).replace(/ breaker=open.*$/, "").replace(/ caller=.*$/, "")) as Record<string, number>;
  const expected = Object.entries(failures).reduce((a, [k, v]) => (k === "decode_error" ? a : a + v), 0);
  assert.ok(expected >= 2, `the two 503 answers are failures of the not-answered kind: ${line}`);
  assert.equal(count, expected);
});
test("no-answer count is 0 outside a request and when nothing failed", async () => {
  assert.equal(nhtsaNoAnswerCount(), 0);
  globalThis.fetch = (async () => new Response(JSON.stringify({ Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", EngineCylinders: "4", FuelTypePrimary: "Gasoline" }] }), { status: 200 })) as typeof fetch;
  let c = -1; await runWithNhtsaLedger(async () => { await decodeNhtsaElectrification("1HGCM82633A004352", "Honda", "Accord", 4); c = nhtsaNoAnswerCount(); });
  assert.equal(c, 0);
});
