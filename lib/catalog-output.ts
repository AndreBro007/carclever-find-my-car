import { configuredMode } from "./source-mode";

/** True when the app answers from our own catalogue database (LISTING_SOURCE=catalog_db). */
export function catalogOutputActive(): boolean {
  return configuredMode() === "catalog_db";
}

const DETAIL_DROP = ["carfaxUrl", "cpoNote", "ownerHistoryNote", "seatsNote", "dataConfidence", "historyUsageType", "historyPersonalUse", "titleStatus"];

function without<T extends Record<string, unknown>>(o: T | undefined, keys: string[]): T | undefined {
  if (!o || typeof o !== "object") return o;
  const c: Record<string, unknown> = { ...o };
  for (const k of keys) delete c[k];
  return c as T;
}

/**
 * Database mode: leave out fields that can never carry data from the Edmunds feed (no replacement source exists), so the
 * calling model is not shown empty fields or "not reported" warnings. Runs AFTER all card logic (ranking, qualifier
 * accounting, buyer check), so nothing computed from these fields changes. Fields that could be filled later from the
 * VIN decoder (drivetrain, engine, transmission, cylinders, seats, fuel type) are kept.
 */
export function shapeCardForCatalog<T>(card: T): T {
  const c = { ...(card as Record<string, any>) };
  const historyNote: string | undefined = c.history?.note;
  delete c.risk;
  delete c.history;
  c.identity = without(c.identity, ["series", "squishVin", "bodyStyleConfig"]);
  c.condition = without(c.condition, ["cpo", "cpoEvidenceState"]);
  c.body = without(c.body, ["vehicleType"]);
  c.listing = without(c.listing, ["rawVdp", "resolvedDestination", "destinationClass"]);
  c.links = without(c.links, ["dealerListingUrl"]);
  c.media = without(c.media, ["photoUrls"]);
  c.detail = without(c.detail, DETAIL_DROP);
  if (c.buyerCheck && historyNote) {
    const keep = (a: unknown) => (Array.isArray(a) ? a.filter((x) => x !== historyNote) : a);
    c.buyerCheck = { ...c.buyerCheck, goodSigns: keep(c.buyerCheck.goodSigns), concerns: keep(c.buyerCheck.concerns), needsVerification: keep(c.buyerCheck.needsVerification) };
  }
  return c as T;
}

export function shapeCardsForSource<T>(cards: T[]): T[] {
  return catalogOutputActive() ? cards.map(shapeCardForCatalog) : cards;
}
