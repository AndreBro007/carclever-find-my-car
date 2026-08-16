/**
 * Thin-result widening ladder — adapted from the proven design in
 * AUTODEV_V2_NLP_SEARCH_REDESIGN.md §5.4 (Sky redesign, approved July 26).
 *
 * HISTORY / WHY THIS WAS REWRITTEN (2026-08-16, SYS-20260816-008):
 * The original `searchWithLoosening()` was bypassed on Aug 13 per André's
 * request — "search itself needs to work correctly before any widening logic
 * runs on top of it." That precondition is now met (the stage-2 price-ceiling
 * bug SYS-20260816-004 is fixed and the full A/B/C prompt suite verified
 * 9/9 on Aug 16), so widening is being re-enabled — but NOT by simply
 * un-commenting the old call, which would have regressed three things built
 * since it was written:
 *
 *   1. It called the heavy `searchListings()`. route.ts has since moved to a
 *      two-stage lean search (SYS-20260812-060). The search function is now
 *      INJECTED so the caller keeps its own strategy.
 *   2. It owned a `scopeNote: "local" | "nationwide"` field. route.ts now owns
 *      a three-way local/statewide/nationwide disclosure (SYS-20260815-013),
 *      so scope is no longer this module's concern at all.
 *   3. Its "Step 0 ZIP guard" duplicated the ZIP validation + nationwide
 *      fallback route.ts gained on Aug 15 (SYS-20260815-012). Running both
 *      would have produced two conflicting disclosures for one situation.
 *      That step is deliberately GONE from this module.
 *
 * Ladder order (cheapest/least-intrusive first, budget preserved until last):
 *   1. widen year range ±2
 *   2. widen radius to 100 miles (2026-08-16: was 250 — real Edmunds data
 *      shows average US distance traveled to buy a used car is 115mi
 *      (2024), up from 52mi (2019); 250 overshot that, and risked landing
 *      in a different state, adding tax/registration complexity the user
 *      didn't ask for. 100 stays under the real-world average and is far
 *      less likely to cross a state line for most ZIPs.)
 *   3. widen mileage ceiling +30%, then drop it entirely
 *   4. widen price ceiling +15% — ONLY on priceFlexibility "flexible";
 *      NEVER on "strict" (budget is sacred, per the redesign doc). This is
 *      also what keeps the SYS-20260816-004 price-ceiling fix intact.
 *
 * Every step taken is reported in `relaxations`, never silent
 * (SYS-20260812-011 #3). Widening only ever LOOSENS a constraint — it never
 * narrows one. (Real Aug 16 finding: the host model's own ad hoc retry
 * lowered the user's price ceiling when results looked thin, which can only
 * shrink the candidate pool. Server-side widening exists partly to make that
 * unnecessary.)
 *
 * Trim and seats are never part of this ladder — they were never sent as
 * hard filters in the first place (SYS-20260812-023/025).
 */
import type { AutoDevListing, ListingsQuery, ListingsResponse } from "./auto-dev-client";

export interface Relaxation {
  step: string;
  detail: string;
}

export interface WidenOutcome {
  data: AutoDevListing[];
  total: number;
  /** The query that actually produced `data`. Callers MUST verify against this, not the original. */
  query: ListingsQuery;
  relaxations: Relaxation[];
  /** True only if a widening step actually improved the usable count. */
  widened: boolean;
}

export interface WidenOptions {
  /** Injected so the caller keeps its own search strategy (lean vs full). */
  search: (query: ListingsQuery) => Promise<ListingsResponse>;
  /**
   * How many results the user would actually SEE for a given row set + query.
   * Injected because that means post-verification AND diversity — this module
   * must not re-implement either, or the two definitions will drift.
   */
  usableCount: (rows: AutoDevListing[], query: ListingsQuery) => number;
  /** Stop as soon as this many usable results exist. */
  minAcceptable: number;
  priceFlexibility: "strict" | "flexible";
  /**
   * Absolute epoch-ms cutoff. No NEW upstream call is started past it.
   * Mandatory: vercel.json caps this route at 60s and a single lean search can
   * take 40s worst case (25s + 15s retry), so unbounded widening would
   * reproduce the real Aug 12 loosening-ladder timeout incident.
   */
  deadline: number;
  /** Hard cap on upstream calls, independent of the clock. */
  maxCalls?: number;
}

const DEFAULT_MAX_CALLS = 3;

export async function widenSearchIfThin(
  baseQuery: ListingsQuery,
  current: { data: AutoDevListing[]; total: number },
  opts: WidenOptions,
): Promise<WidenOutcome> {
  const relaxations: Relaxation[] = [];
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;

  let query: ListingsQuery = { ...baseQuery };
  let data = current.data;
  let total = current.total;
  let best = opts.usableCount(data, query);
  let calls = 0;
  let widened = false;

  const budgetLeft = () => Date.now() < opts.deadline && calls < maxCalls;

  /**
   * Runs one widening attempt. Accepts it only if it genuinely increases the
   * number of results the user would see — a step that changes nothing is
   * discarded silently rather than disclosed as a relaxation that bought
   * nothing. Returns true once `minAcceptable` is satisfied.
   */
  async function attempt(candidateQuery: ListingsQuery, relaxation: Relaxation): Promise<boolean> {
    if (!budgetLeft()) return true; // out of budget: stop the ladder, keep what we have
    calls += 1;
    const retry = await opts.search(candidateQuery);
    if (retry.error) return false; // a failed call must never look like "widening didn't help"
    const count = opts.usableCount(retry.data, candidateQuery);
    if (count > best) {
      query = candidateQuery;
      data = retry.data;
      total = retry.total;
      best = count;
      widened = true;
      relaxations.push(relaxation);
    }
    return best >= opts.minAcceptable;
  }

  // Step 1 — widen year range ±2
  if (best < opts.minAcceptable && (query.yearMin != null || query.yearMax != null)) {
    const done = await attempt(
      {
        ...query,
        yearMin: query.yearMin != null ? query.yearMin - 2 : undefined,
        yearMax: query.yearMax != null ? query.yearMax + 2 : undefined,
      },
      { step: "year_range", detail: "Widened the year range by ±2 years — too few close matches in the exact range requested." },
    );
    if (done) return { data, total, query, relaxations, widened };
  }

  // Step 2 — widen radius. Only meaningful when a real location is in play.
  if (best < opts.minAcceptable && query.zip && (query.radius ?? 50) < 100) {
    const done = await attempt(
      { ...query, radius: 100 },
      { step: "radius", detail: "Widened the search radius to 100 miles — too few close matches nearby." },
    );
    if (done) return { data, total, query, relaxations, widened };
  }

  // Step 3 — widen the mileage ceiling, then drop it entirely.
  if (best < opts.minAcceptable && query.mileageMax != null) {
    const raised = Math.round(query.mileageMax * 1.3);
    const done = await attempt(
      { ...query, mileageMax: raised },
      { step: "mileage", detail: `Raised the mileage ceiling by 30% (to ${raised.toLocaleString()} mi) to find more matches.` },
    );
    if (done) return { data, total, query, relaxations, widened };

    if (best < opts.minAcceptable) {
      const { mileageMax: _dropped, ...withoutMileage } = query;
      const done2 = await attempt(withoutMileage, {
        step: "mileage",
        detail: "Dropped the mileage limit entirely to find more matches.",
      });
      if (done2) return { data, total, query, relaxations, widened };
    }
  }

  // Step 4 — price, ONLY when the user signalled flexibility. On "strict" the
  // ceiling is never touched: that is the whole point of strict, and it is what
  // keeps the SYS-20260816-004 over-budget-results fix meaningful.
  if (best < opts.minAcceptable && query.priceMax != null && opts.priceFlexibility === "flexible") {
    const raised = Math.round(query.priceMax * 1.15);
    await attempt(
      { ...query, priceMax: raised },
      {
        step: "price",
        detail: `Raised the price ceiling by 15% (to $${raised.toLocaleString()}) — you indicated some flexibility on budget.`,
      },
    );
  }

  return { data, total, query, relaxations, widened };
}
