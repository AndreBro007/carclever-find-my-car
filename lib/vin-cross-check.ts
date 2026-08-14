/**
 * VIN cross-check — now fully LOCAL (design doc §5).
 *
 * Previously called /vin/{vin} once per shortlisted result: 5 extra Auto.dev
 * calls per search, on top of the listings call. Now derived offline from VIN
 * anatomy (ISO 3779/3780), taking a search from 6 API calls to 1.
 *
 * What we can verify offline: model year (position 10 + position 7 cycle rule),
 * manufacturer (WMI, where recognised), and transcription validity (North
 * American check digit). What we cannot: model and trim — these stay "unknown",
 * never assumed wrong.
 *
 * Discipline unchanged: unknown is never treated as a conflict, and trim/model
 * gaps never fail a match (Trust Class B).
 */
import type { AutoDevListing } from "./auto-dev-client";
import { analyzeVin } from "./vin-anatomy";

export interface VerificationResult {
  hardConstraintStatus: "verified_match" | "potential_match" | "failed";
  verifiedAttributes: string[];
  unknownAttributes: string[];
  conflictingAttributes: string[];
  /** Populated when the VIN itself is structurally invalid or fails its check digit. */
  vinIntegrityNote?: string;
}

function makesAgree(listed: string | undefined, decoded: string | null): boolean | null {
  if (!decoded || !listed) return null;
  const a = listed.trim().toLowerCase();
  const b = decoded.trim().toLowerCase();
  // Tolerant of formatting variance (e.g. "Mercedes-Benz" vs "Mercedes Benz").
  const norm = (s: string) => s.replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}

export function crossCheckVin(listing: AutoDevListing): VerificationResult {
  const v = listing.vehicle;
  const anatomy = analyzeVin(listing.vin);

  const verifiedAttributes: string[] = [];
  const unknownAttributes: string[] = [];
  const conflictingAttributes: string[] = [];
  let vinIntegrityNote: string | undefined;

  if (!anatomy.formatValid) {
    return {
      hardConstraintStatus: "potential_match",
      verifiedAttributes: [],
      unknownAttributes: ["make", "model", "year", "trim"],
      conflictingAttributes: [],
      vinIntegrityNote: "VIN is not a valid 17-character VIN — identity could not be checked.",
    };
  }

  if (anatomy.checkDigitValid === false) {
    vinIntegrityNote =
      "VIN check digit does not validate — the VIN may be mistyped in the listing.";
  }

  // Year — derivable from the VIN itself.
  if (anatomy.modelYear != null && v?.year != null) {
    if (anatomy.modelYear === v.year) verifiedAttributes.push("year");
    else conflictingAttributes.push("year");
  } else {
    unknownAttributes.push("year");
  }

  // Make — derivable where the WMI is recognised; unrecognised is unknown.
  const makeAgreement = makesAgree(v?.make, anatomy.manufacturer);
  if (makeAgreement === true) verifiedAttributes.push("make");
  else if (makeAgreement === false) conflictingAttributes.push("make");
  else unknownAttributes.push("make");

  // Model and trim are not encoded in a decodable way in the VIN's public
  // structure — always unknown here, never a conflict.
  unknownAttributes.push("model", "trim");

  const hardConstraintStatus: VerificationResult["hardConstraintStatus"] =
    conflictingAttributes.length > 0
      ? "failed"
      : verifiedAttributes.length > 0
        ? "verified_match"
        : "potential_match";

  return {
    hardConstraintStatus,
    verifiedAttributes,
    unknownAttributes,
    conflictingAttributes,
    vinIntegrityNote,
  };
}
