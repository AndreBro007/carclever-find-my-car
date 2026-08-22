// HMAC-SHA256 signing/verification for /api/img-proxy authorization.
//
// Purpose: the img-proxy route fetches arbitrary caller-supplied URLs on our
// server's behalf (SSRF surface + open relay risk) unless we restrict it to
// only URLs we ourselves generated server-side. Signing does that: the
// signature covers the exact raw image URL, computed with a server-only
// secret, so a client can't get the proxy to fetch anything we didn't
// explicitly authorize.
//
// No expiry by design (per product decision) — old ChatGPT/Claude
// conversations should keep working indefinitely rather than losing vehicle
// images because a signed URL aged out.
import { createHmac, timingSafeEqual } from "crypto";

function getSecret(): string {
  const secret = process.env.IMAGE_PROXY_SECRET;
  if (!secret) {
    throw new Error("IMAGE_PROXY_SECRET is not configured");
  }
  return secret;
}

export function signImageUrl(rawImageUrl: string): string {
  return createHmac("sha256", getSecret()).update(rawImageUrl).digest("hex");
}

export function verifyImageUrlSignature(rawImageUrl: string, signature: string | null): boolean {
  if (!signature) return false;

  const expected = signImageUrl(rawImageUrl);

  // Lengths must match before timingSafeEqual (it throws on mismatched
  // buffer lengths rather than returning false).
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
