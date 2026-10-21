import { z } from "zod";

/**
 * find_matching_vehicle input schema — extracted from
 * app/[transport]/route.ts specifically so it is importable for direct
 * schema-validation testing. Next.js Route Handler files only permit a
 * fixed set of named exports (GET/POST/etc + a few config options);
 * exporting arbitrary names (attempted for this schema directly) produces
 * a real local build failure: "X is not a valid Route export field"
 * (confirmed this session). route.ts imports this schema and uses it both
 * for MCP tool registration (inputSchema) and, implicitly, as the shape
 * the SDK validates incoming tool calls against.
 */
export const FindMatchingVehicleInput = z.object({
  vin: z.string().optional().describe("Exact 17-character VIN for one current listing. Other criteria are evaluated against that listing; no similar-vehicle substitute is returned."),
  priceMax: z.number().optional().describe("Maximum price in USD."),
  priceMin: z.number().optional().describe("Minimum price in USD."),
  priceFlexibility: z.enum(["strict", "flexible"]).optional().describe("Whether an approximate price ceiling may be treated as flexible; omitted ceilings remain strict."),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest"]).optional().describe("Ranking objective: best_for_budget, cheapest, lowest_mileage, or newest. best_for_budget applies to \"best for budget\", \"best in my budget\", or a price ceiling with no other stated optimization. cheapest applies only to explicit lowest-price intent such as \"cheapest\" or \"lowest price\" — the word \"budget\" alone does not imply cheapest."),
  yearMin: z.number().optional().describe("Earliest acceptable model year."),
  yearMax: z.number().optional().describe("Latest acceptable model year."),
  make: z.string().optional().describe("Vehicle manufacturer, such as Toyota, Honda, or Ford."),
  model: z.string().optional().describe("Real model names without the manufacturer, comma-separated (for example, CR-V, RAV4). Keep models the buyer named; see rules 3 and 4."),
  bodyType: z.string().optional().describe("Broad body style: SUV, Sedan, Truck or Minivan."),
  mileageMax: z.number().optional().describe("Maximum odometer mileage."),
  zip: z.string().optional().describe("Five-digit US ZIP code for a local search. For an unambiguous city-only request, use a valid representative ZIP for that city. Use a previously supplied location only when continuing the same search; never assume an unrelated location."),
  radiusMiles: z.number().optional().describe("Search radius in miles from the ZIP; the service applies its documented default when omitted."),
  trimPreference: z.string().optional().describe("Preferred real trim or variant (for example, Limited, Sport Hybrid). Ranks only; never excludes."),
  trimRequired: z.string().optional().describe("Real trim or variant the buyer requires (for example, AMG GLA 35); comma-separated alternatives accepted. Results must match a listed trim. If none match, the reply lists the model's trims."),
  seatsMinPreference: z.number().optional().describe("Preferred minimum seats, from available NHTSA seat data. Missing means unknown, not a failure. Ranks and reports only; not a seating filter or confirmation of a third row."),
  vehicleNeeds: z.array(z.string()).optional().describe("Short list of practical needs (for example, large family SUV, commuter car), resolved into candidates per rule 3."),
  electrificationTypes: z.array(z.enum(["hybrid", "plug_in_hybrid", "electric"])).optional().describe("hybrid (includes mild hybrid), plug_in_hybrid and/or electric. See rule 4."),
  electrificationRequirement: z.enum(["required", "preferred"]).optional().describe("Whether the stated electrification types are required or preferred."),
  // Widened per design doc §2 — all live-verified filterable.
  drivetrain: z.string().optional().describe("AWD, 4WD, FWD, RWD or a comma-separated set. Cars decoded with a different drivetrain are left out; confirmed cars come first; unconfirmed cars follow, marked."),
  transmission: z.enum(["Automatic", "Manual"]).optional().describe("Not used to filter results in this version, because the listing data has no transmission field. Transmission is shown on a result when known."),
  exteriorColor: z.string().optional().describe("Requested exterior colour."),
  interiorColor: z.string().optional().describe("Requested interior colour."),
  vehicleType: z.string().optional().describe("Finer class only when the buyer names it (Crossover, Wagon, Hatchback, Coupe). Do not repeat bodyType."),
  doors: z.number().optional().describe("Requested door count."),
  cylinders: z.number().optional().describe("Not used to filter results in this version, because the listing data has no cylinder-count field. Engine details are shown on a result when known."),
  used: z.boolean().optional().describe("Vehicle condition: true for used only, false for new only; omitted includes both."),
  cpo: z.boolean().optional().describe("Request for certified pre-owned status. Results distinguish confirmed, reported-not-CPO, and unreported evidence."),
  state: z.string().optional().describe("Two-letter US state code for a state-wide search when no local ZIP is available."),
  noAccidents: z.boolean().optional().describe("Request for no reported accidents. Results distinguish reported-clean, reported issues, and unreported history."), // maps to history.accidentCount=0
  oneOwner: z.boolean().optional().describe("Request for one-owner history. Results distinguish available ownership evidence from unreported history."), // maps to history.ownerCount=1
})
  // Legacy `goals` must be HARD-REJECTED post-cutover, never silently
  // stripped or dual-accepted (locked decision — see DECISIONS.md
  // SYS-20260909-001, and FINAL_DESCRIPTION_20260908.md's "Not in the
  // schema" note). `.strict()` is required — plain z.object() silently
  // drops unrecognized keys during ordinary Zod parsing.
  .strict()
  // Cross-field validation: electrificationRequirement is meaningless
  // without a non-empty electrificationTypes to apply it to. Reject
  // { electrificationRequirement: "required" } (no types at all) and
  // { electrificationRequirement: "preferred", electrificationTypes: [] }
  // (empty array) the same way — both leave the requirement with
  // nothing to require or prefer.
  //
  // CORRECTED comment (this session): an earlier version of this file
  // claimed `.superRefine()` breaks the SDK's schema/description
  // exposure by producing a ZodEffects wrapper with no `.shape`
  // property, and therefore avoided it entirely. That claim was tested
  // directly against the actual installed packages this session
  // (zod@4.4.3, @modelcontextprotocol/server) and is FALSE for this
  // version: `.shape` remains present and correct on a `.superRefine()`
  // result here, and — more importantly — the SDK's own JSON-schema
  // generation path (standardSchemaToJsonSchema -> z.toJSONSchema())
  // does not use `.shape`/getSchemaShape() for tool registration at
  // all; it uses Zod v4's native `.toJSONSchema()`, which correctly
  // unwraps a refined schema and preserves every field's `.describe()`
  // text. Verified directly: a `.strict().superRefine()` schema in this
  // exact setup produces a complete, fully-described JSON schema AND
  // enforces the refinement during real parsing. See DECISIONS.md for
  // the corrected finding — this replaces the prior avoidance rationale
  // rather than sitting alongside it as an unresolved contradiction.
  .superRefine((data, ctx) => {
    if (data.electrificationRequirement !== undefined) {
      const types = data.electrificationTypes;
      if (types === undefined || types.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["electrificationTypes"],
          message: "electrificationTypes must be present and non-empty when electrificationRequirement is set — required/preferred has nothing to apply to otherwise.",
        });
      }
    }
  });
  //
  // The legacy-`goals`-rejection mechanism above (`.strict()`) is
  // unaffected by this addition: `.strict()` already ran and rejected
  // unrecognized keys before `.superRefine()` ever sees the data,
  // confirmed by the same direct test — `.strict().superRefine(...)`
  // still produces the exact `{code: "unrecognized_keys", keys:
  // ["goals"], message: 'Unrecognized key: "goals"'}` result, surfaced
  // to the host as an McpError, not silently dropped.

/**
 * Database app: the same inputs, with notes that say what this inventory can and cannot do. The the provider
 * notes stay as they are for the other apps. Only descriptions differ; the accepted fields and types are identical.
 */
export const FindMatchingVehicleInputCatalog = FindMatchingVehicleInput.safeExtend({
  vin: z.string().optional().describe("Exact 17-character VIN for one current listing. Other criteria are evaluated against that listing; if the VIN is not listed, a link to similar vehicles on Edmunds is returned, but no different vehicle is substituted."),
  exteriorColor: z.string().optional().describe("Requested exterior colour (for example white, black, gray, blue), matched against the dealer's colour name. If fewer than 3 cars match, colour only influences ranking."),
  interiorColor: z.string().optional().describe("Requested interior colour, matched against the dealer's colour name. If fewer than 3 cars match, colour only influences ranking."),
  cpo: z.boolean().optional().describe("Request for certified pre-owned status. This inventory carries no certification data, so results are reported as unconfirmed."),
  noAccidents: z.boolean().optional().describe("Request for no reported accidents. This inventory carries no accident-history data, so results are reported as unconfirmed."),
  oneOwner: z.boolean().optional().describe("Request for one-owner history. This inventory carries no ownership data, so results are reported as unconfirmed."),
});
