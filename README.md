# CarClever - Find My Car

A live MCP server for vehicle search and matching across current U.S. new and used inventory. Built on Auto.dev's Starter tier (VIN Decode, Listings, Photos endpoints).

**Status: Production live at `carclever-find-my-car.vercel.app`**

## What this app does

- Searches current U.S. new and used vehicle inventory by make, model, year, price, mileage, body type, and powertrain
- Hard-filters on user-specified criteria (e.g. price ceiling, max mileage)
- Ranks matches using one of five priority axes: `best_for_budget`, `cheapest`, `lowest_mileage`, `newest`, `lower_risk`
  - `lower_risk` ranks by reported purchase-risk evidence (accident history, CPO status, VIN identity verification) — it is not a vehicle safety guarantee
- Supplies exact-VIN Buyer Check: accident history, CPO status, VIN identity verification
- Links results to Edmunds (Commission Junction affiliate) listing or similar-options pages where available

## Architecture

- **Next.js** on Vercel (serverless)
- **Auto.dev API** for live inventory (Starter tier: VIN Decode, Listings, Photos)
- **MCP Apps** for visual result cards (SEP-1865 standard, supports Claude and ChatGPT)
- **Zod** for input/output validation
- **TypeScript** throughout

See `TESTING.md` for the deterministic regression and release workflow.

## For contributors / AI coding sessions

Before making changes, read `TESTING.md` — it describes the test-first workflow and release gates. Run `npm test` to validate any code change.

All regression suites are deterministic and offline (no network calls, no mutable state).

## Production operation

Deployed SHA always matches `main` branch in GitHub. Vercel deployment status is the source of truth for live status.

## Docs & decisions

Design decisions, provider data audit, API contracts, and field handling live in the `carclever-widget` repo:
- `DECISIONS.md` — full decision history
- `specs/Auto_Dev_Field_Audit_v1.md` — provider field reliability and coercion rules
- `STATE.md` — current session and session archive

<!-- Remove outputSchema from find_matching_vehicle (c8a5c36) -->
