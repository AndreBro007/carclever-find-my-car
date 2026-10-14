/**
 * One footnote for cars whose seat count is not reported, instead of a repeated "Confirmed" line on every car.
 * Pure function, database mode only (the caller decides when to add it).
 */
export function seatUnknownFootnote(cards: ReadonlyArray<{ intentConfirmations: string[] }>): string {
  const n = cards.filter((c) => c.intentConfirmations.some((x) => x.startsWith("Seating capacity not reported"))).length;
  if (n === 0) return "";
  return n === 1
    ? "\n\nSeating capacity is not reported for 1 of these cars, so it cannot be confirmed for that car."
    : `\n\nSeating capacity is not reported for ${n} of these cars, so it cannot be confirmed for them.`;
}
