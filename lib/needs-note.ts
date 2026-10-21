/**
 * The buyer's stated needs echoed in the closing line ("Also ask the dealer about: ..."), minus needs that are only a size or class label ("midsize SUV", "compact car").
 * A size label is already carried by the models chosen (tool text rule 3), so telling the buyer to ask the dealer about "midsize SUV" reads oddly and helps nobody.
 * "Family" counts as part of the class ("midsize family SUV", "family SUV"). A practical need ("towing 5,000 lbs", "good in snow", "three-row SUV") stays.
 */
const SIZE_WORDS = new Set(["subcompact", "compact", "small", "mid", "midsize", "medium", "full", "fullsize", "large", "big", "extra", "size", "sized", "class", "mid-size", "full-size", "medium-size"]);
const BODY_WORDS = new Set(["family", "suv", "suvs", "crossover", "cuv", "sedan", "truck", "pickup", "van", "minivan", "wagon", "coupe", "hatchback", "car", "vehicle", "a", "an", "the"]);

export function isSizeClassOnly(need: unknown): boolean {
  const words = String(need ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => SIZE_WORDS.has(w) || BODY_WORDS.has(w));
}

export function needsWorthAsking(needs: unknown): string[] {
  return (Array.isArray(needs) ? needs : []).map((n) => String(n ?? "").trim()).filter((n) => n && !isSizeClassOnly(n));
}
