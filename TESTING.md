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

## 10. Test Run Log

**Required after every release/promotion, and after any session where host rendering/tooling was investigated.** Record each host tested separately — a pass on one host is never evidence for the other. This directly answers "did we actually test ChatGPT and Claude individually, and did it work" without having to reconstruct it from chat history later.

Template per entry:

```
### <date> — <commit/branch> — <host: Claude | ChatGPT | raw MCP>
- Tester:
- Result: PASS | FAIL | BLOCKED (client-side, e.g. cache) | NOT TESTED
- Scenarios run: (list, or "see TESTING.md section 3/5 list")
- Notes: (anything host-specific — widget rendering, tool-list visibility, etc., distinct from the underlying data/logic being correct)
```

A tool call succeeding at the server/data level (confirmed via raw MCP call or via one host) is NOT the same as it working on a DIFFERENT host — record each separately, even when the underlying commit is identical.

---

### Sep 6, 2026 — commit `45c7011` (`feature/edmunds-two-button-cta`) — Host: Claude (CarClever Test connector)
- Tester: Claude (Engineering lane), directed by André
- Result: **PASS** — tool list now shows all 3 tools (`find_matching_vehicle`, `check_vehicle`, `resolve_dealer_url`); prior session's client-side tool-list caching issue cleared on its own overnight.
- Scenarios run:
  1. `check_vehicle` — nonexistent VIN → honest "not found," no crash
  2. `find_matching_vehicle` — generic Bronco search → real results, model-name auto-correction disclosed, widget rendered correctly
  3. `check_vehicle` — real VIN (`1FMDE6BH4TLA65389`) → full Buyer Check + real NHTSA recall data (8 campaigns), correctly classified "routine" (Recalls: Verify status)
  4. `check_vehicle` — make/model/year only (no VIN) → `buyerCheck: null`, recall-only response, honest no-VIN caveat
  5. `find_matching_vehicle` — Kia Sportage hybrid/PHEV model list → base/Hybrid/PHEV variants correctly distinguished, correct per-variant Edmunds paths
  6. `find_matching_vehicle` — `trimRequired: "Raptor"` → every result genuinely Raptor, "Confirmed: Raptor" shown
  7. `find_matching_vehicle` — `priorityAxis: "lower_risk"` → ran cleanly, no errors
  8. `find_matching_vehicle` — `priorityAxis: "lowest_mileage"` → correctly disclosed used-only default, results genuinely lowest-mileage
- Notes: this run covers V2.3 (`check_vehicle`, recalls — new) plus regression for V2.2 (hybrid/PHEV model resolution), V2.1 (`lower_risk` ranking), and V1 (trim-required hard filter, VIN Buyer Check, basic search/link routing) in one pass. Widget rendering confirmed visually working on Claude as of this session (was previously blocked by a stale connector cache in the prior session).

### Sep 5, 2026 — commit `45c7011` (`feature/edmunds-two-button-cta`) — Host: ChatGPT (CarClever Test connector)
- Tester: Claude (Engineering lane) + André, live in ChatGPT
- Result: **FAIL (widget rendering only)** — `check_vehicle`'s own tool call succeeds correctly with real data (confirmed via raw tool-call trace). `find_matching_vehicle`'s results WIDGET renders blank/gray. Root cause NOT confirmed — an initial DNS-label-length theory was proposed and later retracted (André reported the same long branch URL rendered correctly as recently as the day before, which contradicts a static DNS explanation). The real browser `net::ERR_...` code was never captured. **Status: OPEN, unresolved as of this log entry.**
- Notes: exact timing of when this last worked is unknown — André believes V2.1 still rendered correctly; V2.2 or later introduced the regression, but this has not been isolated. See "Next step" plan below.

---

## Not Included Here

This document covers the core deterministic and smoke-testing workflow. It does NOT cover:

- GitHub Actions, branch protection, or required status checks (logged as a separate hardening follow-up)
- Full API specification or contract documentation (see `specs/` folder)
- Field audit or provider data completeness tracking (see `specs/Auto_Dev_Field_Audit_v1.md`)
- Business metrics, traffic monitoring, or user-facing analytics

For those topics, see the referenced files and the broader DECISIONS.md / STATE.md project records.
