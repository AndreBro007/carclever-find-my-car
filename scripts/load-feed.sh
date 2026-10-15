#!/usr/bin/env bash
# Loads the verified feed into the database. SAMPLE_EVERY=N loads every Nth car (test mode for a small database).
# The .gz is first decompressed with gzip (the same tool that verified the header in fetch-feed.sh) and the header is
# checked AGAIN on the plain file, so the loader only ever reads a file whose first line is proven to be the rich header.
# Prints facts only (sizes, counts, header column names); never credentials, never car rows.
set -euo pipefail
FEED="${1:-feed.txt.gz}"
: "${DATABASE_URL_DIRECT:?DATABASE_URL_DIRECT is not set}"
# Run record (evidence for scheduler timing): one row per run, written before the load. Never stops the load.
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL_DIRECT" -q -c "CREATE TABLE IF NOT EXISTS load_log (id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), trigger text, run_id text, run_attempt int)" -c "INSERT INTO load_log (trigger, run_id, run_attempt) VALUES ('${GITHUB_EVENT_NAME:-unknown}', '${GITHUB_RUN_ID:-unknown}', ${GITHUB_RUN_ATTEMPT:-0})" || echo "run record not written (continuing)"
else
  echo "run record skipped: psql not installed (continuing)"
fi
PLAIN="$FEED"
if [[ "$FEED" == *.gz ]]; then
  PLAIN="${FEED%.gz}"
  trap 'rm -f "$PLAIN"' EXIT
  gzip -dc "$FEED" > "$PLAIN"
fi
hdr=$(head -n1 "$PLAIN" | tr -d '\r\357\273\277')
cols=$(printf '%s' "$hdr" | awk -F'\t' '{print NF}')
echo "plain file: $(stat -c %s "$PLAIN") bytes | first line: ${#hdr} chars, $cols columns"
if [ "$cols" -ne 27 ] || [[ "$hdr" != id$'\t'title$'\t'* ]]; then
  echo "LOAD REFUSED: the first line of the decompressed file is not the rich 27-column header (it starts with: $(printf '%s' "$hdr" | cut -c1-12)). Nothing was loaded."
  exit 1
fi
echo "header OK, begins: $(printf '%s' "$hdr" | cut -c1-110 | tr '\t' '|')"
if [ -n "${SAMPLE_EVERY:-}" ]; then
  npx tsx scripts/catalog-load.ts "$PLAIN" --sample-every "$SAMPLE_EVERY"
else
  npx tsx scripts/catalog-load.ts "$PLAIN" --expect-rows 1300000
fi
