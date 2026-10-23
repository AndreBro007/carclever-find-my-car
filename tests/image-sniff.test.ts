// Identify a picture by its first bytes (23 Oct 2026). Offline.
import test from "node:test";
import assert from "node:assert/strict";
import { sniffImageType, isGenericContentType } from "../lib/image-sniff";

const b = (...x: number[]) => Uint8Array.from([...x, ...new Array(20).fill(0)]);
test("the four raster formats are recognised by their signatures", () => {
  assert.equal(sniffImageType(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffImageType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffImageType(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), "image/gif"); assert.equal(sniffImageType(b(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)), "image/gif");
  assert.equal(sniffImageType(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), "image/webp");
});
test("SVG, HTML, text, empty and almost-signatures are never taken for a picture", () => {
  const enc = (s: string) => new TextEncoder().encode(s + " ".repeat(40));
  for (const s of ["<svg xmlns=", "<!DOCTYPE html>", "<html>", "Access Denied", "{\"error\":1}", "RIFF\u0000\u0000\u0000\u0000WAVE"]) assert.equal(sniffImageType(enc(s)), null, s);
  assert.equal(sniffImageType(new Uint8Array(0)), null); assert.equal(sniffImageType(b(0xff, 0xd8)), null, "two bytes of a JPEG signature are not enough");
  assert.equal(sniffImageType(b(0x89, 0x50, 0x4e, 0x47)), null, "a PNG needs the whole 8-byte signature");
  assert.equal(sniffImageType(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20)), null, "RIFF AVI is not WebP");
});
test("only a Content-Type that says nothing is generic: text/html and image/svg+xml are believed", () => {
  for (const g of [undefined, null, "", "application/octet-stream", "Application/Octet-Stream; charset=binary", "binary/octet-stream", "application/binary"]) assert.ok(isGenericContentType(g), String(g));
  for (const n of ["text/html", "text/plain", "image/svg+xml", "image/jpeg", "application/json", "application/xml"]) assert.ok(!isGenericContentType(n), n);
});
