/**
 * Two short notes for the reply, with no lookup tables: the calling AI is the one that knows what "midsize SUV" means, so the
 * tool only tells it, in the reply it reads, what it did and did not apply.
 */

import { bodyClassesFor } from "./catalog-db/normalize";

type Card = { detail?: { cylinders?: number | null }; powertrain?: { transmission?: string | null } };
const one = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** A body type with no model list and no make: the results span all sizes, so say how to ask for a class. "" otherwise. */
export function broadBodyTypeHint(input: { make?: string; model?: string; bodyType?: string; vehicleType?: string }): string {
  const body = one(input.bodyType) || one(input.vehicleType);
  if (!body || one(input.model) || one(input.make)) return "";
  return `This is a broad ${body} search with no model names, so the results span all sizes. If the buyer asked for a size or class (for example midsize, compact or full-size), next step: resend with the real model names for that class in "model": the catalogue has no size data.`;
}

function counts(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n} of ${values.length})`).join(", ");
}

/**
 * Cylinder count and transmission are not fields the catalogue can filter on. Say so, show what the results actually are, and
 * tell the AI to state only that. "" when neither was asked for.
 */
export function unappliedFilterNote(input: { cylinders?: number | null; transmission?: string | null }, cards: Card[]): string {
  const names: string[] = [], shown: string[] = [];
  if (input.cylinders != null) {
    names.push("cylinder count");
    shown.push(`Cylinder count in these results: ${counts(cards.map((c) => (c.detail?.cylinders != null ? `${c.detail.cylinders}-cylinder` : "unknown")))}.`);
  }
  if (one(input.transmission)) {
    names.push("transmission");
    shown.push(`Transmission in these results: ${counts(cards.map((c) => one(c.powertrain?.transmission) || "unknown"))}.`);
  }
  if (!names.length) return "";
  return `${names.join(" and ")} could not be applied as a filter because the catalogue has no such field. ${cards.length ? shown.join(" ") + " " : ""}State only what is shown here: the catalogue has no data on what a manufacturer sells or has sold.`;
}

/** vehicleType is only ever used as a body style. Say so, instead of letting a size or class word in it pass as applied. "" when none was sent. */
export function vehicleTypeNote(input: { bodyType?: string; vehicleType?: string }): string {
  const vt = one(input.vehicleType);
  if (!vt) return "";
  const body = one(input.bodyType);
  if (body) return `Vehicle type "${vt}" was not applied as a separate filter: body style "${body}" was already used, and the catalogue has no size or class field.`;
  const classes = bodyClassesFor(vt);
  return classes
    ? `Vehicle type "${vt}" was used only as body style ${classes.join(" or ")}; any size or class wording in it could not be applied (the catalogue has no size field).`
    : `Vehicle type "${vt}" could not be applied: the catalogue has no such field.`;
}
