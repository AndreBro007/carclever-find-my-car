/**
 * Group 2, item 5 (9 Nov 2026): three short statements that stop a chat over-claiming. Pure functions, counts only, no VIN and no buyer data.
 * B4(ii) stock photos: only the banner on the picture said so; no line did.
 * B3 partial NHTSA failure: a drivetrain search could return fewer cars with no word about cars that could not be checked.
 * B2 capped pool: "No vehicles matched" after a drivetrain check of a limited candidate list read like an empty market.
 */
export function stockPhotoNote(photoUrls: ReadonlyArray<string | null | undefined>): string | null {
  const total = photoUrls.length;
  const n = photoUrls.filter((u) => typeof u === "string" && u.includes("&stock=")).length;
  if (n === 0) return null;
  return n === 1
    ? `1 of these ${total} photos is a stock picture of the same model, not the actual car (the picture says so).`
    : `${n} of these ${total} photos are stock pictures of the same model, not the actual cars (the pictures say so).`;
}

/** failures: the per-request counts by class from lib/nhtsa-client.ts. "decode_error" (NHTSA answered but the VIN did not decode cleanly) is not "did not answer". */
export function noAnswerNote(noAnswerCount: number): string | null {
  const n = Math.round(noAnswerCount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n} car${n === 1 ? "" : "s"} could not be checked because NHTSA's VIN service did not answer; ${n === 1 ? "it is" : "they are"} not counted here. Trying again shortly may show more.`;
}

export function cappedDrivetrainNoMatchNote(requested: string, excluded: number, couldNotCheck: number, strictObjective: boolean): string | null {
  const checked = Math.round(excluded) + Math.round(couldNotCheck);
  if (!Number.isFinite(checked) || checked <= 0 || !requested.trim()) return null;
  const word = (k: number): string => `${k} car${k === 1 ? "" : "s"}`;
  const unknown = couldNotCheck > 0 ? ` (${couldNotCheck} could not be checked)` : "";
  return ` ${word(checked)} ${checked === 1 ? "was" : "were"} checked against the requested drivetrain (${requested.trim()}) and none had it${unknown}. The search checks a limited number of the best-ranked candidates, so adding model names${strictObjective ? ", or dropping the strict cheapest, newest or lowest-mileage order," : ""} can reach cars it did not check.`;
}
