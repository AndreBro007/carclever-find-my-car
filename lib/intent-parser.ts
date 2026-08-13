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

  return {
    hardConstraints: {
      priceMax: input.priceMax,
      priceMin: input.priceMin,
      yearMin: input.yearMin,
      yearMax: input.yearMax,
      make: input.make,
      model: input.model,
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
  };
}
