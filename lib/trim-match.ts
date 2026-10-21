/**
 * Trim/variant matcher for `trimRequired` (SYS-20260823 — explicit trim
 * requests were being treated as soft ranking preferences, e.g. "Mercedes
 * AMG GLA 35" returning GLA 250s as "Strong match"). Deliberately NOT used
 * to build a provider query filter — `vehicle.trim` is not trusted as a
 * hard provider filter param anywhere in this codebase, and this module
 * doesn't change that; it's a local, post-fetch matcher only.
 *
 * Normalized, directional, token-subset matching:
 * - Case, punctuation, and trademark symbols (®, ™, ©) are stripped before
 *   comparing, so "AMG® GLA 35" and "amg gla-35" compare equal.
 * - A letter/digit boundary gets a space inserted ("GLA35" -> "GLA 35") so
 *   minor formatting differences between what a host model sends and what
 *   the provider reports don't cause a false non-match.
 * - Directional: every token in the REQUESTED trim must appear in the
 *   ACTUAL (reported) trim's tokens. This means a less-specific actual
 *   trim ("AMG" alone) never satisfies a more-specific request ("AMG GLA
 *   35") — it's missing the "gla" and "35" tokens — while a more-specific
 *   actual trim can still satisfy a less-specific request.
 */

import { stripElectrificationWords } from "./electrified-models";

function normalize(s: string): string {
  return s
    .replace(/[®™©]/g, "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const normalized = normalize(s);
  return normalized.length > 0 ? normalized.split(/\s+/) : [];
}

/**
 * Words that are not trim words. They are removed from BOTH sides before comparing (SYS-20261021-004, R2 and R3).
 *
 * Drivetrain words (always): AWD, 4WD, 2WD, FWD, RWD, 4x4, and the brand names for all-wheel drive that the catalogue feed puts
 * inside trims: 4MATIC (and 4MATIC+), xDrive (also fused with digits, "xDrive40i"), quattro, SH-AWD. Evidence: getcarwise-docs
 * EVIDENCE_CATALOGUE_MODEL_TRIM_NAMING_20261021.md (for example "GLC 300 4MATIC" 6,017 cars, "xDrive40i" 5,711, "SH-AWD" 1,299).
 * Drivetrain itself is judged separately (lib/drivetrain-filter.ts), so a trim request never has to carry it.
 *
 * Electrification words (only when the buyer requested an electrified type): Hybrid, Plug-In, PHEV, Prime, Electric, EV. The feed
 * puts them in the model name for some cars ("RAV4 Hybrid") and in the trim for others ("Sport-L Hybrid", "Hybrid SEL"), so a
 * request for "Sport-L" with a hybrid wanted must match "Sport-L Hybrid". Without an electrified request the words stay
 * significant: "Sport" must not match "Sport Hybrid".
 */
export interface TrimMatchOptions {
  /** True when the buyer asked for hybrid, plug-in hybrid or electric (required or preferred). */
  electrified?: boolean;
}

function stripDrivetrain(s: string): string {
  return s
    .replace(/\b4\s*x\s*4\b/gi, " ")
    .replace(/\b[24]\s*wd\b/gi, " ")
    .replace(/\bsh[\s-]*awd\b/gi, " ")
    .replace(/\b(awd|fwd|rwd)\b/gi, " ")
    .replace(/\b4matic\+?/gi, " ")
    .replace(/\bxdrive(?=\d|\b)/gi, " ")
    .replace(/\bquattro\b/gi, " ");
}

function requestTokens(requested: string, opts: TrimMatchOptions): string[] {
  const d = stripDrivetrain(requested);
  return tokens(opts.electrified ? stripElectrificationWords(d) : d);
}

function actualTokens(actualStr: string, opts: TrimMatchOptions): Set<string> {
  const d = stripDrivetrain(actualStr);
  return new Set(tokens(opts.electrified ? stripElectrificationWords(d) : d));
}

/** A request made only of electrification words ("Hybrid") names no trim: with an electrified request any listed trim satisfies it. */
function onlyElectrificationWords(requested: string, opts: TrimMatchOptions): boolean {
  return !!opts.electrified && tokens(stripDrivetrain(requested)).length > 0 && requestTokens(requested, opts).length === 0;
}

/**
 * True when every token of `requested` is present among the tokens of
 * `actual`. Returns false for an empty/missing `actual` (an unknown trim
 * can never be a CONFIRMED match — callers decide separately whether an
 * unknown trim should be treated as provisional-pass or hard-fail
 * depending on which stage they're at).
 *
 * Runtime-safety fix (fix/provider-string-runtime-safety, SYS-20260828):
 * `actual` accepts `unknown`, not `string | null | undefined` — every
 * call site here passes a raw VehicleListing vehicle.trim value straight
 * through (route.ts:532/1256/1261, lib/constraint-evidence.ts:245), and a
 * live production crash confirmed vehicle.trim can genuinely be a NUMBER
 * at runtime (observed: 1958) despite the client's own declared
 * `trim?: string` type — the same failure class already fixed for model
 * matching in lib/model-match.ts. The old `if (!actual) return false`
 * guard only caught falsy values (null/undefined/""); a truthy non-string
 * like 1958 sailed straight through into normalize()'s unguarded
 * `.replace()` calls and crashed exactly like the unrelated
 * configurationKey() bug this same session fixed. String()-coercing here
 * means a malformed trim becomes its own literal string ("1958") rather
 * than crashing OR silently vanishing — and per the directional
 * token-subset matching above, that literal string can only ever satisfy
 * a requested trim that ALSO contains "1958" as a token, which is
 * vanishingly unlikely for a real trim name — so a malformed value still
 * correctly fails to satisfy trimRequired in practice, it just does so
 * without throwing.
 */
export function trimMatches(requested: string, actual: unknown, opts: TrimMatchOptions = {}): boolean {
  // 'Sport Touring Hybrid AWD' matches the same cars as 'Sport Touring Hybrid'; 'EX' does not match 'EX-L'.
  const reqTokens = requestTokens(requested, opts);
  const actualStr = actual == null ? "" : String(actual);
  if (reqTokens.length === 0) return onlyElectrificationWords(requested, opts) && actualStr !== "";
  if (!actualStr) return false;
  const actTokens = actualTokens(actualStr, opts);
  const reqSet = new Set(reqTokens);
  const extra = [...actTokens].filter((t) => !reqSet.has(t));
  return reqTokens.every((t) => actTokens.has(t)) && extra.length === 0;
}

/** A required trim may name several acceptable trims, comma-separated (for example "AMG GLA 35, AMG GLA 45"); any one may match. */
export function trimMatchesAny(required: string | undefined | null, actual: string | undefined | null, opts: TrimMatchOptions = {}): boolean {
  const parts = String(required ?? "").split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  return parts.some((p) => trimMatches(p, actual, opts));
}

/**
 * Second tier (SYS-20261021-004, R8): the "close trim match". Every requested word must appear in the reported trim, extra words
 * allowed ("Premium Plus" is close to "2.0T Premium Plus"). Used ONLY when no listing matches exactly, and always labelled as a close
 * match. Known risk, accepted: "EX" is close to "EX-L" when no plain EX exists.
 */
export function trimContainsAll(requested: string, actual: unknown, opts: TrimMatchOptions = {}): boolean {
  const reqTokens = requestTokens(requested, opts);
  const actualStr = actual == null ? "" : String(actual);
  if (reqTokens.length === 0) return onlyElectrificationWords(requested, opts) && actualStr !== "";
  if (!actualStr) return false;
  const actTokens = actualTokens(actualStr, opts);
  return reqTokens.every((t) => actTokens.has(t));
}

export function trimContainsAllAny(required: string | undefined | null, actual: string | undefined | null, opts: TrimMatchOptions = {}): boolean {
  const parts = String(required ?? "").split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  return parts.some((p) => trimContainsAll(p, actual, opts));
}
