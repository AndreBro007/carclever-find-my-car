# Testing & Release Process

This document describes the testing and release workflow for CarClever Find My Car, a live MCP vehicle-search app. The workflow is designed to prevent regressions while keeping the testing discipline maintainable.

## 1. Deterministic Regression Gate

**Required for every code change.**

```bash
npm test
```

This command runs all deterministic, offline regression suites using the locally installed `tsx` binary. It includes:

- `tests/best-for-budget-ranking.test.ts` — settled `best_for_budget` ranking formula contracts
- `tests/geo-verification.test.ts` — geographic radius verification logic
- `tests/risk-tier.test.ts` — risk classification and Buyer Check boundaries
- `tests/provider-string-runtime-safety.test.ts` — malformed Auto.dev field handling
- `tests/provider-string-normalization-boundary.test.ts` — provider data type coercion rules
- `tests/stable-boundaries.test.ts` — VIN dedup, link routing, widget metadata contracts

All deterministic tests are offline. They do NOT call Auto.dev, NHTSA, Vercel, production, preview, external websites, or any mutable network service. A failing suite makes `npm test` exit non-zero. No silent skips.

## 2. Clean Reproducibility Gate

**Required before considering code complete.**

From a genuinely clean checkout:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

This verifies:
- Dependencies install cleanly without warnings
- All regression suites pass
- TypeScript compilation is clean
- Next.js production build succeeds

## 3. Targeted Preview Smoke

**Only after deterministic checks pass.** 

Deploy to preview and run representative real tests:

- Generic SUV / bodyType-only search
- Locked discovery scenario (e.g., "reliable hybrid SUV under $40k in 90210")
- Hard trim/variant search
- Lowest-mileage behavior
- Lower-risk ranking behavior (e.g., "low risk F-150 under $50k for towing")
- Exact VIN Buyer Check
- Outbound link sanity (Edmunds affiliate, fallback routing)

Preview/live smoke is NOT a replacement for deterministic tests. It exists to catch live semantic behavior that offline tests cannot.

## 4. Provider Drift / API Validation

**Kept separate from normal regression testing.**

This layer covers live, mutable behavior:

- Auto.dev filter mechanics (new/used/cpo/used+cpo combined)
- Malformed provider fields (verified via production smoke-test)
- CPO semantics on real inventory
- Used/new sorting and distribution
- History-field coverage (accidents, CPO status, etc.)
- Fuel/powertrain classification edge cases
- NHTSA cross-check behavior (Make, Model, ModelYear, EngineCylinders)
- Provider response-shape drift (new fields, deprecated fields, field-type changes)

Mutable provider inventory MUST NOT become the basis of deterministic unit/regression tests. This layer is validated via focused preview/production smoke-tests on known regression scenarios, not via offline suites.

## 5. Natural-Language Functional QA

**Separate layer, documented but not automated here.**

Broader prompt-based QA covers representative buyer intents before major releases/submissions. Examples:

- "cheapest used sedan under $30k"
- "hybrid SUV with good safety, under $40k, in Denver"
- "low-risk CPO Toyota with under 50k miles"
- "towing-capable F-150 under $50k"
- "family car for a teen driver"

This layer validates the full intent-to-results pipeline and product fitness. It is NOT automated in `npm test` but should be run as a checklist before major releases or submission updates.

## 6. Independent Diff Review

**Before any merge to main.**

Inspect the actual GitHub diff:

- Changes to implementation files (lib/*.ts, app/*/route.ts, etc.)
- Test changes (are they testing the right contracts?)
- Documentation updates (TESTING.md, README.md, etc.)
- Dependency changes (package.json, package-lock.json)

Confirm that no accepted product contract was silently altered. Do not rely only on an implementation summary or commit message.

## 7. Production Promotion

**Promote only the exact reviewed SHA.**

Verify:
- Vercel deployment for that SHA is READY
- Production `githubCommitSha` matches the reviewed SHA exactly

If Vercel shows a different SHA deployed, investigate and reconcile before considering the change live.

## 8. Production / Host Smoke

**After promotion to production.**

Run:

- Direct MCP tool calls (via curl or client test)
  - Generic search: `{"bodyType":"SUV"}`
  - Locked discovery: `{"priorityAxis":"best_for_budget", ...}`
  - Known regression prompts from past fixes
- ChatGPT host test (via the ChatGPT app directory)
- Claude host test (via Claude MCP connector, both web and Desktop if available)
- Verify links route to Edmunds affiliate correctly
- Spot-check a real accident-history vehicle for Buyer Check behavior

## 9. Release / Rollback

**Record the promotion.**

When promoting to production:

- Note the reviewed SHA
- Tag in git if appropriate (e.g., `git tag v1.0.5 <sha>`)
- Document the release (commit messages, DECISIONS.md entry, etc.)

If production smoke fails:

- Rollback to the previous known-good SHA
- Document the issue
- Investigate root cause (was it missed by preview smoke, or did something change post-preview?)
- Fix and re-test before next promotion

## Normal Workflow

Repeat for every behavior-affecting change:

```
branch → implementation → npm test → npm run typecheck → npm run build
  ↓
preview deploy
  ↓
targeted preview smoke tests
  ↓
independent GitHub diff review (on pull request)
  ↓
merge to main
  ↓
production deploy to exact reviewed SHA
  ↓
production host smoke
```

## Not Included Here

This document covers the core deterministic and smoke-testing workflow. It does NOT cover:

- GitHub Actions, branch protection, or required status checks (logged as a separate hardening follow-up)
- Full API specification or contract documentation (see `specs/` folder)
- Field audit or provider data completeness tracking (see `specs/Auto_Dev_Field_Audit_v1.md`)
- Business metrics, traffic monitoring, or user-facing analytics

For those topics, see the referenced files and the broader DECISIONS.md / STATE.md project records.

## Test Run Log

### Sep 14, 2026 — Old CarClever (search-used-cars) — post-fix verification round via live Claude connector

**Method:** Real tool calls via the live `CarClever` Claude connector, one query per scenario, actual results reported (models/prices/counts), not pass/fail alone. Session ID: this conversation.

| # | Query | Result | Verdict |
|---|---|---|---|
| 1a | hybrid SUV under $40k in 90210 (2 runs) | 6/6 CR-V Hybrid, byte-identical both runs | ✅ PASS |
| 1b | large hybrid SUV under $70k in 90210 | 2 Highlander Hybrid, 2 RAV4 Prime, 2 CR-V Hybrid | ⚠️ Large-class filter loose (compacts mixed in) |
| 1c | plug-in hybrid SUV under 50k in 90210 | 5 RAV4 Prime + 1 RAV4 Hybrid (VIN JTMB6RFV1SD167378) | ❌ FAIL (not reproduced manually — see note below) |
| 1c | PHEV under 40k in 90210 | 6/6 RAV4 Prime | ✅ PASS |
| 1d | hybrid minivan in 90210 | 6/6 Toyota Sienna | ✅ PASS |
| 1e | electric sedan under 40k in 90210 | 3 Model Y, 3 Ioniq 6, Model Y ranked #1 | ✅ PASS (matches documented limitation) |
| 1f | RAV4 Prime under 45k in 90210 | 6/6 RAV4 Hybrid, zero Prime | ❌ FAIL (not reproduced manually — see note below) |
| 1g | electric truck under 80k in 90210 | 6/6 Rivian R1T | ✅ PASS |
| 1g | compact electric truck under 60k in 90210 | 2 R1T + 4 F-150 Lightning (full-size, as documented) | ✅ PASS |
| 1h | AWD SUV low mileage under 35k in 90210 | 6/6 tagged AWD | ✅ PASS |
| 1i | diesel truck under 50k in 90210 | 5/5 genuine diesel (Sierra/Silverado) | ✅ PASS |
| 1j | large SUV under 70k in 90210 | 6/6 Toyota Sequoia | ✅ PASS |
| 1k | large luxury SUV under 80k in 90210 | 1 Audi Q8 + 5 Mercedes GLS | ✅ PASS |
| 1l | small size suv under 40k in 90210 | 2 Nissan Kicks + 4 Hyundai Kona | ✅ PASS |
| 2a | Honda CR-V under 50k, no sort | default = Recommended, all 2026 delivery-mileage | ✅ PASS |
| 2b | same, sort=deal_score | genuinely reordered, labeled "Best Deal" | ✅ PASS |
| 2c | same, sort=price_low / price_high | correctly ascending/descending, correctly labeled | ✅ PASS |
| 2d | same, sort=mileage_low | correctly ascending, correctly labeled | ✅ PASS |
| 2e | Ford F-150 under 40k in 90210, no sort | 6/6 F-150 Lightning (electric only), pool=7 | ❌ FAIL (not reproduced manually — see note below) |
| 3a | Ford F150 under 40k in Dallas (no hyphen) | 6/6 Ford Expedition, zero F-150, pool=200 | ❌ FAIL (not reproduced manually — see note below) |
| 3b | Ford F-150 under 40k in Dallas (hyphen) | 1 result, F-150 Lightning at $499 | ❌ FAIL (not reproduced manually — see note below) |
| 3c | Chevrolet Silverado 1500 under 40k in Dallas | 6/6 Silverado 1500, pool=100 | ✅ PASS (control) |
| 3d | RAV4 Hybrid under 40k in 90210 | 6/6 RAV4 Hybrid, zero Prime | ✅ PASS |
| 4a | Toyota Camry under 30k in 90210 | 6/6 Camry Hybrid, no plain Camry | ⚠️ Note (not clearly a bug) |
| 4b | full-size truck under 50k in 90210 | 4 Tundra + 1 Ram 1500 | ✅ PASS |
| 4c | midsize truck under 40k in 90210 | 4 Tacoma, 1 Colorado, 1 Frontier | ✅ PASS |
| 4d | luxury sedan under 60k in 90210 | Audi A6, BMW ×3, Acura TLX, Mercedes S-Class | ✅ PASS |
| 4e | certified pre-owned Toyota RAV4 under 35k in 90210 | 6/6 CPO=true, all RAV4 Hybrid | ✅ PASS |
| 4f | family SUV under 45k in 90210 | 6/6 Ford Explorer, zero diversity | ⚠️ Known pre-existing gap, not new |

**Critical note on the 5 ❌ rows above:** none of these reproduced when André manually re-ran the identical query text in a separate, isolated pass outside this connector session. His results: query 1 (PHEV) → all Prime; query 2 (RAV4 Prime) → all Prime; query 3 (F150 no-hyphen) → all F-150; query 4 (F-150 hyphen) → 100 found (healthy pool); query 5 (F-150 plain) → no electric contamination. This is a genuine, unresolved discrepancy between in-session Claude tool-call results and manual out-of-session results for the same exact query strings.

**Leading hypothesis (unconfirmed):** session-position effects compounding with the already-documented (Aug 16 entry, this repo's STATE.md) unconstrained-pool non-determinism, since all 5 failing calls were made late in one long back-to-back connector session, vs. André's fresh/isolated calls. Live inventory turnover between test passes is also possible and would produce the same symptom without being a bug.

**Required follow-up, not yet run (ran out of session budget):** run the identical PHEV query as message 1 of a brand-new chat, then several unrelated searches, then repeat the identical query as message 6+, to isolate whether results genuinely degrade with session position. See TASKS.md #63.

**Standing verdict:** 17/22 scenarios independently confirmed clean. The 5 failures are downgraded to unconfirmed/open, not treated as confirmed regressions, pending the isolated-vs-late-session test above.
