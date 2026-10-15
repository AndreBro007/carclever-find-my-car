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
  c.hideRiskPill = true; // no evidence behind the RISK badge in database mode
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
  // Catalogue: the feed has no certification or history data, and the listing page on Edmunds is the place to check them.
  const CATALOG_DROP = /Certified Pre-Owned|\bCPO\b|certif|history|Carfax|accident|cannot be confirmed from the VIN alone|Recall reported|model\/year-level/i;
  const keep = (a: string[]) => a.filter((x) => !MISSING_DATA_LINE.test(x) && !CATALOG_DROP.test(x));
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
   "An exact 17-character VIN refers to one specific listing; if it is not listed, that outcome is reported with a link to similar vehicles on Edmunds, rather than substituting a different vehicle."],
  ["Results include current matching listings, viewing links where available, and available evidence about confirmed, unconfirmed, or changed criteria.",
   "Results include current matching listings, viewing links where available, available evidence about confirmed, unconfirmed, or changed criteria, and, where available, NHTSA safety information for the model year (overall rating, recall campaign count, standard safety features)."],
];
export const CATALOG_DESCRIPTION_APPENDIX = " To compare two or more specific vehicles from a list side by side, use compare_vehicles; for recalls and red flags on one vehicle, use check_vehicle. Each result links to its Edmunds listing, where the buyer can verify the details and contact the dealer.";
export function catalogDescription(base: string): string {
  let d = base;
  for (const [from, to] of CATALOG_DESCRIPTION_EDITS) {
    if (!d.includes(from)) console.error("[catalog-output] description sentence not found, left unchanged:", from.slice(0, 60));
    d = d.replace(from, () => to);
  }
  return d.trimEnd() + CATALOG_DESCRIPTION_APPENDIX;
}

/**
 * Database app: the per-car text the AI reads (many AI hosts rely mostly on the text, not the structured data). Adds one line of vehicle
 * details (fuel, drive, engine, transmission, seats) and one line of NHTSA safety information (rating, model-year recall count, up to 4
 * standard features). Returns "" for other apps and for cars with nothing to show.
 */
export function nhtsaTextLines(c: any, active: boolean = catalogOutputActive()): string {
  if (!active || !c) return "";
  const p = c.powertrain ?? {}, d = c.detail ?? {};
  const spec = [d.fuelTypeDisplay, p.drivetrain, p.engine, p.transmission, d.seats ? `${d.seats} seats` : null].filter((x) => typeof x === "string" ? x.trim() : x).join(" · ");
  const safety: string[] = [];
  if (d.nhtsaOverallRating) safety.push(`NHTSA ${d.nhtsaOverallRating}★ overall`);
  if (d.nhtsaRecallCampaigns > 0) safety.push(`${d.nhtsaRecallCampaigns} recall campaign${d.nhtsaRecallCampaigns === 1 ? "" : "s"} for this model year`);
  const feats: string[] = Array.isArray(d.standardSafetyTech) ? d.standardSafetyTech : [];
  if (feats.length) safety.push(`NHTSA lists as standard: ${feats.slice(0, 4).join(", ")}${feats.length > 4 ? ` +${feats.length - 4} more` : ""}. Confirm which of these come with this trim with the dealer.`);
  return (spec ? `\n   ${spec}` : "") + (safety.length ? `\n   ${safety.join(" · ")}` : "");
}

/** One footnote (not one per car) explaining what a recall count means; "" when no car shows one. */
export function nhtsaTextFootnote(cards: any[], active: boolean = catalogOutputActive()): string {
  if (!active || !cards.some((c) => c?.detail?.nhtsaRecallCampaigns > 0)) return "";
  return "\n\nNote: recall counts are for the model year, not specific to a car, and do not say whether a recall was repaired; a buyer can check a VIN at nhtsa.gov/recalls.";
}

/**
 * Database app, check_vehicle: the V3 tool description with the phrases written for Auto.dev replaced. This inventory carries no accident or
 * certification history, and our result lists are numbered (not lettered). Everything else in the description is left exactly as it is.
 */
export const CHECK_VEHICLE_DESCRIPTION_EDITS: Array<[from: string, to: string]> = [
  ["(e.g. 'check option A', 'any recalls on the second one', 'is this Camry safe to buy')", "(e.g. 'check number 2', 'any recalls on the second one', 'is this Camry safe to buy')"],
  ["Returns a Buyer Check (identity verification, accident/CPO history, next steps) when a VIN is supplied,", "Returns a Buyer Check (identity verification and next steps; this inventory carries no accident or certification history) when a VIN is supplied,"],
  ["this tool is for one already-identified vehicle only.", "this tool is for one already-identified vehicle only; to compare two or more vehicles side by side use compare_vehicles."],
  ["so 'status needs verification' is a normal, honest result, not an error).", "so 'status needs verification' is a normal, honest result, not an error). For a used car with a VIN the result also includes NHTSA's free VIN lookup link, which shows whether that specific car has an unrepaired recall."],
];
export function catalogCheckVehicleDescription(base: string): string {
  if (!catalogOutputActive()) return base;
  let d = base;
  for (const [from, to] of CHECK_VEHICLE_DESCRIPTION_EDITS) {
    if (!d.includes(from)) console.error("[catalog-output] check_vehicle description sentence not found, left unchanged:", from.slice(0, 60));
    d = d.replace(from, () => to);
  }
  return d;
}

/**
 * Database app: "Just added" and "Price dropped" signals from the daily loads. Honest scope: the feed has no listing age, so "just added"
 * means the car first appeared in OUR listings within the last 3 days (never "new on the market"); a price drop is a fall of at least $100
 * recorded between two daily loads within the last 7 days. Cars that were already stored before tracking began have no first-seen date
 * and are never labelled.
 */
export const JUST_ADDED_DAYS = 3;
export const PRICE_DROP_DAYS = 7;
export const PRICE_DROP_MIN = 100;
function daysAgo(ymd: string | undefined, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  if (!m) return null;
  return Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000);
}
export function freshnessSignals(
  cat: { firstSeen?: string; priceWas?: number; priceChangedAt?: string } | undefined,
  price: number | null | undefined,
  now: Date = new Date(),
): { justAdded?: true; priceDrop?: { amount: number; was: number; on: string } } {
  const out: { justAdded?: true; priceDrop?: { amount: number; was: number; on: string } } = {};
  if (!cat) return out;
  const fa = daysAgo(cat.firstSeen, now);
  if (fa != null && fa >= 0 && fa <= JUST_ADDED_DAYS) out.justAdded = true;
  const pc = daysAgo(cat.priceChangedAt, now);
  if (pc != null && pc >= 0 && pc <= PRICE_DROP_DAYS && cat.priceWas != null && price != null && cat.priceWas - price >= PRICE_DROP_MIN && cat.priceChangedAt) {
    out.priceDrop = { amount: cat.priceWas - price, was: cat.priceWas, on: cat.priceChangedAt };
  }
  return out;
}
const shortDate = (ymd: string): string => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** One text line under a car: "Just added to the listings · Price dropped $1,200 (was $32,990, changed Oct 21)". "" when neither applies or in other apps. */
export function freshnessTextLine(c: any, active: boolean = catalogOutputActive()): string {
  if (!active || !c?.detail) return "";
  const d = c.detail, bits: string[] = [];
  if (d.justAdded) bits.push("Just added to the listings");
  if (d.priceDrop) bits.push(`Price dropped $${d.priceDrop.amount.toLocaleString("en-US")} (was $${d.priceDrop.was.toLocaleString("en-US")}, changed ${shortDate(d.priceDrop.on)})`);
  return bits.length ? `\n   ${bits.join(" · ")}` : "";
}
