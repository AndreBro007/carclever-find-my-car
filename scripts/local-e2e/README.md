# Local end-to-end test of the catalogue app (no Vercel needed)

Real app + real loader + local PostgreSQL + live NHTSA vPIC decoder. Only api.nhtsa.gov (ratings) is stubbed with MADE-UP values in the real response layout, because the Claude sandbox could not reach that host on Oct 13, 2026.

1. Local PostgreSQL: create a database and a superuser role (tests also need TEST_DATABASE_URL, otherwise the database tests skip).
2. python3 collect_feed.py  -> /tmp/e2e_feed.tsv (27 columns, real listings found through the live test app).
3. DATABASE_URL_DIRECT=postgres://USER:PASS@localhost:5432/DB npx tsx scripts/catalog-load.ts /tmp/e2e_feed.tsv
4. LISTING_SOURCE=catalog_db DATABASE_URL=postgres://USER:PASS@localhost:5432/DB IMAGE_PROXY_SECRET=x NODE_OPTIONS="--require=$PWD/scripts/local-e2e/stub_nhtsa.cjs" setsid nohup npx next dev -p 3100 > /tmp/next.log 2>&1 < /dev/null &
5. python3 scripts/local-e2e/e2e_local.py  (six searches; prints which new fields appear)
Pitfalls: next dev rewrites tsconfig.json and creates next-env.d.ts (revert before committing); never run pkill -f "next dev" in the same command (use "next[ ]dev"); start the server detached.
