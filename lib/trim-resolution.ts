/**
 * Resolve a required trim against the trim names the database really holds (SYS-20261021-004, R1 and R8).
 *
 * The database is not searched by trim text. Instead the route lists the trim names that exist for the asked make and model (any price, nationwide),
 * this module picks the ones that satisfy the request, and the search then asks the database for exactly those strings. The matching rules stay in one
 * place (lib/trim-match.ts) and a rare trim can no longer fall outside the candidate rows for a popular model.
 *
 *   exact  one or more real trims match under the exact rule (R1, R2, R3): the normal case.
 *   close  no trim matches exactly but some contain every requested word (R8): shown only as a labelled "close trim match".
 *   none   neither: the search runs as before and the no-match reply lists the database's trims.
 */
import { trimMatchesAny, trimContainsAllAny, type TrimMatchOptions } from "./trim-match";

export interface TrimResolution {
  tier: "exact" | "close" | "none";
  trims: string[];
}

export function resolveRequiredTrims(required: string | undefined | null, available: Array<{ value: string }>, opts: TrimMatchOptions = {}): TrimResolution {
  const wanted = String(required ?? "").trim();
  if (!wanted) return { tier: "none", trims: [] };
  const names = [...new Set(available.map((a) => String(a.value ?? "")).filter((v) => v !== ""))];
  const exact = names.filter((n) => trimMatchesAny(wanted, n, opts));
  if (exact.length) return { tier: "exact", trims: exact };
  const close = names.filter((n) => trimContainsAllAny(wanted, n, opts));
  if (close.length) return { tier: "close", trims: close };
  return { tier: "none", trims: [] };
}
