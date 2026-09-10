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
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"]).optional().describe("Ranking objective: best_for_budget, cheapest, lowest_mileage, newest, or lower_risk. best_for_budget applies to \"best for budget\", \"best in my budget\", or a price ceiling with no other stated optimization. cheapest applies only to explicit lowest-price intent such as \"cheapest\" or \"lowest price\" — the word \"budget\" alone does not imply cheapest. Lower risk ranks available purchase-risk evidence and is not a guarantee. Use lower_risk for requests such as \"lower-risk,\" \"low risk,\" \"safer-looking,\" \"cleanest-looking history,\" or \"which cars look like the lower-risk buys.\" This changes ranking only; it is not a guarantee of safety or clean history. Data conflicts remain separate verification notes, not purchase-risk evidence."),
  yearMin: z.number().optional().describe("Earliest acceptable model year."),
  yearMax: z.number().optional().describe("Latest acceptable model year."),
  make: z.string().optional().describe("Vehicle manufacturer, such as Toyota, Honda, or Ford."),
  model: z.string().optional().describe("One or more real vehicle model names, without the manufacturer (for example, \"E-Class\" rather than \"Mercedes-Benz E-Class\"). This applies even in a cross-brand list: \"CR-V, RAV4, Outback\" is correct; \"Honda CR-V, Toyota RAV4, Subaru Outback\" is not. Comma-separated for multiple models. When a practical need implies a vehicle class (for example, a large family SUV, or a reliable commuter car), resolve it into real matching model names yourself, using your own knowledge, before calling this tool (for example, CR-V, RAV4, Highlander for a family SUV), every time, alongside the related need stated in vehicleNeeds. For broad hybrid, plug-in hybrid, or electric requests, also resolve suitable real electrified model or variant names and include them here."),
  bodyType: z.string().optional().describe("Broad body style, such as SUV, Sedan, Truck, or Minivan."),
  mileageMax: z.number().optional().describe("Maximum odometer mileage."),
  zip: z.string().optional().describe("Five-digit US ZIP code for a local search."),
  radiusMiles: z.number().optional().describe("Search radius in miles from the ZIP; the service applies its documented default when omitted."),
  trimPreference: z.string().optional().describe("Preferred trim or variant. It influences ranking and does not require a matching trim."),
  trimRequired: z.string().optional().describe("Requested trim or variant. A confirmed different trim is not treated as a match."),
  seatsMinPreference: z.number().optional().describe("Preferred minimum seating capacity. Results report whether available seating evidence meets the preference."),
  vehicleNeeds: z.array(z.string()).optional().describe("Short, capped list of listing-relevant practical needs (for example, a large family SUV or a commuter vehicle); not a transcript or broad profile. When a listed need implies a vehicle class, also resolve it into real matching model names yourself and include them in \`model\` alongside it (for example, a large family SUV need pairs with a model list like CR-V, RAV4, Highlander)."),
  electrificationTypes: z.array(z.enum(["hybrid", "plug_in_hybrid", "electric"])).optional().describe("One or more accepted electrified powertrain types: hybrid (including conventional and mild hybrids), plug_in_hybrid, and/or electric. For a broad request without a named model, pair this field with resolved model/variant names in model; do not use electrification fields alone for a generic body-style search."),
  electrificationRequirement: z.enum(["required", "preferred"]).optional().describe("Whether the stated electrification types are required or preferred."),
  // Widened per design doc §2 — all live-verified filterable.
  drivetrain: z.string().optional().describe("Requested drivetrain: AWD, 4WD, FWD, RWD, or a comma-separated acceptable set."),
  transmission: z.enum(["Automatic", "Manual"]).optional().describe("Requested transmission: Automatic or Manual. Supply this field only when the user explicitly stated or clearly implied a transmission preference; do not invent a value."),
  exteriorColor: z.string().optional().describe("Requested exterior colour."),
  interiorColor: z.string().optional().describe("Requested interior colour."),
  vehicleType: z.string().optional().describe("Finer vehicle classification when the user expressly distinguishes it, such as Crossover, Wagon, Hatchback, or Coupe. Do not duplicate bodyType; this field is for distinctions narrower than broad body styles."),
  doors: z.number().optional().describe("Requested door count."),
  cylinders: z.number().optional().describe("Requested engine cylinder count: V8 is 8, V6 is 6, and I4/four-cylinder is 4. Engine displacement is not represented by this field."),
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
