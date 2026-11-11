/**
 * Vehicle investigation in check_vehicle's reply text (release 4, 11 Nov 2026; André's decision, way A: text only, no new field).
 * The block is built from the FROZEN assessment module (lib/vehicle-assessment.ts, version 2, blob c4b84917) fields: its own renderer is NOT used. It is appended at the END of the
 * existing reply, replaces nothing, and never gives a verdict, score, valuation or history. The recall list for a listed car mirrors the website (lib/recall-list.ts, blob c2507a8f).
 */
import { buildAssessment, type AssessmentStatus, type CatalogueFacts } from "./vehicle-assessment";
import { readingLinkFor, tradeInLink } from "./vehicle-investigation-links";
import { recallListFor } from "./recall-list";
import type { RecallInfo } from "./nhtsa-recalls-client";

export interface InvestigationInput {
  status: AssessmentStatus;
  vin: string | null;
  title: string | null;
  decodeConfirmed: boolean;
  titleFromCatalogue?: boolean;
  facts?: CatalogueFacts | null;
  vehicle: { year: number | null; make: string | null; model: string | null };
  /** A listed car says used (true) or new (false); otherwise null/undefined and the model year decides the guide. */
  used?: boolean | null;
  now?: Date;
}

/** The block, as lines to append to the reply text. */
export function investigationBlock(i: InvestigationInput): string[] {
  const a = buildAssessment({ vin: i.vin, status: i.status, title: i.title, decodeConfirmed: i.decodeConfirmed, titleFromCatalogue: i.titleFromCatalogue, facts: i.facts ?? null, seller: null });
  // W2 (ChatGPT lane review, André's yes 11 Nov 2026): when the catalogue lookup FAILED but a VIN was given, the module's first question asks for the VIN; swap it for the module's own question used when a VIN is known.
  const questions = [...a.dealerQuestions];
  if (a.status === "catalogue_unavailable" && i.vin && /^Can you give me the VIN/.test(questions[0] ?? "")) questions[0] = `Is this exact car (VIN ${i.vin}) available right now, and at which store can I see it?`;
  const n = questions.length;
  const things = `${n} ${n === 1 ? "thing" : "things"}`;
  // W1 (same review): "Confirmed" only when the NHTSA VIN decode confirmed the identity; otherwise say where the title came from.
  const lead = a.status === "identity_only"
    ? (a.identity.title ? `Identity as given: ${a.identity.title} (no VIN, so not confirmed). ` : "")
    : a.identity.title
      ? (a.identity.confirmedByDecode ? `Confirmed: ${a.identity.title}. ` : `Listed as: ${a.identity.title} (the NHTSA VIN decode did not confirm it). `)
      : "";
  const L: string[] = ["", "Before you contact the dealer:"];
  L.push(`${lead}Still to confirm with the dealer: ${things}. Contact the dealer to confirm.`);
  if (a.status === "identity_only") L.push("For a full check of this exact car, please share its VIN (on the listing, the dashboard or the driver's door jamb).");
  // The two links come right after the readiness line: hosts passed on the lines near the top and the dealer questions but dropped links at the very end (host tests, 11 Nov 2026; André approved the move).
  const reading = readingLinkFor({ vehicle: i.vehicle, used: i.used, now: i.now });
  L.push("Share these two links with the buyer:");
  L.push(`Helpful reading: ${reading.text}: ${reading.url}${reading.note ? ` (${reading.note})` : ""}`);
  const t = tradeInLink();
  L.push(`${t.text}: ${t.url}`);
  L.push("Still unknown:");
  a.unknowns.forEach((u) => L.push(`- ${u}`));
  L.push("Questions to ask the dealer:");
  questions.forEach((q, k) => L.push(`${k + 1}) ${q}`));
  if (a.continuation.kind !== "none") L.push(`Edmunds: ${a.continuation.note}`);
  return L;
}

/**
 * The recall campaigns NHTSA lists for the model year, newest first, at most ten, in the website's wording rules (number, month and year, component, one short defect line).
 * Returned as lines; empty when there are none. Campaigns are listed by make, model and model year only, so one may not apply to this exact car.
 */
export function recallListLines(recall: RecallInfo | null | undefined, modelYear: number | null): string[] {
  if (!recall || !Array.isArray(recall.campaigns) || recall.campaigns.length === 0) return [];
  const raw = recall.campaigns.map((c) => ({ NHTSACampaignNumber: c.campaignNumber, ReportReceivedDate: c.reportReceivedDate, Component: c.component, Summary: c.summary }));
  const list = recallListFor(raw);
  const shown = list.items.length;
  const head = `Recall campaigns NHTSA lists for this model year${modelYear ? ` (${modelYear})` : ""}: ${list.total} in total${shown < list.total ? `, the newest ${shown} shown` : ""}. A campaign can cover certain vehicles only, so it may not apply to this car; the NHTSA VIN lookup shows what is open on it.`;
  return [head, ...list.items.map((r) => `- ${[r.id, r.when, r.component].filter(Boolean).join(" · ") || "Campaign details not given"}${r.summary ? `: ${r.summary}` : ""}`)];
}
