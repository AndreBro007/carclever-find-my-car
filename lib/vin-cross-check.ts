/**
 * VIN cross-check — decode each shortlisted VIN and diff against the
 * Listings-reported identity fields. Per-field agree/disagree/unknown,
 * never a single boolean (SYS-20260812-002/025). Only run on the
 * shortlist (3-5 results), never the full candidate pool — Starter tier
 * is rate-limited to 5 req/sec (SYS-20260812-002 §6).
 */
import { decodeVin, type AutoDevListing, type VinDecodeResult } from "./auto-dev-client";

export interface VerificationResult {
  hardConstraintStatus: "verified_match" | "potential_match" | "failed";
  verifiedAttributes: string[];
  unknownAttributes: string[];
  conflictingAttributes: string[];
}

function fieldsAgree(listed: string | undefined, decoded: string | undefined): boolean | null {
  if (decoded == null || decoded === "") return null; // unknown, not a conflict
  if (listed == null || listed === "") return null;
  return listed.trim().toLowerCase() === decoded.trim().toLowerCase();
}

export async function crossCheckVin(listing: AutoDevListing): Promise<VerificationResult> {
  const decoded = await decodeVin(listing.vin);

  if (!decoded) {
    // Decode unavailable — everything stays unknown, never assumed false or true.
    return {
      hardConstraintStatus: "potential_match",
      verifiedAttributes: [],
      unknownAttributes: ["make", "model", "year", "trim"],
      conflictingAttributes: [],
    };
  }

  const checks: Array<[string, boolean | null]> = [
    ["make", fieldsAgree(listing.make, decoded.make)],
    ["model", fieldsAgree(listing.model, decoded.model)],
    ["year", fieldsAgree(listing.year != null ? String(listing.year) : undefined, decoded.year != null ? String(decoded.year) : undefined)],
    ["trim", fieldsAgree(listing.trim, decoded.trim)], // informational only — trim is never a hard filter
  ];

  const verifiedAttributes = checks.filter(([, v]) => v === true).map(([k]) => k);
  const conflictingAttributes = checks.filter(([, v]) => v === false).map(([k]) => k);
  const unknownAttributes = checks.filter(([, v]) => v === null).map(([k]) => k);

  // trim conflicts are informational, never fail the overall match (Trust Class B).
  const materialConflicts = conflictingAttributes.filter((k) => k !== "trim");

  const hardConstraintStatus: VerificationResult["hardConstraintStatus"] =
    materialConflicts.length > 0
      ? "failed"
      : unknownAttributes.length > 0
        ? "potential_match"
        : "verified_match";

  return { hardConstraintStatus, verifiedAttributes, unknownAttributes, conflictingAttributes };
}
