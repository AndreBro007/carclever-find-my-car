import zipcodes from "zipcodes";

/** One vehicle as the comparison sees it (everything optional except the VIN; unknown stays null, never guessed). */
export interface CompareItem {
  vin: string;
  year?: number | null; make?: string | null; model?: string | null; trim?: string | null;
  price?: number | null; mileage?: number | null; condition?: string | null;
  /** The card carries the "price-likely-inaccurate" flag: the price is shown, but never counted as the best or as an extreme (R4-06). */
  priceLikelyInaccurate?: boolean;
  dealerZip?: string | null; fuel?: string | null; drive?: string | null; engine?: string | null;
  rating?: number | null; recallCampaigns?: number | null;
  transmission?: string | null; bodyStyle?: string | null; doors?: number | null; seats?: number | null;
  exteriorColor?: string | null; interiorColor?: string | null; dealer?: string | null;
}
export interface CompareRow { label: string; values: Array<string | null>; note?: string; /** Positions (0-based) of the best value in the row, set only for price, mileage, year and distance and only when the values differ. */ best?: number[] }

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const miles = (n: number): string => `${Math.round(n).toLocaleString("en-US")} mi`;

/** Straight-line miles between two US ZIP codes; null when either is unknown. */
export function zipDistanceMiles(a: string | null | undefined, b: string | null | undefined): number | null {
  const za = a ? zipcodes.lookup(String(a).slice(0, 5)) : null, zb = b ? zipcodes.lookup(String(b).slice(0, 5)) : null;
  if (!za || !zb) return null;
  const R = 3958.8, r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(zb.latitude - za.latitude), dLon = r(zb.longitude - za.longitude);
  return Math.round(2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(za.latitude)) * Math.cos(r(zb.latitude)) * Math.sin(dLon / 2) ** 2)));
}

/** A numeric row with a plain-words note about the extremes (lowest and highest), only when the values differ. */
function numericRow(label: string, vals: Array<number | null>, fmt: (n: number) => string, unit: string, better?: "low" | "high", flagged?: boolean[]): CompareRow | null {
  if (vals.every((v) => v == null)) return null;
  // A flagged value is displayed but is not counted: it cannot be the best, the lowest or the highest, and the row says so.
  const known = vals.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null && !flagged?.[x.i]);
  const flaggedNums = vals.map((v, i) => (v != null && flagged?.[i] ? `#${i + 1}` : null)).filter((x): x is string => x != null);
  let note: string | undefined;
  let best: number[] | undefined;
  if (known.length >= 2) {
    const min = Math.min(...known.map((k) => k.v)), max = Math.max(...known.map((k) => k.v));
    if (min === max) note = `same ${unit} on every vehicle that reports one`;
    else {
      if (better) { const target = better === "low" ? min : max; best = known.filter((k) => k.v === target).map((k) => k.i); }
      const lo = known.filter((k) => k.v === min).map((k) => `#${k.i + 1}`).join(", "), hi = known.filter((k) => k.v === max).map((k) => `#${k.i + 1}`).join(", ");
      note = `lowest ${lo}; highest ${hi}; spread ${fmt(max - min)}`;
    }
  }
  if (flaggedNums.length) note = `${note ? note + "; " : ""}${flaggedNums.join(", ")} ${flaggedNums.length === 1 ? "looks" : "look"} like a data error and ${flaggedNums.length === 1 ? "is" : "are"} not counted`;
  return { label, values: vals.map((v) => (v == null ? null : fmt(v))), ...(note ? { note } : {}), ...(best ? { best } : {}) };
}

function textRow(label: string, vals: Array<string | null | undefined>): CompareRow | null {
  const v = vals.map((x) => (x && String(x).trim() ? String(x).trim() : null));
  if (v.every((x) => x == null)) return null;
  const known = new Set(v.filter((x): x is string => x != null).map((x) => x.toLowerCase()));
  const note = known.size === 1 && v.every((x) => x != null) ? "the same on every vehicle" : undefined;
  return { label, values: v, ...(note ? { note } : {}) };
}

/** Rows that say how the vehicles differ. States differences only: no ranking, no judgement of safety. Rows with no data at all are left out. */
export function buildComparison(items: CompareItem[], fromZip?: string | null): CompareRow[] {
  const rows = [
    numericRow("Price", items.map((i) => i.price ?? null), money, "price", "low", items.map((i) => !!i.priceLikelyInaccurate)),
    numericRow("Mileage", items.map((i) => i.mileage ?? null), miles, "mileage", "low"),
    numericRow("Year", items.map((i) => i.year ?? null), (n) => String(Math.round(n)), "year", "high"),
    textRow("Trim", items.map((i) => i.trim)),
    textRow("Condition", items.map((i) => i.condition)),
    textRow("Fuel", items.map((i) => i.fuel)),
    textRow("Drive", items.map((i) => i.drive)),
    textRow("Engine", items.map((i) => i.engine)),
    textRow("Transmission", items.map((i) => i.transmission)),
    textRow("Body style", items.map((i) => i.bodyStyle)),
    numericRow("Doors", items.map((i) => i.doors ?? null), (n) => String(Math.round(n)), "door count"),
    numericRow("Seats (NHTSA)", items.map((i) => i.seats ?? null), (n) => String(Math.round(n)), "seat count"),
    textRow("Exterior color", items.map((i) => i.exteriorColor)),
    textRow("Interior color", items.map((i) => i.interiorColor)),
    textRow("Dealer", items.map((i) => i.dealer)),
    numericRow("NHTSA overall rating (model year)", items.map((i) => i.rating ?? null), (n) => `${Math.round(n)} of 5`, "rating"),
    numericRow("NHTSA recall campaigns (model year, not this car)", items.map((i) => i.recallCampaigns ?? null), (n) => String(Math.round(n)), "count"),
    fromZip ? numericRow(`Distance from ${fromZip}`, items.map((i) => zipDistanceMiles(fromZip, i.dealerZip)), miles, "distance", "low") : null,
  ];
  return rows.filter((r): r is CompareRow => r != null);
}

/** The "Differences" block of the reply text. */
export function comparisonText(rows: CompareRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- ${r.label}: ${r.values.map((v, i) => `#${i + 1} ${v ?? "unknown"}`).join(" · ")}${r.note ? ` (${r.note})` : ""}`);
  return `Differences (stated, not ranked):\n${lines.join("\n")}`;
}

const cell = (v: string): string => v.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/**
 * The comparison as a ready-made markdown table: one column per vehicle, one row per line of the Differences block, with a Vehicle and a VIN row first. The best value
 * (lowest price, lowest mileage, newest year, shortest distance) is in bold, only when the values differ; every other row, safety and recalls included, is stated without a mark.
 */
export function comparisonTable(items: CompareItem[], rows: CompareRow[]): string {
  if (rows.length === 0 || items.length < 2) return "";
  const title = (i: CompareItem) => [i.year, i.make, i.model, i.trim].filter((x) => x != null && String(x).trim() !== "").join(" ") || "unknown";
  const head = `| | ${items.map((_, i) => `#${i + 1}`).join(" | ")} |`;
  const sep = `|---|${items.map(() => "---").join("|")}|`;
  const lead = [`| Vehicle | ${items.map((i) => cell(title(i))).join(" | ")} |`, `| VIN | ${items.map((i) => cell(i.vin)).join(" | ")} |`];
  const body = rows.map((r) => `| ${cell(r.label)} | ${r.values.map((v, i) => { const t = cell(v ?? "unknown"); return r.best?.includes(i) ? `**${t}**` : t; }).join(" | ")} |`);
  return [head, sep, ...lead, ...body].join("\n");
}
