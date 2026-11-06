import { Pool } from "pg";
// Guard for tests that DROP tables: they must only ever run against a throwaway database.
// 1) the database must be on this machine (localhost, 127.0.0.1, ::1), unless ALLOW_DESTRUCTIVE_TESTS names that exact database and the name contains "test";
// 2) none of the real-data tables may hold more than a test database should (catches a real database even when the URL looks harmless).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export function disposableUrlProblem(url: string | undefined, allow: string | undefined = process.env.ALLOW_DESTRUCTIVE_TESTS): string | null {
  if (!url) return "TEST_DATABASE_URL is not set";
  let u: URL; try { u = new URL(url); } catch { return "TEST_DATABASE_URL is not a valid URL"; }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!db) return "the URL names no database";
  if (LOCAL_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (allow && allow === db && /test/i.test(db)) return null;
  return `host ${u.hostname} is not local; set ALLOW_DESTRUCTIVE_TESTS=<exact database name containing "test"> only for a database that is truly disposable`;
}
// search_log is not guarded: ordinary test runs fill it. listing and dealer hold real data in a real database (about 1.45 million and 6,000 rows) and a few rows in a test one.
export const GUARDED_TABLES = ["listing", "dealer", "usage_event"] as const;
export const MAX_ROWS_IN_TEST_DB = 1000;
export async function assertDisposableDatabase(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, url: string | undefined): Promise<void> {
  const problem = disposableUrlProblem(url);
  if (problem) throw new Error(`Refusing a destructive test: ${problem}`);
  for (const t of GUARDED_TABLES) {
    const exists = (await pool.query("SELECT to_regclass($1) IS NOT NULL AS e", [t])).rows[0]?.e;
    if (!exists) continue;
    const n = Number((await pool.query(`SELECT count(*) AS n FROM (SELECT 1 FROM ${t} LIMIT ${MAX_ROWS_IN_TEST_DB + 1}) x`)).rows[0]?.n);
    if (n > MAX_ROWS_IN_TEST_DB) throw new Error(`Refusing a destructive test: table ${t} holds more than ${MAX_ROWS_IN_TEST_DB} rows, so this does not look like a throwaway database`);
  }
}

export interface PoolLike { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>; end: () => Promise<void> }
export interface DisposableOptions { cleanupSql?: string[]; poolMax?: number; makePool?: (url: string) => PoolLike }
/**
 * Runs a destructive test body only on a database the guard accepts. If the guard REFUSES, nothing destructive runs: not the body and not the cleanup statements
 * (cleanup used to run in a finally block even after a refusal); the pool is just closed and the refusal is thrown. If the guard accepts, the body runs and the cleanup runs afterwards, even when the body fails.
 */
export async function withDisposableDatabase<T>(url: string | undefined, body: (pool: PoolLike) => Promise<T>, opts: DisposableOptions = {}): Promise<T> {
  const problem = disposableUrlProblem(url);
  if (problem) throw new Error(`Refusing a destructive test: ${problem}`); // no pool is even opened
  const pool = (opts.makePool ?? ((u: string) => new Pool({ connectionString: u, max: opts.poolMax ?? 3 }) as unknown as PoolLike))(url as string);
  try { await assertDisposableDatabase(pool, url); }
  catch (e) { await pool.end().catch(() => undefined); throw e; } // refused: close and stop
  try { return await body(pool); }
  finally { try { for (const sql of opts.cleanupSql ?? []) await pool.query(sql); } finally { await pool.end(); } }
}
