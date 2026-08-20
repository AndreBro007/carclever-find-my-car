# CarClever - Find My Car

A lean MCP server for fast, trustworthy used-vehicle matching, built on
Starter-tier Auto.dev endpoints only (VIN Decode, Listings, Photos).

**This is a scaffold** — structure, real reusable modules, and tool stubs are
in place; the actual search/match/scoring logic is not yet implemented. See
`app/[transport]/route.ts` for TODOs.

## Design source of truth
Full design decisions live in the `carclever-widget` repo (GitHub), not here:
- `DECISIONS.md` — SYS-20260812-001 through 027 covers the full design arc
- `specs/CarClever_Snap_Build_Spec_v0.1.md` — stack + reuse/rebuild verdict
- `specs/FindMyCar_Response_Schema_v0.1.md` — response schema, canonical
  schema alignment, intent parsing reference
- `reference/source-exports/` — real confirmed source for the ported modules

## What's real vs. stubbed
- `lib/edmunds-cj.ts`, `lib/fuel-type.ts`, `lib/dealer-name.ts` — ported
  verbatim from the confirmed flagship source (SYS-20260812-020). Real,
  not placeholders.
- `lib/corpus-count.ts` — ported pattern, but the fallback figure is
  deliberately vague ("several million") pending resolution of a real
  discrepancy (3.6M live vs. 4.4M hardcoded fallback, SYS-20260812-021).
- `lib/capabilities.ts` — the modular capability-flag pattern (SYS-20260812-012).
- `app/[transport]/route.ts` — three tools registered (`find_matching_vehicle`,
  `get_vehicle_photos`, `resolve_dealer_url`) with locked names/descriptions,
  but the actual search/scoring pipeline is a stub.

## Hosting
Target: `findmycar.getcarwise.app` (Vercel, CNAME from Porkbun — not yet
configured, SYS-20260812-026).

## Not yet started
Intent parser, diversity pass, VIN cross-check, Match Score calculation,
relaxation-penalty formula (deliberately deferred pending real data,
SYS-20260812-013).

<!-- Deploy trigger: 1787213834 -->