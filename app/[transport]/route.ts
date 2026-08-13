import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { searchListings, type AutoDevListing } from "@/lib/auto-dev-client";
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

const FIND_MATCHING_VEHICLE_DESCRIPTION = () => `Finds specific used vehicle listings that match a buyer's stated or implied criteria — price range, body type, make/model, mileage, year, or descriptive needs like 'reliable for a teen driver' or 'good for a family.' Searches across a live pool of ${getCorpusCountForDescription()} active US listings. Each result is cross-checked against its own VIN-decoded data before being shown, so matches carry a verified-identity signal, not just a keyword match. Results include full vehicle detail (trim, engine, transmission, drivetrain, title status) so follow-up questions about a specific result can be answered without a new search. Use this when a user is trying to decide on or locate an actual vehicle to buy, not for general questions about car types, comparisons of car categories, or how-to advice about buying a car. Returns a small set of closely matching, VIN-checked listings with current pricing, photos, and a link to view or purchase.`;

const FindMatchingVehicleInput = z.object({
  priceMax: z.number().optional(),
  priceMin: z.number().optional(),
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
});

const SHORTLIST_SIZE = 5;
const CANDIDATE_POOL_SIZE = 50;

async function buildResultCard(listing: AutoDevListing, intent: ReturnType<typeof parseIntent>) {
  const verification = await crossCheckVin(listing);
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

      const { data: candidates, total } = await searchListings({
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
        limit: CANDIDATE_POOL_SIZE,
      });

      const diversified = applyDiversity(candidates, SHORTLIST_SIZE * 2);
      const shortlist = diversified.slice(0, SHORTLIST_SIZE);

      const cards = (
        await Promise.all(shortlist.map((listing) => buildResultCard(listing, intent)))
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      cards.sort((a, b) => b.ranking.matchScore - a.ranking.matchScore);

      const response = {
        meta: {
          totalCandidatesConsidered: candidates.length,
          totalMatches: typeof total === "number" ? total : null,
          corpusSizeApprox: getCorpusCountForDescription(),
          relaxations: [] as Array<{ field: string; requested: unknown; actual: unknown; reason: string }>,
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
      const summary =
        cards.length === 0
          ? "No results matched closely enough to show. Consider relaxing price, location, or year constraints."
          : `Found ${cards.length} closely matching vehicle${cards.length === 1 ? "" : "s"}${totalPhrase}:\n\n` +
            cards
              .map((c, i) => {
                const id = c.identity;
                const l = c.listing;
                const r = c.ranking;
                const trimStr = id.trim ? ` ${id.trim}` : "";
                const priceStr = l.price != null ? `$${l.price.toLocaleString()}` : "price unavailable";
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
