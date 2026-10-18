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
  try {
    if (single) {
      const open: ListingsQuery = { ...query, priceMin: undefined, priceMax: undefined, classHint: undefined, sort: "price.asc", limit: 60 };
      let r = await search(open);
      let scope = query.zip ? `near ZIP ${query.zip}` : "in the catalogue";
      let rows = r.error ? [] : r.data;
      if (!rows.length && query.zip) {
        r = await search({ ...open, zip: undefined, radius: undefined, state: undefined });
        rows = r.error ? [] : r.data;
        scope = `anywhere in the country (none near ZIP ${query.zip})`;
      }
      const top = pick(rows, 3, false);
      if (top.length) {
        return `\n\nClosest ${condition}${make} ${model} options ${scope}, lowest price first.${query.priceMax != null ? ` These are over your budget:` : opts.trim ? ` None is the ${opts.trim} trim you asked for:` : opts.unmet ? ` None is confirmed ${opts.unmet}:` : ""}\n` +
          top.map((l, i) => describe(l, i + 1)).join("\n") + (query.priceMax != null ? `\n(Shown for comparison only: they are above your price limit.)` : "");
      }
    }
    const wide: ListingsQuery = { ...query, model: undefined, classHint: undefined, sort: "price.asc", limit: 60 };
    const r2 = await search(wide);
    const top2 = r2.error ? [] : pick(r2.data, 3, true);
    if (top2.length) {
      return `\n\nNo ${condition}${make} ${model || "vehicles"} listings matched. Other ${make} models inside your filters:\n` + top2.map((l, i) => describe(l, i + 1)).join("\n");
    }
  } catch {
    /* alternatives are a courtesy; never let them break the reply */
  }
  return "";
}
