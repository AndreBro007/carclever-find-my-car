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
  /** Test mode for a small database: load only every Nth car (for example 5 loads a fifth of the feed). */
  sampleEvery?: number;
  log?: (msg: string) => void;
}
export interface LoadReport {
  /** Cars whose body class came from their model (the feed gave none, or a label that is no body style). */
  bodyClassInferred: number;
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

/**
 * Body class for cars the feed does not classify (SYS-20261021-047, tightened in SYS-20261022-055 after ChatGPT's review finding BA22-05 and the real Neon numbers: of 37,351 cars the first rule
 * would have classified, 3,621 sat in models whose classified cars agree less than 95%). A car with no body class, or the class "other", takes the class of the cars of the SAME make, model and
 * model year, and of the same door count when the car has one, when at least 3 of those cars are classified and at least 95% of them are in one class. A car with no door count only
 * takes a class when all doors agree (the 95% rule over the whole model year AND no door group of its own that leans another way: a group's own majority, or a tie, in a different class blocks it,
 * review R2-03: 100 four-door sedans and 3 two-door coupes must not turn an unknown-door car into a sedan), so a model sold as a sedan and a coupe in one year is never guessed. A model year with no classified cars gives no evidence (an older generation is not
 * judged by a newer one). Cars the feed classified are never touched. The raw label is kept as it came.
 */
export const INFER_BODY_CLASS_SQL = `
  WITH v1 AS (
    SELECT make_key, model_key, year, doors, body_class, count(*) AS n,
           sum(count(*)) OVER (PARTITION BY make_key, model_key, year, doors) AS total
    FROM listing_stage
    WHERE body_class IS NOT NULL AND body_class <> 'other' AND doors IS NOT NULL
    GROUP BY make_key, model_key, year, doors, body_class
  ), p1 AS (
    SELECT DISTINCT ON (make_key, model_key, year, doors) make_key, model_key, year, doors, body_class
    FROM v1 WHERE total >= 3 AND n >= 0.95 * total
    ORDER BY make_key, model_key, year, doors, n DESC
  ), v2 AS (
    SELECT make_key, model_key, year, body_class, count(*) AS n,
           sum(count(*)) OVER (PARTITION BY make_key, model_key, year) AS total
    FROM listing_stage
    WHERE body_class IS NOT NULL AND body_class <> 'other'
    GROUP BY make_key, model_key, year, body_class
  ), p2 AS (
    SELECT DISTINCT ON (make_key, model_key, year) make_key, model_key, year, body_class
    FROM v2 WHERE total >= 3 AND n >= 0.95 * total
      AND NOT EXISTS (SELECT 1 FROM v1 WHERE v1.make_key = v2.make_key AND v1.model_key = v2.model_key AND v1.year = v2.year
                        AND v1.body_class <> v2.body_class AND v1.n * 2 >= v1.total)
    ORDER BY make_key, model_key, year, n DESC
  ), pick AS (
    SELECT s.id, CASE WHEN s.doors IS NOT NULL THEN p1.body_class ELSE p2.body_class END AS body_class
    FROM listing_stage s
    LEFT JOIN p1 ON s.doors IS NOT NULL AND p1.make_key = s.make_key AND p1.model_key = s.model_key AND p1.year = s.year AND p1.doors = s.doors
    LEFT JOIN p2 ON s.doors IS NULL AND p2.make_key = s.make_key AND p2.model_key = s.model_key AND p2.year = s.year
    WHERE s.body_class IS NULL OR s.body_class = 'other'
  )
  UPDATE listing_stage s SET body_class = pick.body_class
  FROM pick WHERE s.id = pick.id AND pick.body_class IS NOT NULL`;

export async function loadFeed(pool: Pool, lines: AsyncIterable<string>, opts: LoadOptions = {}): Promise<LoadReport> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const client = await pool.connect();
  let copy: { destroy?: () => void } | null = null;
  let copyDone = false;
  let copyError: Error | null = null;
  let dropConnection = false;
  const report: LoadReport = { bodyClassInferred: 0, linesRead: 0, parsed: 0, skipped: {}, staged: 0, inserted: 0, updated: 0, deleted: 0, seconds: 0 };
  try {
    await client.query(SCHEMA_SQL);
    await client.query("TRUNCATE listing_stage");
    const stream = client.query(copyFrom(`COPY listing_stage (${STAGE_COLUMNS.join(", ")}) FROM STDIN`));
    copy = stream;
    stream.on("error", (e: Error) => { copyError = e; });
    let idx: Record<string, number> | null = null;
    let dataRow = 0;
    const every = opts.sampleEvery && opts.sampleEvery > 1 ? Math.floor(opts.sampleEvery) : 0;
    for await (const line of lines) {
      if (line === "") continue;
      report.linesRead++;
      if (!idx) { idx = headerIndex(line); continue; }
      dataRow++;
      if (every && dataRow % every !== 0) { report.skipped["not in sample"] = (report.skipped["not in sample"] ?? 0) + 1; continue; }
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

    const inferred = await client.query(INFER_BODY_CLASS_SQL);
    report.bodyClassInferred = inferred.rowCount ?? 0;
    log(`body class taken from the model for ${report.bodyClassInferred} cars`);

    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO dealer (id, name, street, city, state, zip, lat, lon)
        SELECT DISTINCT ON (dealer_id) dealer_id, dealer_name, dealer_street, dealer_city, state, zip, lat, lon
        FROM listing_stage WHERE dealer_id IS NOT NULL ORDER BY dealer_id
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, street = EXCLUDED.street, city = EXCLUDED.city,
          state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lon = EXCLUDED.lon`);
      const cols = "id, vin, year, make, make_key, model, model_key, trim, condition, price, odometer, body_raw, body_class, doors, ext_color, int_color, dealer_id, state, zip, lat, lon, image_url, link_override";
      // Change test (review finding 1): every column the app reads must be in this tuple, or a corrected colour, door count, VIN or
      // location is skipped as "unchanged". make_key and model_key follow make and model, which are already watched. Rows with no real
      // change are still left alone (no rewrite just to touch loaded_at).
      const up = await client.query(`
        WITH up AS (
          INSERT INTO listing (${cols}, first_seen)
          SELECT DISTINCT ON (id) ${cols}, ${existing > 0 ? "current_date" : "NULL::date"} FROM listing_stage ORDER BY id
          ON CONFLICT (id) DO UPDATE SET vin = EXCLUDED.vin, year = EXCLUDED.year, make = EXCLUDED.make, make_key = EXCLUDED.make_key,
            model = EXCLUDED.model, model_key = EXCLUDED.model_key, trim = EXCLUDED.trim, condition = EXCLUDED.condition,
            price = EXCLUDED.price, odometer = EXCLUDED.odometer, body_raw = EXCLUDED.body_raw, body_class = EXCLUDED.body_class,
            doors = EXCLUDED.doors, ext_color = EXCLUDED.ext_color, int_color = EXCLUDED.int_color, dealer_id = EXCLUDED.dealer_id,
            state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lon = EXCLUDED.lon, image_url = EXCLUDED.image_url,
            link_override = EXCLUDED.link_override, loaded_at = now(),
            price_prev = CASE WHEN listing.price IS NOT NULL AND EXCLUDED.price IS NOT NULL AND listing.price <> EXCLUDED.price THEN listing.price ELSE listing.price_prev END,
            price_changed_at = CASE WHEN listing.price IS NOT NULL AND EXCLUDED.price IS NOT NULL AND listing.price <> EXCLUDED.price THEN current_date ELSE listing.price_changed_at END
          WHERE (listing.price, listing.odometer, listing.condition, listing.image_url, listing.link_override, listing.dealer_id, listing.body_class, listing.trim, listing.make, listing.model, listing.year, listing.vin, listing.body_raw, listing.doors, listing.ext_color, listing.int_color, listing.state, listing.zip, listing.lat, listing.lon)
                IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.odometer, EXCLUDED.condition, EXCLUDED.image_url, EXCLUDED.link_override, EXCLUDED.dealer_id, EXCLUDED.body_class, EXCLUDED.trim, EXCLUDED.make, EXCLUDED.model, EXCLUDED.year, EXCLUDED.vin, EXCLUDED.body_raw, EXCLUDED.doors, EXCLUDED.ext_color, EXCLUDED.int_color, EXCLUDED.state, EXCLUDED.zip, EXCLUDED.lat, EXCLUDED.lon)
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
