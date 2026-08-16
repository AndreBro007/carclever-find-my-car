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
 * BASE ORDER, researched at André's request (2026-08-16, SYS-20260816-027):
 * the original order (year, radius, mileage, price) was inherited from an
 * internal doc that itself conflicts with a second internal doc describing a
 * different shipped, live-tested widget's order — neither had real research
 * behind the year/radius/mileage relationship, and neither considered that
 * "year ±2" can silently cross a full model redesign/generation boundary
 * (confirmed real via research: 2022 was the first year of the Civic's
 * 11th-gen redesign, a different platform and design from the 10th-gen 2021
 * — SYS-20260816-026), which arguably makes year the LEAST safe step to run
 * early, not the safest. Radius and mileage never change what the car
 * actually IS, only how far away or how worn it is. Real base order:
 *
 *   1. widen radius to 100 miles (real Edmunds data: US buyers travel 115mi
 *      on average to buy a used car in 2024, up from 52mi in 2019 — the
 *      previous 250mi step considerably overshot that and risked landing in
 *      a different state, adding tax/registration complexity nobody asked
 *      for; 100 stays under the real average)
 *   2. widen mileage ceiling +30%, then drop it entirely
 *   3. widen year range ±2 (generation-boundary risk noted above; no
 *      mitigation implemented yet, just moved later in the sequence)
 *   4. widen price ceiling +15% — ONLY on priceFlexibility "flexible";
 *      NEVER on "strict" (budget is sacred, per the redesign doc, and this is
 *      what keeps the SYS-20260816-004 price-ceiling fix meaningful)
 *
 * PRIORITY-AXIS AWARENESS (2026-08-16, SYS-20260816-028): the base order
 * above is a single fixed sequence applied to every search, which doesn't
 * fit this codebase's own "server stays thin, calling LLM owns intent"
 * principle used everywhere else — priorityAxis is already a real, structured
 * signal the host model decodes from what the user actually asked to
 * optimize for, and until now this module ignored it entirely. Loosening the
 * exact dimension the user said they care about most undermines the point of
 * the search, so that dimension is moved to run LAST (tried only as a final
 * resort, never removed outright — same "never silently drop a real match"
 * principle as everything else here):
 *
 *   priorityAxis "newest"         -> year runs last
 *   priorityAxis "lowest_mileage" -> mileage runs last
 *   priorityAxis "cheapest"       -> price runs last (on top of already only
 *                                    running when priceFlexibility is
 *                                    "flexible" - widening price when the
 *                                    user explicitly asked for the cheapest
 *                                    option contradicts the premise of the
 *                                    search, so this is deliberately the
 *                                    most protected combination)
 *   priorityAxis "best_for_budget" (default) or unset -> base order as-is
 *
 * goals (freeform buyer text like "reliable for a teen driver") deliberately
 * does NOT feed into this — mapping arbitrary text to a specific widening
 * dimension needs real semantic judgment, which is exactly what this
 * codebase's architecture keeps server-side out of scope (decode-then-execute
 * pattern used everywhere else in route.ts). priorityAxis is a clean fit
 * because it's already structured and already decoded by the host model;
 * goals is not.
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
  /**
   * Every step that was actually attempted (an upstream call was made),
   * regardless of whether it helped. Distinct from `relaxations`, which only
   * lists steps that DID help. Exists so a caller whose search stays empty
   * even after this runs can say what was genuinely tried and found nothing,
   * instead of a generic message suggesting options that were already
   * exhausted (SYS-20260816-030 — real André-reported failure: the tool told
   * a user "widening would likely help" on a search where widening had
   * already run across every available dimension and genuinely found
   * nothing, because Auto.dev's own inventory for that combination was
   * empty — the message contradicted what the tool itself had just done).
   */
  attemptedSteps: StepName[];
}

export type PriorityAxis = "best_for_budget" | "cheapest" | "lowest_mileage" | "newest";

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
   * What the user is actually optimizing for. Reorders the ladder so that
   * dimension is tried last rather than early — see PRIORITY-AXIS AWARENESS
   * above. Optional/undefined behaves the same as "best_for_budget".
   */
  priorityAxis?: PriorityAxis;
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

// Guarantees every dimension gets at least one real attempt regardless of
// priorityAxis ordering (SYS-20260816-048, fixing a real bug found live
// 2026-08-16: with the old value of 3, a `lowest_mileage` search with
// radius+year+price all applicable could exhaust the whole budget on those
// three before mileage — the protected, deferred-to-last dimension — was
// ever attempted at all, silently). Worst case to guarantee the LAST
// (protected) dimension gets a real shot: the 3 dimensions ahead of it can
// cost up to 4 calls total (mileage alone can cost 2 — raise, then drop —
// plus 1 each for the other two), then +1 more for the protected one = 5.
const DEFAULT_MAX_CALLS = 5;

export type StepName = "radius" | "mileage" | "year" | "price";

/** Base order — see BASE ORDER doc comment above for the research behind this. */
const BASE_ORDER: StepName[] = ["radius", "mileage", "year", "price"];

const AXIS_PROTECTS: Partial<Record<PriorityAxis, StepName>> = {
  newest: "year",
  lowest_mileage: "mileage",
  cheapest: "price",
};

/**
 * Returns step names in the order they should be attempted. The dimension
 * the user's priorityAxis is optimizing for (if any) is moved to the end —
 * still attempted as a final resort, never removed outright.
 */
function resolveStepOrder(priorityAxis: PriorityAxis | undefined): StepName[] {
  const protect = priorityAxis ? AXIS_PROTECTS[priorityAxis] : undefined;
  if (!protect) return BASE_ORDER;
  return [...BASE_ORDER.filter((s) => s !== protect), protect];
}

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
  const attemptedSteps: StepName[] = [];

  const budgetLeft = () => Date.now() < opts.deadline && calls < maxCalls;

  /**
   * Runs one widening attempt. Accepts it only if it genuinely increases the
   * number of results the user would see — a step that changes nothing is
   * discarded silently rather than disclosed as a relaxation that bought
   * nothing. Returns true once `minAcceptable` is satisfied.
   */
  async function attempt(candidateQuery: ListingsQuery, relaxation: Relaxation & { step: StepName }): Promise<boolean> {
    if (!budgetLeft()) return true; // out of budget: stop the ladder, keep what we have
    calls += 1;
    const retry = await opts.search(candidateQuery);
    if (retry.error) return false; // a failed call must never look like "widening didn't help"
    attemptedSteps.push(relaxation.step);
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

  async function runRadius(): Promise<boolean> {
    if (!(query.zip && (query.radius ?? 50) < 100)) return false;
    return attempt(
      { ...query, radius: 100 },
      { step: "radius", detail: "Widened the search radius to 100 miles — too few close matches nearby." },
    );
  }

  async function runMileage(): Promise<boolean> {
    if (query.mileageMax == null) return false;
    const raised = Math.round(query.mileageMax * 1.3);
    const done = await attempt(
      { ...query, mileageMax: raised },
      { step: "mileage", detail: `Raised the mileage ceiling by 30% (to ${raised.toLocaleString()} mi) to find more matches.` },
    );
    if (done || best >= opts.minAcceptable) return done;

    const { mileageMax: _dropped, ...withoutMileage } = query;
    return attempt(withoutMileage, {
      step: "mileage",
      detail: "Dropped the mileage limit entirely to find more matches.",
    });
  }

  async function runYear(): Promise<boolean> {
    if (!(query.yearMin != null || query.yearMax != null)) return false;
    return attempt(
      {
        ...query,
        yearMin: query.yearMin != null ? query.yearMin - 2 : undefined,
        yearMax: query.yearMax != null ? query.yearMax + 2 : undefined,
      },
      { step: "year", detail: "Widened the year range by ±2 years — too few close matches in the exact range requested." },
    );
  }

  async function runPrice(): Promise<boolean> {
    if (!(query.priceMax != null && opts.priceFlexibility === "flexible")) return false;
    const raised = Math.round(query.priceMax * 1.15);
    return attempt(
      { ...query, priceMax: raised },
      {
        step: "price",
        detail: `Raised the price ceiling by 15% (to $${raised.toLocaleString()}) — you indicated some flexibility on budget.`,
      },
    );
  }

  const runners: Record<StepName, () => Promise<boolean>> = {
    radius: runRadius,
    mileage: runMileage,
    year: runYear,
    price: runPrice,
  };

  for (const step of resolveStepOrder(opts.priorityAxis)) {
    if (best >= opts.minAcceptable) break;
    const done = await runners[step]();
    if (done) break;
  }

  return { data, total, query, relaxations, widened, attemptedSteps };
}
