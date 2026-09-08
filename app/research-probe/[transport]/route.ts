import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

/**
 * SCHEMA-ONLY HOST-ROUTING PROBE — research/v2-schema-probe branch.
 *
 * Purpose: capture what ChatGPT and Claude actually send for the candidate
 * shared `find_matching_vehicle` public contract (schema + description),
 * before any V2 implementation. This is NOT V2, NOT V3, and has no path to
 * `release/v2` or production.
 *
 * Deliberately excluded (per approved scope): Auto.dev, NHTSA, search,
 * ranking, widening, VIN lookups, link resolution, images, cards, API keys.
 * This tool does exactly one thing: accept input shaped like the candidate
 * schema, then echo back what was received plus computed lengths/counts,
 * so real host output can be measured against the proposed caps.
 *
 * Cross-field rules (priceMin<=priceMax, yearMin<=yearMax,
 * electrificationRequirement requires electrificationTypes, etc.) are
 * evaluated and reported as notes in the response, not enforced as hard
 * schema rejections here — the goal of this probe is to observe real host
 * output, including any input that would eventually be rejected, not to
 * reject it prematurely. `model` and the other free-text fields use a
 * generous research ceiling, not the eventual production cap, for the
 * same reason.
 *
 * Server logs record only computed lengths/counts, never raw field values
 * or full request bodies. Raw received values are returned in the tool's
 * own response to whoever is running the test prompt — that is the
 * evidence being captured, not a server-side log.
 */

const PROBE_DESCRIPTION = `Finds current vehicles for sale in the United States and returns a concise shortlist matching a user's stated requirements. Appropriate for listing requests with explicit criteria, optimization goals such as lowest price, newest, lowest mileage, or best within a stated budget, practical needs such as a large family SUV or commuter vehicle, or an exact current listing by VIN.

Search inputs include make, model, price, year, mileage, location, body style, drivetrain, transmission, trim, seating, color, condition, electrification, and purchase priority. Most direct criteria are matched against actual listing data; seating, certification, and history-related requests reflect available evidence, which may be confirmed, unconfirmed, or unreported rather than guaranteed. Practical needs such as a large family SUV, a teen-driver car, or a vehicle for towing are interpreted before the search runs to identify relevant candidates; this tool then searches and ranks them using actual listing data — it does not independently establish reliability, safety, running cost, towing suitability, condition, accident-free history, or certification. When a practical need points to specific vehicle types, the calling assistant identifies likely matching models and includes them alongside the stated need.

An exact 17-character VIN refers to one specific listing; if unavailable, that outcome is reported rather than substituting a similar vehicle. Electrification requests state accepted types — hybrid (including mild hybrid), plug-in hybrid, electric — and whether required or preferred. A vehicle's primary fuel label alone does not determine hybrid or plug-in-hybrid status. For an unambiguous city-only request, a representative ZIP may be supplied as the local search anchor; results disclose the overall local, state-wide, or nationwide scope.

Results include current matching listings, viewing links where available, and available evidence about confirmed, unconfirmed, or changed criteria. Missing history, ownership, certification, or specification data remains unknown and is never treated as proof a vehicle satisfies or fails a request.

This tool is for vehicle-listing searches — not general automotive education, maintenance, financing, leasing, unsupported categories, or comparisons not requiring current listings.`;

// Research-only ceilings — generous on purpose. Real production caps for
// `model` and the provisional 50-char fields are set later from the
// evidence this probe collects, not decided here.
const PROBE_MODEL_MAX = 500;
const PROBE_TEXT_MAX = 200;

// Plain, flat shape — this is what `registerTool`'s `inputSchema` consumes.
// No cross-field .refine() at this level; those checks run explicitly in
// the handler below so this shape stays a simple, introspectable object,
// matching how the production schema is structured today.
// Declared explicitly because MCP client behavior for `structuredContent`
// diverges without it: some clients only surface/parse structuredContent
// when the tool declares a matching outputSchema, others pass it through
// regardless. Declaring this is the documented fix for that interop gap
// (see modelcontextprotocol/typescript-sdk#911 and similar reports) and is
// required for this probe's actual purpose — the structuredContent IS the
// evidence being collected, so it must reliably reach every host tested.
const probeOutputShape = {
  probe: z.boolean(),
  receivedInput: z.record(z.string(), z.unknown()),
  fieldStats: z.record(z.string(), z.unknown()),
  crossFieldNotes: z.array(z.string()),
};

const probeShape = {
  vin: z.string().optional(),
  priceMax: z.number().optional(),
  priceMin: z.number().optional(),
  priceFlexibility: z.enum(["strict", "flexible"]).optional(),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"]).optional(),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  make: z.string().max(PROBE_TEXT_MAX).optional(),
  model: z.string().max(PROBE_MODEL_MAX).optional(),
  bodyType: z.string().max(PROBE_TEXT_MAX).optional(),
  vehicleType: z.string().max(PROBE_TEXT_MAX).optional(),
  mileageMax: z.number().optional(),
  zip: z.string().optional(),
  radiusMiles: z.number().optional(),
  state: z.string().optional(),
  trimRequired: z.string().max(PROBE_TEXT_MAX).optional(),
  trimPreference: z.string().max(PROBE_TEXT_MAX).optional(),
  seatsMinPreference: z.number().optional(),
  vehicleNeeds: z.array(z.string().max(60)).max(5).optional(),
  drivetrain: z.string().max(PROBE_TEXT_MAX).optional(),
  transmission: z.enum(["Automatic", "Manual"]).optional(),
  exteriorColor: z.string().max(PROBE_TEXT_MAX).optional(),
  interiorColor: z.string().max(PROBE_TEXT_MAX).optional(),
  doors: z.number().optional(),
  cylinders: z.number().optional(),
  used: z.boolean().optional(),
  cpo: z.boolean().optional(),
  noAccidents: z.boolean().optional(),
  oneOwner: z.boolean().optional(),
  electrificationTypes: z.array(z.enum(["hybrid", "plug_in_hybrid", "electric"])).max(3).optional(),
  electrificationRequirement: z.enum(["required", "preferred"]).optional(),
};

type ProbeInput = { [K in keyof typeof probeShape]?: unknown };

function trimIfString(v: unknown): unknown {
  return typeof v === "string" ? v.trim() : v;
}

function fieldStats(input: Record<string, unknown>) {
  const stats: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const value = trimIfString(rawValue);
    if (typeof value === "string") {
      stats[key] = { type: "string", length: value.length, emptyAfterTrim: value.length === 0 };
    } else if (Array.isArray(value)) {
      stats[key] = {
        type: "array",
        count: value.length,
        itemLengths: value.map((v) => (typeof v === "string" ? v.trim().length : null)),
        hasDuplicates: new Set(value).size !== value.length,
      };
    } else if (typeof value === "number") {
      stats[key] = { type: "number", value, finite: Number.isFinite(value) };
    } else if (typeof value === "boolean") {
      stats[key] = { type: "boolean", value };
    } else if (value != null) {
      stats[key] = { type: typeof value };
    }
  }
  return stats;
}

function crossFieldNotes(input: ProbeInput): string[] {
  const notes: string[] = [];
  const priceMin = input.priceMin as number | undefined;
  const priceMax = input.priceMax as number | undefined;
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    notes.push(`priceMin (${priceMin}) > priceMax (${priceMax}) — would fail the locked priceMin<=priceMax rule`);
  }
  const yearMin = input.yearMin as number | undefined;
  const yearMax = input.yearMax as number | undefined;
  if (yearMin != null && yearMax != null && yearMin > yearMax) {
    notes.push(`yearMin (${yearMin}) > yearMax (${yearMax}) — would fail the locked yearMin<=yearMax rule`);
  }
  const electrificationTypes = input.electrificationTypes as string[] | undefined;
  const electrificationRequirement = input.electrificationRequirement as string | undefined;
  if (electrificationRequirement != null && (electrificationTypes == null || electrificationTypes.length === 0)) {
    notes.push("electrificationRequirement present without a non-empty electrificationTypes — would fail the locked cross-field rule");
  }
  if (electrificationTypes != null && new Set(electrificationTypes).size !== electrificationTypes.length) {
    notes.push("electrificationTypes contains duplicates — would fail the locked uniqueness rule");
  }
  const vin = input.vin as string | undefined;
  if (vin != null && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) {
    notes.push(`vin ("${vin}") does not match the 17-character VIN shape after trim/uppercase`);
  }
  const zip = input.zip as string | undefined;
  if (zip != null && !/^\d{5}$/.test(zip.trim())) {
    notes.push(`zip ("${zip}") does not match the 5-digit shape after trim`);
  }
  const state = input.state as string | undefined;
  if (state != null && !/^[A-Za-z]{2}$/.test(state.trim())) {
    notes.push(`state ("${state}") does not match the 2-letter shape after trim`);
  }
  const radiusMiles = input.radiusMiles as number | undefined;
  if (radiusMiles != null && radiusMiles <= 0) {
    notes.push(`radiusMiles (${radiusMiles}) is not strictly positive — would fail the locked rule`);
  }
  const vehicleNeeds = input.vehicleNeeds as string[] | undefined;
  if (vehicleNeeds != null && vehicleNeeds.filter((s) => s.trim().length > 0).length === 0) {
    notes.push("vehicleNeeds present but has no non-empty item after trim — would fail the locked min-1-non-empty rule");
  }
  return notes;
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "find_matching_vehicle",
      {
        description: PROBE_DESCRIPTION,
        inputSchema: probeShape,
        outputSchema: probeOutputShape,
        annotations: {
          title: "Find Matching Vehicle (schema probe)",
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      async (input) => {
        const typedInput = input as ProbeInput;
        const stats = fieldStats(input as Record<string, unknown>);
        const notes = crossFieldNotes(typedInput);

        // Server-side log: computed stats and notes only — never raw
        // field values or the full request body.
        console.log("[probe] fieldStats:", JSON.stringify(stats));
        console.log("[probe] crossFieldNotes:", JSON.stringify(notes));

        return {
          content: [
            {
              type: "text" as const,
              text: "Schema-only research probe — no live search performed. Echoing received input for host-routing evidence capture.",
            },
          ],
          structuredContent: {
            probe: true,
            receivedInput: input,
            fieldStats: stats,
            crossFieldNotes: notes,
          },
        };
      },
    );
  },
  {
    serverInfo: {
      name: "carclever-v2-schema-probe",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "0.1.0",
    },
  },
);

export { handler as GET, handler as POST, handler as DELETE };

// Trigger commit: fires the Vercel Git webhook now that Production branch tracking is set to this branch (2026-09-08).
