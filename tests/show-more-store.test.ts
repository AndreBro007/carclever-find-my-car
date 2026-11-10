// R4-6 step 3 (11 Nov 2026): the requirements validator and the storage layer. Run: npx tsx --test tests/show-more-store.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildRequirements, colourKeys, hasForbiddenKey } from "../lib/show-more/requirements";
import { writeSlate, readSlate, commitSlate, newReference, REF_PATTERN, resetEnsuredForTests, type Queryable } from "../lib/show-more/store";
import { newSlate, SLATE_TTL_MS, type Slot } from "../lib/show-more/slate";

const slot = (vin: string): Slot => ({ vin, price: 20000, drive: "na", fuel: "na", stars: 5 });
const mkSlate = () => newSlate(Array.from({ length: 8 }, (_, i) => slot(`S${i + 1}`)), Array.from({ length: 8 }, (_, i) => ({ vin: `R${i + 1}`, drive: "na" as const, fuel: "na" as const })));

// a tiny in-memory stand-in that understands exactly the statements the store sends
function fakeDb() {
  const rows = new Map<string, { expires: number; version: number; first: number; body: string; created: number }>();
  let seq = 0; const log: string[] = [];
  const db: Queryable = {
    async query(sql, p = []) {
      log.push(sql.slice(0, 40));
      if (/^CREATE/.test(sql)) return { rows: [] };
      if (/^DELETE FROM search_slate WHERE expires_at/.test(sql)) { for (const [k, v] of rows) if (v.expires < Number(p[0])) rows.delete(k); return { rows: [] }; }
      if (/^DELETE FROM search_slate WHERE ref IN/.test(sql)) { const lim = Math.max(0, rows.size - 9999); [...rows.entries()].sort((a, b) => a[1].created - b[1].created).slice(0, lim).forEach(([k]) => rows.delete(k)); return { rows: [] }; }
      if (/^DELETE FROM search_slate WHERE ref = /.test(sql)) { rows.delete(String(p[0])); return { rows: [] }; }
      if (/^INSERT/.test(sql)) { rows.set(String(p[0]), { expires: Number(p[1]), version: Number(p[2]), first: Number(p[3]), body: String(p[4]), created: ++seq }); return { rows: [] }; }
      if (/^SELECT/.test(sql)) { const r = rows.get(String(p[0])); return { rows: r ? [{ version: r.version, first_shown: r.first, body: JSON.parse(r.body), expires_ms: r.expires }] : [] }; }
      if (/^UPDATE/.test(sql)) { const r = rows.get(String(p[0])); if (!r || r.version !== Number(p[1]) || r.expires <= Number(p[4])) return { rows: [] }; r.version = Number(p[2]); r.body = String(p[3]); return { rows: [{ version: r.version }] }; }
      throw new Error("unexpected sql " + sql);
    },
  };
  return { db, rows, log };
}
beforeEach(() => resetEnsuredForTests());

test("requirements: validated values only; an odd value anywhere means no row at all", () => {
  const ok = buildRequirements({ make: "Honda", model: "CR-V, RAV4", priceMax: 30000.4, yearMin: 2020, condition: "used", drivetrain: "awd, 4wd", electrificationTypes: ["hybrid"], electrificationRequirement: "required", cpo: true, exteriorColor: "Gray silver", relaxations: ["radius", "radius"] });
  assert.deepEqual(ok, { make: "Honda", models: ["CR-V", "RAV4"], priceMax: 30000, yearMin: 2020, condition: "used", drivetrain: ["AWD", "4WD"], electrificationTypes: ["hybrid"], electrificationRequirement: "required", cpo: true, exteriorColors: ["gray", "silver"], relaxations: ["radius"] });
  assert.equal(buildRequirements({ exteriorColor: "Gray and silver" }), null, "\"and\" is not a colour word: the whole search is not expandable");
});
test("colour words: only the fixed base table; anything else makes the whole search unexpandable", () => {
  assert.deepEqual(colourKeys("Silver"), ["silver"]); assert.equal(colourKeys("Glacier White"), "bad"); assert.equal(colourKeys("navy"), "bad"); assert.equal(colourKeys(""), undefined);
  assert.equal(buildRequirements({ make: "Honda", exteriorColor: "Glacier White" }), null);
});
test("requirements: bad characters, unknown drivetrain words, bad numbers, bad flags, bad codes all refuse", () => {
  for (const bad of [{ make: "Hon<da" }, { model: "a".repeat(60) }, { drivetrain: "sideways" }, { priceMax: "cheap" }, { cpo: "yes" }, { condition: "salvage" }, { relaxations: ["Radius 50"] }, { electrificationTypes: ["steam"] }, { doors: NaN }])
    assert.equal(buildRequirements(bad as never), null, JSON.stringify(bad));
});
test("requirements carry no location and no caller data, and the guard sees them if they ever appear", () => {
  const r = buildRequirements({ make: "Honda", model: "CR-V", zip: "90210", radiusMiles: 50, state: "CA", vehicleNeeds: ["family"] } as never)!;
  assert.equal(hasForbiddenKey(r), false); assert.deepEqual(Object.keys(r).sort(), ["make", "models"]);
  assert.equal(hasForbiddenKey({ a: { zip: "90210" } }), true); assert.equal(hasForbiddenKey({ distance: 3 }), true);
});
test("references are random, 12 characters, from the clear alphabet", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newReference())); assert.equal(seen.size, 200);
  for (const r of seen) assert.match(r, REF_PATTERN);
  assert.equal(REF_PATTERN.test("abc"), false); assert.equal(REF_PATTERN.test("ABCDEFGHJKMN"), false);
});
test("write then read gives the same list; the expiry is 24 hours from the write", async () => {
  const { db, rows } = fakeDb(); const now = 1_000_000;
  const slate = mkSlate(); const req = buildRequirements({ make: "Honda", model: "CR-V" })!;
  const ref = await writeSlate(db, now, slate, req); assert.ok(ref && REF_PATTERN.test(ref));
  assert.equal(rows.get(ref!)!.expires, now + SLATE_TTL_MS);
  const got = await readSlate(db, now + 1000, ref!); assert.equal(got.status, "ok");
  if (got.status === "ok") { assert.deepEqual(got.slate, slate); assert.deepEqual(got.requirements, req); assert.equal(got.expiresAtMs, now + SLATE_TTL_MS); }
});
test("an expired list is expired at once by its stored time, then removed; unknown and badly formed references say unknown", async () => {
  const { db, rows } = fakeDb(); const now = 5_000_000;
  const ref = (await writeSlate(db, now, mkSlate(), {}))!;
  assert.equal((await readSlate(db, now + SLATE_TTL_MS - 1, ref)).status, "ok");
  assert.equal((await readSlate(db, now + SLATE_TTL_MS, ref)).status, "expired"); assert.equal(rows.has(ref), false);
  assert.equal((await readSlate(db, now, "zzzzzzzzzzzz")).status, "unknown"); assert.equal((await readSlate(db, now, "nope")).status, "unknown");
});
test("a first-search write first deletes expired rows", async () => {
  const { db, rows } = fakeDb(); const t0 = 1000;
  const old = (await writeSlate(db, t0, mkSlate(), {}))!; assert.ok(rows.has(old));
  await writeSlate(db, t0 + SLATE_TTL_MS + 1, mkSlate(), {}); assert.equal(rows.has(old), false); assert.equal(rows.size, 1);
});
test("the commit is a compare-and-swap: the first request wins, the second sees a conflict", async () => {
  const { db } = fakeDb(); const now = 10_000; const slate = mkSlate(); const ref = (await writeSlate(db, now, slate, {}))!;
  const a = { ...slate, version: slate.version + 1 }, b = { ...slate, version: slate.version + 1 };
  assert.equal(await commitSlate(db, now, ref, slate.version, a, {}), true);
  assert.equal(await commitSlate(db, now, ref, slate.version, b, {}), false, "stale version loses");
  assert.equal(await commitSlate(db, now + SLATE_TTL_MS + 1, ref, a.version, { ...a, version: a.version + 1 }, {}), false, "an expired list cannot be committed");
});
test("any database failure: the write returns null (no hint), the read says unavailable (never unknown), the commit says no", async () => {
  const boom: Queryable = { async query() { throw new Error("down"); } };
  assert.equal(await writeSlate(boom, 1, mkSlate(), {}), null);
  assert.deepEqual(await readSlate(boom, 1, "abcdefghjkmn"), { status: "unavailable" });
  assert.equal(await commitSlate(boom, 1, "abcdefghjkmn", 1, mkSlate(), {}), false);
});
test("a list holding location or caller data is never written", async () => {
  const { db, rows } = fakeDb(); assert.equal(await writeSlate(db, 1, mkSlate(), { zip: "90210" } as never), null); assert.equal(rows.size, 0);
});
test("the row cap removes the oldest first", async () => {
  const { db, rows } = fakeDb();
  for (let i = 0; i < 10_000; i++) rows.set(`seed${i}`, { expires: 1e15, version: 1, first: 8, body: "{}", created: i });
  await writeSlate(db, 1, mkSlate(), {}); assert.equal(rows.size, 10_000); assert.equal(rows.has("seed0"), false); assert.equal(rows.has("seed9999"), true);
});
