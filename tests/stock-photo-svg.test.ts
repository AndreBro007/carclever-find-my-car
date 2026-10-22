// The "Stock photo" watermark builder (23 Oct 2026). Offline.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStockPhotoSvg, stockCodeFor, isStockCode, STOCK_LABELS } from "../lib/stock-photo-svg";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 251);

test("stock code: a used car always says 'not this car'; a new car says 'colour may differ' only when the colour does not match", () => {
  assert.equal(stockCodeFor(false, true), "1"); assert.equal(stockCodeFor(false, false), "2");
  assert.equal(stockCodeFor(true, true), "3"); assert.equal(stockCodeFor(true, false), "3");
  assert.equal(stockCodeFor(undefined, true), "1", "unknown condition is treated as new");
  assert.ok(isStockCode("1") && isStockCode("2") && isStockCode("3")); assert.ok(!isStockCode("4") && !isStockCode("") && !isStockCode(null) && !isStockCode("<svg>"));
});
test("svg: the photo is embedded as base64 under its own type, with the label across the bottom", () => {
  const b = bytes(500); const svg = buildStockPhotoSvg("image/jpeg", b, "2")!;
  assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"));
  assert.ok(svg.includes(`xlink:href="data:image/jpeg;base64,${Buffer.from(b).toString("base64")}"`));
  assert.ok(svg.includes(">Stock photo · colour may differ</text>"));
  assert.ok(svg.includes('viewBox="0 0 800 450"') && svg.includes('preserveAspectRatio="xMidYMid slice"'), "16:9, like the widget's photo box");
});
test("svg: each code carries its own label, and image/jpg is written as image/jpeg", () => {
  for (const c of ["1", "2", "3"] as const) assert.ok(buildStockPhotoSvg("image/png; charset=binary", bytes(300), c)!.includes(`>${STOCK_LABELS[c]}</text>`));
  assert.ok(buildStockPhotoSvg("image/jpg", bytes(300), "1")!.includes("data:image/jpeg;base64,"));
  assert.equal(STOCK_LABELS["1"], "Stock photo");
});
test("svg: only plain raster images are embedded (an upstream SVG, HTML or a tiny body is refused)", () => {
  for (const ct of ["image/svg+xml", "text/html", "application/octet-stream", "", "image/x-icon"]) assert.equal(buildStockPhotoSvg(ct, bytes(500), "1"), null, ct);
  assert.equal(buildStockPhotoSvg("image/jpeg", bytes(50), "1"), null, "a body under 100 bytes is not a photo");
  for (const ct of ["image/jpeg", "image/png", "image/webp", "image/gif", "IMAGE/PNG"]) assert.ok(buildStockPhotoSvg(ct, bytes(500), "1"), ct);
});
test("svg: the banner stays inside the part of the picture every widget box shows (a 2:1 box crops 25px top and bottom; a 4:3 box shows the middle 600px)", () => {
  for (const c of ["1", "2", "3"] as const) {
    const svg = buildStockPhotoSvg("image/jpeg", bytes(500), c)!;
    const rectY = Number(svg.match(/<rect x="0" y="(\d+)" width="800" height="(\d+)"/)![1]), rectH = Number(svg.match(/<rect x="0" y="(\d+)" width="800" height="(\d+)"/)![2]);
    assert.ok(rectY >= 300 && rectY + rectH <= 450, "inside the picture"); assert.ok(rectY + rectH <= 435, "clear of the bottom edge");
    const fs = Number(svg.match(/font-size="(\d+)"/)![1]); const label = STOCK_LABELS[c];
    assert.ok(fs * label.length * 0.54 <= 625, `${label}: text fits the middle 620px at font ${fs}`); assert.ok(fs >= 36, "big enough to read once the card is drawn small");
  }
});
