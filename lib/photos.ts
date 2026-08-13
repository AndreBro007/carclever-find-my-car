/**
 * Photo handling — lazy/non-blocking, per-photo independent validation.
 * A broken image (real observed pattern: one 403 in a 51-image gallery,
 * SYS-20260812-014) should never invalidate the rest of the gallery or the
 * result itself.
 */
import { getPhotos } from "./auto-dev-client";

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getValidatedPhotos(vin: string, maxPhotos = 3): Promise<string[]> {
  const result = await getPhotos(vin);
  if (!result || !Array.isArray(result.photos) || result.photos.length === 0) return [];

  const candidates = result.photos.slice(0, maxPhotos * 2); // check a few extra in case some fail
  const checks = await Promise.all(candidates.map((url) => isReachable(url)));

  const valid = candidates.filter((_, i) => checks[i]);
  return valid.slice(0, maxPhotos);
}
