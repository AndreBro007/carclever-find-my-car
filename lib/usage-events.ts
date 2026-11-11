import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { getCatalogPool } from "./catalog-db-source";
import { priceBand } from "./search-log";
import { setNhtsaFailureSink, setNhtsaCallerProvider } from "./nhtsa-client";
import { maybeLogHeaderNames, maybeLogClientHeader } from "./header-name-spike";
import { newStageTotals, runWithStageTotals, sanitizeStageMs, STAGE_KEYS, type StageTotals } from "./stage-timer";
import { setSharedIdPlatformProvider } from "./shared-id-context";

/**
 * Usage events (Phase C P6, design approved by André 6 Nov 2026). One row per tool call in usage_event, plus a daily listen counter and a daily summary.
 * Privacy: never stores a VIN, ZIP code, IP address, raw prompt, the host AI's need text, or the raw caller string. caller_class is "recognised, unverified".
 * Isolation: events are written only on the TEST host unless USAGE_EVENTS_ENABLED=1 is set deliberately, so this code does nothing on the live server by default.
 * Logging can never change or delay a tool answer: every write is scheduled after the response and every failure is swallowed.
 */
export const USAGE_LABEL_VERSION = 1;
export type UsageTool = "search" | "compare" | "check" | "link" | "more";
export type UsageEnv = "test" | "live" | "unknown";
export type CallerClass = "claude" | "chatgpt" | "grok" | "other" | "unknown";

const TOOL_BY_NAME: Record<string, UsageTool> = {
  find_matching_vehicle: "search",
  check_vehicle: "check",
  compare_vehicles: "compare",
  get_edmunds_vehicle_link: "link",
  resolve_dealer_url: "link",
  show_more_vehicles: "more", // R4-6 (André approved the count-only line, 11 Nov 2026): counts and fixed words only; never the reference, a VIN or a car
};

export function callerClass(userAgent?: string | null): CallerClass {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("claude")) return "claude";
  if (ua.includes("openai") || ua.includes("chatgpt")) return "chatgpt";
  if (ua.includes("grok")) return "grok";
  return "other";
}

/**
 * R4-1 (10 Nov 2026, André approved Option A): the Claude surface, from the value of the ONE header x-anthropic-client, through a FIXED list built from the values actually seen
 * (the header spike on 10 Nov saw "ClaudeAI" and "Cowork"). Anything else, a missing header, or any caller other than Claude is "unknown". The raw header value is never stored.
 * "claude_ai" means Claude chat (web, and possibly the desktop chat: not separated by this header as far as seen); "cowork" is Cowork.
 */
export const SURFACES = ["claude_ai", "cowork", "unknown"] as const;
export type Surface = (typeof SURFACES)[number];
export function surfaceOf(headerValue: string | null | undefined, caller: CallerClass): Surface {
  if (caller !== "claude") return "unknown";
  const v = String(headerValue ?? "").trim().toLowerCase();
  if (v === "claudeai") return "claude_ai";
  if (v === "cowork") return "cowork";
  return "unknown";
}

const HOST_ENV: Record<string, UsageEnv> = {
  "carclever-db-test.getcarwise.app": "test",
  "carclever-db.getcarwise.app": "live",
};
export function envFromHost(host?: string | null): UsageEnv {
  const h = (host ?? "").trim().toLowerCase().split(":")[0];
  return HOST_ENV[h] ?? "unknown";
}
export function usageEnabled(env: UsageEnv): boolean {
  return env === "test" || process.env.USAGE_EVENTS_ENABLED === "1";
}

// An explicit request for value always wins over any other cue (ChatGPT review, 6 Nov 2026), so it is checked first.
const VALUE_RE = /\b(best|good|great|better|top)\s+value\b|\bvalue\s+(for|of)\s+(the\s+|my\s+)?money\b|\bvalue\s*(pick|buy|car|option)s?\b|\bbang\s+for\s+(my|the)\s+buck\b|\bmost\s+for\s+my\s+money\b|^\s*value\s*$/i;
export interface IntentInputs { bodyType?: unknown; seatsMinPreference?: unknown; electrificationTypes?: unknown; electrificationRequirement?: unknown; vehicleNeeds?: unknown }
/** Label from structured inputs and the host's short need text. The need text is read here and never stored. SUV does not mean family; a low budget does not mean commute. */
export function intentLabel(i: IntentInputs): string {
  const needs = Array.isArray(i.vehicleNeeds) ? i.vehicleNeeds.map(String).join(" ") : typeof i.vehicleNeeds === "string" ? i.vehicleNeeds : "";
  const text = needs.toLowerCase();
  if (VALUE_RE.test(needs)) return "value";
  const seats = Number(i.seatsMinPreference);
  if ((Number.isFinite(seats) && seats >= 6) || /three[- ]row|3[- ]row|\bseven[- ]seat|\b7[- ]seat/.test(text)) return "three_row";
  const body = String(i.bodyType ?? "").toLowerCase();
  if (/truck|pickup/.test(body) || /\btruck\b|\btow(ing)?\b|\bpickup\b/.test(text)) return "truck";
  const types = Array.isArray(i.electrificationTypes) ? i.electrificationTypes.map((t) => String(t)) : [];
  if (types.includes("electric") || /\belectric\b|\bev\b/.test(text)) return "electric";
  if (types.includes("hybrid") || types.includes("plug_in_hybrid") || /\bhybrid\b/.test(text)) return "hybrid";
  if (/\bfamily\b|\bkids?\b/.test(text)) return "family";
  if (/\bcommut/.test(text)) return "commute";
  if (/\bluxury\b/.test(text)) return "luxury";
  return "unknown";
}

const FILTER_FIELDS = ["priceMin", "priceMax", "yearMin", "yearMax", "mileageMax", "drivetrain", "trimRequired", "trimPreference", "exteriorColor", "seatsMinPreference", "electrificationTypes", "cpo", "noAccidents", "oneOwner"];
export interface UsageAttributes { body_style: string | null; price_band: string | null; condition: string | null; make_given: boolean; model_given: boolean; filter_count: number }
export function usageAttributes(input: Record<string, unknown> | undefined | null): UsageAttributes {
  const a = input ?? {};
  const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  const cond = String(a.condition ?? "").toLowerCase();
  const pm = typeof a.priceMax === "number" ? a.priceMax : null;
  return {
    body_style: bodyStyleOf(a.bodyType),
    price_band: priceBand(pm),
    condition: cond === "new" || cond === "used" ? cond : null,
    make_given: present(a.make),
    model_given: present(a.model),
    filter_count: FILTER_FIELDS.filter((f) => present(a[f])).length,
  };
}

// ---- fixed vocabularies: nothing a caller types can reach an event except as one of these values, a number or a yes/no ----
export const BODY_STYLES = ["suv", "truck", "sedan", "coupe", "hatchback", "wagon", "van", "minivan", "convertible", "other"] as const;
export function bodyStyleOf(v: unknown): string | null {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
  const t = (Array.isArray(v) ? v.map(String).join(" ") : typeof v === "string" ? v : "").toLowerCase();
  if (/mini\s?van/.test(t)) return "minivan";
  if (/\bvan\b/.test(t)) return "van";
  if (/\bsuv\b|sport utility|crossover/.test(t)) return "suv";
  if (/truck|pickup/.test(t)) return "truck";
  if (/sedan|saloon|4dr car/.test(t)) return "sedan";
  if (/coupe/.test(t)) return "coupe";
  if (/hatch/.test(t)) return "hatchback";
  if (/wagon|estate/.test(t)) return "wagon";
  if (/convert|roadster|cabrio/.test(t)) return "convertible";
  return "other";
}
const PRICE_BANDS = ["up to 15k", "15k to 25k", "25k to 40k", "over 40k"];
export const INTENT_LABELS = ["value", "three_row", "truck", "electric", "hybrid", "family", "commute", "luxury", "unknown"];
export const OUTCOMES = ["results", "none", "error", "invalid_input", "decoded_recall_known", "decoded_recall_unknown", "not_decoded", "produced", "generated", "added", "unchanged", "pending", "list_unknown", "list_expired", "list_unavailable"];
const int = (v: unknown, max = 1_000_000_000): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : null);
/** Last line of defence: whatever reaches insertUsageEvent is forced into the fixed vocabularies, so even a future bug cannot store caller text. */
export function sanitizeUsageEvent(e: UsageEvent): UsageEvent | null {
  if (!["search", "compare", "check", "link", "more"].includes(e.tool)) return null;
  const a = e.attrs;
  return {
    tool: e.tool,
    outcome: OUTCOMES.includes(e.outcome) ? e.outcome : "error",
    env: (["test", "live", "unknown"] as const).includes(e.env) ? e.env : "unknown",
    caller_class: (["claude", "chatgpt", "grok", "other", "unknown"] as const).includes(e.caller_class) ? e.caller_class : "unknown",
    found: int(e.found), shown: int(e.shown, 100000),
    attrs: a ? {
      body_style: a.body_style && (BODY_STYLES as readonly string[]).includes(a.body_style) ? a.body_style : null,
      price_band: a.price_band && PRICE_BANDS.includes(a.price_band) ? a.price_band : null,
      condition: a.condition === "new" || a.condition === "used" ? a.condition : null,
      make_given: a.make_given === true, model_given: a.model_given === true, filter_count: int(a.filter_count, 100) ?? 0,
    } : undefined,
    intent_label: e.intent_label && INTENT_LABELS.includes(e.intent_label) ? e.intent_label : null,
    surface: (SURFACES as readonly string[]).includes(String(e.surface)) ? (e.surface as Surface) : "unknown",
    stage_ms: sanitizeStageMs(e.stage_ms),
    link_code: e.link_code && /^[a-z0-9]{1,64}$/.test(e.link_code) ? e.link_code : null,
    duration_ms: int(e.duration_ms, 3_600_000), nhtsa_failures: int(e.nhtsa_failures, 100000),
  };
}

// ---- outcomes (P2 definitions) ----
type ToolResult = { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: any } | null | undefined;
const textOf = (r: ToolResult) => (r?.content ?? []).map((c) => c?.text ?? "").join("\n");
export function searchOutcome(r: ToolResult): { outcome: string; found: number | null; shown: number } {
  const sc = r?.structuredContent;
  const shown = Array.isArray(sc?.results) ? sc.results.length : 0;
  const total = typeof sc?.meta?.totalMatches === "number" ? sc.meta.totalMatches : null;
  if (!r || r.isError || sc?.meta?.serviceError) return { outcome: "error", found: total, shown };
  return { outcome: shown > 0 ? "results" : "none", found: total, shown };
}
export function checkOutcome(r: ToolResult): string {
  const sc = r?.structuredContent;
  if (!r || r.isError || sc?.meta?.serviceError) return "error";
  const res = Array.isArray(sc?.results) ? sc.results[0] : null;
  const id = res?.identity;
  const decoded = !!(id && id.make && id.model && id.year);
  if (!decoded) return "not_decoded";
  const state = res?.buyerCheck?.recall?.state;
  const known = (typeof state === "string" && state !== "unavailable") || /Recall details \(NHTSA, \d+ total\)/.test(textOf(r));
  return known ? "decoded_recall_known" : "decoded_recall_unknown";
}
export function compareOutcome(r: ToolResult): string {
  const sc = r?.structuredContent;
  if (!r || r.isError || sc?.meta?.serviceError) return "error";
  return Array.isArray(sc?.results) && sc.results.length >= 2 ? "produced" : "error";
}
/**
 * Show 8 more (R4-6): the outcome in fixed words, and two counts. found = cars added by THIS call, shown = cars now shown. Nothing about the list, its reference or any car is read out of the reply.
 * added = at least one car was added; unchanged = nothing new (same total, or nothing left); pending = some cars could not be checked right now; list_unknown / list_expired / list_unavailable = no list.
 */
export function moreOutcome(r: ToolResult): { outcome: string; found: number | null; shown: number | null } {
  if (!r || r.isError) return { outcome: "error", found: null, shown: null };
  const c = r.structuredContent?.continuation;
  if (c && typeof c === "object") {
    const added = int(c.added) ?? 0, shown = int(c.shown, 100000);
    const outcome = (int(c.pending) ?? 0) > 0 ? "pending" : added > 0 ? "added" : "unchanged";
    return { outcome, found: added, shown };
  }
  const t = textOf(r);
  if (/^That list has expired/.test(t)) return { outcome: "list_expired", found: null, shown: null };
  if (/^I could not read the saved list/.test(t)) return { outcome: "list_unavailable", found: null, shown: null };
  return { outcome: "list_unknown", found: null, shown: null };
}

export function linkOutcome(r: ToolResult): string {
  const sc = r?.structuredContent;
  if (!r || r.isError) return "error";
  return typeof sc?.affiliateUrl === "string" && sc.affiliateUrl ? "generated" : "error";
}

// ---- per-request context ----
interface UsageContext { env: UsageEnv; caller: CallerClass; surface: Surface; listenMessages: number }
const store = new AsyncLocalStorage<UsageContext>();
export function runWithUsageContext<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const h = req.headers;
  const ctx: UsageContext = { env: envFromHost(h.get("x-forwarded-host") ?? h.get("host")), caller: callerClass(h.get("user-agent")), surface: "unknown", listenMessages: 0 };
  ctx.surface = surfaceOf(h.get("x-anthropic-client"), ctx.caller);
  maybeLogHeaderNames(h, ctx.caller); // R4-1 spike: preview builds only, header NAMES only; removed before release 4 goes live
  maybeLogClientHeader(h, ctx.caller); // R4-1 spike step 2: the value of x-anthropic-client only, safe pattern, preview builds only; removed before release 4 goes live
  return store.run(ctx, fn);
}
// NHTSA decode failures are counted per tool CALL (not per request), so two tools in one batch, even running at the same time, each get only their own count.
// Only find_matching_vehicle tracks NHTSA failures in the existing code; for the other tools the column stays empty (not captured), which is different from 0 (captured, none).
const callStore = new AsyncLocalStorage<{ failures: number }>();
setNhtsaFailureSink((n) => { const c = callStore.getStore(); if (c) c.failures += n; });
setNhtsaCallerProvider(() => store.getStore()?.caller ?? null);
setSharedIdPlatformProvider(() => store.getStore()?.caller ?? null); // R4-2: Impact Shared ID names the platform

// ---- database ----
let poolOverride: { query: (sql: string, params?: unknown[]) => Promise<any> } | null = null;
export function _setPoolForTests(p: typeof poolOverride): void { poolOverride = p; tablesReady = null; }
const pool = () => poolOverride ?? getCatalogPool();

export const USAGE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS usage_event (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    time_utc timestamptz NOT NULL DEFAULT now(),
    tool text NOT NULL, outcome text NOT NULL, env text NOT NULL DEFAULT 'unknown', caller_class text,
    found integer, shown integer,
    body_style text, price_band text, condition text, make_given boolean, model_given boolean, filter_count integer,
    intent_label text, label_version integer, link_code text, duration_ms integer, nhtsa_failures integer)`,
  `CREATE INDEX IF NOT EXISTS usage_event_time_idx ON usage_event (time_utc)`,
  `CREATE TABLE IF NOT EXISTS usage_counter (day date NOT NULL, env text NOT NULL, kind text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (day, env, kind))`,
  `CREATE TABLE IF NOT EXISTS usage_daily_summary (
    day date NOT NULL, env text NOT NULL, tool text NOT NULL, outcome text NOT NULL,
    caller_class text NOT NULL DEFAULT 'unknown', intent_label text NOT NULL DEFAULT 'unknown', label_version integer NOT NULL DEFAULT 0,
    event_count integer NOT NULL, duration_ms_sum bigint, duration_ms_max integer,
    PRIMARY KEY (day, env, tool, outcome, caller_class, intent_label, label_version))`,
];
let tablesReady: Promise<void> | null = null;
/** Creates the tables once. A failure is NOT remembered: the next call tries again (the T166 fix). */
export function ensureUsageTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => { for (const sql of USAGE_TABLES_SQL) await pool().query(sql); })().catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

export interface UsageEvent {
  tool: UsageTool; outcome: string; env: UsageEnv; caller_class: CallerClass;
  found?: number | null; shown?: number | null; attrs?: UsageAttributes; intent_label?: string | null; link_code?: string | null; duration_ms?: number | null; nhtsa_failures?: number | null;
  surface?: Surface; stage_ms?: StageTotals | null;
}
/** Optional columns added later by additive SQL (R4-1 surface, R4-3 stage_ms). The writer uses a column only when it exists, so a missing column can never break a write.
 * The answer is kept for five minutes per server instance, so a column added later is picked up; a failed lookup means "none" and is not kept. */
export const OPTIONAL_USAGE_COLUMNS = ["surface", "stage_ms"] as const;
const OPTIONAL_COLUMNS_TTL_MS = 5 * 60 * 1000;
let optionalColumns: { at: number; present: Set<string> } | null = null;
export function _resetOptionalColumnsForTests(): void { optionalColumns = null; }
async function presentOptionalColumns(): Promise<Set<string>> {
  if (optionalColumns && Date.now() - optionalColumns.at < OPTIONAL_COLUMNS_TTL_MS) return optionalColumns.present;
  try {
    const r = await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_event' AND column_name = ANY($1)`, [[...OPTIONAL_USAGE_COLUMNS]]);
    const present = new Set<string>((r?.rows ?? []).map((x: { column_name: unknown }) => String(x.column_name)).filter((c: string) => (OPTIONAL_USAGE_COLUMNS as readonly string[]).includes(c)));
    optionalColumns = { at: Date.now(), present };
    return present;
  } catch { return new Set<string>(); }
}
export async function insertUsageEvent(raw: UsageEvent): Promise<void> {
  const e = sanitizeUsageEvent(raw); if (!e) return;
  await ensureUsageTables();
  const a = e.attrs;
  const cols = ["tool", "outcome", "env", "caller_class", "found", "shown", "body_style", "price_band", "condition", "make_given", "model_given", "filter_count", "intent_label", "label_version", "link_code", "duration_ms", "nhtsa_failures"];
  const vals: unknown[] = [e.tool, e.outcome, e.env, e.caller_class, e.found ?? null, e.shown ?? null, a?.body_style ?? null, a?.price_band ?? null, a?.condition ?? null, a?.make_given ?? null, a?.model_given ?? null, a?.filter_count ?? null,
    e.intent_label ?? null, e.intent_label ? USAGE_LABEL_VERSION : null, e.link_code ?? null, e.duration_ms ?? null, e.nhtsa_failures ?? null];
  const optional = await presentOptionalColumns();
  if (optional.has("surface")) { cols.push("surface"); vals.push(e.surface ?? "unknown"); }
  if (optional.has("stage_ms")) { cols.push("stage_ms"); vals.push(e.stage_ms ? JSON.stringify(e.stage_ms) : null); }
  await pool().query(`INSERT INTO usage_event (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
}
export async function bumpUsageCounter(env: UsageEnv, kind: string, n = 1): Promise<void> {
  await ensureUsageTables();
  await pool().query(
    `INSERT INTO usage_counter (day, env, kind, n) VALUES (current_date, $1, $2, $3) ON CONFLICT (day, env, kind) DO UPDATE SET n = usage_counter.n + $3`,
    [env, kind, n],
  );
}

// ---- diagnostics: counts and an error CODE only, never the error text (it can carry connection details); at most one line per kind a minute ----
const diag = { writeFailures: 0, lastCode: null as string | null };
const lastWarnAt = new Map<string, number>();
export const DIAG_WARN_INTERVAL_MS = 60_000;
function noteWriteFailure(kind: string, e: unknown): void {
  diag.writeFailures++;
  const raw = (e as { code?: unknown } | null)?.code ?? (e as { name?: unknown } | null)?.name ?? "error";
  diag.lastCode = String(raw).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "error";
  const now = Date.now(); const last = lastWarnAt.get(kind);
  if (last === undefined || now - last >= DIAG_WARN_INTERVAL_MS) {
    lastWarnAt.set(kind, now);
    console.warn(`[usage-events] ${kind} write failed (code ${diag.lastCode}); ${diag.writeFailures} write failures so far in this instance`);
  }
}
export function usageDiagnostics(): { writeFailures: number; lastCode: string | null } { return { writeFailures: diag.writeFailures, lastCode: diag.lastCode }; }
export function _resetDiagnosticsForTests(): void { diag.writeFailures = 0; diag.lastCode = null; lastWarnAt.clear(); }

// ---- scheduling: runs after the response so the write completes on serverless, and never throws ----
const pending = new Set<Promise<void>>();
export function scheduleUsageTask(kind: string, task: () => Promise<void>): void {
  const run = (): Promise<void> => { const p: Promise<void> = task().catch((e) => noteWriteFailure(kind, e)).finally(() => pending.delete(p)); pending.add(p); return p; };
  try { after(run); } catch { void run(); }
}
export async function flushUsageForTests(): Promise<void> { while (pending.size) await Promise.all([...pending]); }

/** How many messages in a request body are real subscriptions/listen calls (the method field, in one message or in a batch). Text that merely mentions it, such as inside a tool argument, does not count. */
export function countListenMessages(raw: string): number {
  if (!raw.includes("subscriptions/listen")) return 0;
  try {
    const body = JSON.parse(raw); const msgs = Array.isArray(body) ? body : [body];
    return msgs.filter((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "subscriptions/listen").length;
  } catch { return 0; }
}
/** The wrapper tells the request context whether the body held a real subscriptions/listen message. Nothing is written until the answer is known. */
export function noteListenMessages(n: number): void { const c = store.getStore(); if (c) c.listenMessages = n; }
/** Counted per POST REQUEST that carried at least one real listen message (a batch with two listen messages is one request, because one HTTP status answers the whole request).
 * Once the response status is known: 2xx counts as "listen_accepted", anything else as "listen_rejected". Requests refused before the body could be read (too large) or that fail before an answer
 * are not counted. Accepted means the HTTP answer was 2xx, not that a stream stayed open. */
export function noteListenOutcome(status: number): void {
  const ctx = store.getStore(); if (!ctx || ctx.listenMessages <= 0 || !usageEnabled(ctx.env)) return;
  const kind = status >= 200 && status < 300 ? "listen_accepted" : "listen_rejected";
  scheduleUsageTask("listen counter", () => bumpUsageCounter(ctx.env, kind, 1));
}

function record(tool: UsageTool, outcome: string, args: unknown, extra: { found?: number | null; shown?: number | null }, ms: number, nhtsaFailures: number | null = null, rejected = false, stages: StageTotals | null = null): void {
  const ctx = store.getStore(); if (!ctx || !usageEnabled(ctx.env)) return;
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const ev: UsageEvent = {
    tool, outcome, env: ctx.env, caller_class: ctx.caller, found: extra.found ?? null, shown: extra.shown ?? null,
    attrs: tool === "search" && !rejected ? usageAttributes(input) : undefined, intent_label: tool === "search" && !rejected ? intentLabel(input as IntentInputs) : null,
    duration_ms: Math.max(0, Math.round(ms)), nhtsa_failures: nhtsaFailures, surface: ctx.surface, stage_ms: stages,
  };
  scheduleUsageTask("event", () => insertUsageEvent(ev));
}

/** A tool call the SDK rejected before our code ran (input validation). It is recorded as outcome invalid_input, a sub-case of error, so wrong-input calls are visible. Nothing is read from the rejected input: no attributes, no label (the input failed validation, so it cannot be trusted to be what the schema says). Unknown tool names are ignored. */
export function noteToolValidationFailure(toolName: string, _args: unknown, ms: number): void {
  const tool = TOOL_BY_NAME[toolName]; if (!tool) return;
  record(tool, "invalid_input", undefined, {}, ms, null, true);
}

/** Wraps server.registerTool once so every tool callback is timed and recorded. Return values and errors pass through untouched. */
export function instrumentTools(server: { registerTool: (...a: any[]) => any }): void {
  const original = server.registerTool.bind(server);
  server.registerTool = (name: string, config: unknown, cb: (...a: any[]) => any) => {
    const tool = TOOL_BY_NAME[name];
    if (!tool || typeof cb !== "function") return original(name, config, cb);
    const wrapped = async (...cbArgs: any[]) => {
      const t0 = Date.now(); const call = { failures: 0 }; const stages = newStageTotals();
      const nhtsa = () => (tool === "search" ? call.failures : null);
      let result: ToolResult;
      try { result = await runWithStageTotals(stages, () => callStore.run(call, () => cb(...cbArgs))); }
      catch (e) { try { record(tool, "error", cbArgs[0], {}, Date.now() - t0, nhtsa(), false, stages); } catch { /* never alter the failure */ } throw e; }
      try {
        if (tool === "search") { const s = searchOutcome(result); record(tool, s.outcome, cbArgs[0], s, Date.now() - t0, nhtsa(), false, stages); }
        else if (tool === "more") { const m = moreOutcome(result); record(tool, m.outcome, {}, m, Date.now() - t0, null, false, stages); }
        else record(tool, tool === "check" ? checkOutcome(result) : tool === "compare" ? compareOutcome(result) : linkOutcome(result), cbArgs[0], {}, Date.now() - t0, null, false, stages);
      } catch { /* logging must never change the answer */ }
      return result;
    };
    return original(name, config, wrapped);
  };
}

// ---- retention (retry-safe) ----
export const RAW_RETENTION_DAYS = 90;
export const SUMMARY_RETENTION_MONTHS = 24;
export interface RetentionResult { rolledUpRows: number; deletedRows: number; expiredSummaryRows: number; cutoff: string }
/** Rolls raw rows older than the cutoff (start of the UTC day 90 days back) into the daily summary and deletes them. The delete and the summary insert are ONE statement (DELETE ... RETURNING feeds the INSERT),
 * so each old row is deleted and counted exactly once: a failure changes nothing (one transaction), a repeat finds nothing left to add, and two overlapping runs cannot count a row twice because the second
 * waits for the first run's row locks and then finds the rows gone. No advisory lock is used (session locks are unreliable through a pooled connection). */
export async function runUsageRetention(client: { query: (sql: string, params?: unknown[]) => Promise<any> }, now: Date = new Date()): Promise<RetentionResult> {
  const cutoffDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RAW_RETENTION_DAYS));
  const summaryCut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - SUMMARY_RETENTION_MONTHS, now.getUTCDate()));
  const cutoff = cutoffDate.toISOString(); const sCut = summaryCut.toISOString().slice(0, 10);
  await client.query("BEGIN");
  try {
    const roll = await client.query(
      `WITH del AS (
         DELETE FROM usage_event WHERE time_utc < $1
         RETURNING time_utc, env, tool, outcome, caller_class, intent_label, label_version, duration_ms),
       agg AS (
         SELECT (time_utc AT TIME ZONE 'UTC')::date AS day, env, tool, outcome, COALESCE(caller_class,'unknown') AS caller_class, COALESCE(intent_label,'unknown') AS intent_label,
                COALESCE(label_version,0) AS label_version, count(*)::int AS n, COALESCE(sum(duration_ms),0)::bigint AS s, max(duration_ms) AS m
         FROM del GROUP BY 1,2,3,4,5,6,7),
       ins AS (
         INSERT INTO usage_daily_summary (day, env, tool, outcome, caller_class, intent_label, label_version, event_count, duration_ms_sum, duration_ms_max)
         SELECT day, env, tool, outcome, caller_class, intent_label, label_version, n, s, m FROM agg
         ON CONFLICT (day, env, tool, outcome, caller_class, intent_label, label_version) DO UPDATE SET
           event_count = usage_daily_summary.event_count + EXCLUDED.event_count,
           duration_ms_sum = COALESCE(usage_daily_summary.duration_ms_sum,0) + COALESCE(EXCLUDED.duration_ms_sum,0),
           duration_ms_max = GREATEST(usage_daily_summary.duration_ms_max, EXCLUDED.duration_ms_max)
         RETURNING 1)
       SELECT (SELECT COALESCE(sum(n),0)::int FROM agg) AS deleted, (SELECT count(*)::int FROM ins) AS summary_rows`,
      [cutoff]);
    const exp = await client.query("DELETE FROM usage_daily_summary WHERE day < $1::date", [sCut]);
    await client.query("COMMIT");
    const row = roll.rows?.[0] ?? { deleted: 0, summary_rows: 0 };
    return { rolledUpRows: Number(row.summary_rows), deletedRows: Number(row.deleted), expiredSummaryRows: exp.rowCount ?? 0, cutoff };
  } catch (e) { try { await client.query("ROLLBACK"); } catch { /* ignore */ } throw e; }
}
