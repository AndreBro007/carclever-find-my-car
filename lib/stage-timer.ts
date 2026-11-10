/**
 * R4-3 (10 Nov 2026, approved by André): how many milliseconds one tool call spent in each of four fixed stages, so the pool and timeout question can be answered from
 * evidence (the 10 Nov 05:18 cold-start timeout was at stage model_facets). Fixed keys only: db, nhtsa, rank, assemble. Numbers only: no VIN, ZIP, text or caller input ever enters.
 * Each stage SUMS the time of every timed piece of work in the call. Work that runs at the same time (parallel NHTSA decodes, parallel cards) adds up, so a stage total can exceed the
 * call's wall-clock time, and the assemble stage includes the waits for NHTSA inside card building. The totals are for spotting where time goes, not an exclusive breakdown.
 * Timing never changes behaviour: with no active call, every function here simply runs the work.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const STAGE_KEYS = ["db", "nhtsa", "rank", "assemble"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageTotals = Record<StageKey, number>;

const store = new AsyncLocalStorage<StageTotals>();

export function newStageTotals(): StageTotals { return { db: 0, nhtsa: 0, rank: 0, assemble: 0 }; }
export function runWithStageTotals<T>(totals: StageTotals, fn: () => T): T { return store.run(totals, fn); }

/** Adds elapsed milliseconds to one stage of the current call. Never negative, never throws; does nothing outside a call. */
export function addStageMs(stage: StageKey, ms: number): void {
  try {
    const t = store.getStore();
    if (!t || !(STAGE_KEYS as readonly string[]).includes(stage) || !Number.isFinite(ms)) return;
    t[stage] += Math.max(0, Math.round(ms));
  } catch { /* timing must never affect a request */ }
}
export async function timeStage<T>(stage: StageKey, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { return await fn(); } finally { addStageMs(stage, Date.now() - t0); }
}
export function timeStageSync<T>(stage: StageKey, fn: () => T): T {
  const t0 = Date.now();
  try { return fn(); } finally { addStageMs(stage, Date.now() - t0); }
}
/** The stored form: the four fixed keys, each a whole number of milliseconds between 0 and one hour. Anything else is dropped. */
export function sanitizeStageMs(v: unknown): StageTotals | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>; const out = newStageTotals();
  for (const k of STAGE_KEYS) { const n = o[k]; out[k] = typeof n === "number" && Number.isFinite(n) ? Math.min(3_600_000, Math.max(0, Math.round(n))) : 0; }
  return out;
}
