import { z } from "zod";

/**
 * find_matching_vehicle input schema (SYS-20260909-010) — extracted from
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
  vin: z.string().optional().describe("An exact 17-character VIN, when the user supplies one directly (e.g. 'Find VIN W1N4N5BB1TJ864755', 'is this VIN still available', 'check this VIN before I buy it', 'any red flags on this VIN?'). When set, this looks up that ONE specific vehicle directly — it does NOT run a broad search, and no other field is used to search for a different vehicle. Do not infer make/model/price filters instead of passing the VIN; pass the VIN as-is here. Any other stated criteria (price, trim, etc.) are checked against this specific vehicle and disclosed honestly, never used to substitute a different one. If the vehicle isn't found, that's reported plainly — never silently substituted with something similar. This path also returns a Buyer Check (good signs, concerns, what needs independent verification, next steps) built from evidence already on the result — appropriate whenever the user is asking about buying/verifying that specific VIN, not just its availability."),
  priceMax: z.number().optional().describe("Maximum price in USD. A hard ceiling — never send a value higher than what the user actually stated."),
  priceMin: z.number().optional().describe("Minimum price in USD."),
  priceFlexibility: z.enum(["strict", "flexible"]).optional().describe("Whether the price ceiling can flex. Set to 'flexible' only if the user signals approximation ('around', 'roughly', 'about') — otherwise omit; the ceiling stays strict by default."),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"]).optional().describe("What the user is actually optimizing for, not merely which words appear in the request. 'best_for_budget' (default) for 'best for budget', 'best in my budget', 'best value within my budget', 'best I can get', 'nicest in my budget', or a price ceiling with no other stated optimization. 'cheapest' ONLY for explicit lowest-price intent: 'cheapest', 'lowest price', 'spend as little as possible' — the word 'budget' by itself is NOT a signal for cheapest; 'best for budget' means best_for_budget, never cheapest. 'lowest_mileage' for fewest miles (this defaults the search to used vehicles only — new/demo cars are excluded automatically, disclosed to the user). 'newest' for latest model year. 'lower_risk' for 'lower-risk', 'low risk', 'safer-looking', 'cleanest-looking history', or 'which cars look like the lower-risk buys' — ranking only, based on genuine purchase-risk evidence (VIN identity verification failure, reported accident/history evidence, confirmed CPO or clean reported history); NEVER a guarantee a vehicle is safe, clean, or problem-free, and never excludes a vehicle for having unreported/unknown history. Listing/spec data conflicts (e.g. a cylinder-count disagreement) are verification notes, not purchase-risk evidence, and do not affect lower_risk ranking — but still worth mentioning when relevant, e.g. for a towing request where configuration matters. See LOWER RISK RANKING below. Also protects that same dimension if the search needs automatic widening — see AUTOMATIC WIDENING."),
  yearMin: z.number().optional().describe("Minimum model year."),
  yearMax: z.number().optional().describe("Maximum model year."),
  make: z.string().optional().describe("Vehicle manufacturer, e.g. Toyota, Honda, Ford."),
  model: z.string().optional().describe("Real vehicle model name(s) ONLY — never include the manufacturer name here, even if make is also set or omitted. Correct: 'ES' not 'Lexus ES'; 'E-Class' not 'Mercedes-Benz E-Class'; '530i' not 'BMW 530i'. Auto.dev's model field never contains the make, so a combined string silently returns zero results, not an error. Comma-separate multiple models, e.g. 'RAV4,RAV4 Hybrid' or 'Suburban,Tahoe,Yukon' for a resolved size/style qualifier — this works fine across different manufacturers in one list too (e.g. '530i,E-Class,A6' for a cross-brand luxury sedan search), since model names are typically unique without needing the make attached. Any size, style, or use-case description the user gives ('large SUV', 'good for towing', 'sporty') has no dedicated field — resolve it into real model names here, using your own knowledge, before calling this tool."),
  bodyType: z.string().optional().describe("Broad body style only, e.g. SUV, Sedan, Truck, Minivan. Use vehicleType instead for a finer distinction like Crossover vs SUV or hatchback vs coupe."),
  mileageMax: z.number().optional().describe("Maximum odometer mileage."),
  zip: z.string().optional().describe("5-digit US ZIP code to search near. Required for a local search radius — a search without one covers the user's stated state (if given) or the whole country, and is disclosed as such."),
  radiusMiles: z.number().optional().describe("Search radius in miles from the ZIP. Defaults to 50 if omitted."),
  trimPreference: z.string().optional().describe("Preferred trim level, e.g. 'Limited' or 'Sport'. Use ONLY when the user signals it's a soft preference ('prefer', 'ideally', 'if possible'). Ranking input only — never excludes a result with a different or unknown trim. If the user simply names a specific trim/variant as what they want, use trimRequired instead."),
  trimRequired: z.string().optional().describe("A specific trim/variant the user explicitly asked for, e.g. 'AMG GLA 35', 'Raptor', 'Type R', 'Limited'. A HARD eligibility requirement — a result with a confirmed different trim is excluded, not just ranked lower. Use this whenever a trim/variant name is part of the request, even folded into what looks like a model name (e.g. 'Mercedes AMG GLA 35' -> model: 'GLA', trimRequired: 'AMG GLA 35'). Never sent to Auto.dev as a query filter; matched locally against each result's own reported trim."),
  seatsMinPreference: z.number().optional().describe("Minimum seating capacity needed, e.g. 7 for a family needing three rows. Never excludes a result — seat count is disclosed per result (meets, falls short, or unreported), not hard-filtered, since seating capacity is not a real Auto.dev filter."),
  vehicleNeeds: z.array(z.string()).optional().describe("Freeform buyer needs like 'family', 'reliability', 'commuting'. Ranking/context input only, not a hard filter — this tool has no reliability or ownership-cost data to verify these claims against. Replaces the retired `goals` field (SYS-20260909-004/005) — no dual-accept."),
  electrificationTypes: z.array(z.enum(["hybrid", "plug_in_hybrid", "electric"])).optional().describe("Which electrified powertrain type(s) satisfy the request. 'hybrid' implicitly includes mild hybrids at match time — mild_hybrid is an internal NHTSA classification only and is never a selectable value here. 'plug_in_hybrid' is distinct and never implied by 'hybrid'. Combine with electrificationRequirement to say whether this is a hard requirement or a ranking preference."),
  electrificationRequirement: z.enum(["required", "preferred"]).optional().describe("'required' excludes any vehicle NHTSA cannot confirm as one of electrificationTypes (unconfirmed/ambiguous vehicles are dropped, never assumed to satisfy the request). 'preferred' only affects ranking — no vehicle is excluded for unconfirmed electrification."),
  // Widened per design doc §2 — all live-verified filterable.
  drivetrain: z.string().optional().describe("AWD, 4WD, FWD, or RWD. Comma-separate multiple values if the user is open to more than one."),
  transmission: z.enum(["Automatic", "Manual"]).optional().describe("Automatic or Manual. A real, verified hard filter — always use this field when the user names a transmission type."),
  exteriorColor: z.string().optional().describe("Named exterior color, e.g. Blue, Red, Black, Silver. A real, verified hard filter on the actual data — always use this field when the user names an exterior color, never skip it or leave it unfiltered."),
  interiorColor: z.string().optional().describe("Named interior color, e.g. Black, Tan, Gray. A real, verified hard filter on the actual data, exactly like exteriorColor — always use this field when the user names an interior color. Do not skip it, and do not substitute checking each result's interior color manually after an unfiltered search — that produces an incomplete result set."),
  vehicleType: z.string().optional().describe("Finer body classification than bodyType, e.g. Crossover, SUV, Sedan, Wagon, Minivan, Performance/Sports, Hybrid, Hatchback, Coupe, Luxury, Electric. This field's tagging can be genuinely inconsistent per model in the underlying data (e.g. a Volvo V90 wagon is tagged Crossover, not Wagon). Combined with a specific model, the tool automatically retries without this filter if it returns zero, and only excludes a genuine mismatch when real alternatives still remain — it never hides an entire correct result set over a data-tagging quirk. For a plain body-style request with no specific model, bodyType is the more reliable choice."),
  doors: z.number().optional().describe("Exact door count, e.g. 2 or 4."),
  cylinders: z.number().optional().describe("Engine cylinder COUNT — a discrete number, distinct from engine displacement in liters (e.g. '2.5L', '3.5L'), which is NOT filterable. 'V8' means 8. 'V6' means 6. 'four-cylinder' or 'I4' means 4. This is a real, verified hard filter on the actual data — always use this field for a stated cylinder configuration. Do not treat it as unfilterable, and do not substitute checking each result's engine text manually after an unfiltered search — that produces an incomplete result set."),
  used: z.boolean().optional().describe("true for used vehicles only, false for new vehicles only. Omit to search both. Automatically set to true when priorityAxis is 'lowest_mileage' unless the user explicitly asked for new."),
  cpo: z.boolean().optional().describe("true if the user specifically wants certified pre-owned. Never excludes non-CPO results — CPO status is disclosed per result (confirmed, reported not CPO, or unreported), not hard-filtered, since the data can confirm CPO status but never disprove it."),
  state: z.string().optional().describe("Two-letter US state code, e.g. CA, TX, NY. Use for a state-wide search when the user names a state but gives no city or ZIP — the search is disclosed as covering the whole state rather than a specific area."),
  noAccidents: z.boolean().optional().describe("true if the user specifically wants no reported accidents. Never excludes results — accident history is disclosed per result (reported clean, reported issues, or unreported), not hard-filtered, since roughly half of listings have no history data at all and unknown must never be treated as false."), // maps to history.accidentCount=0
  oneOwner: z.boolean().optional().describe("true if the user specifically wants a one-owner vehicle. Never excludes results — ownership history is disclosed per result, not hard-filtered, for the same reason as noAccidents."), // maps to history.ownerCount=1
})
  // SYS-20260909-005/007: legacy `goals` must be HARD-REJECTED post-cutover,
  // never silently stripped (André, Sep 9 2026). `.strict()` is required —
  // plain z.object() silently drops unrecognized keys during ordinary Zod
  // parsing.
  //
  // IMPORTANT, verified against the actual installed @modelcontextprotocol/sdk
  // source this session: this schema is registered below as `inputSchema`,
  // and the SDK runs its OWN validation (McpServer.validateToolInput) against
  // exactly the schema object we hand it, before our handler function ever
  // sees `input` — our handler receives only the already-parsed/rejected
  // result. A `.superRefine()`/`.passthrough()` chain was tried first for a
  // fully custom "unsupported legacy field 'goals'; use 'vehicleNeeds'"
  // message, but that converts this into a ZodEffects wrapper with no
  // `.shape` property — the SDK's normalizeObjectSchema() falls back to
  // EMPTY_OBJECT_JSON_SCHEMA when `.shape` is missing, which would have
  // silently erased every field description from the tool schema shown to
  // the host. `.strict()` alone (no further chaining) is the version that
  // keeps `.shape` intact (confirmed: `typeof schema.shape === "object"`
  // after `.strict()`), so the SDK both (a) advertises the real schema to
  // hosts and (b) genuinely rejects `goals` server-side via its own
  // safeParseAsync call — verified locally: `{goals:[...]}` produces
  // `{code: "unrecognized_keys", keys: ["goals"], message: 'Unrecognized
  // key: "goals"'}`, surfaced to the host as an McpError, not silently
  // dropped. Tradeoff, flagged not hidden: the rejection message is Zod's
  // own generic "Unrecognized key" text, not the fully custom wording
  // originally requested — a fully custom per-field message would require
  // intercepting the raw CallToolRequest upstream of the SDK's own
  // validateToolInput, which is a different, larger change outside this
  // route file's scope. The field's own `.describe()` text already tells
  // any host reading the error+schema together that `vehicleNeeds` is the
  // correct field.
  .strict();

