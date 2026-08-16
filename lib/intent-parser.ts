/**
 * Intent parser — natural language → search_intent.schema.json structure.
 *
 * Rule-based v1, not an LLM call: the host model (Claude/ChatGPT) already
 * does most of the natural-language interpretation before calling this tool
 * (it fills in the structured `FindMatchingVehicleInput` fields itself, per
 * the tool's Zod schema). This module's job is narrower: take those already-
 * mostly-structured inputs plus any freeform `goals` the host model passed
 * through, and produce the intent object that drives search + scoring +
 * transparency — including the semantic (non-filter) fields.
 *
 * Reference worked example: contracts/search_intent.schema.example.json
 * (SYS-20260812-025).
 */

import type { z } from "zod";

export interface ParsedIntent {
  hardConstraints: {
    priceMax?: number;
    priceMin?: number;
    yearMin?: number;
    yearMax?: number;
    make?: string;
    model?: string;
    bodyType?: string;
    mileageMax?: number;
    location?: { zip: string; radiusMiles: number; strict: boolean };
  };
  // Semantic — never sent as raw Auto.dev filter params (SYS-20260812-023/025):
  semantic: {
    trimPreference?: string;
    seatsMin?: number;
    goals: string[]; // e.g. "family", "reliability", "commuting"
  };
  verificationRequired: string[];
  interpretationNotes: string[];
  /**
   * Model entries that had a manufacturer name stripped off the front, e.g.
   * "Lexus ES" -> "ES" (SYS-20260816-032). Real, confirmed live bug: Auto.dev's
   * `model` field never includes the make — a host model combining them into
   * one string (a completely reasonable-looking mistake) silently returns
   * zero, not an error. Returned here (rather than fixed silently) so route.ts
   * can disclose it via `relaxations`, the same way the existing facet-based
   * model-name correction already is — `interpretationNotes` above does NOT
   * reach the text block the host model actually reads (confirmed
   * SYS-20260812-011 #3), so a silent or interpretationNotes-only fix here
   * would repeat that same gap.
   */
  modelPrefixesStripped: Array<{ original: string; corrected: string }>;
}

// Stable, common US-market manufacturer names (SYS-20260816-032). Distinct
// in kind from a "family SUV -> model list" mapping table: this is a small,
// closed set of legal entity/brand names that essentially never changes,
// not a judgment call about which models suit a lifestyle need — the same
// distinction André drew when rejecting a category-table approach earlier
// (2026-08-16). Sorted longest-first so a multi-word make (e.g.
// "Mercedes-Benz") is checked before any shorter name that could
// coincidentally prefix-match part of it.
const MAKE_NAMES = [
  "Alfa Romeo", "Aston Martin", "Land Rover", "Rolls-Royce", "Mercedes-Benz",
  "Mercedes Benz", "Mercedes", "Acura", "Audi", "Bentley", "BMW", "Buick",
  "Cadillac", "Chevrolet", "Chevy", "Chrysler", "Dodge", "Ferrari", "Fiat",
  "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep",
  "Kia", "Lamborghini", "Lexus", "Lincoln", "Lotus", "Maserati", "Mazda",
  "McLaren", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche", "Ram",
  "Rivian", "Subaru", "Tesla", "Toyota", "Volkswagen", "VW", "Volvo",
].sort((a, b) => b.length - a.length);

/**
 * Strips a leading manufacturer name off a single model string, if present.
 * "Lexus ES" -> "ES". "ES" -> "ES" (unchanged, no prefix present). Case-
 * insensitive match, but the returned remainder preserves the original
 * casing/spacing exactly as given.
 */
function stripMakePrefix(modelEntry: string): { corrected: string; original: string | null } {
  const trimmed = modelEntry.trim();
  const lower = trimmed.toLowerCase();
  for (const make of MAKE_NAMES) {
    const prefix = make.toLowerCase() + " ";
    if (lower.startsWith(prefix) && trimmed.length > prefix.length) {
      return { corrected: trimmed.slice(prefix.length).trim(), original: trimmed };
    }
  }
  return { corrected: trimmed, original: null };
}

/**
 * Applies stripMakePrefix across a comma-separated model list. Returns the
 * corrected list plus a record of exactly which entries were changed, for
 * disclosure — never a silent correction.
 */
function stripMakePrefixesFromModelList(
  model: string | undefined,
): { model: string | undefined; corrections: Array<{ original: string; corrected: string }> } {
  if (!model) return { model, corrections: [] };
  const corrections: Array<{ original: string; corrected: string }> = [];
  const entries = model.split(",").map((entry) => {
    const { corrected, original } = stripMakePrefix(entry);
    if (original) corrections.push({ original, corrected });
    return corrected;
  });
  return { model: entries.join(","), corrections };
}

const GOAL_SEAT_HINTS: Record<string, number> = {
  family: 5,
  road_trip: 5,
};

export function parseIntent(input: {
  priceMax?: number;
  priceMin?: number;
  yearMin?: number;
  yearMax?: number;
  make?: string;
  model?: string;
  bodyType?: string;
  mileageMax?: number;
  zip?: string;
  radiusMiles?: number;
  trimPreference?: string;
  seatsMinPreference?: number;
  goals?: string[];
}): ParsedIntent {
  const goals = input.goals ?? [];
  const verificationRequired: string[] = [];
  const interpretationNotes: string[] = [];

  // Seats: hard constraint semantically, but never an API filter param
  // (Trust Class C, provider_filter_allowed: false — SYS-20260812-016/025).
  let seatsMin = input.seatsMinPreference;
  if (seatsMin == null) {
    for (const goal of goals) {
      if (GOAL_SEAT_HINTS[goal] != null) {
        seatsMin = GOAL_SEAT_HINTS[goal];
        break;
      }
    }
  }
  if (seatsMin != null) verificationRequired.push("seating");

  // Powertrain-adjacent goals (e.g. "reliable", "low_total_cost") don't map
  // to a hard filter here — Find My Car has no TCO/reliability data on
  // Starter tier. They're passed through as ranking-adjacent soft signals
  // only, not silently promised as verified.
  if (goals.length > 0) {
    interpretationNotes.push(
      `Goals (${goals.join(", ")}) influence ranking only — Find My Car does not have ` +
        `reliability, ownership-cost, or history data on the Starter tier to verify these claims.`,
    );
  }

  if (input.trimPreference) {
    verificationRequired.push("trim");
    interpretationNotes.push(
      `Trim preference "${input.trimPreference}" affects ranking, not eligibility — listings ` +
        `with a different or unknown trim still appear (Trust Class B, not hard-filterable).`,
    );
  }

  const location =
    input.zip != null
      ? { zip: input.zip, radiusMiles: input.radiusMiles ?? 50, strict: false }
      : undefined;
  if (location) {
    verificationRequired.push("destination");
    interpretationNotes.push("Radius may widen only with disclosure (never silently).");
  }

  verificationRequired.push("identity"); // VIN cross-check always runs on the shortlist

  const { model: correctedModel, corrections: modelPrefixesStripped } =
    stripMakePrefixesFromModelList(input.model);
  if (modelPrefixesStripped.length > 0) {
    interpretationNotes.push(
      `Removed the manufacturer name from the model field (${modelPrefixesStripped
        .map((c) => `"${c.original}" → "${c.corrected}"`)
        .join(", ")}) — Auto.dev's model field never includes the make.`,
    );
  }

  return {
    hardConstraints: {
      priceMax: input.priceMax,
      priceMin: input.priceMin,
      yearMin: input.yearMin,
      yearMax: input.yearMax,
      make: input.make,
      model: correctedModel,
      bodyType: input.bodyType,
      mileageMax: input.mileageMax,
      location,
    },
    semantic: {
      trimPreference: input.trimPreference,
      seatsMin,
      goals,
    },
    verificationRequired,
    interpretationNotes,
    modelPrefixesStripped,
  };
}
