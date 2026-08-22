import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { type AutoDevListing, type ListingsQuery } from "@/lib/auto-dev-client";
import { searchListingsLean, getListingByVin, getModelFacets } from "@/lib/auto-dev-client";
// Widening ladder re-enabled 2026-08-16 (SYS-20260816-008). It was bypassed on
// Aug 13 per André's request — "search itself needs to work correctly before any
// widening logic runs on top of it." That precondition is now met: the stage-2
// price-ceiling bug (SYS-20260816-004) is fixed and the full A/B/C prompt suite
// verified 9/9 the same day. Re-enabled via a rewritten, injected API rather
// than the old call — see lib/loosening-ladder.ts header for exactly why.
import { widenSearchIfThin, type StepName } from "@/lib/loosening-ladder";
import { verifyAgainstConstraints } from "@/lib/post-verify";
import { parseIntent } from "@/lib/intent-parser";
import { applyDiversity } from "@/lib/diversity";
import { crossCheckVin } from "@/lib/vin-cross-check";
import { computeMatchScore } from "@/lib/match-score";
import { resolveLinks } from "@/lib/link-resolution";
import { sanitizeDealerName } from "@/lib/dealer-name";
import { applyKnownHybridOverride, formatFuelTypeForDisplay } from "@/lib/fuel-type";
import { decodeNhtsaElectrification, nhtsaIndicatesElectrified, type NhtsaElectrificationResult } from "@/lib/nhtsa-client";
import { getCorpusCountForDescription, initCorpusCount } from "@/lib/corpus-count";
import { CAPABILITIES } from "@/lib/capabilities";
import { buildIntentConfirmations, detectDataConflicts, buildQualifierAccounting, type CardIntentInput } from "@/lib/qualifier-accounting";
import { RESULTS_CARD_RESOURCE_URI, buildResultsCardHtml } from "@/lib/results-card";

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

Use priceFlexibility: "flexible" only when the user signals approximation ("around," "roughly," "about"). Otherwise price is a strict ceiling, never silently loosened.

RESULT TRUST

Every result's text states plainly which criteria it met, and separately flags any genuine data conflict (e.g. a cylinder count disagreeing with its own series description). If a price, mileage, or other value is flagged as an implausible data error, never present it as the genuine cheapest, newest, or best match in your own summary — it stays visible for transparency but is excluded from that judgment.

Open with real scale: \`corpusSizeApprox\` searched, narrowed to \`totalMatches\` matching this request — e.g. "3,581,127 searched → 406 matched, here are the strongest options:". Never claim an exact count for the results actually shown, since that depends on how the response gets formatted — keep that part qualitative ("strongest options," "best matches"). If \`totalMatches\` is null, the exact count wasn't available for this search — don't say "0 matched" or invent a number; just open with \`corpusSizeApprox\` searched and go straight into the results.

PRIORITY AXIS

Set priorityAxis based on what the user is actually optimizing for: "cheapest"/"lowest price"/"budget option" → cheapest. "Lowest mileage"/"as few miles as possible" → lowest_mileage (this defaults the search to used vehicles only, since a new car's low mileage isn't a meaningful comparison — disclosed to the user, not silent). "Newest"/"latest model year" → newest. "Best," "nicest," a price ceiling with no other stated priority → best_for_budget (default — samples from the top of budget down). When uncertain, use best_for_budget.

LOCATION HANDLING

A ZIP anchors a local search, defaulting to a 50-mile radius when none is specified; if results are thin it may widen to 100 miles automatically, disclosed in the result — see AUTOMATIC WIDENING. Validate a user-provided ZIP before calling — if it's invalid or not a real US ZIP, ask for a corrected one rather than substituting another location yourself. A named city with no ZIP has no dedicated field on this tool — if the city/state is unambiguous, resolve it to a real, representative central ZIP yourself and disclose the ZIP used, the same way you'd resolve "large SUV" into real model names. If the city or state is ambiguous (Portland, Springfield, Columbus, and similar), ask which one before searching rather than guessing. A named state with no ZIP searches that whole state — disclosed to the user as broader than a local search, never presented as if it were local. No location at all searches nationwide — same disclosure. Never silently narrow or widen scope without saying so.

AUTOMATIC WIDENING

If a search comes back too thin, the tool automatically retries with progressively wider constraints, protecting whatever priorityAxis says the user cares about most, and always discloses what changed — relay that disclosure rather than omitting it. Don't run your own retry on a thin result; the tool already does this correctly and safely.

EMPTY SEARCHES

If a search still returns nothing after automatic widening, a strict user constraint is never silently relaxed further to fix it. When the tool can genuinely self-correct (for example, an unrecognized model name gets checked against real inventory and corrected), that correction is always disclosed, never silent — treat it as a real fix, not a guess. If nothing can be self-corrected, say plainly that nothing matched, name the limiting constraint if it's clear, and suggest the smallest real adjustment (a higher budget, a wider radius, an additional model) rather than guessing at a workaround yourself.

PRESENTING RESULTS

If a visual result card was already rendered above this response (MCP Apps-capable hosts only), it already shows each result's photo, price, mileage, match score, and its own click-through link — don't restate those details in text. On hosts without a rendered card, or in addition to it, still follow everything below in full; the two links and count text remain required since not every host renders the card.

Two links belong on every result.

1. THE LISTING LINK. Include each result's own link by default. For virtually every result that is the Edmunds link (\`affiliateUrl\`). Never substitute a dealer's own site, Carfax, Autolist, or any other URL instead of it, even if another link looks cleaner or more direct. Exception: when \`affiliateUrl\` is null (Carvana-sourced listings only, never on Edmunds), use \`dealerListingUrl\` instead. Where format allows a label, "Check availability on Edmunds" is preferred — but showing the link matters more than the exact wording.

2. THE FALLBACK LINK. Include \`affiliateFallbackUrl\` alongside the listing link on every result. State it distinctly, e.g. "if that Edmunds listing is no longer available, see similar options here: [link]" — don't fold it into the listing link as if the two were the same thing.

For the top result, embed its \`primaryImage\` directly using markdown image syntax so it renders inline — the URL is already present in the result data, no separate tool call needed. Only do this if \`primaryImage\` is present; never substitute a placeholder or generic image.

MAPS

For local vehicle searches, when results include 3+ dealer locations, present the recommended results on an interactive map using any available map visualization tool — this applies whenever geographic/dealer location data is returned, using the dealer/location data already returned by the tool.`;

const FindMatchingVehicleInput = z.object({
  priceMax: z.number().optional().describe("Maximum price in USD. A hard ceiling — never send a value higher than what the user actually stated."),
  priceMin: z.number().optional().describe("Minimum price in USD."),
  priceFlexibility: z.enum(["strict", "flexible"]).optional().describe("Whether the price ceiling can flex. Set to 'flexible' only if the user signals approximation ('around', 'roughly', 'about') — otherwise omit; the ceiling stays strict by default."),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest"]).optional().describe("What the user is actually optimizing for. 'best_for_budget' (default) for 'best I can get' or 'nicest in my budget'. 'cheapest' for lowest price. 'lowest_mileage' for fewest miles (this defaults the search to used vehicles only — new/demo cars are excluded automatically, disclosed to the user). 'newest' for latest model year. Also protects that same dimension if the search needs automatic widening — see AUTOMATIC WIDENING."),
  yearMin: z.number().optional().describe("Minimum model year."),
  yearMax: z.number().optional().describe("Maximum model year."),
  make: z.string().optional().describe("Vehicle manufacturer, e.g. Toyota, Honda, Ford."),
  model: z.string().optional().describe("Real vehicle model name(s) ONLY — never include the manufacturer name here, even if make is also set or omitted. Correct: 'ES' not 'Lexus ES'; 'E-Class' not 'Mercedes-Benz E-Class'; '530i' not 'BMW 530i'. Auto.dev's model field never contains the make, so a combined string silently returns zero results, not an error. Comma-separate multiple models, e.g. 'RAV4,RAV4 Hybrid' or 'Suburban,Tahoe,Yukon' for a resolved size/style qualifier — this works fine across different manufacturers in one list too (e.g. '530i,E-Class,A6' for a cross-brand luxury sedan search), since model names are typically unique without needing the make attached. Any size, style, or use-case description the user gives ('large SUV', 'good for towing', 'sporty') has no dedicated field — resolve it into real model names here, using your own knowledge, before calling this tool."),
  bodyType: z.string().optional().describe("Broad body style only, e.g. SUV, Sedan, Truck, Minivan. Use vehicleType instead for a finer distinction like Crossover vs SUV or hatchback vs coupe."),
  mileageMax: z.number().optional().describe("Maximum odometer mileage."),
  zip: z.string().optional().describe("5-digit US ZIP code to search near. Required for a local search radius — a search without one covers the user's stated state (if given) or the whole country, and is disclosed as such."),
  radiusMiles: z.number().optional().describe("Search radius in miles from the ZIP. Defaults to 50 if omitted."),
  trimPreference: z.string().optional().describe("Preferred trim level, e.g. 'Limited' or 'Sport'. Ranking input only — never excludes a result with a different or unknown trim."),
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
  priorityAxis: "best_for_budget" | "cheapest" | "lowest_mileage" | "newest" | undefined,
  priceMax: number | undefined,
): string | undefined {
  switch (priorityAxis) {
    case "cheapest":
      return "price.asc";
    case "lowest_mileage":
      return "miles.asc";
    case "newest":
      return "year.desc";
    case "best_for_budget":
    default:
      return priceMax != null ? "price.desc" : "year.desc";
  }
}

const CANDIDATE_POOL_SIZE = 100; // Growth plan cap per docs; silently clamps to 20 on Starter

async function buildResultCard(
  listing: AutoDevListing,
  intent: ReturnType<typeof parseIntent>,
  intentInput: CardIntentInput,
  nhtsa?: NhtsaElectrificationResult | null,
) {
  const verification = crossCheckVin(listing); // now local/synchronous — no API call
  const { matchScore, matchScoreLabel, breakdown } = computeMatchScore(listing, intent, verification);
  const links = resolveLinks(listing, intent.hardConstraints.priceMax);

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

  // Photos must never block the search-results critical path (real evidence:
  // 868ms median Photos latency, SYS-20260812-014/021). Leave the gallery
  // empty here — it's populated only via the separate, lazy
  // get_vehicle_photos tool call.
  const photos: string[] = [];

  const badges: string[] = [];
  if (verification.hardConstraintStatus === "verified_match") badges.push("vin-verified");
  if (verification.hardConstraintStatus === "failed") badges.push("vin-conflicting");
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
  const ANOMALOUS_PRICE_FLOOR = 1000;
  if (listing.retailListing?.price != null && listing.retailListing.price < ANOMALOUS_PRICE_FLOOR) {
    badges.push("price-likely-inaccurate");
  }

  const cardShape = {
    canonicalVehicleId: listing.vin,
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
      inventoryType: rl?.used === false ? "new" : rl?.used === true ? "used" : "unknown",
      used: rl?.used ?? null,
      cpo: rl?.cpo ?? null,
      cpoEvidenceState: cpoSummary.state,
    },
    powertrain: {
      type: normalizedFuel,
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
      photoUrls: photos,
    },
    verification,
    ranking: { matchScore, matchScoreLabel, breakdown },
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

  return {
    ...cardShape,
    // Qualifier accounting (SYS-20260815 follow-up): dynamic, per-result
    // confirmation of only the fields the user actually asked about — keeps
    // the card lean while closing the "text summary only ever warns, never
    // confirms" gap found in the Aug 15 baseline.
    intentConfirmations: buildIntentConfirmations(intentInput, cardShape),
    dataConflicts: detectDataConflicts(listing),
  };
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
          _meta: {
            ui: {
              // Real fix, confirmed against OpenAI's own official docs
              // example (developers.openai.com/plugins/build/chatgpt-ui):
              // domain is a standard _meta.ui field set to the app's own
              // deployed origin, not an OpenAI-assigned value — this is
              // what the portal's "widget domain is not set" warning was
              // asking for.
              csp: { resourceDomains: ["https://carclever-find-my-car.vercel.app"] },
              prefersBorder: false,
            },
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
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      // Per SEP-1865: hosts that don't support MCP Apps ignore this field
      // and the tool behaves exactly as before (text/structuredContent
      // only) — this is additive, not a replacement path. Also set the
      _meta: {
        ui: { resourceUri: RESULTS_CARD_RESOURCE_URI },
      },
    },
    async (input) => {
      // Anchored before any upstream work so the widening budget accounts for
      // everything already spent (primary search, facet correction, retries).
      const requestStartedAt = Date.now();
      const intent = parseIntent(input);

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
      const rawResult = await searchListingsLean(baseQuery);
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
        const { bodyType: _droppedBodyType, vehicleType: _droppedVehicleType, ...withoutBodyStyle } = effectiveQuery;
        const retryResult = await searchListingsLean(withoutBodyStyle);

        if (retryResult.data.length > 0) {
          candidates = retryResult.data;
          total = retryResult.total;
          effectiveQuery = withoutBodyStyle;
          droppedBodyStyle = droppedStyle;
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
          rows.filter((c) => verifyAgainstConstraints(c, q).length === 0),
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

      const diversified = applyDiversity(bodyStyleFilteredCandidates, targetCount * 2);
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
      // Falls back to the already-verified lean row if the stage-2 refetch
      // itself now fails the check — same "never silently drop a real match"
      // preference as the existing getListingByVin-failure fallback above,
      // but only when the lean row itself still passes.
      // Uses effectiveQuery, not baseQuery: if the widening ladder ran, stage 1
      // verified against the widened constraints, so stage 2 must too — checking
      // against the original would reject exactly the rows widening just gained
      // and silently undo it (SYS-20260816-008).
      //
      // Factored into a helper (SYS-20260817-013) so the exact same
      // price-drift-aware refetch logic can run a second time on the spare
      // pool during backfill, instead of duplicating this block.
      function priceCheckedRefetch(refetchedRows: AutoDevListing[], leanRows: AutoDevListing[]) {
        let anyDrift = false;
        const checked = refetchedRows.map((full, i) => {
          const violations = verifyAgainstConstraints(full, effectiveQuery);
          if (violations.length === 0) return full;
          anyDrift = true;
          const lean = leanRows[i];
          return verifyAgainstConstraints(lean, effectiveQuery).length === 0 ? lean : full;
        });
        return { checked, anyDrift };
      }

      const { checked: shortlistWithPriceCheck, anyDrift: priceDriftFromPrimary } =
        priceCheckedRefetch(refetched, leanShortlist);
      let priceDriftDetected = priceDriftFromPrimary;

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
      const shortlist = await (async () => {
        if (!droppedBodyStyle) return shortlistWithPriceCheck;

        const primaryMatches = shortlistWithPriceCheck.filter((full) => {
          const matches = bodyStyleMatchFilter(full);
          if (!matches) bodyStyleDriftDetected = true;
          return matches;
        });

        const shortfall = targetCount - primaryMatches.length;
        if (shortfall <= 0 || spareLean.length === 0) {
          if (primaryMatches.length > 0) return primaryMatches;
          bodyStyleFallbackUsed = shortlistWithPriceCheck.length > 0;
          return shortlistWithPriceCheck;
        }

        // One bounded backfill round: fetch stage-2 detail for the spare
        // pool (already capped to targetCount by construction above), same
        // price-drift-aware refetch as the primary shortlist.
        const spareFullDetail = await Promise.all(
          spareLean.map((lean) => getListingByVin(lean.vin)),
        );
        const spareRefetched = spareLean.map((lean, i) => spareFullDetail[i] ?? lean);
        const { checked: spareChecked, anyDrift: spareDrift } = priceCheckedRefetch(
          spareRefetched,
          spareLean,
        );
        if (spareDrift) priceDriftDetected = true;

        const backfillMatches = spareChecked
          .filter((full) => {
            const matches = bodyStyleMatchFilter(full);
            if (!matches) bodyStyleDriftDetected = true; // spares excluded too — still worth disclosing
            return matches;
          })
          .slice(0, shortfall);

        const combined = [...primaryMatches, ...backfillMatches];
        if (combined.length > 0) return combined;

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
      };

      const cards = (
        await Promise.all(shortlist.map((listing) => buildResultCard(listing, intent, intentInput, nhtsaByVin.get(listing.vin))))
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
          "One or more listings had updated pricing or details at the time of the detailed lookup that no longer matched your stated filters (e.g. a live price change) — the original verified data was used instead where possible.",
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
      };

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
                // Carvana's VIN-specific Edmunds link is confirmed always dead
                // (SYS-20260817-001) — never constructed, so present the real
                // Carvana link as primary instead. Every other case keeps the
                // existing affiliateUrl-first behavior. Either way, the
                // category-level Edmunds fallback is appended whenever
                // available — it's the safety net for a dead/unpredictable
                // primary link, not conditional on one having failed.
                const primaryLinkStr = c.links.isCarvana && c.links.dealerListingUrl
                  ? `${c.links.dealerListingUrl} (view on Carvana)`
                  : c.links.affiliateUrl ?? c.links.dealerListingUrl ?? null;
                const fallbackLinkStr = c.links.affiliateFallbackUrl
                  ? ` · If that Edmunds listing is no longer available, see similar ${id.year ?? ""} ${id.make ?? ""} ${id.model ?? ""}`.replace(/\s+/g, " ") +
                    `: ${c.links.affiliateFallbackUrl}`
                  : "";
                const linkStr = (primaryLinkStr ?? c.links.affiliateFallbackUrl ?? "no link available") + (primaryLinkStr ? fallbackLinkStr : "");
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
        "Resolves a usable link for viewing or purchasing a specific vehicle, given its VIN, make, model, and year. Prefers the Edmunds pricing link; falls back to the dealer's own listing if usable (for Carvana-sourced vehicles, the real Carvana link is preferred instead — the VIN-specific Edmunds link is never available for Carvana inventory). The response also always includes affiliateFallbackUrl, a live Edmunds category-search link for the same make/model that never dead-ends, useful to offer alongside the primary link or if it turns out to be stale.",
      inputSchema: {
        vin: z.string().describe("The vehicle's 17-character VIN."),
        make: z.string().describe("Vehicle manufacturer, e.g. Toyota."),
        model: z.string().describe("Vehicle model name, e.g. Camry."),
        year: z.number().describe("Model year."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ vin, make, model, year }) => {
      // No retailListing data available in this call path (only VIN/make/
      // model/year are passed in), so Carvana detection here always
      // evaluates false — that's fine, it only affects which link is
      // preferred as primary, and affiliateFallbackUrl is unaffected either
      // way.
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

      const primary = links.isCarvana && links.dealerListingUrl
        ? links.dealerListingUrl
        : links.affiliateUrl ?? links.dealerListingUrl ?? links.affiliateFallbackUrl!;
      return {
        content: [{ type: "text" as const, text: primary }],
        structuredContent: links,
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
