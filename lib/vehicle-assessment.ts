/**
 * Vehicle assessment (T134 Test build): the short "facts, conflicts, unknowns, dealer questions" block that check_vehicle adds for ONE known VIN.
 * Pure functions, no network and no storage. Seller-supplied details are used only inside the one call: they are cleaned, compared and echoed back,
 * labelled as the seller's words, and never stored or logged by this module.
 *
 * Rules this module enforces (handoff HANDOFF_VEHICLE_INVESTIGATION_TEST_BUILD_CLAUDE_20261109.md):
 * - catalogue facts and seller-supplied claims are always separate and labelled;
 * - "not listed" is stated for a decoded VIN with no catalogue row, and no link to that specific car is offered;
 * - a failed catalogue lookup is "unavailable", never "not listed";
 * - nothing is invented: no valuation, history, condition, battery health, physical location or stock confirmation.
 */

export interface SellerInput { price?: number | null; mileage?: number | null; dealer?: string | null; notes?: string | null }
export interface SellerDetails { price: number | null; mileage: number | null; dealer: string | null; notes: string | null }

const MAX_DEALER = 160;
const MAX_NOTES = 600;
const clean = (s: unknown, max: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t ? t : null;
};
const num = (n: unknown, lo: number, hi: number): number | null => (typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null);

/** Cleans what the buyer supplied from the seller's listing. Returns null when nothing usable was supplied. Out-of-range numbers are dropped, not guessed. */
export function cleanSellerDetails(i: SellerInput | null | undefined): SellerDetails | null {
  if (!i) return null;
  const d: SellerDetails = { price: num(i.price, 1, 5_000_000), mileage: num(i.mileage, 0, 2_000_000), dealer: clean(i.dealer, MAX_DEALER), notes: clean(i.notes, MAX_NOTES) };
  return d.price == null && d.mileage == null && d.dealer == null && d.notes == null ? null : d;
}

export type AssessmentStatus = "listed" | "not_listed" | "catalogue_unavailable" | "identity_only";

export interface CatalogueFacts {
  price: number | null; mileage: number | null; dealer: string | null; city: string | null; state: string | null; zip: string | null;
  used: boolean | null;
  /** Date the catalogue row last CHANGED (loaded_at). The loader leaves unchanged rows alone, so this is "last changed", not "last confirmed". */
  rowChangedAt: string | null;
}

export interface Conflict { field: "price" | "mileage" | "dealer" | "dealer_location"; seller: string; catalogue: string | null; note: string }

export interface Assessment {
  version: 1;
  status: AssessmentStatus;
  identity: { title: string | null; source: "NHTSA VIN decode" | "catalogue listing" | "typed by the buyer" | "none"; confirmedByDecode: boolean };
  catalogue: { checked: boolean; listed: boolean | null; facts: CatalogueFacts | null; snapshotNote: string };
  seller: SellerDetails | null;
  conflicts: Conflict[];
  unknowns: string[];
  dealerQuestions: string[];
  continuation: { kind: "edmunds_listing_link" | "similar_vehicles_only" | "none"; note: string };
  alternatives: { offered: false; note: string };
}

export interface AssessmentInput {
  vin: string | null;
  status: AssessmentStatus;
  title: string | null;
  decodeConfirmed: boolean;
  /** True when the title comes from the catalogue row (a listed car) rather than from what the buyer typed. */
  titleFromCatalogue?: boolean;
  facts?: CatalogueFacts | null;
  seller: SellerDetails | null;
}

const usd = (n: number) => "$" + n.toLocaleString("en-US");
const mi = (n: number) => n.toLocaleString("en-US") + " mi";
const STOP = new Set(["the", "of", "and", "inc", "llc", "auto", "autos", "motors", "motor", "cars", "car", "group", "sales", "center", "online", "only"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

/** True when the seller's text names two or more places (for example a page header and a vehicle store block): the conflict is kept, never resolved by guessing. */
export function namesSeveralPlaces(s: string): string[] {
  const parts = s.split(/\s*(?:\/|;|\||\bvs\.?\b|\bversus\b|\bor\b)\s*/i).map((p) => p.trim()).filter((p) => p.length >= 3);
  return parts.length >= 2 ? parts : [];
}

export function buildAssessment(i: AssessmentInput): Assessment {
  const f = i.facts ?? null;
  const listed = i.status === "listed" ? true : i.status === "not_listed" ? false : null;
  const s = i.seller;
  const conflicts: Conflict[] = [];

  if (s && f) {
    if (s.price != null && f.price != null && s.price !== f.price) {
      conflicts.push({ field: "price", seller: usd(s.price), catalogue: usd(f.price), note: `Seller-supplied ${usd(s.price)} versus catalogue ${usd(f.price)} (difference ${usd(Math.abs(s.price - f.price))}). Capture time, fees or a price change can explain this; confirm the price in writing.` });
    }
    if (s.mileage != null && f.mileage != null && s.mileage !== f.mileage) {
      conflicts.push({ field: "mileage", seller: mi(s.mileage), catalogue: mi(f.mileage), note: `Seller-supplied ${mi(s.mileage)} versus catalogue ${mi(f.mileage)} (difference ${mi(Math.abs(s.mileage - f.mileage))}). Different capture times or rounding can explain a small gap; ask for the current reading.` });
    }
    if (s.dealer && f.dealer) {
      const a = new Set(tokens(s.dealer)), b = tokens(`${f.dealer} ${f.city ?? ""}`);
      if (a.size > 0 && b.length > 0 && !b.some((t) => a.has(t))) conflicts.push({ field: "dealer", seller: s.dealer, catalogue: f.dealer, note: `Seller-supplied dealer/location "${s.dealer}" does not appear to match the catalogue dealer "${f.dealer}". Treat the physical store as unconfirmed.` });
    }
  }
  if (s?.dealer) {
    const places = namesSeveralPlaces(s.dealer);
    if (places.length >= 2) conflicts.push({ field: "dealer_location", seller: s.dealer, catalogue: f?.dealer ?? null, note: `The seller details name more than one location (${places.join("; ")}). Which physical store holds the car is not established; it is not chosen from a group name or page header.` });
  }

  const unknowns: string[] = [];
  if (i.status === "not_listed") {
    unknowns.push("Price, mileage, dealer and location for this VIN: the checked catalogue has no record of it.");
    unknowns.push("Whether it's for sale elsewhere: check similar listings on Edmunds and ask the dealer.");
  } else if (i.status === "catalogue_unavailable") {
    unknowns.push("Whether this VIN is listed: the catalogue did not answer, so nothing here says anything about inventory.");
  } else if (i.status === "identity_only") {
    unknowns.push("Which specific car this is: no VIN was given, so there is no listing check.");
  } else {
    unknowns.push("Whether it's still available: confirm with the dealer before you visit.");
  }
  if (s?.dealer && i.status !== "listed") unknowns.push(`The physical store: the seller-supplied "${s.dealer}" is not verified by the catalogue.`);
  unknowns.push(i.status === "listed"
    ? "Vehicle history, accidents, ownership and condition: check the Edmunds listing and ask the dealer for a full vehicle history report. Total price with fees and whether any recall was repaired: ask the dealer to confirm in writing."
    : "Vehicle history and condition: ask the dealer for a full history report, and check the listing for one. Total price with fees and recall repairs: confirm with the dealer in writing.");

  const q: string[] = [];
  const vinTxt = i.vin ? ` (VIN ${i.vin})` : "";
  q.push(i.status === "listed" || i.status === "not_listed" ? `Is this exact car${vinTxt} available right now, and at which store can I see it?` : "Can you give me the VIN for this exact car so it can be checked?");
  const priceQ = conflicts.find((c) => c.field === "price");
  q.push(priceQ ? `The price is shown as ${priceQ.seller} and as ${priceQ.catalogue}; which is correct, and what is the total price with all fees and taxes?` : "What is the total price including every fee, tax and add-on, in writing?");
  const odoQ = conflicts.find((c) => c.field === "mileage");
  q.push(odoQ ? `The mileage is shown as ${odoQ.seller} and as ${odoQ.catalogue}; what does the odometer read today?` : "What does the odometer read today?");
  if (conflicts.some((c) => c.field === "dealer" || c.field === "dealer_location")) q.push("Which physical store holds the car, and can it be inspected there?");
  q.push("Can you send a full vehicle history report (accidents, owners, title) and any service records?");
  q.push("Have all recalls for this VIN been completed? (NHTSA's VIN lookup does not show repaired ones.)");
  q.push("Can an independent pre-purchase inspection be arranged?");
  q.push("Can I book a test drive, and can you hold the car until then?");

  const continuation: Assessment["continuation"] =
    i.status === "listed" ? { kind: "edmunds_listing_link", note: "Check availability opens this car on Edmunds. The dealer can confirm it's still for sale." }
    : i.status === "not_listed" ? { kind: "similar_vehicles_only", note: "We don't have a link to this exact car. View similar listings shows other cars of this make and model on Edmunds (not this exact car), useful for comparing while you confirm with the dealer." }
    : { kind: "none", note: "No Edmunds link is offered from this check." };

  return {
    version: 1, status: i.status,
    identity: { title: i.title, source: i.decodeConfirmed ? "NHTSA VIN decode" : i.title ? (i.titleFromCatalogue ? "catalogue listing" : "typed by the buyer") : "none", confirmedByDecode: i.decodeConfirmed },
    catalogue: {
      checked: i.status === "listed" || i.status === "not_listed", listed, facts: f,
      snapshotNote: i.status === "listed" ? (f?.rowChangedAt ? `Our listing was last updated ${f.rowChangedAt}. Check with the dealer that it's still available.` : "Check with the dealer that it's still available.")
        : i.status === "not_listed" ? "Not found in our listings, so there is no listing to compare. Check similar listings on Edmunds, and confirm availability with the dealer."
        : "The catalogue was not checked.",
    },
    seller: s, conflicts, unknowns, dealerQuestions: q.slice(0, 8), continuation,
    alternatives: { offered: false, note: "Similar listings are different cars and may be at different dealers." },
  };
}

const STATUS_LABEL: Record<AssessmentStatus, string> = { listed: "Listed in the checked catalogue", not_listed: "Not listed in the checked catalogue", catalogue_unavailable: "Incomplete: catalogue did not answer", identity_only: "Identity only (no VIN)" };

/** The short text block appended to check_vehicle's reply. */
export function renderAssessment(a: Assessment): string {
  const L: string[] = [];
  L.push(`Assessment (CarClever Test): ${STATUS_LABEL[a.status]}`);
  L.push(`Identity: ${a.identity.title ?? "not identified"}${a.identity.title ? (a.identity.confirmedByDecode ? " (confirmed by the NHTSA VIN decode: make, model and year only)" : a.identity.source === "catalogue listing" ? " (from the catalogue listing; the NHTSA VIN decode was not available)" : " (as typed; not confirmed)") : ""}`);
  const f = a.catalogue.facts;
  if (a.status === "listed" && f) {
    const bits = [f.price != null ? usd(f.price) : "price not shown", f.mileage != null ? mi(f.mileage) : "mileage not shown", f.used === true ? "used" : f.used === false ? "new" : null, [f.dealer, [f.city, f.state].filter(Boolean).join(", ")].filter(Boolean).join(", ") || "dealer not shown"].filter(Boolean);
    L.push(`Catalogue facts: ${bits.join(" · ")}. ${a.catalogue.snapshotNote}`);
  } else L.push(`Catalogue: ${a.catalogue.snapshotNote}`);
  if (a.seller) {
    const bits = [a.seller.price != null ? usd(a.seller.price) : null, a.seller.mileage != null ? mi(a.seller.mileage) : null, a.seller.dealer ? `dealer/location "${a.seller.dealer}"` : null, a.seller.notes ? `notes "${a.seller.notes}"` : null].filter(Boolean);
    L.push(`Seller-supplied (the seller's words, not from our catalogue): ${bits.join(" · ")}`);
  }
  if (a.conflicts.length) { L.push("Conflicts:"); a.conflicts.forEach((c) => L.push(`- ${c.note}`)); }
  L.push("Unknowns:"); a.unknowns.forEach((u) => L.push(`- ${u}`));
  L.push("Questions for the dealer:"); a.dealerQuestions.forEach((x, n) => L.push(`${n + 1}) ${x}`));
  L.push(`Edmunds: ${a.continuation.note}`);
  L.push(`Alternatives: ${a.alternatives.note}`);
  return L.join("\n");
}
