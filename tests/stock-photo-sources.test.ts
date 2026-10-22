// Which photos may stand in as a stock photo (23 Oct 2026): only studio and manufacturer sources that measured clean of text. Offline.
import test from "node:test";
import assert from "node:assert/strict";
import { STOCK_PHOTO_SOURCES, isStockPhotoSource, stockPhotoSourcePatterns } from "../lib/stock-photo-sources";

test("every source is an https prefix that ends at a path boundary, so a look-alike host cannot match", () => {
  for (const p of STOCK_PHOTO_SOURCES) { assert.match(p, /^https:\/\/[a-z0-9.-]+\/(.*\/)?$/, p); }
  assert.ok(!isStockPhotoSource("https://partners.fastly.carvana.io.evil.example/x.jpg"));
  assert.ok(!isStockPhotoSource("https://evil.example/https://partners.fastly.carvana.io/x.jpg"));
  assert.ok(!isStockPhotoSource("http://partners.fastly.carvana.io/x.jpg"), "plain http is not accepted");
});
test("studio stock photos are accepted", () => {
  for (const u of ["https://vehicle-images.carscommerce.inc/stock-images/chrome/0ad3f.webp", "https://autonationoverlays.blob.core.windows.net/anwhitebgchrome/484880/bg_wht.jpg",
    "https://autonationoverlays.blob.core.windows.net/cdstock/488375/cc_1.jpg", "https://imageonthefly.autodatadirect.com/images/?width=1200&height=900&IMG=USD50FOT212B01300.jpg",
    "https://media.rti.toyota.com/x.jpg", "https://partners.fastly.carvana.io/x.jpg", "https://images.dealer.com/x.jpg"]) assert.ok(isStockPhotoSource(u), u);
});
test("photos that carry dealer text are refused: dealer lot paths, overlays and the hosts measured with text", () => {
  for (const u of ["https://vehicle-images.carscommerce.inc/32b8-110010338/1C4PJXAG7VW566080/0b16.jpg", "https://autonationoverlays.blob.core.windows.net/nophoneoverlay/2676_5_bg_wht_x.jpg",
    "https://content.homenetiol.com/2002058/2145424/0x0/f12.jpg", "https://assets.cai-media-management.com/resize/1024x1024/common-vehicle-media/x.jpg", "https://cdn.dlron.us/x.jpg",
    "https://cdn.inventoryrsc.com/x.jpg", "https://vehicle-images.driveway.com/x.jpg", "https://pictures.dealer.com/m/mercedesbenzofcolumbiamb/x.jpg", "https://img2.carmax.com/x.jpg?wm=NoFees", ""]) assert.ok(!isStockPhotoSource(u), u);
  assert.ok(!isStockPhotoSource(null) && !isStockPhotoSource(undefined));
});
test("the SQL patterns are the prefixes with a trailing wildcard, special characters escaped", () => {
  const pats = stockPhotoSourcePatterns(); assert.equal(pats.length, STOCK_PHOTO_SOURCES.length);
  for (let i = 0; i < pats.length; i++) assert.ok(pats[i].endsWith("%") && !pats[i].slice(0, -1).includes("%"));
  assert.ok(stockPhotoSourcePatterns().every((p) => !p.includes("_") || p.includes("\\_")), "an underscore would be a LIKE wildcard, so it is escaped");
});
