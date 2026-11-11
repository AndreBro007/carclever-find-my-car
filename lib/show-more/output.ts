/** R4-6 step 4b: the NEW tool's own published output (design section 6, point 5): the search's results and meta, plus a continuation object. A new tool cannot clash with a cached schema of the old ones. */
import { z } from "zod";
import { CatalogDbOutputSchema } from "../find-matching-vehicle-output";

export const ShowMoreContinuationSchema = z.object({
  reference: z.string(),
  shown: z.number(),
  added: z.number(),
  /** Cars added by THIS call (0 when the same total is asked again). `added` counts since the first reply. */
  addedNow: z.number(),
  leftOut: z.object({ contradicted_filter: z.number(), outside_radius: z.number(), removed: z.number(), limit_break: z.number() }),
  leftOutTotal: z.number(),
  pending: z.number(),
  couldNotCheck: z.number(),
  canAdd: z.number(),
  cap: z.number(),
  state: z.enum(["more_available", "pending_retry", "only_could_not_check", "none_left"]),
});
export const ShowMoreOutputSchema = CatalogDbOutputSchema.extend({ continuation: ShowMoreContinuationSchema.nullable() });
export type ShowMoreOutput = z.infer<typeof ShowMoreOutputSchema>;

export const SHOW_MORE_DESCRIPTION = "Shows more cars from a search you already ran. Use the reference printed under that search's results and the total number of cars to show, up to 16; the cars already shown keep their numbers and new ones are added after them. Only for a search that printed a reference: never make one up. If the list has expired or the reference is unknown, run a new search.";
