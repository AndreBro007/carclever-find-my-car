import { catalogOutputActive } from "./catalog-output";

/**
 * NHTSA's free recall lookup, pre-filled with a VIN (André, Oct 14, from his own testing: https://www.nhtsa.gov/recalls?vymm=<VIN>).
 * A plain government link: no affiliate wrapper, no Shared ID, and nothing is fetched from NHTSA per car; the buyer clicks it.
 * What NHTSA says its VIN search shows: whether this car has an UNREPAIRED recall from a participating manufacturer. What it does not
 * show: recalls already repaired, some very recent recalls, recalls older than 15 years, small manufacturers, non-safety campaigns.
 */
export const NHTSA_RECALLS_URL = "https://www.nhtsa.gov/recalls";
export function nhtsaRecallCheckUrl(vin: string | null | undefined): string | null {
  const v = (vin ?? "").trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? `${NHTSA_RECALLS_URL}?vymm=${v}` : null;
}
/** Card field for a USED car only (database app); {} otherwise. */
export function nhtsaLinkField(vin: string | null | undefined, used: boolean, active: boolean = catalogOutputActive()): { nhtsaRecallCheckUrl?: string } {
  const u = active && used ? nhtsaRecallCheckUrl(vin) : null;
  return u ? { nhtsaRecallCheckUrl: u } : {};
}

const ADVICE = "then call or email the dealer to confirm, and ask for a vehicle history report (many dealers provide one free)";
const SCOPE = "NHTSA's lookup covers participating manufacturers and does not show recalls that were already repaired";

/** One footnote under a list that contains used cars: how to check ANY listed car for an unrepaired recall. "" otherwise. */
export function recallCheckFootnote(cards: any[], active: boolean = catalogOutputActive()): string {
  if (!active || !Array.isArray(cards) || !cards.some((c) => c?.links?.nhtsaRecallCheckUrl)) return "";
  return `\n\nBefore contacting a dealer: check a specific car for open (unrepaired) recalls with NHTSA's free VIN lookup, ${NHTSA_RECALLS_URL}?vymm=<the car's VIN>, ${ADVICE}. ${SCOPE}.`;
}
/** The same advice with the car's own link, for a single car (VIN lookup, check_vehicle). "" for new cars and in other apps. */
export function recallCheckLine(card: any, active: boolean = catalogOutputActive()): string {
  const u = active ? card?.links?.nhtsaRecallCheckUrl : null;
  return u ? `\nOpen recalls on THIS car: check its VIN with NHTSA's free lookup, ${u}, ${ADVICE}. ${SCOPE}.` : "";
}
/** Adds the recall-check step to a Buyer Check's next steps (used cars, database app). Returns the same object when nothing applies. */
export function addRecallCheckStep<T extends { nextSteps: string[] }>(bc: T, card: any, active: boolean = catalogOutputActive()): T {
  const u = active ? card?.links?.nhtsaRecallCheckUrl : null;
  return u ? { ...bc, nextSteps: [...bc.nextSteps, `Check this VIN for open (unrepaired) recalls with NHTSA's free lookup (${u}), ${ADVICE}.`] } : bc;
}
