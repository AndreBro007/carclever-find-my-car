// T134 amendment 3: the recall campaigns NHTSA lists for a make, model and model year, shaped for the "Many recalls on record" list.
// Pure functions: no network, no storage. The same NHTSA response that gives the count gives these fields, so the count and the list always agree.
// NHTSA's open data lists campaigns by make, model and model year only: a campaign can cover "certain vehicles", so it may not apply to one VIN.

export interface RecallItem {
  /** Campaign number as NHTSA writes it in its reports, e.g. 16V-725; null when NHTSA gave none. */
  id: string | null;
  /** Month and year NHTSA received the report, e.g. "Oct 2016"; null when the date is missing or unreadable. */
  when: string | null;
  /** Affected component in plain words, e.g. "Parking brake". */
  component: string | null;
  /** NHTSA's own summary, cleaned and cut to one short line. */
  summary: string | null;
}
export interface RecallList {
  /** Every campaign NHTSA returned (equals the recall count shown on the page). */
  total: number;
  /** The newest campaigns, at most MAX_SHOWN. */
  items: RecallItem[];
}

export const MAX_SHOWN = 10;
const MAX_SUMMARY = 150;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 16V725000 becomes 16V-725 (the form NHTSA uses in its reports); anything else is kept as given, short. */
export function campaignLabel(v: unknown): string | null {
  const s = str(v)?.toUpperCase();
  if (!s) return null;
  const m = /^(\d{2}[A-Z])(\d{3})(\d{3})?$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : s.slice(0, 20);
}

/** NHTSA's ReportReceivedDate is day/month/year ("11/10/2016" is 11 October 2016). Returns a label and a sort key, or nulls. */
export function reportedOn(v: unknown): { label: string | null; sort: number } {
  const s = str(v);
  const m = s ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s) : null;
  if (!m) return { label: null, sort: 0 };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1950 || year > 2100) return { label: null, sort: 0 };
  return { label: `${MONTHS[month - 1]} ${year}`, sort: year * 10000 + month * 100 + day };
}

/** "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP" becomes "Fuel system, gasoline" (the first part, sentence case). */
export function componentLabel(v: unknown): string | null {
  const first = str(v)?.split(":")[0]?.trim();
  if (!first) return null;
  const lower = first.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function shortSummary(v: unknown): string | null {
  const s = str(v)?.replace(/\s+/g, " ");
  if (!s) return null;
  if (s.length <= MAX_SUMMARY) return s;
  const cut = s.slice(0, MAX_SUMMARY);
  const at = cut.lastIndexOf(" ");
  return `${(at > 80 ? cut.slice(0, at) : cut).replace(/[ ,.;:]+$/, "")}…`;
}

/**
 * NHTSA's summaries usually open with a sentence about WHICH vehicles are covered ("Honda is recalling certain 2013-2023 Accord, Civic ...") and only then say
 * what is wrong. The page has room for one short line, so when there is more than one sentence and the first one is that "is recalling" sentence, the line
 * starts at the next sentence (the defect). A one-sentence summary is kept whole. Cut to a short line either way.
 */
export function defectSummary(v: unknown): string | null {
  const s = str(v)?.replace(/\s+/g, " ");
  if (!s) return null;
  const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const rest = sentences.length > 1 && /\brecalling\b/i.test(sentences[0]) ? sentences.slice(1).join(" ") : s;
  return shortSummary(rest);
}

/** Shapes NHTSA's result list: newest first, at most MAX_SHOWN shown, total = how many NHTSA returned. A malformed entry still counts. */
export function recallListFor(results: unknown[]): RecallList {
  const rows = results.map((r, i) => {
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const d = reportedOn(o.ReportReceivedDate);
    const item: RecallItem = { id: campaignLabel(o.NHTSACampaignNumber), when: d.label, component: componentLabel(o.Component), summary: defectSummary(o.Summary) };
    return { item, sort: d.sort, i };
  });
  rows.sort((a, b) => b.sort - a.sort || a.i - b.i);
  return { total: results.length, items: rows.slice(0, MAX_SHOWN).map((r) => r.item) };
}
