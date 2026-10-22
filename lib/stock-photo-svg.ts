/**
 * The "Stock photo" watermark (23 Oct 2026). A car with no photo of its own gets a photo of ANOTHER listing of the same make, model and year (lib/catalog-db/search.ts, stockPhotos),
 * and the image proxy draws the label onto it, so every host that shows our image (Claude, ChatGPT, Meta, Lite) shows the label without any widget change.
 * The proxy returns a small SVG: the photo (embedded as base64) with a dark banner and the label across the bottom. SVG is used instead of a raster library on purpose: text drawn on the
 * server on Vercel often has no fonts, whereas the viewer's browser always has them.
 * Codes (the `stock` parameter of /api/img-proxy): 1 = same make, model, year and colour; 2 = same model and year, another colour; 3 = used car (a photo of another car, so a
 * stronger label).
 */
export type StockCode = "1" | "2" | "3";

export const STOCK_LABELS: Record<StockCode, string> = {
  "1": "Stock photo",
  "2": "Stock photo · colour may differ",
  "3": "Stock photo · not this car",
};

export function isStockCode(x: unknown): x is StockCode {
  return x === "1" || x === "2" || x === "3";
}

/** The code for a car: a used car always gets the "not this car" label; a new car says so only when the colour does not match. */
export function stockCodeFor(used: boolean | undefined, colourMatched: boolean): StockCode {
  return used === true ? "3" : colourMatched ? "1" : "2";
}

const RASTER = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The watermarked image, or null when the upstream picture is not a plain raster image (an upstream SVG is never embedded).
 * Shape (found by rendering it at the widget's real photo size, 23 Oct 2026): the widget shows a photo in a box 120px high and as wide as the card (about 1.8:1; the comparison table's box
 * is 150x84) with object-fit: cover, so a 4:3 picture lost its bottom strip and the banner with it. The picture is therefore 16:9 (800x450), the banner sits clear of the bottom edge
 * (a box up to 2:1 still shows all of it) and the text is centred inside the middle 620px (a 4:3 box still shows it), with a font size chosen from the label length so it stays about
 * 11px high when the card is drawn about 220px wide.
 */
export function buildStockPhotoSvg(contentType: string, bytes: Uint8Array, code: StockCode): string | null {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (!RASTER.has(ct) || bytes.byteLength < 100) return null;
  const b64 = Buffer.from(bytes).toString("base64");
  const text = STOCK_LABELS[code];
  const fontSize = Math.min(46, Math.floor(620 / (text.length * 0.54)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="450" viewBox="0 0 800 450">` +
    `<image x="0" y="0" width="800" height="450" preserveAspectRatio="xMidYMid slice" xlink:href="data:${ct === "image/jpg" ? "image/jpeg" : ct};base64,${b64}"/>` +
    `<rect x="0" y="358" width="800" height="72" fill="#000000" fill-opacity="0.6"/>` +
    `<text x="400" y="${358 + 36 + Math.round(fontSize * 0.35)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${esc(text)}</text>` +
    `</svg>`
  );
}
