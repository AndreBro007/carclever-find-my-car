import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { buildEdmundsUrl, wrapWithCJ } from "@/lib/edmunds-cj";
import { sanitizeDealerName } from "@/lib/dealer-name";
import { applyKnownHybridOverride, formatFuelTypeForDisplay } from "@/lib/fuel-type";
import { getCorpusCountForDescription, initCorpusCount } from "@/lib/corpus-count";
import { CAPABILITIES } from "@/lib/capabilities";

initCorpusCount();

// Tool description locked per DECISIONS.md SYS-20260812-009.
// Corpus figure is intentionally approximate (SYS-20260812-007) — see
// lib/corpus-count.ts for the pending 3.6M/4.4M discrepancy to resolve.
const FIND_MATCHING_VEHICLE_DESCRIPTION = () => `Finds specific used vehicle listings that match a buyer's stated or implied criteria — price range, body type, make/model, mileage, year, or descriptive needs like 'reliable for a teen driver' or 'good for a family.' Searches across a live pool of ${getCorpusCountForDescription()} active US listings. Each result is cross-checked against its own VIN-decoded data before being shown, so matches carry a verified-identity signal, not just a keyword match. Results include full vehicle detail (trim, engine, transmission, drivetrain, title status) so follow-up questions about a specific result can be answered without a new search. Use this when a user is trying to decide on or locate an actual vehicle to buy, not for general questions about car types, comparisons of car categories, or how-to advice about buying a car. Returns a small set of closely matching, VIN-checked listings with current pricing, photos, and a link to view or purchase.`;

// Hard constraints per search_intent.schema.json (Step 2 contract).
// trim is deliberately absent from filter params — Trust Class B,
// hard_filter_allowed: false — it's a ranking input only (see §8 of
// FindMyCar_Response_Schema_v0.1.md, SYS-20260812-025).
// seats is likewise absent from filter params for the same reason
// (provider_filter_allowed: false) — parsed as intent, verified post-search.
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
  // Soft/semantic — parsed from natural language, not sent as raw Auto.dev filters:
  trimPreference: z.string().optional(),
  seatsMinPreference: z.number().optional(),
  goals: z.array(z.string()).optional(), // e.g. "family", "reliability", "commuting"
});

const handler = createMcpHandler((server) => {
  server.tool(
    "find_matching_vehicle",
    FIND_MATCHING_VEHICLE_DESCRIPTION(),
    FindMatchingVehicleInput.shape,
    async (input) => {
      // TODO: implement — this is a scaffold stub, not the real search.
      // Pipeline per build sequence step 4 (DECISIONS.md SYS-20260812-026):
      //   1. Call Auto.dev /listings with hard constraints only (no trim/seats)
      //   2. Diversity pass, unconditional (SYS-20260812-002)
      //   3. VIN cross-check the shortlist (3-5 results) against /vin/{vin}
      //   4. Assemble response per canonical_vehicle.schema.json field names
      //      (identity/listing/powertrain/condition/verification/media/ranking)
      //   5. Apply link-fallback/suppression (Edmunds primary, dealer secondary,
      //      suppress result if neither usable) — SYS-20260812-024
      //   6. Apply relaxation transparency to meta.relaxations + penalize
      //      matchScoreBreakdown.statedCriteriaFit accordingly (formula TBD,
      //      deliberately deferred — SYS-20260812-013)
      return {
        content: [
          {
            type: "text" as const,
            text: "find_matching_vehicle is scaffolded but not yet implemented.",
          },
        ],
      };
    },
  );

  server.tool(
    "get_vehicle_photos",
    "Fetches additional photos for a specific vehicle by VIN. Lazy/non-blocking — call this after showing initial search results, never before. Each photo is validated independently; a single broken image never affects the rest of the gallery or the vehicle's match quality.",
    { vin: z.string() },
    async ({ vin }) => {
      // TODO: implement — per-photo fallback logic (SYS-20260812-014):
      // skip broken/403/non-image assets silently, never invalidate the result.
      return {
        content: [{ type: "text" as const, text: `Photos lookup for ${vin} not yet implemented.` }],
      };
    },
  );

  server.tool(
    "resolve_dealer_url",
    "Resolves a usable link for viewing or purchasing a specific vehicle, given its VIN, make, model, and year. Prefers the Edmunds pricing link; falls back to the dealer's own listing if usable.",
    {
      vin: z.string(),
      make: z.string(),
      model: z.string(),
      year: z.number(),
    },
    async ({ vin, make, model, year }) => {
      const edmundsUrl = buildEdmundsUrl({ vin, make, model, year });
      const affiliateUrl = edmundsUrl ? wrapWithCJ(edmundsUrl) : null;

      // TODO: attempt the dealer's own retailListing.vdp as a secondary link;
      // drop it silently if obviously broken (right-sized per SYS-20260812-024,
      // not a full URL-001 classification subsystem).

      if (!affiliateUrl) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No usable link could be built for this vehicle (missing VIN/make/model/year).",
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: affiliateUrl }],
        structuredContent: { url: affiliateUrl, linkStatus: "edmunds-only" },
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
