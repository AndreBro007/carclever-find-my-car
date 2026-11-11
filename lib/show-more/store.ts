/**
 * R4-6 step 3 (11 Nov 2026): the one table behind Show 8 more (design section 3). One row per search: a random reference, times, a version number and the list (slots, reserve,
 * excluded, requirements). Nothing else: no ZIP, radius, distance, free text, host, IP, user, account or conversation identifier.
 * EXPIRY is decided by the stored time and never by the row being gone; DELETION happens when a row is read after expiry, when a first-search write runs, and by the 10,000-row cap
 * (oldest first). There is no scheduled job. The table is created if missing (the same way the usage tables are).
 */
import { randomInt } from "node:crypto";
import { SLATE_TTL_MS, type Slate } from "./slate";
import { hasForbiddenKey, type Requirements } from "./requirements";

export interface Queryable { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> }
export const SLATE_ROW_CAP = 10_000;
const REF_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0, o, 1, l, i: copied by eye or by a model without mistakes
export const REF_LENGTH = 12;
export const REF_PATTERN = new RegExp(`^[${REF_ALPHABET}]{${REF_LENGTH}}$`);

export function newReference(): string { let s = ""; for (let i = 0; i < REF_LENGTH; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)]; return s; }

const DDL = [
  `CREATE TABLE IF NOT EXISTS search_slate (ref text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, version integer NOT NULL, first_shown smallint NOT NULL, body jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS search_slate_expires_idx ON search_slate (expires_at)`,
];
let ensured = false;
export async function ensureSlateTable(db: Queryable): Promise<void> { if (ensured) return; for (const sql of DDL) await db.query(sql); ensured = true; }
export function resetEnsuredForTests(): void { ensured = false; }

interface Body { slots: Slate["slots"]; reserve: Slate["reserve"]; couldNotCheck: string[]; excluded: Slate["excluded"]; requirements: Requirements; valueLines?: Record<string, string>; distances?: Record<string, number> }
const bodyOf = (slate: Slate, requirements: Requirements): Body => ({ slots: slate.slots, reserve: slate.reserve, couldNotCheck: slate.couldNotCheck, excluded: slate.excluded, requirements, ...(slate.valueLines ? { valueLines: slate.valueLines } : {}), ...(slate.distances ? { distances: slate.distances } : {}) });

/** The first-search write: clean up, then insert. Returns the reference, or null on ANY failure (the search then answers normally with no reference and no hint). */
export async function writeSlate(db: Queryable, nowMs: number, slate: Slate, requirements: Requirements): Promise<string | null> {
  try {
    const body = bodyOf(slate, requirements);
    if (hasForbiddenKey(body)) return null; // last guard: nothing about location or callers is ever stored
    await ensureSlateTable(db);
    const ref = newReference();
    // ONE round trip: delete expired rows, enforce the cap (oldest first), insert the new row (measured 11 Nov 2026: three separate statements cost about 60 ms a search at the median).
    await db.query(
      `WITH expired AS (DELETE FROM search_slate WHERE expires_at < to_timestamp($1 / 1000.0) RETURNING 1), ` +
      `over_cap AS (DELETE FROM search_slate WHERE ref IN (SELECT ref FROM search_slate ORDER BY created_at ASC LIMIT GREATEST(0, (SELECT count(*) FROM search_slate) - ${SLATE_ROW_CAP - 1})) RETURNING 1) ` +
      `INSERT INTO search_slate (ref, expires_at, version, first_shown, body) VALUES ($2, to_timestamp($3 / 1000.0), $4, $5, $6::jsonb)`,
      [nowMs, ref, nowMs + SLATE_TTL_MS, slate.version, slate.firstShown, JSON.stringify(body)],
    );
    return ref;
  } catch { return null; }
}

export type ReadResult =
  | { status: "ok"; slate: Slate; requirements: Requirements; expiresAtMs: number }
  | { status: "expired" | "unknown" | "unavailable" };

/** Expired or unknown references get an explicit answer, never a silent rerun. A failed read is "unavailable" (never "unknown"). */
export async function readSlate(db: Queryable, nowMs: number, ref: string): Promise<ReadResult> {
  if (!REF_PATTERN.test(ref)) return { status: "unknown" };
  try {
    await ensureSlateTable(db);
    const res = await db.query(`SELECT version, first_shown, body, (extract(epoch from expires_at) * 1000)::float8 AS expires_ms FROM search_slate WHERE ref = $1`, [ref]);
    const row = res.rows[0];
    if (!row) return { status: "unknown" };
    const expiresAtMs = Number(row.expires_ms);
    if (nowMs >= expiresAtMs) { await db.query(`DELETE FROM search_slate WHERE ref = $1`, [ref]).catch(() => undefined); return { status: "expired" }; }
    const b = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as Body;
    return { status: "ok", slate: { version: Number(row.version), firstShown: Number(row.first_shown), slots: b.slots, reserve: b.reserve, couldNotCheck: b.couldNotCheck, excluded: b.excluded, ...(b.valueLines ? { valueLines: b.valueLines } : {}), ...(b.distances ? { distances: b.distances } : {}) }, requirements: b.requirements, expiresAtMs };
  } catch { return { status: "unavailable" }; }
}

/** Compare-and-swap commit: succeeds only if nobody committed since the version this request read (and the list has not expired). */
export async function commitSlate(db: Queryable, nowMs: number, ref: string, expectedVersion: number, next: Slate, requirements: Requirements): Promise<boolean> {
  try {
    const res = await db.query(`UPDATE search_slate SET version = $3, body = $4::jsonb WHERE ref = $1 AND version = $2 AND expires_at > to_timestamp($5 / 1000.0) RETURNING version`, [ref, expectedVersion, next.version, JSON.stringify(bodyOf(next, requirements)), nowMs]);
    return res.rows.length === 1;
  } catch { return false; }
}
