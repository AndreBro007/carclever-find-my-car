# CarClever – Buying Assistant

A remote MCP server that helps US shoppers find and compare new and used cars from inside an AI chat. It searches a daily-refreshed catalogue of US dealer listings, checks vehicles by VIN with NHTSA data, and links each car to its Edmunds listing.

**Live MCP endpoint:** `https://carclever-db.getcarwise.app/mcp` (Streamable HTTP, no sign-in, no API key)

Built by GetCarWise (Broekman Consulting Pty Ltd) · https://getcarwise.app · MIT licence

## What it does

- Search new and used listings by make, model, price, year, mileage, body style, drivetrain, ZIP and radius, including hybrid and electric options
- Choose a ranking priority: best for budget, cheapest, lowest mileage or newest
- Refine a search in conversation and browse the results as vehicle cards
- Spot price drops and compare a shortlist of two to four cars side by side
- Check a vehicle by VIN, with decoding and recall information from NHTSA
- Take the next step with the dealer through Edmunds. Edmunds links are affiliate links and are disclosed

## Tools

| Tool | Purpose |
|---|---|
| `find_matching_vehicle` | Search listings and rank matches |
| `check_vehicle` | Check a car by VIN (NHTSA decoding and recalls) |
| `compare_vehicles` | Compare two to four cars |
| `get_edmunds_vehicle_link` | Return the Edmunds link for a chosen car |

All four tools are read-only.

## Connect

Add the endpoint as a remote MCP server (custom connector) in any client that supports Streamable HTTP. No sign-in and no API key are needed.

```json
{
  "mcpServers": {
    "carclever": { "url": "https://carclever-db.getcarwise.app/mcp" }
  }
}
```

Example prompts:

- Find a used Toyota RAV4 under $30,000 near 90210
- Show me all-wheel-drive SUVs under $45,000 near 90210, then compare my top three
- Check the VIN of the car I picked and show any recalls

## Data

- **Listings:** the Edmunds catalogue, supplied through Impact and loaded once a day into a Neon Postgres database by a scheduled job (`scripts/fetch-feed.sh`, `scripts/load-feed.sh`). It is a daily refresh, not a real-time feed.
- **Vehicle data:** decoding, specifications, recalls and ratings from NHTSA.
- **Not in the data:** the catalogue feed carries no accident history, ownership history, Carfax link or certified-pre-owned status. When a buyer asks for those, the result is reported as unconfirmed and the buyer is pointed to the dealer.
- **Search log:** stores only make, model, price band, state and result counts.

## Architecture

- Next.js on Vercel (serverless), TypeScript, Zod validation
- Neon Postgres for the catalogue; NHTSA lookups
- MCP served with `mcp-handler`; MCP Apps cards for results and comparisons
- `/api/catalog-status` reports catalogue size and the last load

## Branches

- `release/catalog`: the live Buying Assistant (this README)
- `catalog-db/v1`: the same code on the test and nightly-load track, kept level with `release/catalog`
- `release/v2`: CarClever – Find My Car, a separate app on a different data source (Auto.dev)

## Run and test

- `npm install`, `npm run dev`, `npm test`
- Configuration names are in `.env.example`
- Database tests need a local PostgreSQL (`TEST_DATABASE_URL`) and are skipped without one. See `TESTING.md` and `scripts/local-e2e/README.md`.

## Licence

MIT, see `LICENSE`. The code licence does not cover listing data, Edmunds content or trademarks, which stay subject to their owners' terms.

## Contact

info@getcarwise.app · https://getcarwise.app
