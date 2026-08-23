/**
 * Canonical find_matching_vehicle output schema (SYS-20260825).
 *
 * This is find_matching_vehicle's REGISTERED outputSchema (activated
 * SYS-20260825, follow-up pass) — this file is the live output contract,
 * not just a validation aid. The four live structuredContent construction
 * paths in app/[transport]/route.ts (invalid VIN, VIN not found, VIN
 * success, normal response) remain compile-time validated against this
 * shape via `satisfies FindMatchingVehicleOutput`.
 *
 * Built by reading the CURRENT runtime code — buildResultCard() in
 * route.ts, lib/vin-cross-check.ts, lib/match-score.ts,
 * lib/link-resolution.ts, lib/constraint-evidence.ts,
 * lib/qualifier-accounting.ts, lib/auto-dev-client.ts — not from the
 * previously deleted, stale FindMatchingVehicleOutput schema. Do not copy
 * shapes from that old schema; if this file and the old one ever
 * disagreed, the old one was wrong (that's why it was deleted).
 *
 * Two fields are intentionally z.unknown().nullable(), not string/number:
 * vehicle.style and vehicle.confidence in lib/auto-dev-client.ts are
 * themselves typed `unknown` ("observed in schema audit — meaning
 * unconfirmed" / "real field, unresearched"). identity.bodyStyleConfig and
 * detail.dataConfidence are those same values passed through unchanged
 * (`v?.style ?? null`, `v?.confidence ?? null`) — declaring them narrower
 * here would silently assert a type Auto.dev's own API doesn't guarantee,
 * which is exactly the mistake that made the old schema stale.
 */
import { z } from "zod";

const RelaxationSchema = z.object({
  step: z.string(),
  detail: z.string(),
});

const QualifierAccountingEntrySchema = z.object({
  requested: z.string(),
  tier: z.enum(["structural_filter", "disclosed_not_filtered"]),
  applied: z.string(),
});

const MetaSchema = z.object({
  totalCandidatesConsidered: z.number(),
  totalMatches: z.number().nullable(),
  corpusSizeApprox: z.string(),
  relaxations: z.array(RelaxationSchema),
  dataNotes: z.array(z.string()),
  scopeNote: z.enum(["local", "statewide", "nationwide", "vin_lookup"]),
  serviceError: z.string().nullable(),
  interpretationNotes: z.array(z.string()),
  qualifierAccounting: z.array(QualifierAccountingEntrySchema),
});

const IdentitySchema = z.object({
  vin: z.string(),
  year: z.number().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  trim: z.string().nullable(),
  series: z.string().nullable(),
  squishVin: z.string().nullable(),
  // vehicle.style is `unknown` at the source (lib/auto-dev-client.ts) —
  // see file header. Passed through via `v?.style ?? null`.
  bodyStyleConfig: z.unknown().nullable(),
});

const ConditionSchema = z.object({
  inventoryType: z.enum(["new", "used", "unknown"]),
  used: z.boolean().nullable(),
  cpo: z.boolean().nullable(),
  cpoEvidenceState: z.enum(["confirmed_cpo", "reported_not_cpo", "unknown"]),
});

const PowertrainSchema = z.object({
  type: z.string(),
  engine: z.string().nullable(),
  drivetrain: z.string().nullable(),
  transmission: z.string().nullable(),
});

const BodySchema = z.object({
  bodyStyle: z.string().nullable(),
  vehicleType: z.string().nullable(),
  doors: z.number().nullable(),
});

const ListingSchema = z.object({
  price: z.number().nullable(),
  mileage: z.number().nullable(),
  dealer: z.string().nullable(),
  dealerId: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  rawVdp: z.string().nullable(),
  resolvedDestination: z.string().nullable(),
  destinationClass: z.string().nullable(),
});

const HistorySchema = z.object({
  state: z.enum(["known_clean", "known_issues", "unreported"]),
  note: z.string(),
  ownerNote: z.string().nullable(),
});

const MediaSchema = z.object({
  primaryImage: z.string().nullable(),
  cardImageUrl: z.string().nullable(),
  photoUrls: z.array(z.string()),
});

const VerificationSchema = z.object({
  identityVerificationStatus: z.enum(["verified_match", "potential_match", "failed"]),
  verifiedAttributes: z.array(z.string()),
  unknownAttributes: z.array(z.string()),
  conflictingAttributes: z.array(z.string()),
  vinIntegrityNote: z.string().optional(),
});

const MatchScoreBreakdownSchema = z.object({
  statedCriteriaFit: z.number(),
  resolvedCriteriaFit: z.number(),
  identityConfidence: z.number(),
  penalizedByRelaxation: z.array(z.string()),
});

const RankingSchema = z.object({
  matchScore: z.number(),
  matchScoreLabel: z.enum(["Strong match", "Good match", "Partial match"]),
  breakdown: MatchScoreBreakdownSchema,
});

const LinksSchema = z.object({
  affiliateUrl: z.string().nullable(),
  affiliateFallbackUrl: z.string().nullable(),
  dealerListingUrl: z.string().nullable(),
  isCarvana: z.boolean(),
  linkStatus: z.enum(["both-available", "edmunds-only", "dealer-only", "fallback-only", "none-available"]),
});

const DetailSchema = z.object({
  carfaxUrl: z.string().nullable(),
  cpoNote: z.string(),
  ownerHistoryNote: z.string().nullable(),
  interiorColor: z.string().nullable(),
  exteriorColor: z.string().nullable(),
  cylinders: z.number().nullable(),
  seats: z.number().nullable(),
  seatsNote: z.string(),
  // vehicle.confidence is `unknown` at the source — see file header.
  // Passed through via `v?.confidence ?? null`.
  dataConfidence: z.unknown().nullable(),
  historyUsageType: z.string().nullable(),
  historyPersonalUse: z.boolean().nullable(),
  titleStatus: z.string().nullable(),
  // formatFuelTypeForDisplay() (lib/fuel-type.ts) can genuinely return
  // undefined — when normalized fuel is "unknown" and no raw fallback
  // string is available. Real runtime possibility, not TS over-widening;
  // schema fixed to match, not the other way around.
  fuelTypeDisplay: z.string().optional(),
});

const ConstraintCheckSchema = z.object({
  field: z.string(),
  status: z.enum(["verified", "mismatch", "unknown", "relaxed"]),
  // requested/actual currently carry JSON primitive values or null — not a
  // richer type, matching lib/constraint-evidence.ts's ConstraintCheck
  // interface (requested: unknown; actual: unknown) exactly.
  requested: z.unknown(),
  actual: z.unknown(),
});

const ResultSchema = z.object({
  canonicalVehicleId: z.string(),
  identity: IdentitySchema,
  condition: ConditionSchema,
  powertrain: PowertrainSchema,
  body: BodySchema,
  listing: ListingSchema,
  history: HistorySchema,
  media: MediaSchema,
  verification: VerificationSchema,
  ranking: RankingSchema,
  links: LinksSchema,
  detail: DetailSchema,
  badges: z.array(z.string()),
  intentConfirmations: z.array(z.string()),
  dataConflicts: z.array(z.string()),
  constraintChecks: z.array(ConstraintCheckSchema),
  searchConstraintStatus: z.enum(["verified", "partial", "relaxed", "mismatch", "not_applicable"]),
});

export const FindMatchingVehicleOutputSchema = z.object({
  meta: MetaSchema,
  results: z.array(ResultSchema),
});

export type FindMatchingVehicleOutput = z.infer<typeof FindMatchingVehicleOutputSchema>;
