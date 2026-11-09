/**
 * Group 2, item 2C (9 Nov 2026): when the buyer asked for a strict objective (cheapest, newest, lowest mileage) and several of the cars shown have the SAME value on that objective (for example every
 * shown car is model year 2027 under "newest"), the order inside that tie was never explained. One plain sentence says so and says how the tie is ordered; it is the order the comparators in
 * lib/explicit-axis-order.ts really use. Nothing is said when no car ties with the first one. A presentation line, not a defect fix (André, 7 Nov).
 */
export interface TieCard { identity: { year?: number | null }; listing: { price?: number | null; mileage?: number | null } }
type Axis = "cheapest" | "newest" | "lowest_mileage";

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

export function tieNote(cards: readonly TieCard[], axis: unknown): string | null {
  if (axis !== "cheapest" && axis !== "newest" && axis !== "lowest_mileage") return null;
  const a = axis as Axis;
  if (cards.length < 2) return null;
  const val = (c: TieCard): number | null => {
    const v = a === "cheapest" ? c.listing.price : a === "newest" ? c.identity.year : c.listing.mileage;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const first = val(cards[0]);
  if (first === null) return null;
  const n = cards.filter((c) => val(c) === first).length;
  if (n < 2) return null;
  const what = a === "cheapest" ? `price ${money(first)}` : a === "newest" ? `model year ${first}` : `mileage ${first.toLocaleString("en-US")} mi`;
  const rest = a === "cheapest" ? "mileage, then newer year" : a === "newest" ? "mileage, then price" : "price, then newer year";
  return `${n === cards.length ? `All ${n}` : `${n} of these ${cards.length}`} cars tie on ${what}; within the tie they are listed by ${rest}, then VIN.`;
}
