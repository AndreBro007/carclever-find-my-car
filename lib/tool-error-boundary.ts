/**
 * Last-resort seatbelt for the find_matching_vehicle tool handler
 * (fix/provider-string-runtime-safety, SYS-20260828 review follow-up).
 *
 * NOT primary bug handling — every specific failure mode this tool
 * already knows about (invalid VIN, no matches, Auto.dev timeout/service
 * error, automatic widening, etc.) has its own deliberate handling deep
 * inside the tool body and returns normally; none of those ever reach
 * this wrapper's catch. This exists solely to stop a genuinely
 * unanticipated exception (the exact class of bug fix/provider-string-
 * runtime-safety was created to fix, in case one still slips through
 * some path not yet covered) from ever reaching the user as a raw
 * technical error like "((intermediate value) ?? \"\").trim is not a
 * function".
 *
 * Extracted into its own small module — rather than an inline try/catch
 * duplicated between the real handler and a test — specifically so this
 * exact function, the same one app/[transport]/route.ts's registered
 * handler calls, can be exercised directly by a test with an injected
 * throwing callback, with no fallback-shape duplication anywhere.
 */
import type { FindMatchingVehicleOutput } from "./find-matching-vehicle-output";

export const FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE =
  "The vehicle search hit an unexpected data issue. Please try the search again.";

export interface FindMatchingVehicleToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: FindMatchingVehicleOutput;
}

export async function withFindMatchingVehicleErrorBoundary(
  fn: () => Promise<FindMatchingVehicleToolResult>,
): Promise<FindMatchingVehicleToolResult> {
  try {
    return await fn();
  } catch (err) {
    // Server-side only — never touches apiKey() or any credential; `err`
    // here is whatever the thrown exception actually was (a JS Error
    // object in every real case), never a raw HTTP body or secret value.
    console.error("[find_matching_vehicle] UNEXPECTED ERROR (last-resort boundary):", err);
    const safeContent: FindMatchingVehicleOutput = {
      meta: {
        totalCandidatesConsidered: 0,
        totalMatches: null,
        resultsShown: 0,
        corpusSizeApprox: "unknown",
        relaxations: [],
        dataNotes: [],
        scopeNote: "local",
        serviceError: FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE,
        interpretationNotes: [],
        qualifierAccounting: [],
      },
      results: [],
    };
    // No widget render attempted for this fallback — content +
    // structuredContent only, the same shape every other real error path
    // in the tool body already uses, so a non-widget host gets the same
    // safe text and no host is left trying to render a broken/blank card.
    // Never includes err.message, a stack trace, or any raw provider
    // value — only the fixed, user-safe message above.
    return {
      content: [{ type: "text", text: FIND_MATCHING_VEHICLE_UNEXPECTED_ERROR_MESSAGE }],
      structuredContent: safeContent,
    };
  }
}
