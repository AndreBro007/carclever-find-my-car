/**
 * Daily loader: stream the feed (tab-separated text) into a staging table with COPY, check it is sane,
 * then merge into the live tables in ONE transaction (insert new, update changed, delete vanished).
 * A truncated or empty download can never wipe the catalogue: the merge aborts below the safety floor.
 */
import zipcodes from "zipcodes";
import { from as copyFrom } from "pg-copy-streams";
import type { Pool } from "pg";
import { once } from "node:events";
import { headerIndex, parseRow, type CatalogRow } from "./normalize";
import { SCHEMA_SQL, STAGE_COLUMNS } from "./schema";

export interface LoadOptions {
  /** Abort if the feed has fewer parsed rows than this (default 1). */
  minRows?: number;
  /** Abort if the feed has fewer rows than this fraction of what is already stored (default 0.9). */
  keepRatio?: number;
  log?: (msg: string) => void;
}
export interface LoadReport {
  linesRead: number;
  parsed: number;
  skipped: Record<string, number>;
  staged: number;
  inserted: number;
  updated: number;
  deleted: number;
  seconds: number;
}

const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const cell = (v: unknown): string => (v === null || v === undefined ? "\\N" : esc(String(v)));

export function stageLine(r: CatalogRow): string {
  const geo = r.dealerZip ? zipcodes.lookup(r.dealerZip) : undefined;
  const lat = geo ? geo.latitude : null;
  const lon = geo ? geo.longitude : null;
  const vals: unknown[] = [
    r.id, r.vin, r.year, r.make, r.makeKey, r.model, r.modelKey, r.trim, r.condition, r.price, r.odometer,
    r.bodyRaw, r.bodyClass, r.doors, r.extColor, r.intColor, r.dealerId, r.dealerState, r.dealerZip, lat, lon,
    r.imageUrl, r.linkOverride, r.dealerName, r.dealerStreet, r.dealerCity,
  ];
  return vals.map(cell).join("\t") + "\n";
}

export async function loadFeed(pool: Pool, lines: AsyncIterable<string>, opts: LoadOptions = {}): Promise<LoadReport> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const client = await pool.connect();
  let copy: { destroy?: () => void } | null = null;
  let copyDone = false;
  let copyError: Error | null = null;
  let dropConnection = false;
  const report: LoadReport = { linesRead: 0, parsed: 0, skipped: {}, staged: 0, inserted: 0, updated: 0, deleted: 0, seconds: 0 };
  try {
    await client.query(SCHEMA_SQL);
    await client.query("TRUNCATE listing_stage");
    const stream = client.query(copyFrom(`COPY listing_stage (${STAGE_COLUMNS.join(", ")}) FROM STDIN`));
    copy = stream;
    stream.on("error", (e: Error) => { copyError = e; });
    let idx: Record<string, number> | null = null;
    for await (const line of lines) {
      if (line === "") continue;
      report.linesRead++;
      if (!idx) { idx = headerIndex(line); continue; }
      const res = parseRow(line.split("\t"), idx);
      if ("skip" in res) { report.skipped[res.skip] = (report.skipped[res.skip] ?? 0) + 1; continue; }
      report.parsed++;
      if (!stream.write(stageLine(res.row))) await once(stream, "drain");
      if (report.parsed % 200_000 === 0) log(`staged ${report.parsed} rows`);
    }
    if (!idx) throw new Error("feed was empty (no header line)");
    stream.end();
    await once(stream, "finish");
    copyDone = true;
    if (copyError) throw copyError;

    const staged = Number((await client.query("SELECT count(*) FROM listing_stage")).rows[0].count);
    const existing = Number((await client.query("SELECT count(*) FROM listing")).rows[0].count);
    report.staged = staged;
    const floor = Math.max(opts.minRows ?? 1, Math.floor(existing * (opts.keepRatio ?? 0.9)));
    if (staged < floor) throw new Error(`refusing to merge: feed has ${staged} rows but at least ${floor} are required (stored: ${existing})`);

    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO dealer (id, name, street, city, state, zip, lat, lon)
        SELECT DISTINCT ON (dealer_id) dealer_id, dealer_name, dealer_street, dealer_city, state, zip, lat, lon
        FROM listing_stage WHERE dealer_id IS NOT NULL ORDER BY dealer_id
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, street = EXCLUDED.street, city = EXCLUDED.city,
          state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lon = EXCLUDED.lon`);
      const cols = "id, vin, year, make, make_key, model, model_key, trim, condition, price, odometer, body_raw, body_class, doors, ext_color, int_color, dealer_id, state, zip, lat, lon, image_url, link_override";
      const up = await client.query(`
        WITH up AS (
          INSERT INTO listing (${cols})
          SELECT DISTINCT ON (id) ${cols} FROM listing_stage ORDER BY id
          ON CONFLICT (id) DO UPDATE SET vin = EXCLUDED.vin, year = EXCLUDED.year, make = EXCLUDED.make, make_key = EXCLUDED.make_key,
            model = EXCLUDED.model, model_key = EXCLUDED.model_key, trim = EXCLUDED.trim, condition = EXCLUDED.condition,
            price = EXCLUDED.price, odometer = EXCLUDED.odometer, body_raw = EXCLUDED.body_raw, body_class = EXCLUDED.body_class,
            doors = EXCLUDED.doors, ext_color = EXCLUDED.ext_color, int_color = EXCLUDED.int_color, dealer_id = EXCLUDED.dealer_id,
            state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lon = EXCLUDED.lon, image_url = EXCLUDED.image_url,
            link_override = EXCLUDED.link_override, loaded_at = now()
          WHERE (listing.price, listing.odometer, listing.condition, listing.image_url, listing.link_override, listing.dealer_id, listing.body_class, listing.trim, listing.make, listing.model, listing.year)
                IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.odometer, EXCLUDED.condition, EXCLUDED.image_url, EXCLUDED.link_override, EXCLUDED.dealer_id, EXCLUDED.body_class, EXCLUDED.trim, EXCLUDED.make, EXCLUDED.model, EXCLUDED.year)
          RETURNING (xmax = 0) AS inserted)
        SELECT count(*) FILTER (WHERE inserted)::int AS ins, count(*) FILTER (WHERE NOT inserted)::int AS upd FROM up`);
      report.inserted = up.rows[0].ins; report.updated = up.rows[0].upd;
      const del = await client.query("DELETE FROM listing l WHERE NOT EXISTS (SELECT 1 FROM listing_stage s WHERE s.id = l.id)");
      report.deleted = del.rowCount ?? 0;
      await client.query(`INSERT INTO catalog_meta (key, value) VALUES ('last_load', $1), ('rows', $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [new Date().toISOString(), String(staged)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    await client.query("TRUNCATE listing_stage");
    await client.query("ANALYZE listing");
    report.seconds = Math.round((Date.now() - t0) / 100) / 10;
    log(`loaded: parsed ${report.parsed}, inserted ${report.inserted}, updated ${report.updated}, deleted ${report.deleted}, ${report.seconds}s`);
    return report;
  } catch (e) {
    // A COPY that was never finished leaves the connection unusable: close it instead of returning it to the pool.
    if (!copyDone) {
      dropConnection = true;
      try { copy?.destroy?.(); } catch { /* already closed */ }
    }
    throw e;
  } finally {
    client.release(dropConnection ? true : undefined);
  }
}
