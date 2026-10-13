#!/usr/bin/env bash
# Loads the verified feed into the database. SAMPLE_EVERY=N loads every Nth car (test mode for a small database).
set -euo pipefail
FEED="${1:-feed.txt.gz}"
: "${DATABASE_URL_DIRECT:?DATABASE_URL_DIRECT is not set}"
if [ -n "${SAMPLE_EVERY:-}" ]; then
  npx tsx scripts/catalog-load.ts "$FEED" --sample-every "$SAMPLE_EVERY"
else
  npx tsx scripts/catalog-load.ts "$FEED" --expect-rows 1300000
fi
