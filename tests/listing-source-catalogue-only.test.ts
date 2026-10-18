// Catalogue edition: the third-party listings client and the live-Edmunds mode are gone. Guards what changed with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { catalogOutputActive } from "../lib/catalog-output";
import { searchListingsLean, getListingByVin, getModelFacets } from "../lib/listing-source";

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  return Promise.resolve(fn()).finally(restore);
}

test("database output is always on: LISTING_SOURCE no longer changes anything", async () => {
  for (const v of [undefined, "", "auto", "auto_dev", "edmunds_catalog", "catalog_db"]) {
    await withEnv({ LISTING_SOURCE: v }, () => assert.equal(catalogOutputActive(), true));
  }
});

test("database not configured: a search is a friendly service error, not 'no cars'; lookups stay quiet", async () => {
  await withEnv({ DATABASE_URL: undefined }, async () => {
    const r = await searchListingsLean({ make: "Honda", model: "Civic" });
    assert.ok(r.error, "must report a service error");
    assert.match(r.error!, /coffee break/);
    assert.equal(r.source, "catalog_db");
    assert.equal(await getListingByVin("1HGCV1F34MA000001"), null);
    assert.deepEqual(await getModelFacets({ model: "Civic" }), []);
  });
});

test("no source file calls the old listings API, reads its key, or contains the removed live-Edmunds source", () => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name)) {
      const t = fs.readFileSync(p, "utf8");
      if (/api\.auto\.dev|AUTO_DEV_API_KEY|edmunds_catalog|api\.impact\.com\/Mediapartners/.test(t)) hits.push(p);
    } } };
  walk("app"); walk("lib");
  assert.deepEqual(hits, []);
  assert.equal(fs.existsSync("lib/catalog-source.ts"), false);
});
