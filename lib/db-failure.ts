/**
 * Why a database call failed (group 1, design 1, 9 Nov 2026).
 *
 * Until now every database error in the search path ended in a bare catch and became the generic service error, with no record of the cause: the 22:30 error on 8 Nov left
 * nothing but "a search failed". This writes ONE log line per failure with a FIXED set of fields. It never writes the error message, the SQL, a parameter, a VIN, a ZIP, a make
 * or a model: the class comes from the error, the code only from a Postgres SQLSTATE, and the rest are numbers. A bad minute cannot flood the log: at most one line per class per second
 * per server instance. What the buyer sees is unchanged: callers still return exactly what they returned before.
 */
export type DbFailureStage = "search" | "vin" | "model_facets" | "trim_facets" | "photo";
export type DbFailureClass = "connect_timeout" | "query_timeout" | "connection_ended" | "pool_ended" | "sql_error" | "other";

/** The three counters a pg Pool exposes; anything else (or a missing pool) is written as "na". */
export interface PoolCounts { totalCount?: unknown; idleCount?: unknown; waitingCount?: unknown }

const NODE_CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

/** A Postgres SQLSTATE is five characters of digits and capitals with at least one digit ("57014"); this keeps Node codes such as EPIPE out. */
function sqlState(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) && /\d/.test(c) ? c : null;
}

export function classifyDbError(e: unknown): { cls: DbFailureClass; code: string | null } {
  const msg = (e instanceof Error ? e.message : typeof e === "string" ? e : "").toLowerCase();
  const state = sqlState(e);
  const nodeCode = typeof (e as { code?: unknown } | null)?.code === "string" ? String((e as { code: string }).code) : "";
  if (msg.includes("timeout exceeded when trying to connect")) return { cls: "connect_timeout", code: null };
  if (msg.includes("query read timeout") || state === "57014") return { cls: "query_timeout", code: state };
  if (msg.includes("cannot use a pool after calling end")) return { cls: "pool_ended", code: null };
  if (msg.includes("connection terminated") || msg.includes("connection ended") || msg.includes("connection error") || NODE_CONNECTION_CODES.has(nodeCode) || (state !== null && state.startsWith("57P")) || (state !== null && state.startsWith("08"))) {
    return { cls: "connection_ended", code: state };
  }
  if (state !== null) return { cls: "sql_error", code: state };
  return { cls: "other", code: null };
}

const lastLoggedAt = new Map<DbFailureClass, number>();
export function resetDbFailureLogForTests(): void { lastLoggedAt.clear(); }

const count = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : "na");

/** Classifies the error, writes the (rate-limited) line and returns the class. Never throws and never changes the caller's outcome. */
export function noteDbFailure(stage: DbFailureStage, e: unknown, startedAt: number, pool?: PoolCounts | null): DbFailureClass {
  let cls: DbFailureClass = "other";
  try {
    const r = classifyDbError(e);
    cls = r.cls;
    const now = Date.now();
    if (now - (lastLoggedAt.get(cls) ?? 0) >= 1000) {
      lastLoggedAt.set(cls, now);
      const ms = Math.max(0, Math.round(now - startedAt));
      console.warn(`[db-failure] stage=${stage} class=${cls}${r.code ? ` code=${r.code}` : ""} ms=${ms} pool=${count(pool?.totalCount)}/${count(pool?.idleCount)}/${count(pool?.waitingCount)}`);
    }
  } catch { /* a logging problem must never change what the caller returns */ }
  return cls;
}
