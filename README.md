# CarClever - Find My Car

A live MCP server for fast, trustworthy vehicle matching across current U.S. new, used, certified pre-owned, and demo inventory. Built on Auto.dev's Starter tier (VIN Decode, Listings, Photos endpoints).

**Status: Production live at `carclever-find-my-car.vercel.app`**

## What this app does

- Searches current U.S. vehicle inventory by make, model, year, price, mileage, body type, powertrain, features, and buyer intent (e.g., "cheapest," "lowest mileage," "lower risk")
- Hard-filters on user-specified criteria (price ceiling, max mileage, required features)
- Ranks matches using settled formulas for best-for-budget (value-based), cheapest, lowest-mileage, newest, and lower-risk (safety/history) prioritization
- Supplies exact-VIN Buyer Check: accident history, CPO status, VIN identity verification
- Links all results to Edmunds affiliate (Commission Junction) for dealer availability and pricing
- Supports flexible buyer intent parsing ("reliable hybrid under $40k," "low-risk towing truck," "safe car for a teen driver")

## Architecture

- **Next.js** on Vercel (serverless)
- **Auto.dev API** for live inventory (Starter tier: 3 endpoints, no recurring subscription required)
- **MCP Apps** for visual result cards (SEP-1865 standard, supports Claude and ChatGPT)
- **Zod** for input/output validation
- **TypeScript** throughout

See `TESTING.md` for the deterministic regression and release workflow.

## For contributors / AI coding sessions

Before making changes, read `TESTING.md` — it describes the test-first workflow and release gates. Run `npm test` to validate any code change.

All regression suites are deterministic and offline (no network calls, no mutable state).

## Production operation

Deployed SHA always matches `main` branch in GitHub. Vercel deployment status is the source of truth for live status. Production monitoring via direct MCP tool calls and host-level smoke tests (documented in `TESTING.md`).

## Docs & decisions

Design decisions, provider data audit, API contracts, and field handling live in the `carclever-widget` repo:
- `DECISIONS.md` — full decision history
- `specs/Auto_Dev_Field_Audit_v1.md` — provider field reliability and coercion rules
- `STATE.md` — current session and session archive





















<!-- Remove outputSchema from find_matching_vehicle (c8a5c36) -->