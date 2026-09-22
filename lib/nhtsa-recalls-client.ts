/**
 * NHTSA recalls client (V2.3, SYS-20260904-005 investigation -> build).
 *
 * Decision locked via DECISION-20260902-007 + ChatGPT's 2026-09-05 final
 * design sign-off: NHTSA-only (recallsByVehicle), never Auto.dev's
 * /recalls/{vin} endpoint — this project already has a live, tested NHTSA
 * relationship (nhtsa-client.ts's vPIC decode), so this avoids a new
 * unverified dependency. Accepted, already-recorded trade-off: NHTSA's
 * recall data is make/model/year-level, not VIN-specific, so a given VIN's
 * exact remedy-completion status can't be confirmed from this API alone —
 * that's exactly why "needs verification" is a real, honest, first-class
 * display state below, not a gap to work around.
 *
 * Endpoint: https://api.nhtsa.gov/recalls/recallsByVehicle — public, no
 * API key. Live-tested 2026-09-04: ~308ms for a real query, comparable to
 * the existing per-shortlist-vehicle NHTSA vPIC call already made for
 * electrification data.
 *
 * Scope, deliberately narrow, same discipline as decodeNhtsaElectrification:
 * only called on the final shortlist (5-8 vehicles), never the full
 * candidate pool. Unlike the vPIC decode (VIN-keyed, one call per vehicle),
 * this endpoint is make/model/year-keyed, so callers should deduplicate
 * before firing — two shortlisted vehicles sharing the same make/model/year
 * only need one lookup between them (see dedupeRecallKeys()).
 *
 * Fail-open by design (project-wide standing principle): any failure
 * (timeout, network error, malformed response) returns the "unavailable"
 * state, never throws, never blocks or excludes a card. "Unavailable" is a
 * distinct, honest state from "none found" — the two must never be
 * conflated.
 */

const NHTSA_RECALLS_BASE_URL = "https://api.nhtsa.gov/recalls/recallsByVehicle";
const NHTSA_RECALLS_TIMEOUT_MS = 5_000;

export type RecallDisplayState = "none" | "severe" | "routine" | "unavailable";

export interface RecallCampaign {
  campaignNumber: string | null;
  component: string | null;
  summary: string | null;
  consequence: string | null;
  remedy: string | null;
  reportReceivedDate: string | null;
  parkIt: boolean;
  parkOutSide: boolean;
}

export interface RecallInfo {
  state: RecallDisplayState;
  /** Approved compact card copy (design brief 2026-09-05, ChatGPT sign-off). */
  label: string;
  /** Longer, honest sentence — for a text/chat summary line, not the compact card. */
  detail: string;
  count: number;
  severeCount: number;
  campaigns: RecallCampaign[];
  nhtsaSourceUrl: string;
}

/** Approved 4-state compact copy, kept in exactly one place so card text and
 * any chat-summary text can never drift apart. */
const LABELS: Record<RecallDisplayState, { label: string; detail: string }> = {
  none: {
    label: "Recalls: None found",
    detail: "No open recall signal found",
  },
  severe: {
    label: "Recalls: Attention required",
    detail: "Open recall identified — immediate attention recommended",
  },
  routine: {
    label: "Recalls: Verify status",
    detail:
      "Recall reported — status needs verification. NHTSA's recall data is model/year-level, not VIN-specific, so it can't confirm whether this particular vehicle's remedy was completed.",
  },
  unavailable: {
    label: "Recalls: Data unavailable",
    detail: "Recall status unavailable",
  },
};

function buildUnavailable(make: string, model: string, year: number): RecallInfo {
  return {
    state: "unavailable",
    label: LABELS.unavailable.label,
    detail: LABELS.unavailable.detail,
    count: 0,
    severeCount: 0,
    campaigns: [],
    nhtsaSourceUrl: buildNhtsaSourceUrl(make, model, year),
  };
}

function buildNhtsaSourceUrl(make: string, model: string, year: number): string {
  // NHTSA's own public recall lookup page — used as the "see NHTSA source/
  // details" reference the design brief calls for on routine recalls,
  // without us needing to host or reformat NHTSA's own campaign text.
  const params = new URLSearchParams({ make, model, year: String(year) });
  return `https://www.nhtsa.gov/recalls?${params.toString()}`;
}

/**
 * Fetch recall status for one make/model/year combination. Never throws —
 * any failure resolves to the "unavailable" state (fail-open, matches every
 * other NHTSA-derived signal in this codebase).
 */
export async function fetchRecallStatus(
  make: string,
  model: string,
  year: number,
): Promise<RecallInfo> {
  if (!make || !model || !year) return buildUnavailable(make ?? "", model ?? "", year ?? 0);

  try {
    const url = `${NHTSA_RECALLS_BASE_URL}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(String(year))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(NHTSA_RECALLS_TIMEOUT_MS) });
    if (!res.ok) return buildUnavailable(make, model, year);

    const data = await res.json();
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const count = typeof data?.Count === "number" ? data.Count : results.length;

    const campaigns: RecallCampaign[] = results.map((r) => ({
      campaignNumber: r?.NHTSACampaignNumber ?? null,
      component: r?.Component ?? null,
      summary: r?.Summary ?? null,
      consequence: r?.Consequence ?? null,
      remedy: r?.Remedy ?? null,
      reportReceivedDate: r?.ReportReceivedDate ?? null,
      parkIt: r?.parkIt === true,
      parkOutSide: r?.parkOutSide === true,
    }));

    const severeCount = campaigns.filter((c) => c.parkIt || c.parkOutSide).length;

    let state: RecallDisplayState;
    if (count === 0) {
      state = "none";
    } else if (severeCount > 0) {
      state = "severe";
    } else {
      // Routine, non-severity-flagged recalls default to "needs
      // verification," not "open recall identified" — approved wording
      // (design brief 2026-09-05): NHTSA's result is model/year-level and
      // cannot confirm this specific VIN's remedy was completed, so
      // treating every routine recall as an alarming "open" flag would be
      // inaccurate and unnecessarily alarming.
      state = "routine";
    }

    return {
      state,
      label: LABELS[state].label,
      detail: LABELS[state].detail,
      count,
      severeCount,
      campaigns,
      nhtsaSourceUrl: buildNhtsaSourceUrl(make, model, year),
    };
  } catch {
    return buildUnavailable(make, model, year);
  }
}

/** Dedup key: recalls are make/model/year-level, so multiple shortlisted
 * vehicles sharing the same make/model/year (common — e.g. two same-trim
 * listings from different dealers) only need one NHTSA lookup. */
export function recallKey(make: string | null | undefined, model: string | null | undefined, year: number | null | undefined): string | null {
  if (!make || !model || !year) return null;
  return `${make.trim().toUpperCase()}|${model.trim().toUpperCase()}|${year}`;
}

/**
 * Fetch recall status for a shortlist of vehicles, deduplicated by
 * make/model/year. Returns a Map keyed by the same recallKey() so callers
 * can look up each listing's result (or `null` when make/model/year was
 * incomplete for that listing).
 */
export async function fetchRecallStatusForShortlist(
  vehicles: Array<{ make: string | null | undefined; model: string | null | undefined; year: number | null | undefined }>,
): Promise<Map<string, RecallInfo>> {
  const uniqueKeys = new Map<string, { make: string; model: string; year: number }>();
  for (const v of vehicles) {
    const key = recallKey(v.make, v.model, v.year);
    if (key && !uniqueKeys.has(key)) {
      uniqueKeys.set(key, { make: v.make as string, model: v.model as string, year: v.year as number });
    }
  }

  const entries = Array.from(uniqueKeys.entries());
  const results = await Promise.all(entries.map(([, v]) => fetchRecallStatus(v.make, v.model, v.year)));

  const map = new Map<string, RecallInfo>();
  entries.forEach(([key], i) => map.set(key, results[i]));
  return map;
}
