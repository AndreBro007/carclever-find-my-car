/**
 * What to show when a search matches nothing: real alternatives with links, never a bare "not found".
 *
 *   Tier 1  same make and model with the price limit removed (the closest options over budget), nearest area first,
 *           then anywhere in the country, always labelled so the buyer can see what is being shown and why.
 *   Tier 2  when the model has no listings at all: other models from the same make inside the buyer's own filters.
 *
 * Text only: the result list stays empty, so nothing here is presented as a match.
 */
import type { VehicleListing, ListingsQuery } from "./listing-types";
import { resolveLinks } from "./link-resolution";

export type AlternativesSearch = (q: ListingsQuery) => Promise<{ data: VehicleListing[]; error?: string }>;

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const one = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

function describe(l: VehicleListing, n: number): string {
  const v = l.vehicle ?? {}, r = l.retailListing ?? {};
  const title = [v.year, v.make, v.model, v.trim].filter((x) => x != null && String(x).trim() !== "").join(" ");
  const price = r.price != null ? money(r.price) : "price not listed";
  const miles = r.miles != null ? `${Number(r.miles).toLocaleString("en-US")} mi` : "mileage not listed";
  const where = [r.dealer, [r.city, r.state].filter(Boolean).join(", ")].filter((x) => x && String(x).trim()).join(", ");
  const links = resolveLinks(l);
  const link = links.affiliateUrl ?? links.affiliateFallbackUrl;
  return `${n}. ${title} - ${price}, ${miles}${where ? ` - ${where}` : ""}${link ? `\n   ${link}` : ""}`;
}

function pick(rows: VehicleListing[], max: number, distinctModels: boolean): VehicleListing[] {
  const seen = new Set<string>(), out: VehicleListing[] = [];
  const sorted = [...rows].filter((l) => l.retailListing?.price != null).sort((a, b) => (a.retailListing!.price as number) - (b.retailListing!.price as number));
  for (const l of sorted) {
    const key = distinctModels ? `${one(l.vehicle?.make)}|${one(l.vehicle?.model)}`.toLowerCase() : one(l.vin ?? (l as any).vehicle?.vin);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

export async function buildNoResultsAlternatives(query: ListingsQuery, search: AlternativesSearch, opts: { trim?: string; unmet?: string } = {}): Promise<string> {
  const make = one(query.make), model = one(query.model);
  if (!make) return "";
  const single = model && !model.includes(",") && !make.includes(",");
  const condition = query.used === false ? "new " : query.used === true ? "used " : "";
  let failed = false;
  const items = (rows: VehicleListing[], distinct: boolean): string => pick(rows, 3, distinct).map((l, i) => describe(l, i + 1)).join("\n");
  /** Nearest area first (when a ZIP was given), then the whole country; says which one it used. */
  const nearThenNationwide = async (q: ListingsQuery): Promise<{ rows: VehicleListing[]; scope: string }> => {
    let r = await search(q);
    if (r.error) failed = true;
    let rows = r.error ? [] : r.data;
    if (rows.length || !query.zip) return { rows, scope: query.zip ? `near ZIP ${query.zip}` : "in the catalogue" };
    r = await search({ ...q, zip: undefined, radius: undefined, state: undefined });
    if (r.error) failed = true;
    rows = r.error ? [] : r.data;
    return { rows, scope: `anywhere in the country (none near ZIP ${query.zip})` };
  };
  try {
    if (single) {
      // 1. Same model and condition with the price limit removed.
      const open: ListingsQuery = { ...query, priceMin: undefined, priceMax: undefined, sort: "price.asc", limit: 60 };
      const a = await nearThenNationwide(open);
      const shown = pick(a.rows, 3, false);
      if (shown.length) {
        // Say WHY nothing matched: only call them "over budget" when every one really is; otherwise it is the trim or the electric/hybrid requirement.
        const over = query.priceMax != null && shown.every((l) => (l.retailListing?.price as number) > (query.priceMax as number));
        const why = over ? ` These are over your budget:` : opts.trim ? ` None is the ${opts.trim} trim you asked for:` : opts.unmet ? ` None is confirmed ${opts.unmet}:` : "";
        return `\n\nClosest ${condition}${make} ${model} options ${a.scope}, lowest price first.${why}\n` + items(a.rows, false) + (over ? `\n(Shown for comparison only: they are above your price limit.)` : "");
      }
      // 2. None in that condition at all: the same model in the other condition.
      if (query.used !== undefined) {
        const b = await nearThenNationwide({ ...open, used: undefined });
        if (pick(b.rows, 3, false).length) {
          const other = query.used === false ? "Used" : "New";
          return `\n\nNo ${condition}${make} ${model} listings found. ${other} ones ${b.scope}, lowest price first:\n` + items(b.rows, false) +
            (query.priceMax != null ? `\n(Shown for comparison only: ${other.toLowerCase()} cars, and above your price limit where marked.)` : "");
        }
      }
    }
    // 3. The model has no listings at all: other models from the same make inside the buyer's own filters.
    const wide: ListingsQuery = { ...query, model: undefined, sort: "price.asc", limit: 60 };
    const r3 = await search(wide);
    if (r3.error) failed = true;
    const top3 = r3.error ? [] : pick(r3.data, 3, true);
    if (top3.length) return `\n\nNo ${condition}${make} ${model || "vehicles"} listings matched. Other ${make} models inside your filters:\n` + top3.map((l, i) => describe(l, i + 1)).join("\n");
    // 4. Still nothing: other models of the make with the price limit and condition removed, clearly labelled.
    const r4 = await search({ ...wide, priceMin: undefined, priceMax: undefined, used: undefined });
    if (r4.error) failed = true;
    const top4 = r4.error ? [] : pick(r4.data, 3, true);
    if (top4.length) return `\n\nNo ${condition}${make} ${model || "vehicles"} listings matched. Other ${make} models, lowest price first (these do not match your price limit or condition):\n` + top4.map((l, i) => describe(l, i + 1)).join("\n");
  } catch (e) {
    failed = true;
    console.error("[no-results-alternatives] failed:", e instanceof Error ? e.message : String(e)); // a courtesy, never allowed to break the reply, but never silent either
  }
  if (failed) {
    console.error("[no-results-alternatives] no alternatives shown because a search failed");
    return "\n\n(Similar-vehicle options could not be loaded just now; trying again in a moment may show them.)";
  }
  return "";
}
