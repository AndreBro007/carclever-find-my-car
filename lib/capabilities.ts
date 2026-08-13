/**
 * Capability flags for Find My Car.
 *
 * Each optional data source/feature is a flag here, not a scattered
 * conditional in business logic. Adding a future capability (e.g. Growth-tier
 * Specs enrichment) means writing one new module implementing the relevant
 * fields and flipping one flag — no schema change, no card-renderer change,
 * no Match Score logic change. See DECISIONS.md SYS-20260812-012.
 */
export const CAPABILITIES = {
  /** VIN cross-check against decode data — Starter tier, always on. */
  vinCrossCheck: true,

  /** Populate detail.features from /listings if the payload happens to include it. Never fetched from Specs (Growth tier). */
  featuresArray: "auto" as "auto" | "off",

  /** Growth-tier Specs enrichment (engine/transmission/drivetrain beyond what /listings itself provides). Off for v1. */
  specsEnrichment: false,

  /** Small photo gallery beyond the single primary image. Only used if it doesn't add latency to the primary search response. */
  photoGallery: "auto" as "auto" | "off",

  /** Carfax URL passthrough from retailListing.carfaxUrl, when present. Free, no separate integration. */
  carfaxPassthrough: true,
} as const;

export type Capabilities = typeof CAPABILITIES;
