// Vehicle investigation (release 4, 11 Nov 2026): the two next-step links under the check_vehicle block, mirrored from the website (carclever-widget lib/vin-check-links.ts, blob 64ef1a34).
//   1. "Helpful reading": the Edmunds model-year review when we have verified that page, otherwise the new-car or used-car buying guide;
//   2. an optional trade-in link (Edmunds "Sell Your Car", Impact asset 3949601).
// Pure functions: no network, no storage, no buyer-typed text. Every link goes through Impact (rule of 19 Oct 2026) with the platform-and-role Shared ID of lib/shared-id-context.ts.
// The rules (six verified review pages, the two guide addresses, the new-or-used rule) are the website's: keep them in step if either side changes.
import { wrapWithAffiliateNetwork, withSharedId, slugify } from "./edmunds-cj";
import { sharedIdTag } from "./shared-id-context";

/** Impact "Sell Your Car" asset 3949601 starting link (one hop to Edmunds' sell-car page; verified 21 Sep 2026). */
export const SELL_YOUR_CAR_BASE = "https://edmunds.sjv.io/c/7765200/3949601/52125";
export const GUIDE_URLS = {
  used: "https://www.edmunds.com/car-buying/how-to-buy-a-used-car.html",
  new: "https://www.edmunds.com/car-buying/10-steps-to-buying-a-new-car.html",
} as const;
/**
 * Edmunds model-year pages opened and confirmed on 11 Nov 2026 (make/model/year, Edmunds' own slugs). Only these get a review link; every other car gets the buying
 * guide, because a page cannot be tested at request time and a dead link would hurt trust. Grow this list only with pages that were actually opened.
 */
export const VERIFIED_REVIEW_PAGES: ReadonlySet<string> = new Set([
  "honda/cr-v/2024",
  "toyota/rav4-hybrid/2023",
  "chevrolet/silverado-1500/2021",
  "ford/f-150/2022",
  "hyundai/ioniq-5/2022",
  "bmw/3-series/2019",
]);

export type GuideKind = "new" | "used";
/** A listed car says new or used itself; otherwise the model year decides: the current or a newer model year gets the new-car guide. */
export function guideKindFor(used: boolean | null | undefined, modelYear: number, now: Date): GuideKind {
  if (used === true) return "used";
  if (used === false) return "new";
  return modelYear >= now.getUTCFullYear() ? "new" : "used";
}

export function reviewUrlFor(v: { year: number | null; make: string | null; model: string | null }): string | null {
  const make = slugify(v.make);
  const model = slugify(v.model);
  if (!make || !model || v.year == null || !Number.isInteger(v.year)) return null;
  return VERIFIED_REVIEW_PAGES.has(`${make}/${model}/${v.year}`) ? `https://www.edmunds.com/${make}/${model}/${v.year}/` : null;
}

export interface ReadingLink { kind: "review" | "guide_new" | "guide_used"; text: string; url: string; note?: string }

export function readingLinkFor(i: { vehicle: { year: number | null; make: string | null; model: string | null }; used: boolean | null | undefined; now?: Date }): ReadingLink {
  const now = i.now ?? new Date();
  const review = reviewUrlFor(i.vehicle);
  if (review) {
    return { kind: "review", text: `Edmunds ${i.vehicle.year} ${i.vehicle.make} ${i.vehicle.model} review`, url: wrapWithAffiliateNetwork(review, sharedIdTag("review")), note: "A model-year review, not a check of this car." };
  }
  return guideKindFor(i.used, i.vehicle.year ?? 0, now) === "new"
    ? { kind: "guide_new", text: "Edmunds new-car buying guide", url: wrapWithAffiliateNetwork(GUIDE_URLS.new, sharedIdTag("guide")) }
    : { kind: "guide_used", text: "Edmunds used-car buying guide", url: wrapWithAffiliateNetwork(GUIDE_URLS.used, sharedIdTag("guide")) };
}

export function tradeInLink(): { text: string; url: string } {
  return { text: "Replacing a car? See what yours could sell for or trade in for on Edmunds", url: withSharedId(SELL_YOUR_CAR_BASE, sharedIdTag("tradein")) };
}
