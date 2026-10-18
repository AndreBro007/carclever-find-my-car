// Catalogue edition: the third-party listings client is gone. Guards the three behaviours that changed with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configuredMode } from "../lib/source-mode";
import { activeSource, searchListingsLean, getListingByVin, getModelFacets } from "../lib/listing-source";

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  return Promise.resolve(fn()).finally(restore);
}

test("an unset or unknown LISTING_SOURCE means the catalogue database (never a different output mode)", async () => {
  for (const v of [undefined, "", "auto", "auto_dev", "nonsense", "CATALOG_DB"]) {
    await withEnv({ LISTING_SOURCE: v }, () => { assert.equal(configuredMode(), "catalog_db"); assert.equal(activeSource(), "catalog_db"); });
  }
  await withEnv({ LISTING_SOURCE: "edmunds_catalog" }, () => assert.equal(activeSource(), "edmunds_catalog"));
});

test("database not configured: a search is a service error, not 'no cars'; lookups stay quiet", async () => {
  await withEnv({ LISTING_SOURCE: "catalog_db", DATABASE_URL: undefined }, async () => {
    const r = await searchListingsLean({ make: "Honda", model: "Civic" });
    assert.ok(r.error, "must report a service error");
    assert.equal(r.source, "catalog_db");
    assert.equal(await getListingByVin("1HGCV1F34MA000001"), null);
    assert.deepEqual(await getModelFacets({ model: "Civic" }), []);
  });
});

test("no source file calls the third-party listings API or reads its key", () => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/^tests\//.test(p.replace(/\\/g, "/"))) {
      const t = fs.readFileSync(p, "utf8");
      if (/api\.auto\.dev|AUTO_DEV_API_KEY/.test(t)) hits.push(p);
    } } };
  walk("app"); walk("lib");
  assert.deepEqual(hits, []);
});
