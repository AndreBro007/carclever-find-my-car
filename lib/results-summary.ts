/**
 * One plain "Summary" line for the top of a find_matching_vehicle list (22 Oct 2026, after the Chrome test runs).
 * The chat model writes its own paragraph from the tool text, and in the test runs its paragraph named cars, prices and models that were not in the list (a bZ4X at $26,798, six
 * models where the list had one). Every number here is calculated by the server from the SAME cars that are listed below it, so the model can quote it instead of working it out.
 * Rules: a price flagged as a likely data error is left out of the cheapest and the range; "lowest mileage" is only for used cars (a new car's 3 miles says nothing); nothing is
 * said that the list does not show; fewer than two cars gets no summary.
 */
export interface SummaryCard {
  identity: { year?: number | null; make?: string | null; model?: string | null; trim?: string | null };
  listing: { price?: number | null; mileage?: number | null };
  condition?: { inventoryType?: string | null } | null;
  badges?: readonly string[] | null;
}

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const label = (c: SummaryCard): string => [c.identity.year, c.identity.make, c.identity.model, c.identity.trim].filter((x) => x != null && String(x).trim() !== "").join(" ");

export function resultsSummaryLine(cards: readonly SummaryCard[]): string {
  if (cards.length < 2) return "";
  const counts = new Map<string, number>();
  for (const c of cards) {
    const name = [c.identity.make, c.identity.model].filter((x) => x != null && String(x).trim() !== "").join(" ") || "model not listed";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()];
  const parts: string[] = [`${cards.length} cars, ${names.length === 1 ? `all ${names[0][0]}` : `${names.length} models (${names.map(([n, k]) => (k > 1 ? `${n} x${k}` : n)).join(", ")})`}.`];
  const priced = cards.filter((c) => c.listing.price != null && !(c.badges ?? []).includes("price-likely-inaccurate"));
  if (priced.length > 0) {
    const cheapest = priced.reduce((a, b) => (b.listing.price! < a.listing.price! ? b : a));
    parts.push(`Cheapest ${money(cheapest.listing.price!)}: ${label(cheapest)}.`);
  }
  const usedWithMiles = cards.filter((c) => c.condition?.inventoryType === "used" && c.listing.mileage != null);
  if (usedWithMiles.length > 0) {
    const lowest = usedWithMiles.reduce((a, b) => (b.listing.mileage! < a.listing.mileage! ? b : a));
    parts.push(`Lowest mileage among the used cars ${lowest.listing.mileage!.toLocaleString("en-US")} mi: ${label(lowest)}.`);
  }
  if (priced.length > 1) {
    const prices = priced.map((c) => c.listing.price!);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    if (lo !== hi) parts.push(`Price range ${money(lo)} to ${money(hi)}.`);
  }
  return `Summary (calculated by the server from the cars listed below; quote it as it is): ${parts.join(" ")}`;
}
