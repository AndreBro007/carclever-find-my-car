// End-to-end through the real MCP route on a real PostgreSQL (23 Oct 2026): a car with no photo of its own gets a labelled photo of another listing of the same make, model and year.
// Synthetic cars only. Skipped when TEST_DATABASE_URL is not set.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
process.env.LISTING_SOURCE = "catalog_db"; process.env.DATABASE_URL = DB ?? "postgres://unused";
process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";

import { Pool } from "pg";
import { FEED_COLUMNS, buildTrackingUrl } from "../lib/catalog-db/normalize";
import { loadFeed } from "../lib/catalog-db/load";
import { setCatalogDbPoolForTests, resetStockPhotoCacheForTests } from "../lib/catalog-db-source";

type C = { vin: string; make: string; model: string; year: number; cond: "new" | "used"; color: string; image: string | null; trim?: string; price: number };
const V = (n: number) => `1FTVE${String(n).padStart(12, "0")}`;
const CARS: C[] = [
  { vin: V(1), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "Gray", image: null, price: 30000 },                       // no photo, gray donor exists
  { vin: V(8), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "", image: "https://partners.fastly.carvana.io/nocolour.jpg", price: 30050 },   // a donor with NO colour, listed first: it must never beat a matching donor
  { vin: V(9), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "Red", image: "https://content.homenetiol.com/red-with-dealer-text.jpg", price: 30060 }, // a RED photo, but on a host whose photos carry text: never a donor
  { vin: "3N6AD1EJ0TN000001", make: "Nissan", model: "Frontier", year: 2026, cond: "new", color: "Black", image: null, price: 33000 },                  // no photo; its only possible donor is on a host with text
  { vin: "3N6AD1EJ0TN000002", make: "Nissan", model: "Frontier", year: 2026, cond: "new", color: "Black", image: "https://assets.cai-media-management.com/dealer-banner.jpg", price: 33100 },
  { vin: V(10), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "White", image: null, price: 30070 },                              // no photo; the white donor is a STUDIO photo (images.dealer.com): it cannot vouch for the colour
  { vin: V(2), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "White", image: "https://images.dealer.com/white.jpg", price: 30100 },
  { vin: V(3), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "Gray", image: "https://partners.fastly.carvana.io/gray.jpg", price: 30200 },
  { vin: V(4), make: "Ford", model: "Maverick", year: 2027, cond: "new", color: "Red", image: null, price: 30300 },                         // no photo, no red donor
  { vin: V(5), make: "Ford", model: "Maverick", year: 2027, cond: "used", color: "Black", image: null, price: 28000 },                      // used, no photo
  { vin: V(7), make: "Ford", model: "Maverick", year: 2026, cond: "new", color: "Gray", image: "https://partners.fastly.carvana.io/y2026.jpg", price: 29000 }, // other year: never a donor for 2027
  { vin: "3TMLB5JN7TM000001", make: "Toyota", model: "Tacoma", year: 2026, cond: "new", color: "Black", image: null, price: 40000 },        // no photo, no donor at all
];
const line = (c: C, n: number): string => {
  const id = `sp${String(n).padStart(29, "0")}`;
  const v: Record<string, string> = { id, title: `${c.year} ${c.make} ${c.model}`, condition: c.cond, description: "d", price: c.price.toFixed(2), image_link: c.image ?? "",
    link: buildTrackingUrl({ id, vin: c.vin, year: c.year, make: c.make, model: c.model }), availability: "InStock", identifier_exists: "no", dealer_id: String(n), dealer_name: `Dealer ${n}`,
    dealer_street: "1 Test St", dealer_city: "Houston", dealer_state: "TX", dealer_zip: "77002", dealer_radius: "200 miles", vehicle_vin: c.vin, vehicle_stock_number: "S", vehicle_year: `${c.year}.00`,
    vehicle_make: c.make, vehicle_model: c.model, vehicle_series: c.trim ?? "XL", vehicle_odometer: c.cond === "new" ? "5.00" : "30000.00", vehicle_body: "Truck", vehicle_door_number: "4.00",
    vehicle_exterior_color: c.color, vehicle_interior_color: "Black" };
  return FEED_COLUMNS.map((k) => v[k]).join("\t");
};
async function* lines(): AsyncIterable<string> { yield FEED_COLUMNS.join("\t"); let n = 1; for (const c of CARS) yield line(c, n++); }

let pool: Pool;
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const call = (id: number, name: string, args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
type Card = { identity: { vin: string }; media: { primaryImage: string | null; cardImageUrl: string | null } };
const cardsOf = (o: any): Card[] => o.result.structuredContent.results;
const rawOf = (u: string | null): string | null => (u ? new URL(u).searchParams.get("u") : null);
const stockOf = (u: string | null): string | null => (u ? new URL(u).searchParams.get("stock") : null);

before(async () => {
  if (!DB) return;
  globalThis.fetch = (async () => new Response(JSON.stringify({ Results: [{ ErrorCode: "0" }] }), { status: 200 })) as typeof fetch;
  pool = new Pool({ connectionString: DB, max: 2 });
  await pool.query("DROP TABLE IF EXISTS listing, dealer, listing_stage, catalog_meta CASCADE");
  await loadFeed(pool, lines());
  setCatalogDbPoolForTests(pool);
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
});
beforeEach(() => { resetStockPhotoCacheForTests(); delete process.env.STOCK_PHOTOS; });
after(async () => { if (!DB) return; setCatalogDbPoolForTests(null); await pool.end(); });
const opts = { skip: DB ? false : "TEST_DATABASE_URL not set" };

test("a new car with no photo gets the photo of another same-year listing in the SAME colour, labelled 1 (stock photo)", opts, async () => {
  const cs = cardsOf(await call(10, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const a = cs.find((c) => c.identity.vin === V(1))!;
  assert.equal(rawOf(a.media.cardImageUrl), "https://partners.fastly.carvana.io/gray.jpg", "the gray donor, not the white one");
  assert.equal(stockOf(a.media.cardImageUrl), "1");
  assert.equal(a.media.primaryImage, null, "the car's own image field stays empty: the schema is unchanged");
});
test("no donor of the same colour: another colour is used and labelled 2 (colour may differ)", opts, async () => {
  const cs = cardsOf(await call(11, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const red = cs.find((c) => c.identity.vin === V(4))!;
  assert.equal(stockOf(red.media.cardImageUrl), "2");
  assert.ok(["https://images.dealer.com/white.jpg", "https://partners.fastly.carvana.io/gray.jpg", "https://partners.fastly.carvana.io/nocolour.jpg"].includes(rawOf(red.media.cardImageUrl)!), rawOf(red.media.cardImageUrl)!);
  assert.notEqual(rawOf(red.media.cardImageUrl), "https://partners.fastly.carvana.io/y2026.jpg", "a photo of another model YEAR is never used");
});
test("a used car with no photo gets a stock photo labelled 3 (not this car)", opts, async () => {
  const cs = cardsOf(await call(12, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const used = cs.find((c) => c.identity.vin === V(5))!;
  assert.equal(stockOf(used.media.cardImageUrl), "3"); assert.ok(rawOf(used.media.cardImageUrl));
});
test("a car with its own photo keeps it, with no stock label", opts, async () => {
  const cs = cardsOf(await call(13, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  for (const [vin, img] of [[V(2), "https://images.dealer.com/white.jpg"], [V(3), "https://partners.fastly.carvana.io/gray.jpg"], [V(9), "https://content.homenetiol.com/red-with-dealer-text.jpg"]] as const) {
    const c = cs.find((x) => x.identity.vin === vin)!;
    assert.equal(rawOf(c.media.cardImageUrl), img); assert.equal(stockOf(c.media.cardImageUrl), null, "no stock label on a real photo");
  }
});
test("a model with no photo anywhere stays without one (the widget draws its placeholder)", opts, async () => {
  const cs = cardsOf(await call(14, "find_matching_vehicle", { make: "Toyota", model: "Tacoma" }));
  assert.equal(cs.length, 1); assert.equal(cs[0].media.cardImageUrl, null);
});
test("an exact VIN lookup of a car with no photo gets the stock photo too", opts, async () => {
  const cs = cardsOf(await call(15, "find_matching_vehicle", { vin: V(1) }));
  assert.equal(stockOf(cs[0].media.cardImageUrl), "1");
});
test("STOCK_PHOTOS=off switches the fallback off", opts, async () => {
  process.env.STOCK_PHOTOS = "off";
  const cs = cardsOf(await call(16, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  assert.equal(cs.find((c) => c.identity.vin === V(1))!.media.cardImageUrl, null);
  assert.ok(cs.find((c) => c.identity.vin === V(2))!.media.cardImageUrl, "real photos are unaffected");
});
test("the signed address still verifies, so the proxy accepts it", opts, async () => {
  const { verifyImageUrlSignature } = await import("../lib/image-proxy-sign");
  const cs = cardsOf(await call(17, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const u = new URL(cs.find((c) => c.identity.vin === V(1))!.media.cardImageUrl!);
  assert.ok(verifyImageUrlSignature(u.searchParams.get("u")!, u.searchParams.get("sig")));
});

test("a donor with no recorded colour never outranks one that matches (PostgreSQL sorts NULL first when descending)", opts, async () => {
  const cs = cardsOf(await call(18, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const gray = cs.find((c) => c.identity.vin === V(1))!;
  assert.equal(rawOf(gray.media.cardImageUrl), "https://partners.fastly.carvana.io/gray.jpg"); assert.equal(stockOf(gray.media.cardImageUrl), "1");
  const red = cs.find((c) => c.identity.vin === V(4))!;
  assert.equal(stockOf(red.media.cardImageUrl), "2", "no red donor: another colour, honestly labelled");
  const blank = cs.find((c) => c.identity.vin === V(8))!;
  assert.equal(rawOf(blank.media.cardImageUrl), "https://partners.fastly.carvana.io/nocolour.jpg", "the no-colour car keeps its own photo");
});
test("a car with no recorded colour of its own still gets a stock photo, labelled colour may differ", opts, async () => {
  const { stockPhotos } = await import("../lib/catalog-db/search");
  const r = await stockPhotos(pool as never, [{ vin: V(99), makeKey: "ford", modelKey: "maverick", year: 2027, color: "", trim: "" }]);
  assert.equal(r.length, 1); assert.equal(r[0].colourMatched, false);
});

test("a photo from a host whose pictures carry text is never used, even when it is the only one in the car's colour", opts, async () => {
  const cs = cardsOf(await call(19, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const red = cs.find((c) => c.identity.vin === V(4))!;
  assert.notEqual(rawOf(red.media.cardImageUrl), "https://content.homenetiol.com/red-with-dealer-text.jpg"); assert.equal(stockOf(red.media.cardImageUrl), "2", "another colour, from a stock source");
  for (const c of cs) if (stockOf(c.media.cardImageUrl)) assert.ok(!/homenetiol|cai-media|dlron|inventoryrsc|driveway/.test(rawOf(c.media.cardImageUrl)!), rawOf(c.media.cardImageUrl)!);
});
test("a model whose only possible donor carries text gets no stock photo at all (the placeholder stays)", opts, async () => {
  const cs = cardsOf(await call(20, "find_matching_vehicle", { make: "Nissan", model: "Frontier" }));
  const noPhoto = cs.find((c) => c.identity.vin === "3N6AD1EJ0TN000001")!;
  assert.equal(noPhoto.media.cardImageUrl, null);
  assert.equal(rawOf(cs.find((c) => c.identity.vin === "3N6AD1EJ0TN000002")!.media.cardImageUrl), "https://assets.cai-media-management.com/dealer-banner.jpg", "the car's own photo is untouched");
});

test("a donor recorded in the same colour but on a studio source is labelled 'colour may differ' (the studio photo has its own colour)", opts, async () => {
  const cs = cardsOf(await call(21, "find_matching_vehicle", { make: "Ford", model: "Maverick", yearMin: 2027, yearMax: 2027 }));
  const white = cs.find((c) => c.identity.vin === V(10))!;
  assert.equal(rawOf(white.media.cardImageUrl), "https://images.dealer.com/white.jpg", "the white donor is still preferred");
  assert.equal(stockOf(white.media.cardImageUrl), "2", "but it cannot claim the colour matches");
  const gray = cs.find((c) => c.identity.vin === V(1))!;
  assert.equal(stockOf(gray.media.cardImageUrl), "1", "a Carvana photo is of the actual car, so its colour is believed");
});
