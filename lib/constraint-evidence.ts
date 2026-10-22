/**
 * Constraint evidence (SYS-20260825) — additive, observational only.
 *
 * Purpose: report, per result, whether each constraint the user actually
 * stated is confirmed true, confirmed false, unconfirmable from available
 * data, or was explicitly relaxed by the search itself — as truthful,
 * structured evidence alongside the existing text/card output.
 *
 * Explicitly NOT a search-decision component:
 * - Does not call, wrap, or replace verifyAgainstConstraints() (the real
 *   eligibility gate in lib/post-verify.ts).
 * - Never influences which candidates are fetched, kept, excluded,
 *   ranked, sorted, or how many results are returned.
 * - Operates purely on the already-resolved final listing record (the
 *   same one the card itself is built from) — it observes, it doesn't
 *   decide.
 *
 * Reuses the existing directional model matcher (lib/model-match.ts) and
 * trim matcher (lib/trim-match.ts) so this evidence reflects the exact
 * same matching semantics already used for real eligibility decisions
 * elsewhere, rather than a second, possibly-inconsistent definition.
 */
import { modelSatisfiesRequested } from "./model-match";
import { bodyClassesFor } from "./catalog-db/normalize";
import { trimMatchesAny } from "./trim-match";
import { wantedDriveClasses, judgeDrive } from "./drivetrain-filter";
import { electrificationStateSatisfies } from "./nhtsa-client";

export type ConstraintStatus = "verified" | "mismatch" | "unknown" | "relaxed";

export interface ConstraintCheck {
  field: string;
  status: ConstraintStatus;
  requested: unknown;
  actual: unknown;
}

export type SearchConstraintStatus = "verified" | "partial" | "relaxed" | "mismatch" | "not_applicable";

/**
 * Only the fields the user actually stated should be passed here — a field
 * left undefined is simply not checked (never reported as any status).
 */
export interface ConstraintEvidenceRequest {
  make?: string;
  model?: string;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  mileageMax?: number;
  bodyType?: string;
  drivetrain?: string;
  transmission?: string;
  exteriorColor?: string;
  interiorColor?: string;
  vehicleType?: string;
  doors?: number;
  cylinders?: number;
  used?: boolean;
  state?: string;
  trimRequired?: string;
  /** True when the buyer asked for an electrified type (required or preferred): electrification words are then neutral in the trim check (SYS-20261021-004, R3). */
  electrified?: boolean;
  /** The electrified types the buyer REQUIRED (hybrid, plug_in_hybrid, electric); set only for a required request. Each result then carries an `electrification` check (T52). */
  electrificationTypes?: string[];
}

/**
 * The already-resolved final listing's own reported values — same source
 * of truth the card and verifyAgainstConstraints() itself use, just read
 * here rather than re-fetched or re-decided.
 */
export interface ResolvedListingForEvidence {
  make?: string | null;
  model?: string | null;
  price?: number | null;
  year?: number | null;
  mileage?: number | null;
  bodyStyle?: string | null;
  vehicleType?: string | null;
  drivetrain?: string | null;
  transmission?: string | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  doors?: number | null;
  cylinders?: number | null;
  used?: boolean | null;
  state?: string | null;
  trim?: string | null;
  /** NHTSA's electrification state for this car (lib/nhtsa-client.ts), or null when the decode gave no usable answer. */
  electrificationState?: string | null;
}

/**
 * Runtime-safety fix (fix/provider-string-runtime-safety, SYS-20260828):
 * accepts `unknown`, not `string` — several call sites here pass raw
 * provider-derived values (actual.bodyStyle, actual.vehicleType,
 * actual.state) straight through, and a live production crash confirmed
 * the provider can return a non-string value for a sibling field
 * (vehicle.trim, observed as the number 1958) despite its declared
 * string type in the client contract — the guards at each call site
 * (`actual.bodyStyle ?`) only protect against falsy values, not against
 * a present-but-wrong-type value, so this shared function is the correct
 * single place to make the whole comparison path crash-proof rather than
 * patching each call site individually. String()-coercing a malformed
 * value here can only ever produce a literal string unlikely to
 * accidentally equal a real comparison target — never invents a match,
 * just avoids throwing.
 */
export function normalizeCompareString(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/** Comma-OR-list-tolerant, case-insensitive equality — same tolerance the
 * existing structured filters (drivetrain, etc.) already document as
 * supporting a comma-separated list of acceptable values. */
function anyListValueMatches(requestedList: string, actual: string): boolean {
  const a = normalizeCompareString(actual);
  return requestedList
    .split(",")
    .map((s) => normalizeCompareString(s))
    .some((opt) => opt === a);
}

/** Case-insensitive substring tolerance for freeform color-style fields
 * (e.g. requested "Blue" should verify against an actual "Deep Blue
 * Pearl"). Directional: requested text must appear within the actual
 * text, or vice versa for an unusually terse actual value. */
function colorLikeMatches(requested: string, actual: string): boolean {
  const r = normalizeCompareString(requested);
  const a = normalizeCompareString(actual);
  return a.includes(r) || r.includes(a);
}

function checkStringField(
  field: string,
  requested: string | undefined,
  actual: string | null | undefined,
  relaxed: boolean,
  matches: (requested: string, actual: string) => boolean,
): ConstraintCheck | null {
  if (requested == null || requested === "") return null;
  if (relaxed) return { field, status: "relaxed", requested, actual: actual ?? null };
  if (actual == null || actual === "") return { field, status: "unknown", requested, actual: null };
  return { field, status: matches(requested, actual) ? "verified" : "mismatch", requested, actual };
}

function checkNumericThreshold(
  field: string,
  requested: number | undefined,
  actual: number | null | undefined,
  relaxed: boolean,
  compare: (requested: number, actual: number) => boolean,
): ConstraintCheck | null {
  if (requested == null) return null;
  if (relaxed) return { field, status: "relaxed", requested, actual: actual ?? null };
  if (actual == null) return { field, status: "unknown", requested, actual: null };
  return { field, status: compare(requested, actual) ? "verified" : "mismatch", requested, actual };
}

function checkExactValue<T>(
  field: string,
  requested: T | undefined,
  actual: T | null | undefined,
  relaxed: boolean,
): ConstraintCheck | null {
  if (requested == null) return null;
  if (relaxed) return { field, status: "relaxed", requested, actual: actual ?? null };
  if (actual == null) return { field, status: "unknown", requested, actual: null };
  return { field, status: requested === actual ? "verified" : "mismatch", requested, actual };
}

/**
 * Builds per-result constraint evidence for only the fields the user
 * actually requested. `relaxedFields` is supplied by the caller (route.ts)
 * from its own already-known, explicit relaxation state (the widening
 * ladder's relaxations array and/or droppedBodyStyle) — this module never
 * infers relaxation on its own.
 */
export function buildConstraintChecks(
  requested: ConstraintEvidenceRequest,
  actual: ResolvedListingForEvidence,
  relaxedFields: ReadonlySet<string>,
): ConstraintCheck[] {
  const checks: ConstraintCheck[] = [];
  const push = (c: ConstraintCheck | null) => {
    if (c) checks.push(c);
  };

  push(checkStringField("make", requested.make, actual.make, relaxedFields.has("make"), anyListValueMatches));

  // Model: directional — actual may be more specific than requested, never
  // less specific — same matcher used for real eligibility elsewhere.
  if (requested.model != null && requested.model !== "") {
    if (relaxedFields.has("model")) {
      checks.push({ field: "model", status: "relaxed", requested: requested.model, actual: actual.model ?? null });
    } else if (actual.model == null || actual.model === "") {
      checks.push({ field: "model", status: "unknown", requested: requested.model, actual: null });
    } else {
      checks.push({
        field: "model",
        status: modelSatisfiesRequested(requested.model, actual.model) ? "verified" : "mismatch",
        requested: requested.model,
        actual: actual.model,
      });
    }
  }

  push(
    checkNumericThreshold("priceMin", requested.priceMin, actual.price, relaxedFields.has("priceMin") || relaxedFields.has("price"), (req, act) => act >= req),
  );
  push(
    checkNumericThreshold("priceMax", requested.priceMax, actual.price, relaxedFields.has("priceMax") || relaxedFields.has("price"), (req, act) => act <= req),
  );
  push(
    checkNumericThreshold("yearMin", requested.yearMin, actual.year, relaxedFields.has("yearMin") || relaxedFields.has("year"), (req, act) => act >= req),
  );
  push(
    checkNumericThreshold("yearMax", requested.yearMax, actual.year, relaxedFields.has("yearMax") || relaxedFields.has("year"), (req, act) => act <= req),
  );
  push(
    checkNumericThreshold("mileageMax", requested.mileageMax, actual.mileage, relaxedFields.has("mileageMax") || relaxedFields.has("mileage"), (req, act) => act <= req),
  );

  // bodyType: verified if either the reported bodyStyle or the finer
  // vehicleType field agrees — mirrors the same two-field tolerance the
  // real body-style exclude filter (route.ts bodyStyleMatchFilter) uses.
  if (requested.bodyType != null && requested.bodyType !== "") {
    if (relaxedFields.has("bodyType")) {
      checks.push({ field: "bodyType", status: "relaxed", requested: requested.bodyType, actual: actual.bodyStyle ?? actual.vehicleType ?? null });
    } else {
      const target = normalizeCompareString(requested.bodyType);
      const style = actual.bodyStyle ? normalizeCompareString(actual.bodyStyle) : null;
      const type = actual.vehicleType ? normalizeCompareString(actual.vehicleType) : null;
      if (style == null && type == null) {
        checks.push({ field: "bodyType", status: "unknown", requested: requested.bodyType, actual: null });
      } else {
        // The search maps the requested body type to the database's body classes (bodyClassesFor: "Truck" is the class the cards label "Pickup", "Crossover" is "SUV"), so the check
        // must compare classes too: string equality alone reported "mismatch" on every truck of a Truck search (review F6, 22 Oct 2026). Equality is kept as the fallback.
        const wantedClasses = bodyClassesFor(requested.bodyType);
        const classOf = (label: string | null | undefined): string | null => (label ? bodyClassesFor(label)?.[0] ?? null : null);
        const classMatch = !!wantedClasses && [actual.bodyStyle, actual.vehicleType].some((l) => { const c = classOf(l); return c != null && wantedClasses.includes(c as never); });
        const ok = classMatch || style === target || type === target;
        checks.push({
          field: "bodyType",
          status: ok ? "verified" : "mismatch",
          requested: requested.bodyType,
          actual: actual.bodyStyle ?? actual.vehicleType ?? null,
        });
      }
    }
  }

  // Drivetrain: the same acceptable-set rule the search uses (lib/drivetrain-filter.ts): "AWD, FWD" accepts both, AWD and 4WD are one group,
  // a request with no recognised drivetrain is reported as not applied by the accounting, so it makes no claim here.
  {
    const wantedDrive = wantedDriveClasses(requested.drivetrain);
    if (wantedDrive) {
      if (relaxedFields.has("drivetrain")) checks.push({ field: "drivetrain", status: "relaxed", requested: requested.drivetrain!, actual: actual.drivetrain ?? null });
      else {
        const j = judgeDrive(actual.drivetrain, wantedDrive);
        checks.push({ field: "drivetrain", status: j === "match" ? "verified" : j === "mismatch" ? "mismatch" : "unknown", requested: requested.drivetrain!, actual: actual.drivetrain ?? null });
      }
    }
  }
  push(checkStringField("transmission", requested.transmission, actual.transmission, relaxedFields.has("transmission"), anyListValueMatches));
  push(checkStringField("exteriorColor", requested.exteriorColor, actual.exteriorColor, relaxedFields.has("exteriorColor"), colorLikeMatches));
  push(checkStringField("interiorColor", requested.interiorColor, actual.interiorColor, relaxedFields.has("interiorColor"), colorLikeMatches));
  push(checkStringField("vehicleType", requested.vehicleType, actual.vehicleType, relaxedFields.has("vehicleType"), anyListValueMatches));
  push(checkExactValue("doors", requested.doors, actual.doors, relaxedFields.has("doors")));
  push(checkExactValue("cylinders", requested.cylinders, actual.cylinders, relaxedFields.has("cylinders")));
  push(checkExactValue("used", requested.used, actual.used, relaxedFields.has("used")));
  push(checkStringField("state", requested.state, actual.state, relaxedFields.has("state"), (r, a) => normalizeCompareString(r) === normalizeCompareString(a)));

  // trimRequired: exact reuse of the existing directional trim matcher —
  // same semantics as the real trimRequired eligibility check elsewhere.
  if (requested.trimRequired != null && requested.trimRequired !== "") {
    if (relaxedFields.has("trimRequired")) {
      checks.push({ field: "trimRequired", status: "relaxed", requested: requested.trimRequired, actual: actual.trim ?? null });
    } else if (actual.trim == null || actual.trim === "") {
      checks.push({ field: "trimRequired", status: "unknown", requested: requested.trimRequired, actual: null });
    } else {
      checks.push({
        field: "trimRequired",
        status: trimMatchesAny(requested.trimRequired, actual.trim, { electrified: requested.electrified }) ? "verified" : "mismatch", // same acceptable-set rule as the eligibility check
        requested: requested.trimRequired,
        actual: actual.trim,
      });
    }
  }

  // Required electrification (T52): verified when NHTSA confirms a requested type; mismatch when it shows another type (such cars are left out of the results, so this
  // is not expected on a card); unknown when NHTSA gave no usable answer. Unknown is kept and marked, never assumed to fail or to pass.
  if (requested.electrificationTypes && requested.electrificationTypes.length > 0) {
    const st = actual.electrificationState ?? null;
    const ok = electrificationStateSatisfies((st ?? undefined) as never, requested.electrificationTypes as never);
    checks.push({ field: "electrification", status: ok ? "verified" : st && st !== "ambiguous" ? "mismatch" : "unknown", requested: requested.electrificationTypes.join(", "), actual: st });
  }

  return checks;
}

/**
 * Aggregates the per-field checks into one overall status for the result.
 * Priority order matches the spec exactly: any mismatch wins over
 * everything; otherwise any relaxed; otherwise any unknown (-> "partial");
 * otherwise, if every requested check verified, "verified"; if there were
 * no applicable requested constraints at all, "not_applicable".
 */
export function aggregateSearchConstraintStatus(checks: ConstraintCheck[]): SearchConstraintStatus {
  if (checks.length === 0) return "not_applicable";
  if (checks.some((c) => c.status === "mismatch")) return "mismatch";
  if (checks.some((c) => c.status === "relaxed")) return "relaxed";
  if (checks.some((c) => c.status === "unknown")) return "partial";
  return "verified";
}
