/**
 * Where a "stock photo" may come from (23 Oct 2026, André: "if the image already has text on it, don't use it").
 * Reading text off a picture is not something the server can do per request, so the rule is by SOURCE, and the sources were chosen by measurement with OCR (Tesseract), in two samples
 * of real listing photos read through the image proxy: 116 photos spread evenly over 28 hosts (43 of them, 37 percent, carried text: phone numbers, dealership names and banners such as
 * "HIDDEN DEALER FEE", "CALL TEXT TODAY", "PHOTOS COMING SOON"; that share is for this host-balanced sample and is NOT a catalogue-wide rate), and 131 photos on the hosts that looked
 * clean (11 carried text; the two samples overlap). Dealer lot photos and dealer overlays are where the text is; studio stock photos (Chrome Data and manufacturer images) are not.
 * A source is listed only when the photos on it read clean:
 *   - vehicle-images.carscommerce.inc/stock-images/chrome/   5 of 5 clean   (studio photos; the dealer-specific paths on the same host carry banners and are NOT listed)
 *   - autonationoverlays.blob.core.windows.net/anwhitebgchrome/ and /cdstock/   clean   (studio photos; the /nophoneoverlay/ path carries "hidden dealer fee" overlays and is NOT listed)
 *   - imageonthefly.autodatadirect.com   a studio stock-photo service (checked by eye on a 2027 Maverick: white background, no text; the proxy cannot read it until the browser-identity retry ships)
 *   - media.rti.toyota.com   6 of 6 clean   (manufacturer images)
 *   - partners.fastly.carvana.io   35 of 35 clean
 *   - images.dealer.com   5 of 5 clean
 * Together: 0 of 51 measured images had text. Left out on purpose: every host with text on 40 to 100 percent of its images (homenetiol, cai-media-management, dlron, inventoryrsc, driveway,
 * cdn.max.auto, s3.amazonaws, dealeron, ebizautos, dealersgpt, dealersocket, dealersync, dealercarsearch, carmax) and every host with too few measured images to say. To add a source: measure
 * at least 30 of its photos with the audit script (getcarwise-docs OCR_AUDIT_SCRIPT_20261023.py) and add its prefix here.
 * This only decides which photo may stand in for a car that has none. A car's OWN photo is shown as it is, text and all.
 * Coverage (measured on cars with no photo, from a probe that sees about 46 listings per model-year, so a floor): 54 percent of them have a donor from these sources (new 47, used 85).
 */
export const STOCK_PHOTO_SOURCES: readonly string[] = [
  "https://vehicle-images.carscommerce.inc/stock-images/chrome/",
  "https://autonationoverlays.blob.core.windows.net/anwhitebgchrome/",
  "https://autonationoverlays.blob.core.windows.net/cdstock/",
  "https://imageonthefly.autodatadirect.com/",
  "https://media.rti.toyota.com/",
  "https://partners.fastly.carvana.io/",
  "https://images.dealer.com/",
];

export function isStockPhotoSource(url: string | null | undefined): boolean {
  return !!url && STOCK_PHOTO_SOURCES.some((p) => url.startsWith(p));
}

/** The prefixes as SQL LIKE patterns (the characters LIKE treats specially are escaped with a backslash, the PostgreSQL default). */
export function stockPhotoSourcePatterns(): string[] {
  return STOCK_PHOTO_SOURCES.map((p) => p.replace(/[\\%_]/g, (c) => `\\${c}`) + "%");
}
