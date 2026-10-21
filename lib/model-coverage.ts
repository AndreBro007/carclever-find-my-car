/**
 * Model coverage for a request that names several models (SYS-20261021-017, option A).
 *
 * In a general search the AI, not the buyer, picks the models. Left alone, best-for-budget lets one model's cars fill the whole result and the buyer never learns
 * that the others have matches (a real test told the buyer "Sorento and Santa Fe returned no matches" when both had 8 cars). Three small helpers, all inert for a request
 * naming fewer than two models:
 *   interleaveByGroup  puts the cars of each requested model in turn, so the first NHTSA batches (and the first rows) cover every model;
 *   applyModelCoverage keeps the ranking but gives each requested model that has a car a seat in the shortlist (at most `maxReserve` seats are changed);
 *   modelsNotShown     names the requested models that matched but did not make the shortlist, with their lowest price.
 */
import { modelFamily } from "./electrified-models";

export interface ModelGroup { key: string; name: string }

/** The distinct models asked for, by family ("Highlander" and "Highlander Hybrid" are one group), in the order given. */
export function requestedGroups(models: string | undefined | null): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const raw of String(models ?? "").split(",")) {
    const name = raw.trim();
    const key = modelFamily(name);
    if (name && key && !out.some((g) => g.key === key)) out.push({ key, name });
  }
  return out;
}

/** The group a car's model belongs to, or null when it matches none of the requested models. */
export function groupKeyOf(model: unknown, groups: ModelGroup[]): string | null {
  const fam = modelFamily(String(model ?? ""));
  return groups.find((g) => g.key === fam)?.key ?? null;
}

/** Round-robin by group: first car of each group, then the second of each, and so on. Within a group the order is kept; cars of no group go last. Fewer than two groups: unchanged. */
export function interleaveByGroup<T>(pool: T[], keyOf: (t: T) => string | null, groups: ModelGroup[]): T[] {
  if (groups.length < 2) return pool;
  const lanes = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of pool) {
    const k = keyOf(c) ?? "";
    if (!lanes.has(k)) { lanes.set(k, []); order.push(k); }
    lanes.get(k)!.push(c);
  }
  const named = order.filter((k) => k !== ""); const rest = lanes.get("") ?? [];
  const out: T[] = [];
  for (let i = 0; named.some((k) => i < lanes.get(k)!.length); i++) for (const k of named) { const c = lanes.get(k)![i]; if (c !== undefined) out.push(c); }
  return [...out, ...rest];
}

/**
 * True when every requested model that has cars in `pool` has been tried enough: at least one confirmed car, or two cars decoded without one, or all its cars decoded.
 * `results[i]` belongs to `pool[i]` (the decoded prefix). Stops the NHTSA batches from ending before a model has had a chance.
 */
export function coverageReached<T>(pool: T[], results: unknown[], keyOf: (t: T) => string | null, isConfirmed: (r: unknown) => boolean, groups: ModelGroup[]): boolean {
  if (groups.length < 2) return true;
  for (const g of groups) {
    let total = 0, decoded = 0, confirmed = 0;
    pool.forEach((c, i) => { if (keyOf(c) !== g.key) return; total++; if (i < results.length) { decoded++; if (isConfirmed(results[i])) confirmed++; } });
    if (total > 0 && confirmed === 0 && decoded < Math.min(2, total)) return false;
  }
  return true;
}

/**
 * `ranked` is in the order the buyer would see. Keep its first `targetCount` cars, except: every requested model that has a car in `ranked` but none in that
 * first block gets its best-ranked car, replacing the lowest-ranked car of a model that has more than one in the block (never the only car of a model).
 * At most `maxReserve` replacements. The rest of `ranked` follows, in order.
 */
export function applyModelCoverage<T extends { vehicle?: { model?: unknown } | null }>(ranked: T[], groups: ModelGroup[], targetCount: number, maxReserve = 4): T[] {
  if (groups.length < 2 || ranked.length <= targetCount) return ranked;
  const keyOf = (c: T) => groupKeyOf(c.vehicle?.model, groups);
  let block = ranked.slice(0, targetCount);
  const tail = ranked.slice(targetCount);
  const present = (k: string | null) => block.filter((c) => keyOf(c) === k).length;
  const missing: T[] = [];
  for (const g of groups) { if (present(g.key) === 0) { const best = tail.find((c) => keyOf(c) === g.key); if (best) missing.push(best); } }
  missing.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  let used = 0;
  const moved: T[] = [];
  for (const m of missing) {
    if (used >= maxReserve) break;
    let victim = -1;
    for (let i = block.length - 1; i >= 0; i--) { const k = keyOf(block[i]); if (present(k) > 1) { victim = i; break; } }
    if (victim < 0) break;
    tail.splice(tail.indexOf(m), 1);
    moved.push(block[victim]);
    block = [...block.slice(0, victim), ...block.slice(victim + 1), m];
    used++;
  }
  return [...block, ...moved, ...tail];
}

/**
 * Requested models that have a car among `candidates` but none among `shown`, with the lowest price among the cars that were checked.
 * That is an example, not the model's lowest price: only some of a model's cars are checked (a real test showed a Tucson at $45,110 while the model's hybrids start at $35,824),
 * so callers must say "for example", never "from".
 */
export function modelsNotShown<T extends { vehicle?: { model?: unknown } | null; retailListing?: { price?: number | null } | null }>(candidates: T[], shown: Array<{ model?: unknown }>, groups: ModelGroup[]): Array<{ name: string; examplePrice: number | null }> {
  if (groups.length < 2) return [];
  const shownKeys = new Set(shown.map((s) => groupKeyOf(s.model, groups)));
  const out: Array<{ name: string; examplePrice: number | null }> = [];
  for (const g of groups) {
    if (shownKeys.has(g.key)) continue;
    const cars = candidates.filter((c) => groupKeyOf(c.vehicle?.model, groups) === g.key);
    if (cars.length === 0) continue;
    const prices = cars.map((c) => c.retailListing?.price).filter((p): p is number => typeof p === "number" && p > 0);
    out.push({ name: g.name, examplePrice: prices.length ? Math.min(...prices) : null });
  }
  return out;
}
