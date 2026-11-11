/** R4-6 step 4b (11 Nov 2026): the words of the Show 8 more reply. Every number comes from the list's arrays (counts equal rows); nothing is typed or invented (design section 4, rules 5 and 6). */
import { SLATE_CAP, type ExcludeReason, type SlateCounts } from "./slate";

export const LEFT_OUT_WORDS: Record<ExcludeReason, string> = {
  contradicted_filter: "no longer match your filters",
  outside_radius: "outside the search area",
  removed: "no longer listed",
  limit_break: "now outside your limits",
};

export function leftOutPhrase(c: SlateCounts): string {
  const parts = (Object.keys(LEFT_OUT_WORDS) as ExcludeReason[]).filter((k) => c.leftOut[k] > 0).map((k) => `${c.leftOut[k]} ${LEFT_OUT_WORDS[k]}`);
  return parts.length ? parts.join(", ") : "";
}

/** One status line, then the one sentence that tells the buyer what asking again can do. Three end states kept apart: pending (retry), only could-not-check (final), nothing left. */
export function statusText(c: SlateCounts, requested: number): string {
  const bits = [`${c.shown} cars shown`, `${c.added} added`];
  const lo = leftOutPhrase(c); if (lo) bits.push(`${c.leftOutTotal} left out (${lo})`);
  if (c.pending > 0) bits.push(`${c.pending} could not be checked right now`);
  if (c.couldNotCheck > 0) bits.push(`${c.couldNotCheck} could not be verified and are not shown`);
  let tail: string;
  if (c.state === "pending_retry") tail = `${c.pending} cars could not be checked right now; ask again to retry.`;
  else if (c.state === "only_could_not_check") tail = `No more verified matches in this list. ${c.couldNotCheck} cars could not be verified and are not shown; start a new search to look again.`;
  else if (c.state === "none_left") tail = "No more verified matches in this list.";
  else if (requested > c.shown && c.canAdd > 0) tail = "Ask again to add more.";
  else tail = c.canAdd > 0 && c.shown < SLATE_CAP ? `Ask for up to ${Math.min(c.canAdd, SLATE_CAP - c.shown)} more.` : "";
  return `${bits.join(" · ")}.${tail ? " " + tail : ""}`;
}

export function notFoundText(status: "unknown" | "expired" | "unavailable"): string {
  if (status === "expired") return "That list has expired (lists are kept for 24 hours). Run a new search to get a fresh list.";
  if (status === "unavailable") return "I could not read the saved list just now. Try again in a moment, or run a new search.";
  return "I could not find a list with that reference. Check the reference printed under the search results, or run a new search.";
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export interface SlotLineData { n: number; title: string; vin: string; price: number | null; miles: number | null; used: boolean | null; place: string; firstPrice: number }

/** One numbered line per slot: the same number and VIN as before, the current price with "was $X when first shown" when it moved. */
export function slotLine(d: SlotLineData): string {
  const priceBit = d.price == null ? `price not available (${money(d.firstPrice)} when first shown)` : Math.round(d.price) === Math.round(d.firstPrice) ? money(d.price) : `${money(d.price)} (was ${money(d.firstPrice)} when first shown)`;
  const bits = [priceBit, d.miles != null ? `${d.miles.toLocaleString("en-US")} mi` : "", d.used === true ? "Used" : d.used === false ? "New" : ""].filter(Boolean).join(", ");
  return `${d.n}. ${d.title} — VIN ${d.vin} — ${bits}${d.place ? ` — ${d.place}` : ""}`;
}
export const gone = (n: number, vin: string, firstPrice: number) => `${n}. VIN ${vin} — no longer listed (${money(firstPrice)} when first shown); it keeps this number.`;
export const unchecked = (n: number, vin: string, firstPrice: number) => `${n}. VIN ${vin} — could not be re-checked just now (${money(firstPrice)} when first shown).`;
