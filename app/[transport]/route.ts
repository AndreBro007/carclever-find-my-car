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

Other rules: map descriptive intent to the dedicated fields (bodyType, seatsMinPreference, goals) rather than into free-text model/trim strings. Set priceFlexibility to "flexible" only if the user signals approximation ("around," "roughly," "about") — otherwise price stays a hard ceiling, never silently loosened. Prefer dedicated fields over model-list resolution when one exists: "AWD"/"4WD" → drivetrain; "manual" → transmission; a named color → exteriorColor; "certified pre-owned"/"CPO" → cpo. These are real, verified hard filters. "No accidents"/"one owner" → noAccidents/oneOwner: these influence ranking and are reported per result, but are NOT hard filters — vehicle history is frequently unreported in the underlying data, and a missing history record is never treated as a red flag.`;

const FindMatchingVehicleInput = z.object({
  priceMax: z.number().optional(),
  priceMin: z.number().optional(),
  priceFlexibility: z.enum(["strict", "flexible"]).optional(),
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
  used: z.boolean().optional(),
  cpo: z.boolean().optional(),
  state: z.string().optional(),
  noAccidents: z.boolean().optional(), // maps to history.accidentCount=0
  oneOwner: z.boolean().optional(), // maps to history.ownerCount=1
});

const SHORTLIST_SIZE = 5;
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

  // Photos must never block the search-results critical path (real evidence:
  // 868ms median Photos latency, SYS-20260812-014/021). Leave the gallery
  // empty here — it's populated only via the separate, lazy
  // get_vehicle_photos tool call.
  const photos: string[] = [];

  const badges: string[] = [];
  if (verification.hardConstraintStatus === "verified_match") badges.push("vin-verified");
  if (verification.hardConstraintStatus === "failed") badges.push("vin-conflicting");
  if (intent.semantic.goals.length > 0) badges.push("inferred-match");
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
    },
    condition: {
      inventoryType: rl?.used === false ? "new" : "used",
      used: rl?.used ?? null,
      cpo: rl?.cpo ?? null,
      cpoEvidenceState: rl?.cpo == null ? "unknown" : "provider_reported",
    },
    powertrain: {
      type: normalizedFuel,
      engine: v?.engine ?? null,
      drivetrain: v?.drivetrain ?? null,
      transmission: v?.transmission ?? null,
    },
    body: {
      bodyStyle: v?.bodyStyle ?? null,
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
    history: {
      state: "unknown",
    },
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
        used: input.used,
        cpo: input.cpo,
        state: input.state,
        // accidentCount/ownerCount NOT sent as query filters — history is null
        // in 53% of real listings, so hard-filtering would violate "unknown != false".
        //
        // sort: left at Auto.dev's documented default (updatedAt.desc). price.asc
        // is a valid, documented, indexed sort — it was never a performance
        // problem — but as a *sampling* strategy it biases the pool toward the
        // cheapest listings, which for used cars means oldest/highest-mileage and
        // data errors (real evidence: an $85 2024 CR-V ranked top). With limit at
        // the plan cap and our own Match Score ranking the shortlist, the sample
        // no longer needs a price bias. OPEN QUESTION flagged for André.
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
                return `${i + 1}. ${id.year} ${id.make} ${id.model}${trimStr} — ${priceStr}, ${mileageStr}${dealerStr}\n   ${r.matchScoreLabel} (${r.matchScore}%)${c.badges.includes("vin-verified") ? " · VIN-verified" : ""}\n   Link: ${linkStr}`;
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
});

export { handler as GET, handler as POST, handler as DELETE };
