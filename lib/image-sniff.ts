/**
 * Identify a picture by its first bytes (23 Oct 2026). imageonthefly.autodatadirect.com, a stock-photo service dealers use for new cars, answers with status 200 and the picture but NO
 * Content-Type header at all (the proxy's own error message said "status 200, content-type none"). Browsers work the type out from the bytes; the image proxy insisted on a header and refused
 * every one of those pictures. Only plain raster formats are recognised, by their fixed signatures; SVG, HTML and anything else stay refused.
 */
export function sniffImageType(b: Uint8Array): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** A Content-Type that says nothing about the picture: absent, or a generic binary type. Only then are the bytes consulted; a type that says text/html or image/svg+xml is believed. */
export function isGenericContentType(ct: string | null | undefined): boolean {
  const t = (ct ?? "").split(";")[0].trim().toLowerCase();
  return t === "" || t === "application/octet-stream" || t === "binary/octet-stream" || t === "application/binary";
}
