import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { type AutoDevListing, type ListingsQuery } from "@/lib/auto-dev-client";
import { searchListingsLean, getListingByVin, searchListingByVinExact, getModelFacets } from "@/lib/auto-dev-client";
// Widening ladder re-enabled 2026-08-16 (SYS-20260816-008). It was bypassed on
// Aug 13 per André's request — "search itself needs to work correctly before any
// widening logic runs on top of it." That precondition is now met: the stage-2
// price-ceiling bug (SYS-20260816-004) is fixed and the full A/B/C prompt suite
// verified 9/9 the same day. Re-enabled via a rewritten, injected API rather
// than the old call — see lib/loosening-ladder.ts header for exactly why.
import { widenSearchIfThin, type StepName } from "@/lib/loosening-ladder";
import { isConfirmedOutsideRadius } from "@/lib/geo-verification";
import { verifyAgainstConstraints } from "@/lib/post-verify";
import { parseIntent } from "@/lib/intent-parser";
import { applyDiversity } from "@/lib/diversity";
import { crossCheckVin, type VerificationResult } from "@/lib/vin-cross-check";
import { classifyRiskTier, riskTierRank, type RiskTier } from "@/lib/risk-tier";
import { computeMatchScore } from "@/lib/match-score";
import { resolveLinks } from "@/lib/link-resolution";
import { sanitizeDealerName } from "@/lib/dealer-name";
import { applyKnownHybridOverride, formatFuelTypeForDisplay } from "@/lib/fuel-type";
import { decodeNhtsaElectrification, nhtsaIndicatesElectrified, type NhtsaElectrificationResult } from "@/lib/nhtsa-client";
import { getCorpusCountForDescription, initCorpusCount } from "@/lib/corpus-count";
import { CAPABILITIES } from "@/lib/capabilities";
import { buildIntentConfirmations, detectDataConflicts, buildQualifierAccounting, type CardIntentInput } from "@/lib/qualifier-accounting";
import { RESULTS_CARD_RESOURCE_URI, buildResultsCardHtml } from "@/lib/results-card";
import { signImageUrl } from "@/lib/image-proxy-sign";
import { trimMatches } from "@/lib/trim-match";
import {
  FindMatchingVehicleOutputSchema,
  type FindMatchingVehicleOutput,
} from "@/lib/find-matching-vehicle-output";
import {
  buildConstraintChecks,
  aggregateSearchConstraintStatus,
  type ConstraintEvidenceRequest,
} from "@/lib/constraint-evidence";

initCorpusCount();

// Description rules 2 and 4 below are adapted from the proven, live-tested
// tool-description language in AUTODEV_V2_NLP_SEARCH_REDESIGN.md §5.1
// (Sky redesign, approved July 26, 2026) — same architecture principle
// Find My Car already uses (calling LLM owns intent, server stays thin and
// deterministic), just with more explicit coaching for known data quirks.
const FIND_MATCHING_VEHICLE_DESCRIPTION = () => `Use this tool for live US vehicle-inventory searches when the user wants current vehicles for sale or a shortlist — whether the request is explicit ("Honda CR-V under $35k near 90210"), superlative ("cheapest," "newest," "lowest mileage"), detailed-spec (price, make/model, year, mileage, color, drivetrain, transmission, cylinders, seating), or open-ended buyer need ("reliable for a teen driver," "good for towing," "good for commuting," "good for a family"). This tool resolves what a need actually implies — reliability, size, safety, running cost, capability — into the right real search, even when nothing in the request names a specific car. If a search comes back too thin, it automatically widens the least-restrictive constraint first, protects whatever the user said matters most, and always discloses exactly what changed — see AUTOMATIC WIDENING below; don't retry a thin search yourself.

Do not use this tool for general automotive education, financing or leasing advice, maintenance questions, or category comparisons that don't require live inventory.

The tool searches across ${getCorpusCountForDescription()} active US listings and returns a small set of close matches, not a broad inventory dump. Vehicle identity is VIN-decoded and cross-checked. Every hard filter actually sent is confirmed against the tool's canonical structured data; anything unavailable, preference-only, relaxed, anomalous, or conflicting is disclosed rather than silently assumed or dropped.

VIN-verified means the vehicle's core identity was cross-checked. It does not independently guarantee dealer-reported price, mileage, equipment, availability, ownership history, accident history, or condition.

SEARCH DECOMPOSITION

The tool's structured fields define what can be filtered directly. Before calling it, translate the user's request into those fields using this order:

1. Map anything represented by a real hard-filter field directly to that field. Do not invent price, year, mileage, body-style, history, or other hard filters the user didn't state or clearly imply.
2. Put remaining qualitative preferences into \`goals\`; goals influence relevance and ranking but are not hard exclusions — they never determine which vehicles are eligible.
3. If any goal implies a vehicle class, lifestyle use case, or suitability judgment (family, towing, commuting, off-road, teen driver, and similar), resolve it into a real, comma-separated model list and pass it in the \`model\` field, every time — this model list is a hard eligibility filter, unlike \`goals\`; \`bodyType\` and \`goals\` alone can't enforce which models actually suit the need, and results will skew toward price/mileage instead of genuine fit.
4. If a reliable resolution isn't possible, use the closest literal field and tell the user precision is reduced. Never guess or silently discard the requirement.

Examples:
- "Seven-seat SUV" → bodyType: "SUV", seatsMinPreference: 7
- "V8 F-150" → make: "Ford", model: "F-150", cylinders: 8
- "Reliable teen car" → hard fields plus goals (reliability, safety, manageable size, low running cost) and a resolved model list (e.g. Corolla, Civic, Mazda3, Impreza, Fit, Prius)
- "Large SUV" → resolved model list (no size-class field exists)
- "Family SUV" / "SUV good for a family" → resolved model list (e.g. CR-V, RAV4, CX-5, CX-50, Forester, Outback, Pilot, Highlander, Passport, Ascent)
- "Good for towing" → hard fields and goals, resolved to tow-suitable models, plus a note that VIN-specific tow capacity, payload, and hitch equipment still need verifying

Never rely on an unfiltered search followed by manually inspecting a few returned results when a real field can enforce the requirement — the right vehicles may never even enter the sampled result set. This is the no-manual-post-filtering rule, referenced again below.

HYBRID AND PHEV COVERAGE

Hybrid and plug-in hybrid vehicles are often inconsistently tagged in source listings, and there's no dedicated fuel-type filter. When a specific model is named, include the relevant hybrid/PHEV variant name in the model field (e.g. "RAV4,RAV4 Hybrid,RAV4 Prime" or "Sportage,Sportage Hybrid,Sportage Plug-In Hybrid"). This broadens the search to include both; it doesn't guarantee every result is electrified. Check each individual result's own model field (results distinguish "Camry" from "Camry Hybrid," for example) before telling a user a specific result is or isn't the hybrid/PHEV variant they asked for — a deliberate, narrow exception to the no-manual-post-filtering rule above, made only because no dedicated fuel-type hard filter exists. When no model is named, mention to the user that hybrid/PHEV coverage may be incomplete without one.

Only broaden to include the base gas variant when hybrid/PHEV is a preference the user would accept trading off. When it's a stated requirement instead — "the cheapest hybrid," "only hybrids," "must be electrified" — send just the hybrid/PHEV variant names (e.g. "RAV4 Hybrid,RAV4 Prime", not "RAV4,RAV4 Hybrid,RAV4 Prime"). This matters most with a price-optimizing priorityAxis: hybrid trims almost always cost more than their gas counterparts, so a broadened list combined with cheapest or best_for_budget will systematically surface the cheaper gas variant instead of a hybrid — the opposite of what was asked. This applies to any hybrid/PHEV-capable model, not just the examples above.

HARD FILTERS VERSUS DISCLOSURE

Real hard filters determine eligibility — every primary result satisfies every hard field actually sent. noAccidents, oneOwner, and cpo are different: they're disclosure and ranking inputs, never guaranteed exclusions, since vehicle history and CPO status are often unreported rather than confirmed negative — every result is reported honestly as confirmed, reported-with-issues, or unconfirmed, never assumed clean or excluded for silence. When a result includes a \`carfaxUrl\`, include it as its own distinct link alongside the listing link, labeled plainly (e.g. "Carfax report") — so the buyer can verify independently. If a result doesn't clearly confirm what was asked, say so plainly rather than presenting it as a clean match.

HARD-FIELD MAPPING

Prefer dedicated structured fields whenever one exists:
- AWD or 4WD → drivetrain
- Manual or automatic → transmission
- Named exterior color → exteriorColor
- Named interior color → interiorColor
- V8 → cylinders: 8. V6 → cylinders: 6. Four-cylinder/I4 → cylinders: 4
- Specific door count → doors
- Minimum seating → seatsMinPreference
- Broad body style → bodyType
- Finer classification (crossover vs. SUV, hatchback vs. coupe) → vehicleType
- "New" → used: false. "Used" or "pre-owned" → used: true. Omit if unspecified to search both — except lowest_mileage, which defaults to used only (see PRIORITY AXIS).

Cylinder count is filterable; engine displacement is not. "V8" must use cylinders: 8 — never treat it as an unfilterable displacement spec.

The model field never includes the manufacturer name — "Lexus ES," "BMW 530i," and "Mercedes-Benz E-Class" are all wrong; use "ES," "530i," and "E-Class." This applies even in a cross-brand list with no single make field to set. The tool strips a mistakenly-included make automatically and discloses the correction, so this doesn't cause a failed search — but sending it correctly the first time is still preferable.

TRIM / VARIANT — REQUIRED VERSUS PREFERRED

Two separate fields exist for a trim/variant, and picking the right one matters: \`trimRequired\` is a hard eligibility filter; \`trimPreference\` is ranking-only. Use \`trimRequired\` whenever the user names a specific trim/variant as part of what they're asking for ("AMG GLA 35," "Limited," "Raptor," "Type R") — including when it's folded into a model-like phrase, e.g. "Mercedes AMG GLA 35" means make: "Mercedes-Benz", model: "GLA", trimRequired: "AMG GLA 35" — never trimPreference. Use \`trimPreference\` only when the user explicitly signals it's a soft preference ("prefer," "ideally," "if possible," "would like"). A result whose trim is confirmed to differ from \`trimRequired\` is excluded, never shown as a match — do not manually relax this yourself if the tool returns fewer results; that's the trade-off of an explicit trim requirement, the same as any other hard filter.

DIRECT VIN LOOKUP

When the user supplies a specific 17-character VIN — "Find VIN W1N4N5BB1TJ864755," "is this VIN available," "check VIN ...," "check this VIN before I buy it," "any red flags?," "what should I verify before buying this?" — pass it in \`vin\`. This looks up that exact vehicle only; it is NOT a normal search and doesn't use make/model/price to find a different vehicle. Never translate a VIN into make/model/price filters instead of using this field. Any other criteria the user also stated (price, trim, etc.) are checked against that specific vehicle and reported honestly (met or not) — a mismatch never causes a different, similar vehicle to be substituted. If the exact VIN isn't found in current inventory, that's reported plainly as not found, never silently swapped for something similar. When the user's intent is specifically about pre-purchase due diligence on a known VIN, this path also returns a Buyer Check — good signs, concerns, what still needs independent verification, and next steps — built entirely from evidence already available on that result, never a fabricated fact or a numeric score.

Use priceFlexibility: "flexible" only when the user signals approximation ("around," "roughly," "about"). Otherwise price is a strict ceiling, never silently loosened.

RESULT TRUST

Every result's text states plainly which criteria it met, and separately flags any genuine data conflict (e.g. a cylinder count disagreeing with its own series description). If a price, mileage, or other value is flagged as an implausible data error, never present it as the genuine cheapest, newest, or best match in your own summary — it stays visible for transparency but is excluded from that judgment.

Open with real scale: \`corpusSizeApprox\` searched, narrowed to \`totalMatches\` matching this request — e.g. "3,581,127 searched → 406 matched, here are the strongest options:". Never claim an exact count for the results actually shown, since that depends on how the response gets formatted — keep that part qualitative ("strongest options," "best matches"). If \`totalMatches\` is null, the exact count wasn't available for this search — don't say "0 matched" or invent a number; just open with \`corpusSizeApprox\` searched and go straight into the results.

PRIORITY AXIS

Set priorityAxis based on what the user is actually optimizing for, not merely which words appear in the request:

- best_for_budget (default) — "best for budget," "best in my budget," "best value within my budget," "best," "nicest," or a price ceiling stated with no other explicit optimization ("under $50k," "budget of $50k"). Samples from the top of budget down for genuine value, not the rock-bottom price. When uncertain, use best_for_budget.
- cheapest — only for explicit lowest-price intent: "cheapest," "lowest price," "spend as little as possible." The word "budget" appearing in the request is NOT by itself a signal for cheapest — "best for budget" and "best in my budget" both mean best_for_budget, precisely because the user is asking for the best vehicle a budget affords, not the least expensive vehicle available. Do not map a request to cheapest merely because it contains the word "budget."
- lowest_mileage — "lowest mileage"/"as few miles as possible" (this defaults the search to used vehicles only, since a new car's low mileage isn't a meaningful comparison — disclosed to the user, not silent).
- newest — "newest"/"latest model year".
- lower_risk — "find me a lower-risk CR-V," "low risk F-150 for towing," "the safer-looking options," "cars with the cleanest-looking history," "which available cars look like the lower-risk buys." See LOWER RISK RANKING below.

LOWER RISK RANKING

lower_risk is ranking guidance, not a filter — every existing hard constraint (price, make/model, trimRequired, year, mileage, radius, drivetrain, etc.) still applies exactly as normal; lower_risk never restricts results to only vehicles with positive history evidence, it only changes the order they're shown in. CarClever prioritizes candidates based on available listing/history evidence (VIN identity verification, reported accident history, CPO status, data conflicts) — genuine positive evidence ranks first, then vehicles with no known concerns either way (incomplete/unreported history is neutral, never treated as risky), then vehicles with a known concern, then vehicles with stronger/multiple known concerns. This is shortlist guidance only, never a guarantee that any vehicle is safe, clean, accident-free, or problem-free. Say so naturally once, briefly, rather than repeating a disclaimer on every individual result — e.g. "I prioritized vehicles with stronger reported history evidence and pushed known accident/data concerns lower. Some listings have incomplete history, so check Carfax and Edmunds before buying." When an individual result does carry a known concern, mention it plainly (the result's own disclosure already states what's known) rather than adding a second generic warning on top.

LOCATION HANDLING

A ZIP anchors a local search, defaulting to a 50-mile radius when none is specified; if results are thin it may widen to 100 miles automatically, disclosed in the result — see AUTOMATIC WIDENING. Validate a user-provided ZIP before calling — if it's invalid or not a real US ZIP, ask for a corrected one rather than substituting another location yourself. A named city with no ZIP has no dedicated field on this tool — if the city/state is unambiguous, resolve it to a real, representative central ZIP yourself and disclose the ZIP used, the same way you'd resolve "large SUV" into real model names. If the city or state is ambiguous (Portland, Springfield, Columbus, and similar), ask which one before searching rather than guessing. A named state with no ZIP searches that whole state — disclosed to the user as broader than a local search, never presented as if it were local. No location at all searches nationwide — same disclosure. Never silently narrow or widen scope without saying so.

AUTOMATIC WIDENING

If a search comes back too thin, the tool automatically retries with progressively wider constraints, protecting whatever priorityAxis says the user cares about most, and always discloses what changed — relay that disclosure rather than omitting it. Don't run your own retry on a thin result; the tool already does this correctly and safely.

EMPTY SEARCHES

If a search still returns nothing after automatic widening, a strict user constraint is never silently relaxed further to fix it. When the tool can genuinely self-correct (for example, an unrecognized model name gets checked against real inventory and corrected), that correction is always disclosed, never silent — treat it as a real fix, not a guess. If nothing can be self-corrected, say plainly that nothing matched, name the limiting constraint if it's clear, and suggest the smallest real adjustment (a higher budget, a wider radius, an additional model) rather than guessing at a workaround yourself.

PRESENTING RESULTS

If a visual result card was already rendered above this response (MCP Apps-capable hosts only), it already shows each result's photo, price, mileage, match score, and its own click-through link — don't restate those details in text. On hosts without a rendered card, or in addition to it, still follow everything below in full; the two links and count text remain required since not every host renders the card.

Two links belong on every result.

1. THE LISTING LINK. Include each result's own link by default. For virtually every result that is the Edmunds link (\`affiliateUrl\`). Never substitute a dealer's own site, Carfax, Autolist, or any other URL instead of it, even if another link looks cleaner or more direct — this includes Carvana-sourced results: \`dealerListingUrl\` (including a Carvana link) is never the user-facing destination, even when \`affiliateUrl\` is null. When \`affiliateUrl\` is null, use \`affiliateFallbackUrl\` instead and label it clearly as a fallback — e.g. "Similar options on Edmunds" — never "Check availability," since it isn't this specific vehicle. If neither \`affiliateUrl\` nor \`affiliateFallbackUrl\` is available, say so plainly rather than substituting \`dealerListingUrl\`.

2. THE FALLBACK LINK. Include \`affiliateFallbackUrl\` alongside the listing link on every result. State it distinctly, e.g. "if that Edmunds listing is no longer available, see similar options here: [link]" — don't fold it into the listing link as if the two were the same thing.

For the top result, embed its \`primaryImage\` directly using markdown image syntax so it renders inline — the URL is already present in the result data, no separate tool call needed. Only do this if \`primaryImage\` is present; never substitute a placeholder or generic image.

MAPS

For local vehicle searches, when results include 3+ dealer locations, present the recommended results on an interactive map using any available map visualization tool — this applies whenever geographic/dealer location data is returned, using the dealer/location data already returned by the tool.`;

const FindMatchingVehicleInput = z.object({
  vin: z.string().optional().describe("An exact 17-character VIN, when the user supplies one directly (e.g. 'Find VIN W1N4N5BB1TJ864755', 'is this VIN still available', 'check this VIN before I buy it', 'any red flags on this VIN?'). When set, this looks up that ONE specific vehicle directly — it does NOT run a broad search, and no other field is used to search for a different vehicle. Do not infer make/model/price filters instead of passing the VIN; pass the VIN as-is here. Any other stated criteria (price, trim, etc.) are checked against this specific vehicle and disclosed honestly, never used to substitute a different one. If the vehicle isn't found, that's reported plainly — never silently substituted with something similar. This path also returns a Buyer Check (good signs, concerns, what needs independent verification, next steps) built from evidence already on the result — appropriate whenever the user is asking about buying/verifying that specific VIN, not just its availability."),
  priceMax: z.number().optional().describe("Maximum price in USD. A hard ceiling — never send a value higher than what the user actually stated."),
  priceMin: z.number().optional().describe("Minimum price in USD."),
  priceFlexibility: z.enum(["strict", "flexible"]).optional().describe("Whether the price ceiling can flex. Set to 'flexible' only if the user signals approximation ('around', 'roughly', 'about') — otherwise omit; the ceiling stays strict by default."),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest", "lower_risk"]).optional().describe("What the user is actually optimizing for, not merely which words appear in the request. 'best_for_budget' (default) for 'best for budget', 'best in my budget', 'best value within my budget', 'best I can get', 'nicest in my budget', or a price ceiling with no other stated optimization. 'cheapest' ONLY for explicit lowest-price intent: 'cheapest', 'lowest price', 'spend as little as possible' — the word 'budget' by itself is NOT a signal for cheapest; 'best for budget' means best_for_budget, never cheapest. 'lowest_mileage' for fewest miles (this defaults the search to used vehicles only — new/demo cars are excluded automatically, disclosed to the user). 'newest' for latest model year. 'lower_risk' for 'lower-risk', 'low risk', 'safer-looking', 'cleanest-looking history', or 'which cars look like the lower-risk buys' — ranking only, based on available listing/history evidence (VIN identity check, reported accidents, CPO status, data conflicts); NEVER a guarantee a vehicle is safe, clean, or problem-free, and never excludes a vehicle for having unreported/unknown history — see LOWER RISK RANKING below. Also protects that same dimension if the search needs automatic widening — see AUTOMATIC WIDENING."),
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
  goals: z.array(z.string()).optional().describe("Freeform buyer goals like 'family', 'reliability', 'commuting'. Ranking/context input only, not a hard filter — this tool has no reliability or ownership-cost data to verify these claims against."),
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
});

const ResolveDealerUrlOutput = z.object({
  affiliateUrl: z.string().nullable(),
  affiliateFallbackUrl: z.string().nullable(),
  dealerListingUrl: z.string().nullable(),
  isCarvana: z.boolean(),
  linkStatus: z.enum(["both-available", "edmunds-only", "dealer-only", "fallback-only", "none-available"]),
});

const SHORTLIST_SIZE = 5;

/**
 * Result-count strategy (SYS-20260816-008).
 *
 * Broad, exploratory searches ("SUV good for a family under 40k") get a larger
 * shortlist than precise ones ("blue 2020 Civic EX manual"). Real reason: on a
 * broad search the host model tends to narrow the list further in its own
 * answer — a live Aug 16 run returned 5 good vehicles and the user was shown 3
 * — so a set of 5 can reach the user as 2-3 and read as thin inventory when the
 * underlying pool was in the thousands. A precise search has no such problem
 * and padding it would only add weaker matches.
 *
 * Costs nothing extra upstream in the common case: the diversity step already
 * over-fetches to SHORTLIST_SIZE * 2 candidates and then discards the surplus.
 * Only stage-2 per-VIN detail calls scale with this, and those run in parallel.
 */
const BROAD_SHORTLIST_SIZE = 8;

/**
 * Absolute wall-clock budget from request start, after which NO new widening
 * call is started. vercel.json caps this route at 60s; a single lean search can
 * take 40s worst case (25s + 15s degraded retry). 15s keeps the pathological
 * path bounded at roughly 15s (elapsed) + 25s (one in-flight call) + stage 2,
 * comfortably inside 60s, while leaving normal searches (~1-3s) free to widen.
 * This guard is what prevents a repeat of the real Aug 12 timeout incident.
 */
const WIDENING_TIME_BUDGET_MS = 15_000;
// Vercel's configured function maxDuration (see vercel.json). Used to cap the
// widening budget so a slow primary search shortens the widening window
// instead of risking a hard platform timeout mid-ladder.
const VERCEL_MAX_DURATION_MS = 60_000;
// Time held back for stage-2 per-VIN detail fetches, card assembly and the
// response write after widening finishes — widening must not consume the
// entire remaining window.
const RESPONSE_ASSEMBLY_RESERVE_MS = 20_000;

/**
 * Resolves the calling LLM's decoded priorityAxis into Auto.dev's single-field
 * sort. Same decode-then-execute pattern as the rest of the tool: the LLM reads
 * the user's actual sentence and picks the axis; we map it deterministically.
 *
 * This exists because inferring priority from *which fields happen to be set*
 * is genuinely ambiguous — a user with both priceMax and mileageMax could mean
 * "SUV under $60k, low mileage is a nice-to-have" or "lowest mileage SUV,
 * $60k is just a cap" - identical structured params, opposite intent. Only the
 * sentence itself disambiguates that, so it's the LLM's job, not a heuristic.
 *
 * best_for_budget (default) reflects the app's actual purpose: find the best
 * vehicle for what they're describing, not the cheapest one that qualifies.
 * Sampling from the top of a stated budget (price.desc) tends to correlate
 * with newer years/better trims — without us having to encode that correlation
 * ourselves. Falls back to year.desc when there's no price ceiling to anchor to.
 */
/**
 * CPO disclosure — same Trust Class C treatment as history (SYS-20260812-050/051).
 * cpo=false is explicitly forbidden as definitive proof of non-CPO (CPO-001).
 * Never excludes; always discloses what's actually known.
 */
function buildCpoSummary(
  listing: AutoDevListing,
): { state: "confirmed_cpo" | "reported_not_cpo" | "unknown"; note: string } {
  const cpo = listing.retailListing?.cpo;
  if (cpo === true) {
    return { state: "confirmed_cpo", note: "Reported as Certified Pre-Owned by the dealer." };
  }
  if (cpo === false) {
    return {
      state: "reported_not_cpo",
      note: "Not reported as CPO by this listing — this isn't definitive proof it lacks certification, just that it wasn't flagged as one.",
    };
  }
  return { state: "unknown", note: "CPO status not reported for this listing." };
}

/**
 * Seats disclosure — same Trust Class C treatment as CPO/history
 * (SYS-20260815 follow-up). `vehicle.seats` is a real response field, but
 * confirmed absent from Auto.dev's documented Vehicle Filters list (field
 * audit, 2026-08-14) — it can be reported, never queried as a hard filter.
 * `seatsMinPreference` was collected as input since early in the build and
 * did nothing until now — this closes that gap, without ever excluding a
 * result on seat count (a below-preference or unreported seat count is
 * disclosed, not dropped — same "unknown != false" discipline as history/CPO).
 */
function buildSeatsSummary(
  listing: AutoDevListing,
  seatsMin: number | undefined,
): { state: "meets_or_exceeds" | "below_requested" | "reported" | "unknown"; note: string } {
  const seats = listing.vehicle?.seats;
  if (seats == null) {
    return {
      state: "unknown",
      note: seatsMin != null
        ? `Seating capacity not reported by this listing — can't confirm it meets the requested ${seatsMin}+ seats.`
        : "Seating capacity not reported by this listing.",
    };
  }
  if (seatsMin == null) {
    return { state: "reported", note: `${seats} seats.` };
  }
  if (seats >= seatsMin) {
    return { state: "meets_or_exceeds", note: `${seats} seats — meets the requested ${seatsMin}+ seat minimum.` };
  }
  return {
    state: "below_requested",
    note: `${seats} seats — below the requested ${seatsMin}+ seat minimum. Shown anyway since seat count is a soft preference, not a hard filter.`,
  };
}

/**
 * History disclosure — Trust Class C. Extended (SYS-20260812-051 audit) to
 * cover owner count alongside accidents; previously only accidents were
 * checked despite oneOwner being a real, collected input doing nothing.
 * "discover broadly, then verify locally or cross-API" — NEVER a query filter
 * (already removed as one, SYS-20260812-047), only a post-search disclosure.
 *
 * Design principle (agreed with André): never exclude a result on MISSING
 * history data — only on a known, positive contradiction. Always disclose
 * confidence honestly per result, and point to the Carfax link (free
 * passthrough, SYS-20260812-022) as the independent source when Auto.dev's
 * own data can't fully answer the question. This is the general pattern for
 * "user asked for something we can't be fully sure about" - run broadly,
 * never silently narrow the pool, be explicit about what we actually know.
 */
function buildHistorySummary(
  listing: AutoDevListing,
): { state: "known_clean" | "known_issues" | "unreported"; note: string; ownerNote: string | null } {
  const h = listing.history;
  const carfaxAvailable = Boolean(listing.retailListing?.carfaxUrl);
  const carfaxHint = carfaxAvailable
    ? " The Carfax link on this result is the way to independently confirm."
    : " No Carfax link was available on this listing to independently confirm.";

  // Owner count — same disclosure discipline, previously collected as an
  // input (oneOwner) and never used at all (SYS-20260812-051 audit finding).
  let ownerNote: string | null = null;
  if (h?.ownerCount != null) {
    ownerNote = `Reported ${h.ownerCount} owner${h.ownerCount === 1 ? "" : "s"} in this listing's history.`;
  } else if (h?.oneOwner === true) {
    ownerNote = "Reported as a one-owner vehicle.";
  } else if (h?.oneOwner === false) {
    ownerNote = "Not reported as one-owner — not definitive proof of multiple owners, just not flagged as one-owner.";
  }

  if (!h || (h.accidentCount == null && h.accidents == null)) {
    return {
      state: "unreported",
      note: `Accident history was not reported for this listing — this is common (roughly half of listings), not a red flag by itself.${carfaxHint}`,
      ownerNote,
    };
  }

  const accidentCount = h.accidentCount ?? (h.accidents ? 1 : 0);
  if (accidentCount > 0) {
    return {
      state: "known_issues",
      note: `Reported ${accidentCount} accident${accidentCount === 1 ? "" : "s"} in this listing's history.${carfaxHint}`,
      ownerNote,
    };
  }

  return {
    state: "known_clean",
    note: "No accidents reported in this listing's history (single-source; not an independent guarantee).",
    ownerNote,
  };
}

function resolveSort(
  priorityAxis: "best_for_budget" | "cheapest" | "lowest_mileage" | "newest" | "lower_risk" | undefined,
  priceMax: number | undefined,
): string | undefined {
  switch (priorityAxis) {
    case "cheapest":
      return "price.asc";
    case "lowest_mileage":
      return "miles.asc";
    case "newest":
      return "year.desc";
    // lower_risk has no natural provider-level sort field (Auto.dev has no
    // risk/history sort) — ranking happens entirely via local reordering
    // (applyLocalLowerRiskOrdering(), below), same architecture as
    // best_for_budget. Provider retrieval falls back to the same
    // price-aware default best_for_budget already uses.
    case "best_for_budget":
    case "lower_risk":
    default:
      return priceMax != null ? "price.desc" : "year.desc";
  }
}

const CANDIDATE_POOL_SIZE = 100; // Growth plan cap per docs; silently clamps to 20 on Starter

// Shared anomalous-price rule (feature/value-based-best-for-budget follow-up):
// hoisted to module scope so the "price-likely-inaccurate" card badge
// (buildResultCard, below) and the best_for_budget ranking's price
// weighting (applyLocalBestForBudgetOrdering, immediately below) both read
// the exact same threshold/definition — cannot drift into two independent
// $1,000 rules. Real evidence (Aug 14) that motivated the original badge:
// a listing priced $85 for a 2024 CR-V passed every filter cleanly and got
// VIN-verified — the price itself is the obviously bad data, not the
// identity.
const ANOMALOUS_PRICE_FLOOR = 1000;
function isAnomalousPrice(price: number | undefined | null): boolean {
  return price != null && price < ANOMALOUS_PRICE_FLOOR;
}

/**
 * EXPERIMENT (preview only, SYS-20260825 follow-up): local best_for_budget
 * candidate ordering. Provider retrieval/sort is completely untouched
 * (resolveSort() above is unchanged) — this only reorders the already-
 * eligible lean candidates client-side, after trim ordering and before
 * applyDiversity()/shortlist selection, for priorityAxis best_for_budget
 * (or unset, its default). cheapest/lowest_mileage/newest are untouched —
 * this function is never called for those axes.
 *
 * This is an internal ordering heuristic only — it does not compute or
 * expose a new score, and Match Score (lib/match-score.ts) is completely
 * unaffected; the final cards.sort() by matchScore still runs afterward
 * and, since Array.prototype.sort is stable, preserves this candidate
 * order among equal Match Scores.
 *
 * Ranking, per the pool actually passed in:
 * 1. A confirmed trimPreference match (existing trimMatches() directional
 *    matcher) ranks first, if trimPreference was stated.
 * 2. balancedScore = yearRank + mileageRank descending — pool-relative
 *    min-max ranks (best known -> 1, worst known -> 0, missing -> neutral
 *    0.5), combined equally per spec, not raw weighted units.
 * 3. Lower price as a weak tie-breaker only.
 * 4. Original provider order preserved for any remaining tie (stable sort).
 *
 * Deliberately no budget-distance scoring in this first experiment — the
 * pool is already budget-constrained by the existing hard priceMax filter
 * and (in production) already price-desc from the provider; this tests
 * only whether better age/mileage selection from that same pool helps.
 */
/**
 * EXPERIMENT (preview only, experiment/value-based-best-for-budget):
 * value-based best_for_budget local ordering — extends the original
 * year+mileage-only formula (d5805cc) to also weigh price materially, not
 * just as a final tiebreaker. Motivation: live-tested (fair-pool merge
 * experiment) that even once USED candidates get a genuinely fair chance
 * to enter the pool, the old formula still always favored near-zero-mile
 * current-model-year NEW stock over any USED alternative, however
 * price-competitive — e.g. a 2026 USED X5 at ~$71k/306mi lost every time
 * to a 2026 NEW X5 at ~$101k/1mi, purely because year+mileage never
 * considered the ~$30k price gap at all. This is a genuine "best value to
 * buy" gap, not a bug in the old formula's own narrower goal.
 *
 * balancedScore is now a straight three-way average of yearRank,
 * mileageRank, and priceRank — each independently pool-relative (best
 * known -> 1, worst known -> 0, missing -> neutral 0.5), same rank
 * construction as before, just one more axis with genuinely equal
 * weight (not a coefficient tacked onto the old two-factor score, and
 * not a mere tiebreaker after year+mileage already decided the order).
 * Trim preference precedence (checked first, before balancedScore ever
 * applies) and configuration variety (downstream, unchanged) are both
 * completely unaffected — this only changes how balancedScore itself is
 * computed. No condition (NEW/USED) signal is read anywhere in this
 * function, same as before — still fully condition-blind by construction,
 * so nothing here can force or bias toward either.
 */
/**
 * EXPERIMENT (preview only, follow-up to 59085ba): anomalous-price
 * exclusion. Cross-model validation surfaced a real failure: prices
 * already recognized as untrustworthy by production's own
 * "price-likely-inaccurate" badge rule (below $1,000 — real evidence,
 * e.g. a $85 2024 CR-V that passed every filter and got VIN-verified,
 * the price alone was the bad data) were still allowed to participate as
 * genuinely cheap in priceRank, so a data-entry error could dominate the
 * top of the shortlist purely by being implausibly cheap (observed live:
 * $595/$948 F-150s beating real $40k value picks).
 *
 * Fix, using the exact same ANOMALOUS_PRICE_FLOOR/isAnomalousPrice()
 * shared with the card badge (never a second, independent $1,000 rule):
 * - priceMin/priceMax normalization is computed from genuine prices only
 *   — an anomalous price can no longer stretch or shrink the pool's price
 *   scale for every other (genuine) candidate.
 * - An anomalous candidate's own priceRank is forced to neutral 0.5 —
 *   never scored as "cheap", but not penalized as "expensive" either,
 *   same treatment as a missing price.
 * - A new anomalyRank tier sits between trim-preference and balancedScore:
 *   genuine-price candidates are preferred over anomalous-price ones
 *   whenever both exist, but nothing is discarded — an anomalous
 *   candidate simply sorts after genuine ones (same "reorder, never
 *   drop" philosophy as applyConfigurationVarietyPass below), so it's
 *   still available for shortlist backfill if genuinely nothing else
 *   qualifies.
 *
 * year+mileage weighting for genuine prices is completely unchanged.
 */
function applyLocalBestForBudgetOrdering(
  candidates: AutoDevListing[],
  trimPreference: string | undefined,
): AutoDevListing[] {
  if (candidates.length === 0) return candidates;

  const years = candidates.map((c) => c.vehicle?.year).filter((y): y is number => y != null);
  const miles = candidates.map((c) => c.retailListing?.miles).filter((m): m is number => m != null);
  const genuinePrices = candidates
    .map((c) => c.retailListing?.price)
    .filter((p): p is number => p != null && !isAnomalousPrice(p));
  const yearMin = years.length > 0 ? Math.min(...years) : null;
  const yearMax = years.length > 0 ? Math.max(...years) : null;
  const milesMin = miles.length > 0 ? Math.min(...miles) : null;
  const milesMax = miles.length > 0 ? Math.max(...miles) : null;
  const priceMin = genuinePrices.length > 0 ? Math.min(...genuinePrices) : null;
  const priceMax = genuinePrices.length > 0 ? Math.max(...genuinePrices) : null;

  const yearRank = (y: number | undefined): number => {
    if (y == null || yearMin == null || yearMax == null || yearMax === yearMin) return 0.5;
    return (y - yearMin) / (yearMax - yearMin); // newer -> higher -> closer to 1
  };
  const mileageRank = (m: number | undefined): number => {
    if (m == null || milesMin == null || milesMax == null || milesMax === milesMin) return 0.5;
    return (milesMax - m) / (milesMax - milesMin); // lower miles -> higher -> closer to 1
  };
  const priceRank = (c: AutoDevListing): number => {
    const p = c.retailListing?.price;
    if (isAnomalousPrice(p)) return 0.5; // untrustworthy price — neutral, never "cheap"
    if (p == null || priceMin == null || priceMax == null || priceMax === priceMin) return 0.5;
    return (priceMax - p) / (priceMax - priceMin); // cheaper -> higher -> closer to 1
  };
  const balancedScore = (c: AutoDevListing): number =>
    (yearRank(c.vehicle?.year) + mileageRank(c.retailListing?.miles) + priceRank(c)) / 3;
  const trimMatchRank = (c: AutoDevListing): number =>
    trimPreference && trimMatches(trimPreference, c.vehicle?.trim) ? 0 : 1; // confirmed match sorts first
  const anomalyRank = (c: AutoDevListing): number => (isAnomalousPrice(c.retailListing?.price) ? 1 : 0); // genuine price sorts first

  return [...candidates].sort((a, b) => {
    const trimDiff = trimMatchRank(a) - trimMatchRank(b);
    if (trimDiff !== 0) return trimDiff;

    const anomalyDiff = anomalyRank(a) - anomalyRank(b);
    if (anomalyDiff !== 0) return anomalyDiff;

    const scoreDiff = balancedScore(b) - balancedScore(a); // descending
    if (scoreDiff !== 0) return scoreDiff;

    const priceA = a.retailListing?.price ?? Infinity;
    const priceB = b.retailListing?.price ?? Infinity;
    if (priceA !== priceB) return priceA - priceB; // ascending, exact-tie final tiebreaker

    return 0; // preserve original provider order — stable sort
  });
}

/**
 * lower_risk local ordering (feature/lower-risk-mvp) — ranking only, same
 * architecture as applyLocalBestForBudgetOrdering() above: provider
 * retrieval/sort is untouched (resolveSort() above), hard eligibility
 * filters (price, make/model, trimRequired, year, mileage, radius,
 * drivetrain, etc.) have already been applied by the time this runs — this
 * only reorders the already-eligible candidates. Never restricts results
 * to positive-evidence-only vehicles; it only changes the order they're
 * presented in.
 *
 * Uses classifyRiskTier() (lib/risk-tier.ts) — the exact same evidence
 * BuyerCheck itself reads (crossCheckVin/buildHistorySummary/
 * buildCpoSummary/detectDataConflicts), all four of which already operate
 * directly on a raw AutoDevListing, so this runs at the lean (pre-stage-2)
 * stage, before diversity/shortlisting, same timing as
 * applyLocalBestForBudgetOrdering(). Simple, deterministic: sort by tier
 * rank only (positive < unknown < amber < red), stable — candidates
 * within the same tier keep their existing relative order (whatever the
 * provider's own price.desc/year.desc default already produced), no
 * secondary scoring formula invented on top.
 */
function applyLocalLowerRiskOrdering(candidates: AutoDevListing[]): AutoDevListing[] {
  if (candidates.length === 0) return candidates;

  const tierOf = (c: AutoDevListing): RiskTier =>
    classifyRiskTier({
      verification: crossCheckVin(c),
      history: buildHistorySummary(c),
      condition: { cpoEvidenceState: buildCpoSummary(c).state },
      dataConflicts: detectDataConflicts(c),
    });

  return [...candidates].sort((a, b) => riskTierRank(tierOf(a)) - riskTierRank(tierOf(b)));
}

/**
 * EXPERIMENT (preview only, follow-up to d5805cc): configuration-variety
 * pass. Observed regression in the F-150 fixture: applyLocalBestForBudgetOrdering()
 * above (unchanged, still exactly as in d5805cc) can legitimately rank a
 * batch of near-identical fleet units at the very top when they share the
 * best year+mileage combination in the pool — 5 distinct VINs, same
 * 2026/F-150/STX/price/mileage. That's not a bug in the ranking itself
 * (they genuinely tied on every ranked dimension); it's a visible-shortlist
 * diversity problem this pass addresses separately.
 *
 * Ordering only — never discards a candidate. First pass keeps at most
 * maxPerConfig per (make|model|year|trim) key, in the existing ranked
 * order; anything over the cap is appended to the END, in its own existing
 * relative order, not dropped. So if inventory really is homogeneous (e.g.
 * only 3 total F-150s exist at any price), the normal shortlist/backfill
 * mechanism downstream can still pull the overflow candidates in and fill
 * every result slot exactly as before — this only changes visible-ordering
 * preference among an otherwise-tied pool, not eligibility or count.
 *
 * Missing trim is normalized to "" consistently — never invented/guessed —
 * so two candidates that both lack a reported trim still correctly group
 * together as one "unknown trim" configuration rather than each getting a
 * unique key.
 */
function configurationKey(c: AutoDevListing): string {
  const make = (c.vehicle?.make ?? "").trim().toLowerCase();
  const model = (c.vehicle?.model ?? "").trim().toLowerCase();
  const year = c.vehicle?.year ?? "";
  const trim = (c.vehicle?.trim ?? "").trim().toLowerCase(); // missing -> "" — never invented
  return `${make}|${model}|${year}|${trim}`;
}

function applyConfigurationVarietyPass(
  candidates: AutoDevListing[],
  maxPerConfig = 2,
): AutoDevListing[] {
  const seenCount = new Map<string, number>();
  const withinCap: AutoDevListing[] = [];
  const overflow: AutoDevListing[] = [];

  for (const c of candidates) {
    const key = configurationKey(c);
    const count = seenCount.get(key) ?? 0;
    if (count < maxPerConfig) {
      withinCap.push(c);
      seenCount.set(key, count + 1);
    } else {
      overflow.push(c); // never discarded — appended below, existing relative order preserved
    }
  }

  return [...withinCap, ...overflow];
}

// Same deployed origin the widget declares in its CSP resourceDomains
// (lib/results-card.ts APP_ORIGIN) — kept in sync manually since the two
// files are independent per the MCP Apps static-resource split.
const IMG_PROXY_ORIGIN = "https://carclever-find-my-car.vercel.app";

function signedImageProxyUrl(rawImageUrl: string | null): string | null {
  if (!rawImageUrl) return null;
  // Signing must never fail the whole tool call — if IMAGE_PROXY_SECRET is
  // unexpectedly missing or signing throws for any reason, fall back to no
  // image rather than a 500; the widget already renders the existing
  // "Photo unavailable" placeholder for a null cardImageUrl. The proxy
  // route itself still fails closed (403) for any unsigned/invalid request.
  try {
    const sig = signImageUrl(rawImageUrl);
    return IMG_PROXY_ORIGIN + "/api/img-proxy?u=" + encodeURIComponent(rawImageUrl) + "&sig=" + sig;
  } catch {
    return null;
  }
}

async function buildResultCard(
  listing: AutoDevListing,
  intent: ReturnType<typeof parseIntent>,
  intentInput: CardIntentInput,
  nhtsa?: NhtsaElectrificationResult | null,
  evidenceRequest?: ConstraintEvidenceRequest,
  relaxedFields?: ReadonlySet<string>,
) {
  const verification = crossCheckVin(listing); // now local/synchronous — no API call
  const { matchScore, matchScoreLabel, breakdown } = computeMatchScore(listing, intent, verification);
  const links = resolveLinks(listing);

  // Suppress entirely if no usable outbound link — a result with zero
  // actionable CTAs isn't useful regardless of Match Score (SYS-20260812-023/024).
  if (links.linkStatus === "none-available") return null;

  const v = listing.vehicle;
  const rl = listing.retailListing;

  const normalizedFuel = applyKnownHybridOverride(v?.year, v?.make, v?.model, v?.fuel);
  // NHTSA (SYS-20260819-002): Auto.dev's fuel field has no electrification
  // signal at all, so the model-name allowlist above is a best-effort
  // partial mitigation, not a complete fix. When NHTSA's authoritative
  // decode says electrified and Auto.dev/the allowlist both missed it,
  // trust NHTSA — it's manufacturer-submitted data, not another guess.
  const finalNormalizedFuel =
    normalizedFuel === "gasoline" && nhtsaIndicatesElectrified(nhtsa)
      ? (nhtsa!.electrificationLevel!.toLowerCase().includes("phev") ? "plug_in_hybrid" : "hybrid")
      : normalizedFuel;
  const historySummary = buildHistorySummary(listing);
  const cpoSummary = buildCpoSummary(listing);
  const seatsSummary = buildSeatsSummary(listing, intent.semantic.seatsMin);
  // Computed once here (feature/lower-risk-mvp), reused both for cardShape's
  // own dataConflicts field below and for riskTier — avoids calling
  // detectDataConflicts() twice per card.
  const dataConflicts = detectDataConflicts(listing);
  // Risk tier (feature/lower-risk-mvp) — computed for EVERY card, not just
  // direct-VIN-lookup ones, reusing the exact same evidence BuyerCheck
  // itself reads. Attached to cardShape below (c.risk.tier) so the
  // ordinary-search-card RISK badge (amber/red only, never green, never
  // for unknown/positive — see lib/results-card.ts) can use it without
  // any new data source. This is display-only here; lower_risk's actual
  // ranking (applyLocalLowerRiskOrdering(), above) runs earlier, at the
  // lean stage, using the same classifyRiskTier() function.
  const riskTier = classifyRiskTier({
    verification,
    history: historySummary,
    condition: { cpoEvidenceState: cpoSummary.state },
    dataConflicts,
  });

  // Photos must never block the search-results critical path (real evidence:
  // 868ms median Photos latency, SYS-20260812-014/021). Leave the gallery
  // empty here — it's populated only via the separate, lazy
  // get_vehicle_photos tool call.
  const photos: string[] = [];

  const badges: string[] = [];
  if (verification.identityVerificationStatus === "verified_match") badges.push("vin-verified");
  if (verification.identityVerificationStatus === "failed") badges.push("vin-conflicting");
  if (nhtsa?.makeConflict) badges.push("nhtsa-make-conflict");
  if (nhtsa?.modelConflict) badges.push("nhtsa-model-conflict");
  if (nhtsa?.cylindersConflict) badges.push("nhtsa-cylinders-conflict");
  if (nhtsa && nhtsaIndicatesElectrified(nhtsa) && normalizedFuel === "gasoline") badges.push("nhtsa-electrification-confirmed");
  if (intent.semantic.goals.length > 0) badges.push("inferred-match");
  if (historySummary.state === "known_issues") badges.push("history-issues-reported");
  if (cpoSummary.state === "confirmed_cpo") badges.push("cpo-confirmed");
  // Real evidence (Aug 14): a listing priced $85 for a 2024 CR-V passed every
  // filter cleanly and got VIN-verified — the price itself is the obviously
  // bad data, not the identity. Flag rather than silently present as trustworthy.
  // ANOMALOUS_PRICE_FLOOR/isAnomalousPrice() are shared module-level (see
  // above applyLocalBestForBudgetOrdering) so this badge and the
  // best_for_budget ranking's price weighting can never drift apart.
  if (isAnomalousPrice(listing.retailListing?.price)) {
    badges.push("price-likely-inaccurate");
  }

  const cardShape = {
    canonicalVehicleId: listing.vin,
    // Ordinary-search-card risk badge input (feature/lower-risk-mvp):
    // amber/red only ever get displayed on an ordinary card (see
    // cardHtml() in lib/results-card.ts) — "positive"/"unknown" are
    // carried here for lower_risk ranking's internal use and completeness
    // of the structured data, never surfaced as a card badge either way.
    risk: { tier: riskTier },
    identity: {
      vin: listing.vin,
      year: v?.year ?? null,
      make: v?.make ?? null,
      model: v?.model ?? null,
      trim: v?.trim ?? null,
      series: v?.series ?? null,
      squishVin: v?.squishVin ?? null,
      bodyStyleConfig: v?.style ?? null, // confirmed real (e.g. "4dr SUV") - short structural descriptor, not narrative text
    },
    condition: {
      inventoryType: (rl?.used === false ? "new" : rl?.used === true ? "used" : "unknown") as "new" | "used" | "unknown",
      used: rl?.used ?? null,
      cpo: rl?.cpo ?? null,
      cpoEvidenceState: cpoSummary.state,
    },
    powertrain: {
      type: finalNormalizedFuel,
      engine: v?.engine ?? null,
      drivetrain: v?.drivetrain ?? null,
      transmission: v?.transmission ?? null,
    },
    body: {
      bodyStyle: v?.bodyStyle ?? null,
      vehicleType: v?.type ?? null,
      doors: v?.doors ?? null,
    },
    listing: {
      price: rl?.price ?? null,
      mileage: rl?.miles ?? null,
      dealer: rl?.dealer ? sanitizeDealerName(rl.dealer) : null,
      dealerId: rl?.dealerId ?? null,
      city: rl?.city ?? null,
      state: rl?.state ?? null,
      zip: rl?.zip ?? null,
      rawVdp: rl?.vdp ?? null,
      resolvedDestination: links.dealerListingUrl,
      destinationClass: links.dealerListingUrl ? "dealer_or_aggregator" : null,
    },
    history: historySummary,
    media: {
      primaryImage: rl?.primaryImage ?? null,
      cardImageUrl: signedImageProxyUrl(rl?.primaryImage ?? null),
      photoUrls: photos,
    },
    verification,
    // matchScoreLabel cast: lib/match-score.ts's MatchScoreResult interface
    // declares matchScoreLabel as plain `string`, but the actual runtime
    // computation there is always exactly one of these three literals
    // (`matchScore >= 85 ? "Strong match" : matchScore >= 65 ? "Good match"
    // : "Partial match"`). This cast is a compile-time-only annotation
    // matching that deterministic reality — it changes no runtime value,
    // and lib/match-score.ts itself (the ranking formula/logic) is untouched.
    ranking: { matchScore, matchScoreLabel: matchScoreLabel as "Strong match" | "Good match" | "Partial match", breakdown },
    links: {
      affiliateUrl: links.affiliateUrl,
      affiliateFallbackUrl: links.affiliateFallbackUrl,
      dealerListingUrl: links.dealerListingUrl,
      isCarvana: links.isCarvana,
      linkStatus: links.linkStatus,
    },
    detail: {
      carfaxUrl: CAPABILITIES.carfaxPassthrough ? rl?.carfaxUrl ?? null : null,
      cpoNote: cpoSummary.note,
      ownerHistoryNote: historySummary.ownerNote,
      interiorColor: v?.interiorColor ?? null,
      exteriorColor: v?.exteriorColor ?? null,
      cylinders: v?.cylinders ?? null,
      seats: v?.seats ?? null,
      seatsNote: seatsSummary.note,
      dataConfidence: v?.confidence ?? null, // real field, 0.0-1.0 per docs, unresearched use case - surfaced for observation
      historyUsageType: listing.history?.usageType ?? null,
      historyPersonalUse: listing.history?.personalUse ?? null,
      titleStatus: rl?.titleStatus ?? null,
      fuelTypeDisplay: formatFuelTypeForDisplay(finalNormalizedFuel, v?.fuel),
    },
    badges,
  };

  // Constraint evidence (SYS-20260825): built from the exact same resolved
  // listing (v/rl) the card above is built from — purely observational,
  // computed after cardShape and never fed back into it or into any
  // decision this function already made above (links suppression, badges,
  // Match Score, etc. are all already finalized by this point).
  const constraintChecks = buildConstraintChecks(
    evidenceRequest ?? {},
    {
      make: v?.make ?? null,
      model: v?.model ?? null,
      price: rl?.price ?? null,
      year: v?.year ?? null,
      mileage: rl?.miles ?? null,
      bodyStyle: v?.bodyStyle ?? null,
      vehicleType: v?.type ?? null,
      drivetrain: v?.drivetrain ?? null,
      transmission: v?.transmission ?? null,
      exteriorColor: v?.exteriorColor ?? null,
      interiorColor: v?.interiorColor ?? null,
      doors: v?.doors ?? null,
      cylinders: v?.cylinders ?? null,
      used: rl?.used ?? null,
      state: rl?.state ?? null,
      trim: v?.trim ?? null,
    },
    relaxedFields ?? new Set(),
  );
  const searchConstraintStatus = aggregateSearchConstraintStatus(constraintChecks);

  return {
    ...cardShape,
    // Qualifier accounting (SYS-20260815 follow-up): dynamic, per-result
    // confirmation of only the fields the user actually asked about — keeps
    // the card lean while closing the "text summary only ever warns, never
    // confirms" gap found in the Aug 15 baseline.
    intentConfirmations: buildIntentConfirmations(intentInput, cardShape),
    dataConflicts,
    // Constraint evidence (SYS-20260825): additive, observational only —
    // built from the same already-resolved listing the rest of this card
    // uses, never participates in eligibility/ranking/ordering decisions.
    // See lib/constraint-evidence.ts for the full contract.
    constraintChecks,
    searchConstraintStatus,
  };
}

export interface BuyerCheck {
  outcome: "promising" | "verify_before_proceeding" | "caution" | "significant_concern";
  goodSigns: string[];
  concerns: string[];
  needsVerification: string[];
  nextSteps: string[];
}

/**
 * VIN Buyer Check (preview MVP, feature/vin-buyer-check) — attached ONLY to
 * the direct-VIN-lookup result, never to normal search results. Pure
 * function over evidence buildResultCard() already produced for this same
 * card — no new Auto.dev call, no new data source, no new MCP tool.
 *
 * Hard rules this function follows:
 * - unknown is never treated as a concern — every "we don't know" signal
 *   (unreported history, unconfirmed identity attributes, unknown CPO
 *   status, no Carfax link) goes into needsVerification, never concerns.
 * - Never invents an accident/title/CPO/history fact — every string here is
 *   either a verbatim existing field (history.note, dataConflicts entries)
 *   or a generic, evidence-agnostic verification suggestion.
 * - No numeric risk/deal/value score of any kind.
 * - titleStatus is deliberately NOT used — that source field is still
 *   unverified in the current client contract (lib/auto-dev-client.ts
 *   marks retailListing.titleStatus "unconfirmed").
 *
 * Outcome precedence (first match wins):
 * 1. identityVerificationStatus === "failed" -> significant_concern.
 * 2. A known accident/history issue (history.state === "known_issues") or
 *    a material data conflict (dataConflicts.length > 0) -> caution.
 * 3. No concerns at all AND strong positive evidence (identity confirmed,
 *    history reported clean, no data conflicts) -> promising.
 * 4. Otherwise -> verify_before_proceeding (the common, honest default —
 *    e.g. identity only "potential_match," or clean-but-unreported
 *    history: real evidence exists but isn't strong enough either way).
 */
function buildBuyerCheck(card: {
  verification: VerificationResult;
  history: { state: "known_clean" | "known_issues" | "unreported"; note: string; ownerNote: string | null };
  condition: { cpoEvidenceState: "confirmed_cpo" | "reported_not_cpo" | "unknown" };
  detail: { carfaxUrl: string | null };
  dataConflicts: string[];
}): BuyerCheck {
  const goodSigns: string[] = [];
  const concerns: string[] = [];
  const needsVerification: string[] = [];
  const nextSteps: string[] = [];

  // Identity verification (lib/vin-cross-check.ts — derived offline from
  // VIN anatomy: model year, manufacturer, transcription validity).
  if (card.verification.identityVerificationStatus === "verified_match") {
    goodSigns.push("VIN identity confirmed — the reported year and make match what's encoded in the VIN itself.");
  } else if (card.verification.identityVerificationStatus === "failed") {
    const conflicting = card.verification.conflictingAttributes.join(", ") || "one or more reported attributes";
    concerns.push(
      `VIN identity check failed — ${conflicting} reported by this listing does not match what's encoded in the VIN itself.`,
    );
  } else {
    needsVerification.push(
      "VIN identity could not be fully confirmed from the VIN alone — verify the year and make against the actual vehicle before proceeding.",
    );
  }
  if (card.verification.unknownAttributes.length > 0) {
    needsVerification.push(
      `${card.verification.unknownAttributes.join(" and ")} cannot be confirmed from the VIN alone (VIN anatomy doesn't encode this) — confirm independently, e.g. via a dealer VIN decode or the vehicle's window sticker.`,
    );
  }

  // History (lib/qualifier-accounting.ts-adjacent buildHistorySummary()) —
  // verbatim existing note, never re-worded or embellished.
  if (card.history.state === "known_clean") {
    goodSigns.push(card.history.note);
  } else if (card.history.state === "known_issues") {
    concerns.push(card.history.note);
  } else {
    needsVerification.push(card.history.note);
  }

  // CPO status.
  if (card.condition.cpoEvidenceState === "confirmed_cpo") {
    goodSigns.push("Certified Pre-Owned (CPO) — reported by the dealer.");
  } else if (card.condition.cpoEvidenceState === "unknown") {
    needsVerification.push("CPO status was not reported for this listing — ask the dealer if certification matters to you.");
  }
  // "reported_not_cpo" is neutral (not flagged either way) — this listing
  // simply wasn't marked CPO, which isn't itself a concern.

  // Data conflicts already curated by detectDataConflicts() (e.g. NHTSA
  // make/model/cylinder mismatches) — reused verbatim, not re-derived.
  if (card.dataConflicts.length > 0) {
    concerns.push(...card.dataConflicts);
  }

  // Carfax availability.
  if (card.detail.carfaxUrl) {
    needsVerification.push("Review the linked Carfax report for full accident/title history before purchase.");
  } else {
    needsVerification.push("No Carfax link was available on this listing — request an independent vehicle history report before purchase.");
  }

  // Generic, evidence-agnostic next steps — never specific to a fact we
  // don't actually have.
  if (concerns.length > 0) {
    nextSteps.push("Ask the dealer directly about the flagged item(s) above and get documentation before proceeding.");
  }
  if (needsVerification.length > 0) {
    nextSteps.push("Independently verify the items listed above — via Carfax, a trusted mechanic, or the dealer — before finalizing a purchase.");
  }
  nextSteps.push("Have a pre-purchase inspection done by an independent mechanic if you haven't already.");

  let outcome: BuyerCheck["outcome"];
  if (card.verification.identityVerificationStatus === "failed") {
    outcome = "significant_concern";
  } else if (card.history.state === "known_issues" || card.dataConflicts.length > 0) {
    outcome = "caution";
  } else if (
    card.verification.identityVerificationStatus === "verified_match" &&
    card.history.state === "known_clean" &&
    card.dataConflicts.length === 0
  ) {
    outcome = "promising";
  } else {
    outcome = "verify_before_proceeding";
  }

  return { outcome, goodSigns, concerns, needsVerification, nextSteps };
}

const handler = createMcpHandler((server) => {
  // MCP Apps (SEP-1865) result-card widget — a STATIC resource, registered
  // once. Real per-search data is delivered to it client-side via
  // ui/notifications/tool-result (see lib/results-card.ts); this server-side
  // registration never re-renders per request. Hosts that don't support MCP
  // Apps ignore this entirely and fall back to the tool's normal
  // content/structuredContent response below, unchanged.
  server.registerResource(
    "find-my-car-results-card",
    RESULTS_CARD_RESOURCE_URI,
    {
      title: "CarClever - Find My Car results",
      description: "Compact vehicle result carousel: photo, price, mileage, match score, one Edmunds click-through CTA per card.",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          // Photo domains vary per dealer/Auto.dev listing and can't be
          // enumerated — photos are proxied through our own first-party
          // origin instead (see app/api/img-proxy/route.ts), so only this
          // one domain needs declaring here.
          //
          // domain: intentionally omitted for cross-host MCP Apps
          // compatibility — hosts may use their own default sandbox
          // origin when it's absent (per SEP-1865, the field is
          // optional). Confirmed live (SYS-20260825): a plain-origin
          // value here caused Claude to fetch this resource successfully
          // but fail to mount/render it; Claude iOS rendered correctly
          // once the field was removed, ChatGPT unaffected either way.
          // Do NOT restore a plain Vercel-origin value without
          // re-validating against a live Claude test first.
          csp: { resourceDomains: ["https://carclever-find-my-car.vercel.app"] },
          prefersBorder: false,
        },
      },
    },
    async (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: buildResultsCardHtml(),
          // Per SEP-1865, CSP/prefersBorder must be present on the
          // resources/read response's content item itself, not only on the
          // static registration config above — confirmed via a live check
          // against the deployed endpoint (the registration-level _meta
          // alone did not surface here).
          //
          // domain: intentionally omitted here too, same reasoning as the
          // registration-level _meta.ui above. openai/outputTemplate (on
          // the tool registration, unrelated to this block) is untouched.
          //
          // EXPERIMENT (experiment/openai-widget-domain-metadata-only,
          // André's direction, metadata-only test, preview only): added
          // openai/widgetDomain as a namespaced compatibility field,
          // separate from _meta.ui.domain (which stays absent — see
          // above, do not restore it without re-validating against a
          // live Claude test first, per SYS-20260825). Registration-level
          // _meta is intentionally NOT touched in this experiment.
          _meta: {
            ui: {
              csp: { resourceDomains: ["https://carclever-find-my-car.vercel.app"] },
              prefersBorder: false,
            },
            "openai/widgetDomain": "https://carclever-find-my-car.vercel.app",
          },
        },
      ],
    }),
  );

  server.registerTool(
    "find_matching_vehicle",
    {
      description: FIND_MATCHING_VEHICLE_DESCRIPTION(),
      inputSchema: FindMatchingVehicleInput.shape,
      outputSchema: FindMatchingVehicleOutputSchema,
      // Canonical output contract. All live structuredContent construction paths
      // are compile-time validated against this schema via `satisfies`.
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      // Per SEP-1865: hosts that don't support MCP Apps ignore this field
      // and the tool behaves exactly as before (text/structuredContent
      // only) — this is additive, not a replacement path. Also set the
      // ChatGPT-specific compatibility alias per OpenAI's own docs
      // ("ChatGPT also honors _meta['openai/outputTemplate'] as a
      // compatibility alias") for extra robustness on that host.
      _meta: {
        ui: { resourceUri: RESULTS_CARD_RESOURCE_URI },
        "openai/outputTemplate": RESULTS_CARD_RESOURCE_URI,
      },
    },
    async (input) => {
      // Anchored before any upstream work so the widening budget accounts for
      // everything already spent (primary search, facet correction, retries).
      const requestStartedAt = Date.now();
      const intent = parseIntent(input);

      // Direct VIN lookup (SYS-20260824): when the user supplies an exact
      // VIN, this looks up that one vehicle directly and returns early —
      // the normal search/widening/diversity/backfill pipeline below never
      // runs for this path. Reuses the existing getListingByVin() call and
      // the same buildResultCard() enrichment (verification, NHTSA, image
      // signing, link resolution) as a normal search result, so the card
      // is built exactly the same way a search result's card would be.
      // Any other stated constraint (price, trim, etc.) is checked against
      // THIS vehicle and disclosed honestly — never used to exclude it or
      // substitute a different vehicle.
      if (input.vin) {
        const rawVin = input.vin.trim().toUpperCase();
        // Basic 17-character VIN format check — real VINs never contain I,
        // O, or Q (reserved, to avoid confusion with 1/0). Not a full
        // check-digit/WMI decode, just a cheap, real format validation.
        const vinFormatValid = /^[A-HJ-NPR-Z0-9]{17}$/.test(rawVin);

        if (!vinFormatValid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${input.vin}" doesn't look like a valid 17-character VIN (VINs never contain the letters I, O, or Q) — double-check it and try again.`,
              },
            ],
            structuredContent: {
              meta: {
                totalCandidatesConsidered: 0,
                totalMatches: 0,
                corpusSizeApprox: getCorpusCountForDescription(),
                relaxations: [],
                dataNotes: [],
                scopeNote: "vin_lookup",
                serviceError: null,
                interpretationNotes: [`"${input.vin}" is not a valid 17-character VIN format.`],
                qualifierAccounting: [],
              },
              results: [],
            } satisfies FindMatchingVehicleOutput,
          };
        }

        const [fullListing, exactSearchRow] = await Promise.all([
          getListingByVin(rawVin),
          searchListingByVinExact(rawVin),
        ]);

        if (!fullListing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No listing found for VIN ${rawVin} in current live inventory — this exact vehicle isn't currently available (or was already sold/delisted). Not substituting a similar vehicle since a specific VIN was requested.`,
              },
            ],
            structuredContent: {
              meta: {
                totalCandidatesConsidered: 0,
                totalMatches: 0,
                corpusSizeApprox: getCorpusCountForDescription(),
                relaxations: [],
                dataNotes: [],
                scopeNote: "vin_lookup",
                serviceError: null,
                interpretationNotes: [`Exact VIN lookup for ${rawVin} found no matching live listing.`],
                qualifierAccounting: [],
              },
              results: [],
            } satisfies FindMatchingVehicleOutput,
          };
        }

        // Price reconciliation (SYS-20260824, confirmed live for VIN
        // W1N4N5BB1TJ864755): getListingByVin() — the path-form
        // /listings/{vin} full-detail endpoint — can return a stale price
        // ($61,515) where the LISTINGS SEARCH endpoint's exact vehicle.vin=
        // filter returns the canonical, live-matching price ($59,935, same
        // as Edmunds and normal search's own lean price). Only price is
        // ever merged from the search-endpoint row — every other field
        // (photo, dealer, location, drivetrain, Carfax, used/new, history,
        // mileage, year, make, model, trim, etc.) stays exactly as returned
        // by full-detail. The exact search row's own VIN is verified before
        // its price is trusted at all — Auto.dev's docs don't guarantee
        // this filter can never near-match, so this code doesn't assume it.
        const searchPrice =
          exactSearchRow && exactSearchRow.vin === rawVin ? exactSearchRow.retailListing?.price ?? null : null;
        const fullPrice = fullListing.retailListing?.price ?? null;
        if (searchPrice != null && fullPrice != null && searchPrice !== fullPrice) {
          console.log(
            `[find_matching_vehicle] vin_price_disagreement vin=${rawVin} searchPrice=${searchPrice} fullPrice=${fullPrice} chosenPrice=${searchPrice}`,
          );
        }
        const resolvedListing: AutoDevListing =
          searchPrice != null && fullListing.retailListing
            ? { ...fullListing, retailListing: { ...fullListing.retailListing, price: searchPrice } }
            : fullListing;

        const nhtsaResult = await decodeNhtsaElectrification(
          resolvedListing.vin,
          resolvedListing.vehicle?.make,
          resolvedListing.vehicle?.model,
          resolvedListing.vehicle?.cylinders,
        );

        const vinIntentInput: CardIntentInput = {
          exteriorColor: input.exteriorColor,
          interiorColor: input.interiorColor,
          drivetrain: input.drivetrain,
          transmission: input.transmission,
          cylinders: input.cylinders,
          doors: input.doors,
          vehicleType: input.vehicleType,
          used: input.used,
          cpo: input.cpo,
          noAccidents: input.noAccidents,
          oneOwner: input.oneOwner,
          seatsMinPreference: intent.semantic.seatsMin,
          droppedBodyStyleFilter: null,
          trimRequired: intent.trimRequired,
        };

        const vinCard = await buildResultCard(
          resolvedListing,
          intent,
          vinIntentInput,
          nhtsaResult,
          {
            make: input.make,
            model: input.model,
            priceMin: input.priceMin,
            priceMax: input.priceMax,
            yearMin: input.yearMin,
            yearMax: input.yearMax,
            mileageMax: input.mileageMax,
            bodyType: input.bodyType,
            drivetrain: input.drivetrain,
            transmission: input.transmission,
            exteriorColor: input.exteriorColor,
            interiorColor: input.interiorColor,
            vehicleType: input.vehicleType,
            doors: input.doors,
            cylinders: input.cylinders,
            used: input.used,
            state: input.state,
            trimRequired: intent.trimRequired,
          },
          // A direct VIN lookup never widens/relaxes anything — this is
          // always the exact requested VIN, so no field is ever "relaxed"
          // here.
          new Set(),
        );
        const vinCards = vinCard ? [vinCard] : [];

        // VIN Buyer Check (feature/vin-buyer-check, preview MVP): attached
        // ONLY here, on the direct-VIN-lookup result — never on normal
        // search results. Pure function over the same evidence
        // buildResultCard() already produced for vinCard above; no new
        // Auto.dev call, no new data source.
        const buyerCheck = vinCard ? buildBuyerCheck(vinCard) : null;
        const vinCardsWithBuyerCheck = vinCard && buyerCheck ? [{ ...vinCard, buyerCheck }] : vinCards;

        // Other stated hard constraints (price/year/mileage) are checked
        // against THIS vehicle and disclosed — never used to exclude it or
        // substitute a different one. make/model deliberately omitted: a
        // VIN already identifies an exact vehicle regardless of what
        // make/model the user also stated.
        const vinConstraintViolations = verifyAgainstConstraints(resolvedListing, {
          priceMax: intent.hardConstraints.priceMax,
          priceMin: intent.hardConstraints.priceMin,
          yearMin: intent.hardConstraints.yearMin,
          yearMax: intent.hardConstraints.yearMax,
          mileageMax: intent.hardConstraints.mileageMax,
        });
        const vinDataNotes: string[] =
          vinConstraintViolations.length > 0
            ? [
                `This exact vehicle doesn't fully meet the other stated criteria (${vinConstraintViolations.join(
                  ", ",
                )}) — shown anyway since a specific VIN identifies exactly one vehicle, never substituted for a different one.`,
              ]
            : [];

        const BUYER_CHECK_OUTCOME_LABEL: Record<BuyerCheck["outcome"], string> = {
          promising: "Promising",
          verify_before_proceeding: "Verify before proceeding",
          caution: "Caution",
          significant_concern: "Significant concern",
        };

        const vinSummary =
          vinCards.length === 0
            ? `VIN ${rawVin} was found in inventory but couldn't be built into a displayable result (no usable dealer or affiliate link available for it).`
            : (() => {
                const c = vinCards[0];
                const id = c.identity;
                const l = c.listing;
                const r = c.ranking;
                const trimStr = id.trim ? ` ${id.trim}` : "";
                const priceStr = l.price != null ? `$${l.price.toLocaleString()}` : "price unavailable";
                const mileageStr = l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "mileage unknown";
                const dealerStr = l.dealer ? ` — ${l.dealer}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}` : "";
                // Never route the user to dealerListingUrl (including
                // Carvana) — affiliateUrl (VIN-specific Edmunds) first, then
                // affiliateFallbackUrl (Edmunds category search) labeled as
                // a fallback, never as "this vehicle". dealerListingUrl
                // stays available internally on structuredContent (see
                // links.dealerListingUrl below), never surfaced here.
                const primaryLinkStr = c.links.affiliateUrl
                  ?? (c.links.affiliateFallbackUrl ? `Similar options on Edmunds: ${c.links.affiliateFallbackUrl}` : null)
                  ?? "no link available";
                const violationNote =
                  vinConstraintViolations.length > 0
                    ? `\n   ⚠️ Doesn't fully meet: ${vinConstraintViolations.join(", ")} — this is the exact VIN requested, not a different vehicle.`
                    : "";
                const buyerCheckText = buyerCheck
                  ? `\n\nBuyer Check: ${BUYER_CHECK_OUTCOME_LABEL[buyerCheck.outcome]}` +
                    (buyerCheck.goodSigns.length > 0 ? `\n  Good signs: ${buyerCheck.goodSigns.join(" ")}` : "") +
                    (buyerCheck.concerns.length > 0 ? `\n  Concerns: ${buyerCheck.concerns.join(" ")}` : "") +
                    (buyerCheck.needsVerification.length > 0
                      ? `\n  Needs verification: ${buyerCheck.needsVerification.join(" ")}`
                      : "") +
                    (buyerCheck.nextSteps.length > 0 ? `\n  Next steps: ${buyerCheck.nextSteps.join(" ")}` : "")
                  : "";
                return `Found the exact vehicle for VIN ${rawVin}:\n\n${id.year} ${id.make} ${id.model}${trimStr} — ${priceStr}, ${mileageStr}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}${violationNote}\n   Link: ${primaryLinkStr}${buyerCheckText}`;
              })();

        return {
          content: [{ type: "text" as const, text: vinSummary }],
          structuredContent: {
            meta: {
              totalCandidatesConsidered: 1,
              totalMatches: vinCards.length,
              corpusSizeApprox: getCorpusCountForDescription(),
              relaxations: [],
              dataNotes: vinDataNotes,
              scopeNote: "vin_lookup",
              serviceError: null,
              interpretationNotes: [`Direct VIN lookup for ${rawVin} — identifies exactly one vehicle; no broader search was run.`],
              qualifierAccounting: buildQualifierAccounting(vinIntentInput),
            },
            results: vinCardsWithBuyerCheck,
          } satisfies FindMatchingVehicleOutput,
        };
      }

      // trimRequired (SYS-20260823): a hard eligibility requirement,
      // enforced locally — deliberately never sent to Auto.dev as a query
      // filter (vehicle.trim isn't trusted there as a hard filter param,
      // same as everywhere else in this file). Stage-1 lean data may have
      // trim; when it doesn't, a candidate stays provisional rather than
      // being excluded outright, since stage-2 full-detail can resolve it.
      // At stage 2, a still-missing or non-matching trim must NOT satisfy
      // the requirement — see trimRequiredFullFilter below.
      const trimRequired = intent.trimRequired;
      const trimRequiredLeanFilter = (c: AutoDevListing): boolean => {
        if (!trimRequired) return true;
        const reported = c.vehicle?.trim;
        if (reported == null || reported === "") return true; // provisional — stage 2 may resolve it
        return trimMatches(trimRequired, reported);
      };
      const trimIsConfirmedMatch = (c: AutoDevListing): boolean =>
        !!trimRequired && trimMatches(trimRequired, c.vehicle?.trim);
      const trimRequiredFullFilter = (c: AutoDevListing): boolean => {
        if (!trimRequired) return true;
        // Full detail is the last word — a still-missing or non-matching
        // trim can no longer stay provisional here.
        return trimMatches(trimRequired, c.vehicle?.trim);
      };

      // "Lowest mileage" almost always means "lowest mileage used car" in
      // real buy-intent — a new car being low-mileage isn't a finding worth
      // surfacing as the best match, and Auto.dev has no separate "demo"
      // category (confirmed: retailListing.used is a strict true=used/
      // false=new boolean, nothing else) — a demo vehicle without a prior
      // retail owner would carry used:false, same bucket as genuinely new.
      // So defaulting to used:true when the user hasn't stated a new/used
      // preference correctly excludes both, using the one real signal
      // available. Never silent — always disclosed via dataNotes below,
      // same discipline as every other default/relaxation in this tool.
      // Respects an explicit input.used if the user actually asked for new.
      const lowestMileageDefaultedToUsed = input.priorityAxis === "lowest_mileage" && input.used == null;
      const effectiveUsed = lowestMileageDefaultedToUsed ? true : input.used;

      // Lean ZIP validation (2026-08-15) — Auto.dev silently ignores an
      // invalid ZIP and returns unfiltered, effectively nationwide results
      // with no error and no signal anything went wrong (confirmed live:
      // zip=00000 returned real Camrys from GA/WA/TX). A real host model
      // usually catches this upstream before it reaches us, but that's not
      // something this tool controls or can rely on — same "don't trust the
      // caller's input, verify and disclose" principle as everything else
      // here. Real fix required TWO checks, not one — a bare 5-digit format
      // check alone is insufficient: "00000" IS 5 digits, so it passed a
      // naive regex and reproduced the exact same bug (confirmed live via
      // the first version of this fix). No US ZIP has all-identical digits
      // (00000/11111/.../99999 are unassigned), so that's added as a cheap,
      // real second check — not a full ZIP database, deliberately lean.
      const rawZip = intent.hardConstraints.location?.zip;
      const zipFormatValid = rawZip == null || /^\d{5}$/.test(rawZip);
      const zipNotAllSameDigit = rawZip == null || !/^(\d)\1{4}$/.test(rawZip);
      const zipIsValid = zipFormatValid && zipNotAllSameDigit;

      const baseQuery: ListingsQuery = {
        make: intent.hardConstraints.make,
        model: intent.hardConstraints.model,
        bodyType: intent.hardConstraints.bodyType,
        priceMin: intent.hardConstraints.priceMin,
        priceMax: intent.hardConstraints.priceMax,
        yearMin: intent.hardConstraints.yearMin,
        yearMax: intent.hardConstraints.yearMax,
        mileageMax: intent.hardConstraints.mileageMax,
        zip: zipIsValid ? rawZip : undefined,
        radius: zipIsValid ? intent.hardConstraints.location?.radiusMiles : undefined,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        vehicleType: input.vehicleType,
        doors: input.doors,
        cylinders: input.cylinders,
        used: effectiveUsed,
        // cpo NOT sent as a filter — CPO-001 forbids treating cpo=false as
        // definitive. input.cpo still collected, used for disclosure below.
        state: input.state,
        // accidentCount/ownerCount NOT sent as query filters — history is null
        // in 53% of real listings, so hard-filtering would violate "unknown != false".
        sort: resolveSort(input.priorityAxis, intent.hardConstraints.priceMax),
        limit: CANDIDATE_POOL_SIZE,
      };

      // Two-stage search (SYS-20260812-060): lean ?select= primary search for
      // the full candidate pool (smaller payload, faster), then full-detail
      // refetch via parallel /listings/{vin} calls for just the shortlist.
      //
      // EXPERIMENT (preview only, experiment/value-based-best-for-budget):
      // for a condition-neutral search (baseQuery.used == null — the user
      // never asked for NEW or USED specifically), a single query relies
      // entirely on the provider sort to decide which ~100 rows come back.
      // Live-tested: for a BMW X5 near 10001 with priorityAxis
      // best_for_budget (no priceMax -> year.desc sort), that single
      // top-100 window was 100% NEW, 0% USED. Explicit NEW/USED searches
      // are untouched below — this only changes the condition-neutral case.
      //
      // Fix: run the two conditions as separate lean searches in parallel
      // (each still capped at CANDIDATE_POOL_SIZE, same sort/filters/limit
      // as before — nothing else about either query changes, and no
      // additional API calls beyond these two), then dedupe-merge into one
      // combined pool before handing off to the downstream pipeline
      // (eligibility, trim handling, the new value-based
      // applyLocalBestForBudgetOrdering below, applyConfigurationVarietyPass,
      // applyDiversity, Match Score, cards, links, Buyer Check — all
      // otherwise unchanged). No NEW/USED quota is forced anywhere.
      //
      // SYS-20260825 fix: the merge above is a straight concatenation
      // (NEW rows first, then USED), never globally re-sorted by price.
      // That's fine for best_for_budget (applyLocalBestForBudgetOrdering
      // re-ranks the merged pool by value below), but for cheapest/
      // lowest_mileage/newest — which bypass that re-ranking and rely
      // entirely on provider sort order surviving into the shortlist —
      // the merge silently destroyed the global ordering. Confirmed live:
      // "cheapest BMW X5 near 10001, new or used fine" returned a $71,500
      // NEW X5 as cheapest while a $70,489 USED X5 was in the same live
      // pool. Fix: only fair-pool for best_for_budget/unset, the one axis
      // that actually re-ranks the merged result afterward. cheapest/
      // lowest_mileage/newest keep the original single-query path, so
      // Auto.dev's own global sort (price.asc/miles.asc/year.desc) is
      // preserved intact across NEW+USED exactly as it was before fair
      // pooling was introduced. Ranking formula, anomaly handling,
      // diversity, Match Score, hard filters, and UI are untouched.
      const useFairPool =
        baseQuery.used == null &&
        (input.priorityAxis === "best_for_budget" || input.priorityAxis == null);
      let rawResult: { data: AutoDevListing[]; total: number | null; error?: string; degraded?: string };
      if (useFairPool) {
        const [newResult, usedResult] = await Promise.all([
          searchListingsLean({ ...baseQuery, used: false }),
          searchListingsLean({ ...baseQuery, used: true }),
        ]);
        const seenVins = new Set<string>();
        const mergedData: AutoDevListing[] = [];
        for (const c of [...newResult.data, ...usedResult.data]) {
          if (c.vin && !seenVins.has(c.vin)) {
            seenVins.add(c.vin);
            mergedData.push(c);
          }
        }
        // Same "unreliable total -> null" discipline already used elsewhere
        // (SYS-20260819 doors-param fix) — if either side's total is
        // unknown, the combined total is unknown too, never silently
        // presented as a real number built from a partial sum.
        const mergedTotal =
          newResult.total != null && usedResult.total != null ? newResult.total + usedResult.total : null;
        // A genuine error only surfaces if BOTH sub-queries failed — one
        // succeeding still gives a real, usable (if partial) result, same
        // "partial beats nothing" principle already used for the stage-2
        // full-detail fallback below.
        const mergedError = newResult.error && usedResult.error ? `${newResult.error} ${usedResult.error}` : undefined;
        const mergedDegraded =
          newResult.degraded || usedResult.degraded
            ? [newResult.degraded, usedResult.degraded].filter(Boolean).join(" ")
            : undefined;
        rawResult = { data: mergedData, total: mergedTotal, error: mergedError, degraded: mergedDegraded };
      } else {
        rawResult = await searchListingsLean(baseQuery);
      }
      let candidates = rawResult.data;
      let total = rawResult.total;
      const relaxations: Array<{ step: string; detail: string }> = [];
      for (const c of intent.modelPrefixesStripped) {
        relaxations.push({
          step: "model_prefix_correction",
          detail: `"${c.original}" includes the manufacturer name, which Auto.dev's model field never does — corrected to "${c.corrected}".`,
        });
      }

      // The query that actually produced the rows in `candidates`. Both the
      // model-name correction below and the widening ladder can change it, and
      // post-verification MUST then check against THIS rather than the original
      // baseQuery — otherwise the rows those steps just gained get stripped
      // straight back out, silently undoing them (SYS-20260816-008).
      let effectiveQuery: ListingsQuery = baseQuery;
      // Extended (2026-08-15) — previously only distinguished "local" vs
      // "nationwide" on ZIP validity, so a genuinely absent ZIP (no location
      // given at all — e.g. a bare state-only or fully unscoped search)
      // silently reported as "local" with zero disclosure. Confirmed live:
      // a real "Toyota Camry in Texas" search (state filter, no ZIP) showed
      // scopeNote: "local" despite covering the entire state — the only
      // reason the user got an honest caveat was the host model choosing to
      // add one unprompted, not this tool. Same "don't rely on the caller's
      // good behavior" principle as the invalid-ZIP fix.
      const scopeNote: "local" | "statewide" | "nationwide" =
        rawZip != null && !zipIsValid
          ? "nationwide"
          : rawZip == null && baseQuery.state
          ? "statewide"
          : rawZip == null
          ? "nationwide"
          : "local";

      // Facet-grounded model-name correction (design doc §4), added
      // 2026-08-15 — fixes the real MX-5 regression (SYS-20260815-001):
      // model strings that don't exactly match Auto.dev's data (e.g. "MX-5"
      // vs the real "MX-5 Miata") return a clean silent zero rather than an
      // error. ONLY runs when the primary search genuinely found nothing AND
      // a specific model was requested — every search that already returns
      // results is completely unaffected, so this adds no latency to the
      // common case. One corrective re-search only, never a loop, and the
      // correction is always disclosed via relaxations, never silent.
      if (total === 0 && candidates.length === 0 && baseQuery.model) {
        const requestedModels = baseQuery.model.split(",").map((m) => m.trim());
        const realModels = await getModelFacets(baseQuery);

        const corrections = requestedModels.map((requested) => {
          const lower = requested.toLowerCase();
          const match = realModels.find((real) => {
            const realLower = real.value.toLowerCase();
            return realLower !== lower && (realLower.startsWith(lower) || lower.startsWith(realLower));
          });
          return { requested, corrected: match?.value ?? null };
        });

        const anyCorrected = corrections.some((c) => c.corrected);
        if (anyCorrected) {
          const correctedModelString = corrections
            .map((c) => c.corrected ?? c.requested)
            .join(",");
          const retryQuery: ListingsQuery = { ...baseQuery, model: correctedModelString };
          const retryResult = await searchListingsLean(retryQuery);

          if (retryResult.data.length > 0) {
            candidates = retryResult.data;
            total = retryResult.total;
            effectiveQuery = retryQuery;
            for (const c of corrections) {
              if (c.corrected) {
                relaxations.push({
                  step: "model_name_correction",
                  detail: `"${c.requested}" isn't a recognized model name in current inventory — corrected to "${c.corrected}".`,
                });
              }
            }
          }
        }
      }

      // Tracks the body-style value dropped by the fallback below, if any —
      // used downstream to hard-exclude any candidate whose OWN reported
      // body style/type doesn't match it, at both stage 1 (SYS-20260816-051)
      // and stage 2 (SYS-20260816-052), since the two can genuinely
      // disagree for the same VIN. Closes the real flaw found in
      // SYS-20260816-047: dropping the filter entirely can surface a
      // genuinely different body style, e.g. Convertible results for a
      // Sedan request, since some nameplates like E-Class genuinely span
      // multiple body styles. André's explicit decision (SYS-20260816-051):
      // known-wrong data is excluded outright, not shown with a caveat.
      let droppedBodyStyle: string | undefined;
      // Tracks which of the two possible fields were actually present (and
      // therefore actually dropped) — droppedStyle above only ever holds
      // ONE label string even when both bodyType and vehicleType were
      // supplied and both got dropped, so evidence wiring further down
      // needs its own record of which field(s) were truly requested and
      // truly relaxed (SYS-20260825 follow-up fix — the evidence wiring
      // previously always marked "bodyType" regardless of which field(s)
      // were actually involved).
      let droppedBodyTypeField = false;
      let droppedVehicleTypeField = false;

      // Body-style filter drop (SYS-20260816-046): vehicle.type/vehicle.bodyStyle
      // tagging is genuinely inconsistent per model, not a clean rule that can
      // be predicted or substituted for — confirmed live: Volvo V90 (a wagon)
      // is actually tagged "Crossover" in the real data, not "Wagon" or
      // "Luxury" as an earlier hypothesis this same day assumed. Retrying with
      // a DIFFERENT specific body-style value would just be guessing again.
      // When a specific model is already named, the model itself already
      // implies its own body style, so the body-style filter is redundant
      // confirmation that can backfire on inconsistent tagging — safer to
      // drop it entirely than to guess at a replacement. Runs after the
      // model-name-correction attempt above has already had its chance, and
      // only if still at zero. One retry, never a loop, always disclosed.
      if (total === 0 && candidates.length === 0 && effectiveQuery.model && (effectiveQuery.bodyType || effectiveQuery.vehicleType)) {
        const droppedStyle = effectiveQuery.bodyType ?? effectiveQuery.vehicleType;
        const hadBodyType = !!effectiveQuery.bodyType;
        const hadVehicleType = !!effectiveQuery.vehicleType;
        const { bodyType: _droppedBodyType, vehicleType: _droppedVehicleType, ...withoutBodyStyle } = effectiveQuery;
        const retryResult = await searchListingsLean(withoutBodyStyle);

        if (retryResult.data.length > 0) {
          candidates = retryResult.data;
          total = retryResult.total;
          effectiveQuery = withoutBodyStyle;
          droppedBodyStyle = droppedStyle;
          droppedBodyTypeField = hadBodyType;
          droppedVehicleTypeField = hadVehicleType;
          relaxations.push({
            step: "body_style_filter_dropped",
            detail: `Dropped the body-style filter ("${droppedStyle}") after it returned zero results for the requested model — the model already implies its own body style, and body-style tagging can be inconsistent for some vehicles.`,
          });
        }
      }

      // --- Result-count target (SYS-20260816-008) ---
      // A search is "broad" when it isn't anchored to specific model names, or
      // when the need was expressed as goals rather than exact hard filters.
      // Those are the searches where the host model tends to narrow the answer
      // further on its own, so they get the larger shortlist.
      const isBroadSearch = !baseQuery.model || (input.goals != null && input.goals.length > 0);
      const targetCount = isBroadSearch ? BROAD_SHORTLIST_SIZE : SHORTLIST_SIZE;

      // How many results the user would actually SEE: post-verification AND
      // post-diversity. Widening decisions must use this rather than the raw
      // provider count — a query can return 100 rows that verification strips
      // to two, which is exactly the "plenty of inventory, thin answer" case
      // this whole mechanism exists for.
      const usableCount = (rows: AutoDevListing[], q: ListingsQuery) =>
        applyDiversity(
          rows
            .filter((c) => verifyAgainstConstraints(c, q).length === 0)
            .filter(trimRequiredLeanFilter),
          targetCount,
        ).length;

      // Populated only if the widening block below actually runs — used to
      // build an honest empty-result message (SYS-20260816-030) rather than
      // a generic one that can contradict what the tool just tried.
      let widenAttemptedSteps: StepName[] = [];
      // True when the ladder ran out of time/call budget with steps still
      // untried — distinct from "tried everything relevant and none helped."
      // Must never be presented as a completed search (SYS-20260817-003).
      let widenStoppedEarly = false;

      // Widen only when the result set is genuinely thin — i.e. the standard
      // shortlist can't even be filled. Deliberately NOT triggered by merely
      // falling short of the larger broad-search target: that would fire on
      // most broad searches and spend an upstream call for a marginal gain.
      // A real service error is not "thin results" and must never widen.
      if (!rawResult.error && usableCount(candidates, effectiveQuery) < SHORTLIST_SIZE) {
        // Deadline is anchored HERE, when widening actually starts — not at
        // request start (real bug, confirmed by code + measurement 2026-08-17,
        // SYS-20260817-003). Anchoring at request start meant the primary
        // search plus the model-name-correction and body-style-drop retries
        // all consumed the widening budget before widening began: real
        // measured latencies on exactly the slow paths that need widening
        // were 12.6s, 22.1s and 35.0s against a 15s budget, so the ladder
        // could be fully expired before its first call — silently, and
        // indistinguishably from genuine scarcity.
        //
        // Also capped against the remaining time before Vercel's 60s
        // maxDuration, so a slow primary search can still shorten the
        // widening window rather than pushing the whole request into a
        // platform timeout — it just no longer zeroes it out by default.
        const elapsed = Date.now() - requestStartedAt;
        const remainingBeforePlatformTimeout = Math.max(
          0,
          VERCEL_MAX_DURATION_MS - elapsed - RESPONSE_ASSEMBLY_RESERVE_MS,
        );
        const wideningBudget = Math.min(WIDENING_TIME_BUDGET_MS, remainingBeforePlatformTimeout);

        const widenedOutcome = await widenSearchIfThin(
          effectiveQuery,
          // Widening only needs a number to compare against MIN_ACCEPTABLE —
          // when Auto.dev's total is missing (e.g. vehicle.doors filter, SYS-20260819-001),
          // candidates.length is the best available proxy for that decision.
          // This fallback is local to the widening check only; the real
          // `total` variable (possibly still null) is untouched below and
          // still reported honestly to the user unless widening actually fires.
          { data: candidates, total: total ?? candidates.length },
          {
            search: searchListingsLean,
            usableCount,
            minAcceptable: SHORTLIST_SIZE,
            priceFlexibility: input.priceFlexibility ?? "strict",
            priorityAxis: input.priorityAxis,
            deadline: Date.now() + wideningBudget,
          },
        );
        if (widenedOutcome.widened) {
          candidates = widenedOutcome.data;
          total = widenedOutcome.total;
          effectiveQuery = widenedOutcome.query;
          relaxations.push(...widenedOutcome.relaxations);
        }
        widenAttemptedSteps = widenedOutcome.attemptedSteps;
        widenStoppedEarly = widenedOutcome.stoppedEarly;
      }

      // Post-verification (SYS-20260812-035, redesign doc §5.4 step 6):
      // Auto.dev can silently swallow/mishandle params and return rows that
      // don't actually satisfy a stated filter. Mechanical check only — no
      // semantic/size-class judgment, that stays the calling LLM's job.
      const verifiedCandidates = candidates.filter(
        (c) => verifyAgainstConstraints(c, effectiveQuery).length === 0,
      );
      const violationRate = candidates.length > 0
        ? (candidates.length - verifiedCandidates.length) / candidates.length
        : 0;

      // Body-style hard exclude (SYS-20260816-051, replacing the SYS-20260816-050
      // sort-preference approach): André's explicit design decision — known-
      // wrong data should be EXCLUDED, not disclosed-and-shown. A user
      // skimming a "Strong match" result won't necessarily read a caveat
      // line closely; from their perspective a wrong body style is just a
      // wrong listing, whether the cause is our tool or Auto.dev's data.
      // This is a real, deliberate distinction from the "unknown != false"
      // principle used elsewhere (accident history, CPO): those are
      // genuinely AMBIGUOUS data, so disclosure-not-exclusion is correct.
      // A reported body-style/type that explicitly disagrees with what was
      // asked is not ambiguous — it's a confirmed mismatch. A listing with
      // NEITHER field reported is still unknown, not wrong, and stays
      // eligible rather than being excluded on missing data — same
      // unknown-isn't-false discipline, just applied to exclusion instead
      // of disclosure.
      //
      // Real flaw found live 2026-08-16 (SYS-20260816-057): Auto.dev's own
      // categorization can be wrong for genuinely correct vehicles, not just
      // for genuinely different ones — a real Volvo V90 (a wagon) is tagged
      // "Crossover" there, not "Wagon." For E-Class, the excluded candidates
      // really were a different body style (a Convertible is not a Sedan) —
      // exclusion was correct. For V90, EVERY real match got excluded
      // because the model's own tag is wrong, not because the car is wrong
      // — this hid a genuinely correct answer entirely. There's no reliable
      // way to tell these two cases apart from the tag alone. So: exclusion
      // only applies when it still leaves at least one real candidate:
      // never let it reduce an existing, real candidate pool to nothing.
      // If literally zero candidates in the whole pool match, the filter is
      // not applied at all — the same "never silently drop a real match"
      // principle already used for the widening ladder and elsewhere,
      // extended here. Mismatched candidates surfaced this way still get
      // their honest per-result "NOT the requested X" disclosure
      // (qualifier-accounting.ts) rather than looking like a plain match.
      const bodyStyleMatchFilter = (c: AutoDevListing) => {
        const target = droppedBodyStyle!.toLowerCase();
        const reportedStyle = c.vehicle?.bodyStyle?.toLowerCase();
        const reportedType = c.vehicle?.type?.toLowerCase();
        if (reportedStyle == null && reportedType == null) return true;
        return reportedStyle === target || reportedType === target;
      };
      const bodyStyleFilteredCandidates = droppedBodyStyle
        ? (() => {
            const filtered = verifiedCandidates.filter(bodyStyleMatchFilter);
            return filtered.length > 0 ? filtered : verifiedCandidates;
          })()
        : verifiedCandidates;

      // Trim requirement, stage 1 (SYS-20260823): a confirmed non-match is
      // excluded outright — unlike bodyStyleFilteredCandidates above, there
      // is deliberately NO "never reduce a real pool to zero" fallback here.
      // Body style has that fallback because Auto.dev's own tagging can be
      // wrong for a genuinely correct vehicle (real Volvo V90 tagged
      // "Crossover"); trimRequired is instead an explicit user-stated hard
      // requirement, same category as priceMax — showing a confirmed wrong
      // trim to avoid an empty result would silently violate the exact
      // requirement being fixed here.
      const trimFilteredCandidates = trimRequired
        ? bodyStyleFilteredCandidates.filter(trimRequiredLeanFilter)
        : bodyStyleFilteredCandidates;

      // Prefer a confirmed trim match ahead of a provisional (trim
      // unknown at lean stage) candidate before diversity/shortlisting —
      // stable sort, so candidates within each group keep their existing
      // relative order (already sorted per Auto.dev's own sort/priorityAxis).
      const trimOrderedCandidates = trimRequired
        ? [...trimFilteredCandidates].sort((a, b) => {
            const aRank = trimIsConfirmedMatch(a) ? 0 : 1;
            const bRank = trimIsConfirmedMatch(b) ? 0 : 1;
            return aRank - bRank;
          })
        : trimFilteredCandidates;

      const diversified = applyDiversity(
        // EXPERIMENT (preview only): local best_for_budget ordering, applied
        // only for that axis (or unset, its default) — cheapest/
        // lowest_mileage/newest pass through unchanged. Provider retrieval/
        // sort (resolveSort() above) is completely untouched.
        //
        // lower_risk (feature/lower-risk-mvp): same architecture, its own
        // local reordering pass (applyLocalLowerRiskOrdering, above) —
        // mutually exclusive with best_for_budget's pass, never both.
        input.priorityAxis === "best_for_budget" || input.priorityAxis == null
          ? applyConfigurationVarietyPass(
              applyLocalBestForBudgetOrdering(trimOrderedCandidates, intent.semantic.trimPreference),
            )
          : input.priorityAxis === "lower_risk"
          ? applyLocalLowerRiskOrdering(trimOrderedCandidates)
          : trimOrderedCandidates,
        targetCount * 2,
      );
      const leanShortlist = diversified.slice(0, targetCount);
      // Held in reserve for stage-2 backfill (SYS-20260817-013) if body-style
      // exclusion leaves the shortlist short — these already passed stage-1
      // lean verification and the stage-1 body-style filter, they just
      // haven't had a stage-2 full-detail check yet. Capped at targetCount
      // spares (diversified is built to targetCount*2), so backfill is
      // bounded by construction — never an open-ended search for more.
      const spareLean = diversified.slice(targetCount, targetCount * 2);

      // Stage 2: full detail for exactly the shortlisted vehicles, in parallel.
      // Confirmed working, exact, fast (4.66s for 5 VINs), SYS-20260812-060.
      // Falls back to the lean row itself if a single fetch fails - a partial
      // result (still has vin/make/model/year/price/miles, still gets a real
      // Edmunds link) beats silently dropping a real match.
      const fullDetail = await Promise.all(
        leanShortlist.map((lean) => getListingByVin(lean.vin)),
      );
      const refetched = leanShortlist.map((lean, i) => fullDetail[i] ?? lean);

      // NHTSA electrification check (SYS-20260819-002): same shortlist stage
      // as the full-detail refetch above, run in parallel, never blocks the
      // search — a failed/slow NHTSA call just means that one result keeps
      // relying on Auto.dev's own (known-incomplete) fuel field, same as
      // before this feature existed.
      const nhtsaResults = await Promise.all(
        refetched.map((listing) =>
          decodeNhtsaElectrification(
            listing.vin,
            listing.vehicle?.make,
            listing.vehicle?.model,
            listing.vehicle?.cylinders,
          ),
        ),
      );
      // Keyed by VIN, not index — backfill spares (spareLean, added later if
      // body-style exclusion leaves the shortlist short) never went through
      // this lookup, so a positional zip would silently misalign. Cards for
      // any VIN not in this map simply get `undefined`, same as before this
      // feature existed.
      const nhtsaByVin = new Map(refetched.map((listing, i) => [listing.vin, nhtsaResults[i]]));

      // Post-refetch re-verification (SYS-20260816-004): getListingByVin is a
      // separate, independent Auto.dev fetch and can return a price (or other
      // hard-constraint fields) that differs from the already-verified stage-1
      // lean data — e.g. a live price change between the search call and the
      // per-VIN refetch. Without this check, a listing that correctly passed
      // priceMax/verifyAgainstConstraints at stage 1 could reach the user
      // over budget at stage 2 with zero re-verification, even under
      // priceFlexibility: "strict". Real, confirmed bug — not Auto.dev
      // buffering, not a caller-side parameter mistake (found investigating
      // André's live testing question, root-caused by reading this file).
      //
      // Fixed (SYS-20260822): this used to fall back to the *lean* record
      // whenever the fresh full-detail record violated a constraint. That's
      // backwards — the fresh full-detail fetch is authoritative here, so a
      // confirmed contradiction (e.g. price now over budget) must never be
      // hidden by reverting to older, possibly-stale lean data. A real
      // production result was found missing primaryImage, used/new status,
      // dealer location, drivetrain and Carfax while still showing
      // price/mileage — root cause was exactly this substitution silently
      // serving a stale/incomplete lean row while looking "resolved". Now:
      // a confirmed constraint violation on the full-detail record excludes
      // that candidate entirely (never substitutes lean) and the caller
      // backfills from the spare pool, same architecture as the existing
      // body-style backfill below. A genuine full-detail *lookup failure*
      // (fetch returned null) is a different case — lean fallback is still
      // fine there since we have no fresher data to trust or distrust —
      // logged separately as detail_lookup_failed.
      //
      // Fixed again (SYS-20260823, VIN W1N4N5BB1TJ864755 confirmed live):
      // full-detail is authoritative for everything EXCEPT price. Auto.dev's
      // full-detail endpoint was observed returning $61,515 for a VIN whose
      // live listing (Edmunds-confirmed) and stage-1 lean/listings price
      // were both $59,935 — full-detail's own price was simply wrong. Price
      // now uses the stage-1 lean price as canonical whenever present
      // (logged as stage2_price_disagreement when the two differ), while
      // every other full-detail field is retained unchanged. This is a
      // single-field override, not the whole-record lean substitution that
      // was removed above.
      //
      // Uses effectiveQuery, not baseQuery: if the widening ladder ran, stage 1
      // verified against the widened constraints, so stage 2 must too — checking
      // against the original would reject exactly the rows widening just gained
      // and silently undo it (SYS-20260816-008).
      //
      // Factored into a helper so the exact same lookup-failure/constraint-drift
      // resolution can run a second time on the spare pool during backfill,
      // instead of duplicating this block.
      function resolveStage2Detail(
        leanRows: AutoDevListing[],
        fullRows: (AutoDevListing | null)[],
      ): { kept: AutoDevListing[]; anyLookupFailed: boolean; anyConstraintDrift: boolean } {
        const kept: AutoDevListing[] = [];
        let anyLookupFailed = false;
        let anyConstraintDrift = false;

        for (let i = 0; i < leanRows.length; i++) {
          const lean = leanRows[i];
          const full = fullRows[i];

          if (!full) {
            // Case 1: genuine lookup failure. Lean fallback still allowed so
            // a real candidate isn't unnecessarily lost — no new Auto.dev
            // call/retry added here.
            anyLookupFailed = true;
            console.log(
              `[find_matching_vehicle] stage2 detail_lookup_failed vin=${lean.vin} — full-detail fetch returned null, using lean fallback`,
            );
            kept.push(lean);
            continue;
          }

          // Price precedence (confirmed production case, VIN
          // W1N4N5BB1TJ864755): Auto.dev's full-detail endpoint can return a
          // stale/incorrect price for a VIN whose live listing (Edmunds
          // confirmed) matches the stage-1 lean/listings price exactly —
          // the lean price is canonical for price specifically, applied
          // unconditionally whenever present, before constraint checking.
          // This does NOT revert the whole record to lean: every other
          // full-detail field (photo, dealer, location, drivetrain,
          // Carfax, used/new, history, mileage, year, make, model, etc.)
          // stays exactly as returned by the full-detail fetch. If lean
          // price is missing, fall back to the full-detail price
          // (unchanged behavior).
          const leanPrice = lean.retailListing?.price ?? null;
          const fullPrice = full.retailListing?.price ?? null;
          if (leanPrice != null && fullPrice != null && leanPrice !== fullPrice) {
            console.log(
              `[find_matching_vehicle] stage2_price_disagreement vin=${lean.vin} leanPrice=${leanPrice} fullPrice=${fullPrice} chosenPrice=${leanPrice}`,
            );
          }
          const priceResolved: AutoDevListing =
            leanPrice != null && full.retailListing
              ? { ...full, retailListing: { ...full.retailListing, price: leanPrice } }
              : full;

          const violations = verifyAgainstConstraints(priceResolved, effectiveQuery);
          if (violations.length === 0) {
            kept.push(priceResolved);
            continue;
          }

          // Case 2: full-detail lookup succeeded but the resolved record
          // (with the canonical lean price applied, when available) still
          // contradicts a hard constraint already checked by
          // verifyAgainstConstraints() — e.g. year, mileage, make, model,
          // or a price still over budget even at the lean value. The
          // resolved record is authoritative — exclude rather than
          // reverting to the whole lean row, and let the caller backfill.
          anyConstraintDrift = true;
          console.log(
            `[find_matching_vehicle] stage2 full_detail_rejected_due_to_constraint_drift ` +
              `vin=${lean.vin} violations=${JSON.stringify(violations)} ` +
              `leanPrice=${leanPrice} fullPrice=${fullPrice} ` +
              `leanMileage=${lean.retailListing?.miles ?? null} fullMileage=${full.retailListing?.miles ?? null} ` +
              `leanYear=${lean.vehicle?.year ?? null} fullYear=${full.vehicle?.year ?? null} ` +
              `leanMake=${lean.vehicle?.make ?? null} fullMake=${full.vehicle?.make ?? null} ` +
              `leanModel=${lean.vehicle?.model ?? null} fullModel=${full.vehicle?.model ?? null}`,
          );
        }

        return { kept, anyLookupFailed, anyConstraintDrift };
      }

      const {
        kept: shortlistWithPriceCheck,
        anyLookupFailed: detailLookupFailedFromPrimary,
        anyConstraintDrift: priceDriftFromPrimary,
      } = resolveStage2Detail(leanShortlist, fullDetail);
      let priceDriftDetected = priceDriftFromPrimary;
      let detailLookupFailedDetected = detailLookupFailedFromPrimary;

      // Body-style stage-2 re-check (SYS-20260816-052): the SYS-20260816-051
      // exclude filter runs on stage-1 lean data, but confirmed live that
      // lean and stage-2 full-detail data can genuinely disagree on
      // bodyStyle/type for the same VIN — a candidate can pass the lean-data
      // exclude check and still arrive at stage 2 with a body style that
      // doesn't match what was requested. Same root shape as the proven
      // SYS-20260816-004/005 price-drift fix above: stage 1 isn't
      // authoritative, stage 2 is, so re-check there too.
      //
      // Backfill (SYS-20260817-013): previously, any candidate excluded here
      // was just gone — the shortlist arrived short of targetCount with no
      // attempt to replace it, even though real, un-tried candidates were
      // already sitting in `spareLean`. Confirmed live (Volvo V90, Mercedes
      // E-Class): 3 results shown against a 5-result target, real inventory
      // available. Now: excluded slots are backfilled from the spare pool,
      // one bounded round, before ever falling back to showing mismatches.
      // If a genuine match exists in the spares, the user sees a genuine
      // match instead of a "shown anyway, wrong body style" caveat — a
      // strictly better outcome, and consistent with the project's standing
      // preference for a true result over a false one wherever possible.
      //
      // Same never-reduce-a-real-pool-to-zero fallback as stage 1
      // (SYS-20260816-057): only once BOTH the primary shortlist AND the
      // backfill attempt fail to produce any genuine match at all does this
      // fall back to showing the mismatched entries rather than nothing —
      // each still gets its own honest "NOT the requested X" disclosure via
      // qualifier-accounting.ts, never a bare confirmation.
      let bodyStyleDriftDetected = false;
      let bodyStyleFallbackUsed = false;
      // Trim requirement, stage 2 (SYS-20260823): unlike body style, this
      // NEVER falls back to showing a non-matching/still-unresolved trim —
      // trimRequired is an explicit hard requirement, not a data-tagging
      // quirk to route around. If genuinely nothing satisfies it after the
      // primary shortlist and one backfill round, the result is an empty
      // (or partial) shortlist, same as any other hard filter exhausting
      // real inventory — never a silently-included wrong trim.
      let trimDriftDetected = false;
      // Geographic radius verification, stage 2 (SYS-20260827): same
      // architecture as body style/trim above — Auto.dev's own radius
      // filter is not trusted as ground truth. Only fires when the
      // listing's confirmed reported state is provably outside the
      // effective (possibly widened) radius from the search ZIP — see
      // lib/geo-verification.ts for the full "unknown ≠ false, never
      // guess" design. Uses effectiveQuery.radius specifically (not the
      // original baseQuery/input radius) so a legitimately widened search
      // (e.g. 50 -> 100 miles) is verified against the widened radius, not
      // the original one — the same effectiveQuery discipline already
      // established for verifyAgainstConstraints() above.
      let geoDriftDetected = false;
      const applyLocalStage2Filters = (full: AutoDevListing): boolean => {
        let ok = true;
        if (droppedBodyStyle) {
          const matches = bodyStyleMatchFilter(full);
          if (!matches) bodyStyleDriftDetected = true;
          ok = ok && matches;
        }
        if (trimRequired) {
          const matches = trimRequiredFullFilter(full);
          if (!matches) {
            trimDriftDetected = true;
            console.log(
              `[find_matching_vehicle] stage2 trim_required_rejected vin=${full.vin} trimRequired=${trimRequired} reportedTrim=${full.vehicle?.trim ?? null}`,
            );
          }
          ok = ok && matches;
        }
        const confirmedOutsideRadius = isConfirmedOutsideRadius(
          effectiveQuery.zip,
          effectiveQuery.radius,
          full.retailListing?.state,
        );
        if (confirmedOutsideRadius) {
          geoDriftDetected = true;
          console.log(
            `[find_matching_vehicle] stage2 geo_radius_rejected vin=${full.vin} searchZip=${effectiveQuery.zip ?? null} effectiveRadius=${effectiveQuery.radius ?? null} reportedState=${full.retailListing?.state ?? null} reportedCity=${full.retailListing?.city ?? null}`,
          );
        }
        ok = ok && !confirmedOutsideRadius;
        return ok;
      };
      const shortlist = await (async () => {
        // Shortfall can now come from body-style exclusion, from
        // full_detail_rejected_due_to_constraint_drift exclusion above, from
        // a trimRequired exclusion, or from a confirmed-outside-radius
        // exclusion — all four reduce shortlistWithPriceCheck below
        // targetCount, so the backfill below must run for any of these
        // causes, not just when a body style was dropped.
        const primaryMatches = (droppedBodyStyle || trimRequired || effectiveQuery.zip)
          ? shortlistWithPriceCheck.filter(applyLocalStage2Filters)
          : shortlistWithPriceCheck;

        const shortfall = targetCount - primaryMatches.length;
        if (shortfall <= 0 || spareLean.length === 0) {
          if (primaryMatches.length > 0) return primaryMatches;
          if (trimRequired) return []; // hard requirement — never fall back to a non-matching/unresolved trim
          bodyStyleFallbackUsed = shortlistWithPriceCheck.length > 0;
          return shortlistWithPriceCheck;
        }

        // One bounded backfill round: fetch stage-2 detail for the spare
        // pool (already capped to targetCount by construction above), same
        // lookup-failure/constraint-drift resolution as the primary shortlist.
        const spareFullDetail = await Promise.all(
          spareLean.map((lean) => getListingByVin(lean.vin)),
        );
        const {
          kept: spareResolved,
          anyLookupFailed: spareLookupFailed,
          anyConstraintDrift: spareDrift,
        } = resolveStage2Detail(spareLean, spareFullDetail);
        if (spareDrift) priceDriftDetected = true;
        if (spareLookupFailed) detailLookupFailedDetected = true;

        const backfillMatches = ((droppedBodyStyle || trimRequired || effectiveQuery.zip)
          ? spareResolved.filter(applyLocalStage2Filters)
          : spareResolved
        ).slice(0, shortfall);

        const combined = [...primaryMatches, ...backfillMatches];
        if (combined.length > 0) return combined;

        if (trimRequired) return []; // hard requirement — never fall back to a non-matching/unresolved trim
        bodyStyleFallbackUsed = shortlistWithPriceCheck.length > 0;
        return shortlistWithPriceCheck;
      })();

      const intentInput: CardIntentInput = {
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        cylinders: input.cylinders,
        doors: input.doors,
        vehicleType: input.vehicleType,
        used: input.used,
        cpo: input.cpo,
        noAccidents: input.noAccidents,
        oneOwner: input.oneOwner,
        // Resolved value, not raw input — picks up goal-inferred seat needs
        // (e.g. "family car") as well as an explicit seatsMinPreference.
        seatsMinPreference: intent.semantic.seatsMin,
        droppedBodyStyleFilter: droppedBodyStyle,
        trimRequired,
      };

      // Constraint evidence (SYS-20260825): "requested" values come from
      // intent.hardConstraints (the originally-stated, never-widened values
      // — the same object parseIntent() produced once at the top of this
      // handler, untouched by the widening ladder below it, which only
      // mutates the separate effectiveQuery variable) plus the raw input
      // for the fields intent.hardConstraints doesn't carry. relaxedFields
      // is derived only from this handler's own already-known, explicit
      // relaxation state — never inferred by the evidence module itself.
      const relaxedFields = new Set<string>();
      for (const r of relaxations) {
        if (r.step === "price") relaxedFields.add("priceMax");
        if (r.step === "year") {
          relaxedFields.add("yearMin");
          relaxedFields.add("yearMax");
        }
        if (r.step === "mileage") relaxedFields.add("mileageMax");
        // "radius" and the model-name-correction steps don't correspond to
        // any evidence field above — intentionally not mapped.
      }
      if (droppedBodyTypeField) relaxedFields.add("bodyType");
      if (droppedVehicleTypeField) relaxedFields.add("vehicleType");

      const searchEvidenceRequest: ConstraintEvidenceRequest = {
        make: intent.hardConstraints.make,
        model: intent.hardConstraints.model,
        priceMin: intent.hardConstraints.priceMin,
        priceMax: intent.hardConstraints.priceMax,
        yearMin: intent.hardConstraints.yearMin,
        yearMax: intent.hardConstraints.yearMax,
        mileageMax: intent.hardConstraints.mileageMax,
        bodyType: intent.hardConstraints.bodyType,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        vehicleType: input.vehicleType,
        doors: input.doors,
        cylinders: input.cylinders,
        used: input.used,
        state: input.state,
        trimRequired: intent.trimRequired,
      };

      const cards = (
        await Promise.all(
          shortlist.map((listing) =>
            buildResultCard(listing, intent, intentInput, nhtsaByVin.get(listing.vin), searchEvidenceRequest, relaxedFields),
          ),
        )
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      // Match Score ordering is only correct for the default best_for_budget
      // axis, where "best overall fit" is genuinely what the user asked for.
      // For directional axes (cheapest/lowest_mileage/newest), the shortlist
      // already arrives in the correct order — it was fetched from Auto.dev
      // with the matching sort (resolveSort() above: price.asc/miles.asc/
      // year.desc) and that order survives diversity capping and the stage-2
      // detail refetch unchanged, since both preserve array order rather than
      // reordering. Re-sorting by Match Score here silently overwrote that
      // correct order for every search regardless of priorityAxis, which is
      // exactly what caused three separate real, confirmed 50+ second
      // multi-call incidents in live testing (Aug 15 baseline, SYS-20260815-
      // 001/002: cheapest, lowest_mileage, and newest all affected) — the
      // calling LLM had to manually re-verify and narrow the ceiling itself
      // because our own "cheapest"/"newest" results weren't actually ordered
      // that way by the time they reached it.
      if (input.priorityAxis === "cheapest" || input.priorityAxis === "lowest_mileage" || input.priorityAxis === "newest") {
        // Leave cards in their already-correct fetched order — do not re-sort.
      } else if (input.priorityAxis === "lower_risk") {
        // Final-card risk sort (feature/lower-risk-mvp follow-up #2):
        // applyLocalLowerRiskOrdering() already ranked the LEAN candidates
        // by risk tier before stage-2, but that lean pre-ranking was
        // falling into this same Match Score branch below and being
        // silently overwritten, the same class of bug the cheapest/
        // lowest_mileage/newest branch above already exists to prevent.
        // Fixed by re-sorting the FINAL full-detail cards here by their
        // own c.risk.tier via the same riskTierRank() helper
        // applyLocalLowerRiskOrdering() uses — preferable to merely
        // preserving the lean order, since the final card carries the
        // authoritative full-detail risk evidence (lean is necessarily a
        // pre-stage-2 approximation). Stable sort by tier rank ONLY —
        // candidates within the same tier keep whatever relative order
        // diversity/shortlisting already produced, no secondary scoring
        // formula invented on top. Match Score itself is completely
        // untouched by this branch; a higher Match Score amber/red card
        // can never jump above a lower Match Score positive/unknown card.
        cards.sort((a, b) => riskTierRank(a.risk.tier) - riskTierRank(b.risk.tier));
      } else {
        cards.sort((a, b) => b.ranking.matchScore - a.ranking.matchScore);
      }

      const dataNotes: string[] = [];
      if (lowestMileageDefaultedToUsed) {
        dataNotes.push(
          "Searched used vehicles only — \"lowest mileage\" defaults to used, not new or dealer-demo inventory, since a new car's low mileage isn't a meaningful comparison. Ask for new vehicles specifically if that's what you want.",
        );
      }
      if (priceDriftDetected) {
        dataNotes.push(
          "One or more listings had details at the time of the detailed lookup that still didn't match your stated filters even after reconciling a known price discrepancy against the originally verified data (e.g. a genuine year or mileage conflict) — those results were excluded and, where possible, replaced with an alternate match.",
        );
      }
      if (bodyStyleFallbackUsed) {
        dataNotes.push(
          `None of the results could be confirmed as a genuine ${droppedBodyStyle} — Auto.dev's own data appears to mislabel this model's body style. Shown anyway since they're still the correct model, with each result's actual reported body style disclosed individually below.`,
        );
      } else if (bodyStyleDriftDetected) {
        dataNotes.push(
          `One or more listings turned out not to be a genuine ${droppedBodyStyle} at the detailed lookup stage, despite passing the initial search — excluded rather than shown as a mismatch.`,
        );
      }
      if (trimDriftDetected) {
        dataNotes.push(
          `One or more listings turned out not to be a genuine ${trimRequired} at the detailed lookup stage, despite passing the initial search — excluded rather than shown as a mismatch, since ${trimRequired} was a specific requirement, not a preference.`,
        );
      }
      if (geoDriftDetected) {
        dataNotes.push(
          "One or more listings were confirmed to be reported far outside the requested search radius at the detailed lookup stage, despite passing the provider's own radius filter — excluded rather than shown as a mismatch.",
        );
      }
      if (violationRate > 0.2) {
        dataNotes.push(
          "Some results from the underlying data source didn't fully match the stated filters and were excluded — this can happen with the provider's data.",
        );
      }
      if (rawResult.degraded) {
        dataNotes.push(rawResult.degraded);
      }
      if (scopeNote === "nationwide" && rawZip != null) {
        dataNotes.push("The requested location wasn't recognized, so this search was widened to nationwide.");
      } else if (scopeNote === "nationwide") {
        dataNotes.push("No location was specified, so this search covers listings nationwide rather than a specific area.");
      } else if (scopeNote === "statewide") {
        dataNotes.push(`No specific ZIP or city was given, so this search covers all of ${baseQuery.state} rather than a specific area.`);
      }

      const response = {
        meta: {
          totalCandidatesConsidered: candidates.length,
          totalMatches: typeof total === "number" ? total : null,
          corpusSizeApprox: getCorpusCountForDescription(),
          relaxations,
          dataNotes,
          scopeNote,
          serviceError: rawResult.error ?? null,
          interpretationNotes: intent.interpretationNotes,
          qualifierAccounting: buildQualifierAccounting(intentInput),
        },
        results: cards,
      } satisfies FindMatchingVehicleOutput;

      // The text content block is what the host model actually reads and
      // reasons over — structuredContent is supplementary, not a substitute.
      // Real testing (Aug 13) showed the model only surfaced a one-line
      // summary and couldn't answer follow-ups about the other results, so
      // every result's key detail now goes directly into this text.
      const totalPhrase = typeof total === "number" ? ` out of ${total} in the area` : "";

      // Honest disclosure prefix — any relaxation or data quality note must
      // reach the model's text, not just structuredContent (SYS-20260812-011
      // #3, redesign doc §5 "CALLING LLM presents results and *honestly
      // narrates* any relaxations").
      const disclosurePrefix =
        relaxations.length > 0 || dataNotes.length > 0
          ? [...relaxations.map((r) => `Note: ${r.detail}`), ...dataNotes].join("\n") + "\n\n"
          : "";

      // A failed request must never be reported as "no cars matched" - that
      // sends the user off changing their perfectly good search criteria when
      // the real problem was that the request never completed.
      const serviceFailureMessage = rawResult.error
        ? `${rawResult.error} Your search criteria look fine — this is worth retrying in a moment.`
        : null;

      // Honest empty-result message (SYS-20260816-030): the old version
      // always suggested widening radius/mileage/year, even when automatic
      // widening had already tried exactly that and genuinely found nothing
      // — a real, confirmed failure mode (André's live testing, Aug 16),
      // where the message contradicted what the tool itself had just done.
      // Now built from what actually happened: if nothing was attempted (no
      // zip/mileageMax/yearMin to widen in the first place), the original
      // generic suggestion still applies. If widening WAS attempted and
      // still found nothing, say so plainly and point at genuinely untried
      // levers instead of repeating ones already exhausted.
      const STEP_LABELS: Record<StepName, string> = {
        radius: "search radius",
        mileage: "mileage ceiling",
        year: "year range",
        price: "price ceiling",
      };
      const uniqueAttemptedSteps = Array.from(new Set(widenAttemptedSteps));

      // Non-geographic ZIP check (SYS-20260817-005): a real, confirmed bug —
      // some valid, real US ZIPs (PO-Box-only downtown ZIPs, federal
      // buildings, some university/military ZIPs) can't be geocoded to a
      // meaningful search radius, and Auto.dev silently returns zero rather
      // than erroring. Without this check, that reads exactly like a
      // genuine inventory gap and gets reported as one — a confidently
      // wrong diagnosis. Live-confirmed: zip 77001 (Houston, PO-Box-only)
      // returns 0 total for ANY make/model, while every neighboring zip
      // (77002/77004/77024/77030) returns ~690.
      //
      // Deliberately NOT a general geocoding solution — André's explicit
      // direction: most users type a real, geographic ZIP; this needs an
      // easy, cheap check with honest feedback, not an attempt to resolve
      // or correct the bad ZIP itself. One extra lightweight call, firing
      // only in the already-rare true-zero-after-widening case, using the
      // same unfiltered-except-location shape and 100mi radius as the
      // widening ladder's own max radius step for consistency. A make/
      // model/price-agnostic control query isolates whether the ZIP itself
      // is the problem, rather than this specific search being genuinely
      // thin.
      let zipLikelyInvalid = false;
      if (cards.length === 0 && !rawResult.error && rawZip) {
        const control = await searchListingsLean({ zip: rawZip, radius: 100, limit: 1 });
        zipLikelyInvalid = !control.error && control.total === 0;
      }

      // When the ladder halted on its budget with steps untried, neither
      // standard message is truthful: claiming "more widening on those
      // dimensions wouldn't help" overstates what was checked, and the
      // nothing-attempted message tells the user to widen when the tool
      // silently declined to. Say plainly that the search was cut short
      // (SYS-20260817-003).
      const noResultsMessage = zipLikelyInvalid
        ? `No vehicles matched these criteria, and a broader check found zero listings of ANY kind near ZIP ${rawZip} — this looks like the ZIP itself may not be resolving to a valid searchable location (for example, some ZIPs are PO-Box-only with no real street addresses nearby) rather than a genuine inventory gap. Double-checking the ZIP, or trying a nearby one, is more likely to help than widening price, year, or model.`
        : widenStoppedEarly
        ? uniqueAttemptedSteps.length > 0
          ? `No vehicles matched these criteria. Automatic widening of the ${uniqueAttemptedSteps
              .map((s) => STEP_LABELS[s])
              .join(", ")} was tried without success, and the search was then cut short before every option could be checked — so this may not be the full picture. Trying again, or searching a different location or broader model list, may surface options.`
          : "No vehicles matched these criteria, and the automatic widening step was cut short before it could run — so this may not be the full picture. Trying again, or widening the price range, location radius, or year range yourself, may surface options."
        : uniqueAttemptedSteps.length > 0
          ? `No vehicles matched these criteria, even after automatically trying to widen the ${uniqueAttemptedSteps
              .map((s) => STEP_LABELS[s])
              .join(", ")} — this looks like a genuine inventory gap for this exact combination, not something more widening on those same dimensions would fix. A different location, a broader model list, or (if the budget allows) some price flexibility may help instead.`
          : "No vehicles matched these criteria. Widening the price range, location radius, or year range would likely surface options.";

      // Partial-success disclosure gap (SYS-20260816-049, real bug found live
      // 2026-08-16): a widening step can be genuinely attempted and fail to
      // help even when the search DID find some results, just fewer than the
      // target — that case previously had no disclosure at all, since the
      // logic above only covers the fully-empty case. `relaxations` already
      // covers every widening step that DID help; this covers the ones that
      // were tried and didn't, so the user isn't left wondering whether more
      // was tried on their behalf.
      const successfulWideningSteps = new Set(
        relaxations
          .map((r) => r.step)
          .filter((s): s is StepName => (["radius", "mileage", "year", "price"] as string[]).includes(s)),
      );
      const unsuccessfulAttemptedSteps = uniqueAttemptedSteps.filter((s) => !successfulWideningSteps.has(s));
      const isThin = cards.length > 0 && cards.length < targetCount;
      const partialWideningNote = !isThin
        ? ""
        : widenStoppedEarly
          ? unsuccessfulAttemptedSteps.length > 0
            ? `Note: Also tried widening the ${unsuccessfulAttemptedSteps
                .map((s) => STEP_LABELS[s])
                .join(", ")} without additional matches, then stopped before every option could be checked — there may be more available than shown here.\n\n`
            : `Note: The automatic widening step was cut short before it could finish, so there may be more available than shown here.\n\n`
          : unsuccessfulAttemptedSteps.length > 0
            ? `Note: Also tried widening the ${unsuccessfulAttemptedSteps
                .map((s) => STEP_LABELS[s])
                .join(", ")}, but that didn't turn up any additional matches.\n\n`
            : "";

      const summary =
        serviceFailureMessage
          ? disclosurePrefix + serviceFailureMessage
          : cards.length === 0
          ? disclosurePrefix + noResultsMessage
          : disclosurePrefix + partialWideningNote + `Found ${cards.length} closely matching vehicle${cards.length === 1 ? "" : "s"}${totalPhrase}:\n\n` +
            cards
              .map((c, i) => {
                const id = c.identity;
                const l = c.listing;
                const r = c.ranking;
                const trimStr = id.trim ? ` ${id.trim}` : "";
                const priceAnomalous = c.badges.includes("price-likely-inaccurate");
                const priceStr = l.price != null
                  ? `$${l.price.toLocaleString()}${priceAnomalous ? " ⚠️ price looks like a data error, verify before trusting it" : ""}`
                  : "price unavailable";
                const mileageStr = l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "mileage unknown";
                const dealerStr = l.dealer ? ` — ${l.dealer}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}` : "";
                // affiliateUrl (VIN-specific Edmunds) is always the primary
                // user-facing link when present. dealerListingUrl (including
                // Carvana's own VDP) is NEVER routed to as a user-facing
                // destination — it stays available internally via
                // c.links.dealerListingUrl on structuredContent only. When
                // affiliateUrl is null, affiliateFallbackUrl (Edmunds
                // category search, same make/model) becomes the primary
                // destination instead, labeled explicitly as similar options
                // rather than "this vehicle" — it never dead-ends, but it
                // isn't the specific vehicle either.
                const primaryLinkStr = c.links.affiliateUrl ?? null;
                const similarOptionsLabel = `similar ${id.year ?? ""} ${id.make ?? ""} ${id.model ?? ""}`.replace(/\s+/g, " ").trim();
                const fallbackLinkStr = c.links.affiliateFallbackUrl
                  ? ` · If that Edmunds listing is no longer available, see ${similarOptionsLabel}: ${c.links.affiliateFallbackUrl}`
                  : "";
                const linkStr = primaryLinkStr
                  ? primaryLinkStr + fallbackLinkStr
                  : c.links.affiliateFallbackUrl
                  ? `Similar options on Edmunds (${similarOptionsLabel}): ${c.links.affiliateFallbackUrl}`
                  : "no link available";
                const historyLine = c.history.state === "known_issues" ? `\n   ⚠️ ${c.history.note}` : "";
                // Qualifier accounting: only for fields the user actually
                // asked about (c.intentConfirmations is already scoped to
                // that). Skip the history note here if it's already shown
                // via historyLine above, so it isn't repeated twice.
                const confirmedItems = c.intentConfirmations.filter(
                  (x) => !(c.history.state === "known_issues" && x === c.history.note),
                );
                const confirmedLine = confirmedItems.length > 0 ? `\n   Confirmed: ${confirmedItems.join(", ")}` : "";
                const conflictLine = c.dataConflicts.length > 0 ? `\n   ⚠️ ${c.dataConflicts.join(" ")}` : "";
                return `${i + 1}. ${id.year} ${id.make} ${id.model}${trimStr} — ${priceStr}, ${mileageStr}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}${historyLine}${confirmedLine}${conflictLine}\n   Link: ${linkStr}`;
              })
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: response,
      };
    },
  );


  server.registerTool(
    "resolve_dealer_url",
    {
      description:
        "Resolves a usable link for viewing or purchasing a specific vehicle, given its VIN, make, model, and year. Prefers the Edmunds VIN-specific pricing link; when that's unavailable (including for Carvana-sourced vehicles, which are never on Edmunds by VIN), falls back to affiliateFallbackUrl, a live Edmunds category-search link for the same make/model that never dead-ends. Never returns the dealer's own listing URL (dealerListingUrl) as the resolved link, even for Carvana — that field is still present on structuredContent for internal/diagnostic use, just never the text response.",
      inputSchema: {
        vin: z.string().describe("The vehicle's 17-character VIN."),
        make: z.string().describe("Vehicle manufacturer, e.g. Toyota."),
        model: z.string().describe("Vehicle model name, e.g. Camry."),
        year: z.number().describe("Model year."),
      },
      outputSchema: ResolveDealerUrlOutput,
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ vin, make, model, year }) => {
      // No retailListing data available in this call path (only VIN/make/
      // model/year are passed in), so Carvana detection here always
      // evaluates false via isCarvanaListing()'s dealer/vdp checks — moot
      // either way now, since dealerListingUrl is never routed to as the
      // resolved link regardless of Carvana status (see primary below).
      const links = resolveLinks({ vin, vehicle: { make, model, year } } as AutoDevListing);

      if (links.linkStatus === "none-available") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No usable link could be built for this vehicle (missing VIN/make/model/year, or all links unreachable).",
            },
          ],
        };
      }

      // Never route to dealerListingUrl (including Carvana) as the resolved
      // link — affiliateUrl (VIN-specific Edmunds) first, then
      // affiliateFallbackUrl (Edmunds category search) as the fallback
      // destination. dealerListingUrl stays present on structuredContent
      // for internal/diagnostic use, never returned as the text response.
      // A linkStatus of "dealer-only" (dealerListingUrl present, but
      // neither affiliate option is) has no usable destination here per
      // that same policy — report it plainly rather than substituting the
      // dealer URL.
      const primary = links.affiliateUrl ?? links.affiliateFallbackUrl ?? null;
      if (!primary) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No Edmunds link (VIN-specific or category fallback) could be built for this vehicle.",
            },
          ],
          structuredContent: links,
        };
      }
      return {
        content: [{ type: "text" as const, text: primary }],
        structuredContent: links,
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
