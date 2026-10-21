/**
 * Shared listing types. One normalised vehicle-listing shape (nests under
 * vehicle.* and retailListing.*) that the catalogue-database source fills in and
 * the ranking, matching, output and link code reads. Moved here unchanged (apart
 * from the neutral name) when the third-party listings client was removed from
 * the catalogue edition.
 */

export interface VehicleListing {
  vin: string;
  "@id"?: string;
  createdAt?: string;
  /** Set only for rows that came from the Edmunds/Impact catalogue. */
  catalog?: { itemId?: string; trackingUrl?: string; distanceMiles?: number; firstSeen?: string; priceWas?: number; priceChangedAt?: string };
  vehicle?: {
    make?: string;
    model?: string;
    year?: number;
    trim?: string;
    series?: string; // unconfirmed
    fuel?: string;
    drivetrain?: string;
    transmission?: string;
    bodyStyle?: string;
    engine?: string;
    exteriorColor?: string;
    interiorColor?: string;
    squishVin?: string;
    type?: string; // finer than bodyStyle: Crossover/SUV/Sedan/Wagon/Minivan/Performance-Sports/Hybrid/Hatchback/Coupe/Luxury/Electric
    doors?: number;
    cylinders?: number;
    seats?: number; // real response field ("Seating capacity") — confirmed absent from Vehicle Filters, response-only. Was never even parsed before 2026-08-15, despite seatsMinPreference being collected as input and doing nothing.
    confidence?: unknown; // real field, unresearched — parsed for visibility, not yet used
    style?: unknown; // observed in schema audit — meaning unconfirmed, investigating
    condition?: unknown; // speculative: possible new/used/demo/certified signal
  };
  baseInvoice?: unknown; // observed in schema audit, location in tree unconfirmed — investigating
  baseMsrp?: unknown;
  retailListing?: {
    price?: number;
    miles?: number;
    city?: string;
    state?: string;
    zip?: string; // unconfirmed
    dealer?: string;
    dealerId?: string; // unconfirmed
    cpo?: boolean;
    used?: boolean;
    vdp?: string;
    primaryImage?: string;
    carfaxUrl?: string;
    photoCount?: number; // known unreliable per field-trust registry, don't use for gallery-size prediction
    titleStatus?: string; // unconfirmed
  };
  // Trust Class C (field trust registry): "discover broadly, then
  // verify locally or cross-API" — never a query filter, only a post-search
  // verification/display signal. Confirmed real via live projection test
  // (PROJPARITY-004-select): present in 27/30 sampled rows in that run, but
  // STEP3_STATUS.md's broader 300-row sample found history null in 53% of
  // rows — presence varies, absence is common and must never be read as clean.
  history?: {
    accidents?: boolean;
    accidentCount?: number;
    ownerCount?: number;
    oneOwner?: boolean;
    usageType?: string;
    personalUse?: boolean; // distinct field from usageType per live capture data; not yet surfaced anywhere
  };
}

export interface ListingsQuery {
  make?: string;
  model?: string;
  bodyType?: string;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  mileageMax?: number;
  zip?: string;
  radius?: number;
  limit?: number;
  // Widened per design doc §2 — all live-verified filterable in STEP3_STATUS.md / redesign doc.
  drivetrain?: string; // AWD, 4WD, FWD, RWD (comma-OR)
  transmission?: string; // Automatic, Manual
  exteriorColor?: string; // Gray, White, Black, Blue, Silver, Red, Green, Brown, Orange, Burgundy, Beige
  interiorColor?: string;
  vehicleType?: string; // vehicle.type — finer than bodyType, e.g. Crossover vs SUV
  doors?: number;
  cylinders?: number;
  used?: boolean;
  cpo?: boolean;
  state?: string;
  accidentCount?: number; // history.accidentCount — facet-verified filterable
  ownerCount?: number; // history.ownerCount — facet-verified filterable
  sort?: string; // e.g. "price.asc"
  includeFacets?: boolean;
  /**
   * Exact trim strings the database may return, plus cars with no trim (the later checks decide those). Set by the route after it resolves a
   * required trim against the database's own trim names (SYS-20261021-004, R8); never set by the AI.
   */
  trimIn?: string[];
  /**
   * Set by the route when the buyer asked for an electrified type (SYS-20261021-004, R4); never set by the AI. `extraModels` are further model names of the same
   * family as the asked ones whose wording matches ("RAV4 Hybrid", "RAV4 Prime" for "RAV4"), searched as well; `wordedModels` and `trimWording` mark the cars
   * whose model or trim wording matches, which are listed first; `knownHybridOnly` adds model years that are hybrid with no wording ("RAV4" from 2026, lib/fuel-type.ts). Wording is a hint only: NHTSA still decides (lib/electrified-models.ts).
   */
  electrified?: { extraModels: string[]; wordedModels: string[]; trimWording: string; knownHybridOnly?: Array<{ modelKey: string; fromYear: number }> };
}

export interface ListingsResponse {
  data: VehicleListing[];
  /**
   * `null` means the source returned results but no total count. Must stay
   * distinct from a genuine 0, otherwise the reply would show a false "0 matched"
   * alongside real results.
   */
  total: number | null;
  // Optional facet groups ("Label (count)" mapped to a drill-down URL). The
  // catalogue sources do not fill this in.
  facets?: Record<string, Record<string, string>>;
  /** Set when the request genuinely failed — distinct from "no cars matched". */
  error?: string;
  /** Set when results came back but via a reduced fallback request. */
  degraded?: string;
  /** Which source produced these rows. */
  source?: "catalog_db";
  /** Catalogue rows were ordered/filtered by distance from the search ZIP (dealer ZIP -> offline ZIP table). */
  localApplied?: boolean;
}
