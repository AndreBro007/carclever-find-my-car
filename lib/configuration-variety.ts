/**
 * Configuration-variety pass (extracted from app/[transport]/route.ts,
 * fix/provider-string-runtime-safety, SYS-20260828) — moved into its own
 * module so configurationKey() can be exercised directly by tests
 * (route.ts is a Next.js route file; only specific named exports like
 * GET/POST/config are permitted there, so this couldn't be tested via a
 * plain named export). Pure extraction — no ranking/grouping semantics
 * changed, same function bodies, same behavior, only the runtime-safety
 * String() coercion already applied to configurationKey() before this move.
 */
import type { AutoDevListing } from "./auto-dev-client";

/**
 * EXPERIMENT (preview only, follow-up to d5805cc): configuration-variety
 * pass. Observed regression in the F-150 fixture: applyLocalBestForBudgetOrdering()
 * above (unchanged, still exactly as in d5805cc) can legitimately rank a
 * batch of near-identical fleet units at the very top when they share the
 * best year+mileage combination in the pool — 5 distinct VINs, same
 * 2026/F-150/STX/price/mileage. That's not a bug in the ranking itself
 * (they genuinely tied on every ranked dimension); it's a visible-shortlist
 * diversity problem this pass addresses separately.
 *
 * Ordering only — never discards a candidate. First pass keeps at most
 * maxPerConfig per (make|model|year|trim) key, in the existing ranked
 * order; anything over the cap is appended to the END, in its own existing
 * relative order, not dropped. So if inventory really is homogeneous (e.g.
 * only 3 total F-150s exist at any price), the normal shortlist/backfill
 * mechanism downstream can still pull the overflow candidates in and fill
 * every result slot exactly as before — this only changes visible-ordering
 * preference among an otherwise-tied pool, not eligibility or count.
 *
 * Missing trim is normalized to "" consistently — never invented/guessed —
 * so two candidates that both lack a reported trim still correctly group
 * together as one "unknown trim" configuration rather than each getting a
 * unique key.
 *
 * Runtime-safety fix (fix/provider-string-runtime-safety, SYS-20260828):
 * make/model/trim are all String()-coerced before .trim()/.toLowerCase()
 * — confirmed live via temporary diagnostic logging against a real
 * production request ("bodyType": "SUV", no model filter) that a genuine
 * Auto.dev listing can report vehicle.trim as a NUMBER (observed: 1958,
 * not a string) despite the client's own declared `trim?: string` type.
 * A bare `(c.vehicle?.trim ?? "").trim()` only substitutes the ""
 * fallback for null/undefined — a non-null, non-string value (like that
 * number) sails through unchanged and crashes on `.trim()`, exactly the
 * production failure this fixes. This is the same failure class already
 * documented and fixed for model matching specifically in
 * lib/model-match.ts (2026-08-14) — never applied here until now.
 * String(1958) -> "1958", which still `.trim().toLowerCase()`s safely and
 * produces a normal (if unhelpful) configuration key rather than
 * crashing — the malformed value is coerced to its most literal string
 * reading, never invented into some other trim name, and never silently
 * dropped either (the listing is still fully usable, just with the
 * malformed trim showing up as its own literal string in the grouping
 * key — a real, if imperfect, value, not a guess).
 */
export function configurationKey(c: AutoDevListing): string {
  const make = String(c.vehicle?.make ?? "").trim().toLowerCase();
  const model = String(c.vehicle?.model ?? "").trim().toLowerCase();
  const year = c.vehicle?.year ?? "";
  const trim = String(c.vehicle?.trim ?? "").trim().toLowerCase(); // missing -> "" — never invented
  return `${make}|${model}|${year}|${trim}`;
}

export function applyConfigurationVarietyPass(
  candidates: AutoDevListing[],
  maxPerConfig = 2,
): AutoDevListing[] {
  const seenCount = new Map<string, number>();
  const withinCap: AutoDevListing[] = [];
  const overflow: AutoDevListing[] = [];

  for (const c of candidates) {
    const key = configurationKey(c);
    const count = seenCount.get(key) ?? 0;
    if (count < maxPerConfig) {
      withinCap.push(c);
      seenCount.set(key, count + 1);
    } else {
      overflow.push(c); // never discarded — appended below, existing relative order preserved
    }
  }

  return [...withinCap, ...overflow];
}

