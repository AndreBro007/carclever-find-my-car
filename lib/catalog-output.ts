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
  if (c.buyerCheck) {
    const keep = (a: unknown) => (Array.isArray(a) ? a.filter((x) => x !== historyNote && !MISSING_DATA_LINE.test(String(x))) : a);
    c.buyerCheck = { ...c.buyerCheck, goodSigns: keep(c.buyerCheck.goodSigns), concerns: keep(c.buyerCheck.concerns), needsVerification: keep(c.buyerCheck.needsVerification) };
  }
  return c as T;
}

// Lines that only say "this data is missing": accident history not reported, no Carfax link, CPO not reported.
const MISSING_DATA_LINE = /(accident history|history was not reported|carfax link|cpo status was not reported)/i;
type BuyerCheckLike = { goodSigns: string[]; concerns: string[]; needsVerification: string[]; nextSteps: string[] };

/** Database mode: drop buyer-check lines about history / Carfax / CPO that the feed can never answer. Other lines stay. */
export function shapeBuyerCheckForCatalog<T extends BuyerCheckLike>(bc: T): T {
  if (!catalogOutputActive()) return bc;
  const keep = (a: string[]) => a.filter((x) => !MISSING_DATA_LINE.test(x));
  // The next-steps advice stays, but without the Carfax brand name (this app has no Carfax data or link).
  const nextSteps = bc.nextSteps.map((x) => x.replace(/\bCarfax\b/gi, "a vehicle history report"));
  return { ...bc, goodSigns: keep(bc.goodSigns), concerns: keep(bc.concerns), needsVerification: keep(bc.needsVerification), nextSteps };
}

export function shapeCardsForSource<T>(cards: T[]): T[] {
  return catalogOutputActive() ? cards.map(shapeCardForCatalog) : cards;
}

/**
 * Database app: the tool description with the sentences that were written for Auto.dev replaced by accurate ones. Everything else in the
 * description (including the wording already reviewed by directory reviewers) is left exactly as it is.
 */
export const CATALOG_DESCRIPTION_EDITS: Array<[from: string, to: string]> = [
  ["Most direct criteria are matched against actual listing data; seating, certification, and history-related requests reflect available evidence, which may be confirmed, unconfirmed, or unreported rather than guaranteed.",
   "Make, model, price, year, mileage, location, body style, condition and color are matched against listing data. Drive type, transmission, engine, fuel type and seating come from the vehicle's VIN decode where available and may be unconfirmed; certification, ownership and accident-history requests cannot be matched from this inventory and are reported as unconfirmed rather than guaranteed."],
  ["An exact 17-character VIN refers to one specific listing; if unavailable, that outcome is reported rather than substituting a similar vehicle.",
   "An exact 17-character VIN refers to one specific listing; if it is not listed, that outcome is reported with links to the exact VIN and to similar vehicles on Edmunds, rather than substituting a different vehicle."],
  ["Results include current matching listings, viewing links where available, and available evidence about confirmed, unconfirmed, or changed criteria.",
   "Results include current matching listings, viewing links where available, available evidence about confirmed, unconfirmed, or changed criteria, and, where available, NHTSA safety information for the model year (overall rating, recall campaign count, standard safety features)."],
];
export function catalogDescription(base: string): string {
  let d = base;
  for (const [from, to] of CATALOG_DESCRIPTION_EDITS) {
    if (!d.includes(from)) console.error("[catalog-output] description sentence not found, left unchanged:", from.slice(0, 60));
    d = d.replace(from, () => to);
  }
  return d;
}
