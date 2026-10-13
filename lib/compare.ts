import zipcodes from "zipcodes";

/** One vehicle as the comparison sees it (everything optional except the VIN; unknown stays null, never guessed). */
export interface CompareItem {
  vin: string;
  year?: number | null; make?: string | null; model?: string | null; trim?: string | null;
  price?: number | null; mileage?: number | null; condition?: string | null;
  dealerZip?: string | null; fuel?: string | null; drive?: string | null; engine?: string | null;
  rating?: number | null; recallCampaigns?: number | null;
}
export interface CompareRow { label: string; values: Array<string | null>; note?: string }

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
function numericRow(label: string, vals: Array<number | null>, fmt: (n: number) => string, unit: string): CompareRow | null {
  if (vals.every((v) => v == null)) return null;
  const known = vals.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null);
  let note: string | undefined;
  if (known.length >= 2) {
    const min = Math.min(...known.map((k) => k.v)), max = Math.max(...known.map((k) => k.v));
    if (min === max) note = `same ${unit} on every vehicle that reports one`;
    else {
      const lo = known.filter((k) => k.v === min).map((k) => `#${k.i + 1}`).join(", "), hi = known.filter((k) => k.v === max).map((k) => `#${k.i + 1}`).join(", ");
      note = `lowest ${lo}; highest ${hi}; spread ${fmt(max - min)}`;
    }
  }
  return { label, values: vals.map((v) => (v == null ? null : fmt(v))), ...(note ? { note } : {}) };
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
    numericRow("Price", items.map((i) => i.price ?? null), money, "price"),
    numericRow("Mileage", items.map((i) => i.mileage ?? null), miles, "mileage"),
    numericRow("Year", items.map((i) => i.year ?? null), (n) => String(Math.round(n)), "year"),
    textRow("Trim", items.map((i) => i.trim)),
    textRow("Condition", items.map((i) => i.condition)),
    textRow("Fuel", items.map((i) => i.fuel)),
    textRow("Drive", items.map((i) => i.drive)),
    textRow("Engine", items.map((i) => i.engine)),
    numericRow("NHTSA overall rating (model year)", items.map((i) => i.rating ?? null), (n) => `${Math.round(n)} of 5`, "rating"),
    numericRow("NHTSA recall campaigns (model year, not this car)", items.map((i) => i.recallCampaigns ?? null), (n) => String(Math.round(n)), "count"),
    fromZip ? numericRow(`Distance from ${fromZip}`, items.map((i) => zipDistanceMiles(fromZip, i.dealerZip)), miles, "distance") : null,
  ];
  return rows.filter((r): r is CompareRow => r != null);
}

/** The "Differences" block of the reply text. */
export function comparisonText(rows: CompareRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- ${r.label}: ${r.values.map((v, i) => `#${i + 1} ${v ?? "unknown"}`).join(" · ")}${r.note ? ` (${r.note})` : ""}`);
  return `Differences (stated, not ranked):\n${lines.join("\n")}`;
}
