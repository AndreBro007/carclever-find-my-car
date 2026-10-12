/**
 * Load the Edmunds rich feed into the catalogue database.
 *   npx tsx scripts/catalog-load.ts <feed.txt.gz | feed.txt> [--expect-rows N]
 * Env: DATABASE_URL_DIRECT (preferred: a direct, non-pooled connection) or DATABASE_URL.
 * Aborts (changing nothing) when the feed is empty, truncated (below 90% of what is stored) or below 97% of --expect-rows.
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { Pool } from "pg";
import { loadFeed } from "../lib/catalog-db/load";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: catalog-load.ts <feed.txt.gz> [--expect-rows N]");
  const i = process.argv.indexOf("--expect-rows");
  const expect = i > 0 ? Number(process.argv[i + 1]) : 0;
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL is required");
  const raw = createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const report = await loadFeed(pool, rl, { minRows: expect > 0 ? Math.floor(expect * 0.97) : 1, log: (m) => console.log(m) });
    console.log(JSON.stringify(report));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error("LOAD FAILED:", e instanceof Error ? e.message : String(e)); process.exit(1); });
