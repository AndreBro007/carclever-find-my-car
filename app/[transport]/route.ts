import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { type AutoDevListing, type ListingsQuery } from "@/lib/auto-dev-client";
import { searchListings } from "@/lib/auto-dev-client";
// TEMP: loosening-ladder bypassed per André's request (Aug 13) — search itself
// needs to work correctly before any widening logic runs on top of it.
// import { searchWithLoosening } from "@/lib/loosening-ladder";
import { verifyAgainstConstraints } from "@/lib/post-verify";
import { parseIntent } from "@/lib/intent-parser";
import { applyDiversity } from "@/lib/diversity";
import { crossCheckVin } from "@/lib/vin-cross-check";
import { computeMatchScore } from "@/lib/match-score";
import { resolveLinks } from "@/lib/link-resolution";
import { getValidatedPhotos } from "@/lib/photos";
import { sanitizeDealerName } from "@/lib/dealer-name";
import { applyKnownHybridOverride, formatFuelTypeForDisplay } from "@/lib/fuel-type";
import { getCorpusCountForDescription, initCorpusCount } from "@/lib/corpus-count";
import { CAPABILITIES } from "@/lib/capabilities";

initCorpusCount();

// Description rules 2 and 4 below are adapted from the proven, live-tested
// tool-description language in AUTODEV_V2_NLP_SEARCH_REDESIGN.md §5.1
// (Sky redesign, approved July 26, 2026) — same architecture principle
// Find My Car already uses (calling LLM owns intent, server stays thin and
// deterministic), just with more explicit coaching for known data quirks.
const FIND_MATCHING_VEHICLE_DESCRIPTION = () => `Finds specific used vehicle listings that match a buyer's stated or implied criteria — price range, body type, make/model, mileage, year, or descriptive needs like 'reliable for a teen driver' or 'good for a family.' Searches across a live pool of ${getCorpusCountForDescription()} active US listings. Each result is cross-checked against its own VIN-decoded data before being shown, so matches carry a verified-identity signal, not just a keyword match. Results include full vehicle detail (trim, engine, transmission, drivetrain, title status) so follow-up questions about a specific result can be answered without a new search. Use this when a user is trying to decide on or locate an actual vehicle to buy, not for general questions about car types, comparisons of car categories, or how-to advice about buying a car. Returns a small set of closely matching, VIN-checked listings with current pricing, photos, and a link to view or purchase.

GENERAL PRINCIPLE — read this before decomposing any request: the structured fields on this tool (make, model, bodyType, drivetrain, fuel, seatsMinPreference, goals, price/year/mileage/zip) are what the underlying data can actually be filtered on. Any part of the user's request that does NOT map cleanly onto one of these fields — a size class ("large," "compact"), a use-case ("good for towing," "great in snow," "good for a road trip"), a style descriptor, a nickname, or any other real-world attribute the data doesn't encode directly — must be resolved BEFORE calling this tool, using your own knowledge, into concrete values in the fields that DO exist. In practice this almost always means turning the vague term into a comma-separated list of specific real model names in the model field, or into a value for drivetrain/fuel/seatsMinPreference. Do NOT rely on reviewing results after the search to catch a mismatch — results aren't sorted by anything beyond the literal filters, so the right vehicles may never even be fetched if the request wasn't resolved up front. If you're not confident which specific models or values fit, say so rather than guess, and fall back to the closest literal field (e.g. bodyType alone) with a caveat to the user about reduced precision.

Two worked examples of applying this principle (not an exhaustive list — the same reasoning applies to any request that doesn't map directly to a field):
- Hybrid and plug-in hybrid vehicles are often mistagged in the source data. If a specific model is named (e.g. "Sportage" or "RAV4"), set model to include both the base and hybrid/PHEV variant name (e.g. "RAV4,RAV4 Hybrid" or "RAV4,RAV4 Prime") rather than relying on the fuel filter alone. If no model is named, fuel-based hybrid/PHEV filtering has known partial coverage — mention that to the user.
- Size and style qualifiers ("large SUV," "compact SUV," "sports sedan," "off-road capable," etc.) have no dedicated field — bodyType alone returns every size undifferentiated. Resolve these into a model list before searching (e.g. for "large SUV": "Suburban,Tahoe,Expedition,Sequoia,Wagoneer,Grand Wagoneer,Yukon XL,Yukon,Armada,Land Cruiser").

Other rules: map descriptive intent to the dedicated fields (bodyType, seatsMinPreference, goals) rather than into free-text model/trim strings. Set priceFlexibility to "flexible" only if the user signals approximation ("around," "roughly," "about") — otherwise price stays a hard ceiling, never silently loosened. Prefer dedicated fields over model-list resolution when one exists: "AWD"/"4WD" → drivetrain; "manual" → transmission; a named color → exteriorColor. These are real, verified hard filters. Additional real filters: interiorColor (named interior color), vehicleType (finer than bodyType — use for distinctions like "crossover" vs "SUV" or "hatchback" vs "coupe" when the user is specific about this), doors, cylinders (engine cylinder count, e.g. "V8" → 8). "No accidents"/"one owner"/"CPO"/"certified pre-owned" → noAccidents/oneOwner/cpo: vehicle history and CPO status are frequently unreported or unconfirmed in the underlying data (roughly half of listings for history), so NONE of these are ever used to exclude results — a listing is never dropped just because this data is unknown, and CPO status specifically can never be disproven by the data (only confirmed when present). Instead, every result is checked against whatever data is actually available and honestly labeled: reported clean/certified, reported with issues, or unreported/unconfirmed. A Carfax link is included when available so the user can independently verify. If you asked for "no accidents," "one owner," or "CPO" and a result doesn't clearly confirm it, say so plainly rather than presenting it as if it matched cleanly.

Set priorityAxis based on what the user is actually optimizing for, not just which fields happen to be filled in — the same request text can imply different priorities even with identical filters. "Best SUV I can get under $60k," "nicest one in my budget," or any request with a price ceiling and no other stated priority → "best_for_budget" (default — this samples from the top of the stated budget down, which tends to surface newer years and better trims). "Cheapest," "lowest price," "budget option" → "cheapest". "Lowest mileage," "as few miles as possible" → "lowest_mileage". "Newest," "latest model year" → "newest". When in doubt, use "best_for_budget" — it matches this tool's purpose of finding the best match, not just any match.`;

const FindMatchingVehicleInput = z.object({
  priceMax: z.number().optional(),
  priceMin: z.number().optional(),
  priceFlexibility: z.enum(["strict", "flexible"]).optional(),
  priorityAxis: z.enum(["best_for_budget", "cheapest", "lowest_mileage", "newest"]).optional(),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  bodyType: z.string().optional(),
  mileageMax: z.number().optional(),
  zip: z.string().optional(),
  radiusMiles: z.number().optional(),
  trimPreference: z.string().optional(),
  seatsMinPreference: z.number().optional(),
  goals: z.array(z.string()).optional(),
  // Widened per design doc §2 — all live-verified filterable.
  drivetrain: z.string().optional(), // "AWD" | "4WD" | "FWD" | "RWD", comma-OR
  transmission: z.enum(["Automatic", "Manual"]).optional(),
  exteriorColor: z.string().optional(),
  interiorColor: z.string().optional(),
  vehicleType: z.string().optional(), // finer than bodyType: Crossover, SUV, Sedan, Wagon, Minivan, Performance-Sports, Hybrid, Hatchback, Coupe, Luxury, Electric
  doors: z.number().optional(),
  cylinders: z.number().optional(),
  used: z.boolean().optional(),
  cpo: z.boolean().optional(),
  state: z.string().optional(),
  noAccidents: z.boolean().optional(), // maps to history.accidentCount=0
  oneOwner: z.boolean().optional(), // maps to history.ownerCount=1
});

const SHORTLIST_SIZE = 5;

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

async function buildResultCard(listing: AutoDevListing, intent: ReturnType<typeof parseIntent>) {
  const verification = crossCheckVin(listing); // now local/synchronous — no API call
  const { matchScore, matchScoreLabel, breakdown } = computeMatchScore(listing, intent, verification);
  const links = resolveLinks(listing);

  // Suppress entirely if no usable outbound link — a result with zero
  // actionable CTAs isn't useful regardless of Match Score (SYS-20260812-023/024).
  if (links.linkStatus === "none-available") return null;

  const v = listing.vehicle;
  const rl = listing.retailListing;

  const normalizedFuel = applyKnownHybridOverride(v?.year, v?.make, v?.model, v?.fuel);
  const historySummary = buildHistorySummary(listing);
  const cpoSummary = buildCpoSummary(listing);

  // Photos must never block the search-results critical path (real evidence:
  // 868ms median Photos latency, SYS-20260812-014/021). Leave the gallery
  // empty here — it's populated only via the separate, lazy
  // get_vehicle_photos tool call.
  const photos: string[] = [];

  const badges: string[] = [];
  if (verification.hardConstraintStatus === "verified_match") badges.push("vin-verified");
  if (verification.hardConstraintStatus === "failed") badges.push("vin-conflicting");
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

  return {
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
      dealerListingUrl: links.dealerListingUrl,
      linkStatus: links.linkStatus,
    },
    detail: {
      carfaxUrl: CAPABILITIES.carfaxPassthrough ? rl?.carfaxUrl ?? null : null,
      cpoNote: cpoSummary.note,
      ownerHistoryNote: historySummary.ownerNote,
      interiorColor: v?.interiorColor ?? null,
      titleStatus: rl?.titleStatus ?? null,
      fuelTypeDisplay: formatFuelTypeForDisplay(normalizedFuel, v?.fuel),
    },
    badges,
  };
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    "find_matching_vehicle",
    {
      description: FIND_MATCHING_VEHICLE_DESCRIPTION(),
      inputSchema: FindMatchingVehicleInput.shape,
    },
    async (input) => {
      const intent = parseIntent(input);

      const baseQuery: ListingsQuery = {
        make: intent.hardConstraints.make,
        model: intent.hardConstraints.model,
        bodyType: intent.hardConstraints.bodyType,
        priceMin: intent.hardConstraints.priceMin,
        priceMax: intent.hardConstraints.priceMax,
        yearMin: intent.hardConstraints.yearMin,
        yearMax: intent.hardConstraints.yearMax,
        mileageMax: intent.hardConstraints.mileageMax,
        zip: intent.hardConstraints.location?.zip,
        radius: intent.hardConstraints.location?.radiusMiles,
        drivetrain: input.drivetrain,
        transmission: input.transmission,
        exteriorColor: input.exteriorColor,
        interiorColor: input.interiorColor,
        vehicleType: input.vehicleType,
        doors: input.doors,
        cylinders: input.cylinders,
        used: input.used,
        // cpo NOT sent as a filter — CPO-001 forbids treating cpo=false as
        // definitive. input.cpo still collected, used for disclosure below.
        state: input.state,
        // accidentCount/ownerCount NOT sent as query filters — history is null
        // in 53% of real listings, so hard-filtering would violate "unknown != false".
        sort: resolveSort(input.priorityAxis, intent.hardConstraints.priceMax),
        limit: CANDIDATE_POOL_SIZE,
      };

      const rawResult = await searchListings(baseQuery);
      const candidates = rawResult.data;
      const total = rawResult.total;
      const relaxations: Array<{ step: string; detail: string }> = [];
      const scopeNote: "local" | "nationwide" = "local" as "local" | "nationwide";

      // Post-verification (SYS-20260812-035, redesign doc §5.4 step 6):
      // Auto.dev can silently swallow/mishandle params and return rows that
      // don't actually satisfy a stated filter. Mechanical check only — no
      // semantic/size-class judgment, that stays the calling LLM's job.
      const verifiedCandidates = candidates.filter(
        (c) => verifyAgainstConstraints(c, baseQuery).length === 0,
      );
      const violationRate = candidates.length > 0
        ? (candidates.length - verifiedCandidates.length) / candidates.length
        : 0;

      const diversified = applyDiversity(verifiedCandidates, SHORTLIST_SIZE * 2);
      const shortlist = diversified.slice(0, SHORTLIST_SIZE);

      const cards = (
        await Promise.all(shortlist.map((listing) => buildResultCard(listing, intent)))
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      cards.sort((a, b) => b.ranking.matchScore - a.ranking.matchScore);

      const dataNotes: string[] = [];
      if (violationRate > 0.2) {
        dataNotes.push(
          "Some results from the underlying data source didn't fully match the stated filters and were excluded — this can happen with the provider's data.",
        );
      }
      if (rawResult.degraded) {
        dataNotes.push(rawResult.degraded);
      }
      if (scopeNote === "nationwide") {
        dataNotes.push("The requested location wasn't recognized, so this search was widened to nationwide.");
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

      const summary =
        serviceFailureMessage
          ? disclosurePrefix + serviceFailureMessage
          : cards.length === 0
          ? disclosurePrefix + "No vehicles matched these criteria. Widening the price range, location radius, or year range would likely surface options."
          : disclosurePrefix + `Found ${cards.length} closely matching vehicle${cards.length === 1 ? "" : "s"}${totalPhrase}:\n\n` +
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
                const linkStr = c.links.affiliateUrl ?? c.links.dealerListingUrl ?? "no link available";
                const historyLine = c.history.state === "known_issues" ? `\n   ⚠️ ${c.history.note}` : "";
                return `${i + 1}. ${id.year} ${id.make} ${id.model}${trimStr} — ${priceStr}, ${mileageStr}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}${historyLine}\n   Link: ${linkStr}`;
              })
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: response,
      };
    },
  );

  server.registerTool(
    "get_vehicle_photos",
    {
      description:
        "Fetches additional photos for a specific vehicle by VIN. Lazy/non-blocking — call this after showing initial search results, never before. Each photo is validated independently; a single broken image never affects the rest of the gallery or the vehicle's match quality.",
      inputSchema: { vin: z.string() },
    },
    async ({ vin }) => {
      const photos = await getValidatedPhotos(vin, 5);
      return {
        content: [
          {
            type: "text" as const,
            text: photos.length > 0 ? `Found ${photos.length} photos.` : "No valid photos found for this vehicle.",
          },
        ],
        structuredContent: { vin, photoUrls: photos },
      };
    },
  );

  server.registerTool(
    "resolve_dealer_url",
    {
      description:
        "Resolves a usable link for viewing or purchasing a specific vehicle, given its VIN, make, model, and year. Prefers the Edmunds pricing link; falls back to the dealer's own listing if usable.",
      inputSchema: {
        vin: z.string(),
        make: z.string(),
        model: z.string(),
        year: z.number(),
      },
    },
    async ({ vin, make, model, year }) => {
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

      const primary = links.affiliateUrl ?? links.dealerListingUrl!;
      return {
        content: [{ type: "text" as const, text: primary }],
        structuredContent: links,
      };
    },
  );

  // TEMP diagnostic - testing vehicle.squishVin as a VIN-batch alternative.
  server.registerTool(
    "diag_test_squishvin_batch",
    {
      description: "TEMP diagnostic - do not use for real searches.",
      inputSchema: { squishVins: z.string() },
    },
    async ({ squishVins }) => {
      const result = await searchListings({ squishVinFilter: squishVins, limit: 20 });
      return {
        content: [
          {
            type: "text" as const,
            text: `Requested squishVins: ${squishVins}\nReturned ${result.data.length} rows (total: ${result.total})\nReturned VIN/squishVin pairs: ${result.data.map((r) => `${r.vin}(${r.vehicle?.squishVin})`).join(", ")}\nError: ${result.error ?? "none"}`,
          },
        ],
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
