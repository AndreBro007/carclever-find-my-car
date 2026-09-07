> ## ⚠️ VERSION TERMINOLOGY — canonical, effective Sep 6, 2026, updated Sep 7, 2026 (read before touching any version-labeled content)
>
> **V1** — the submitted/production app.
> - GitHub: `carclever-find-my-car` repo, `main` branch.
> - Vercel: production project `carclever-find-my-car`, domain `carclever.getcarwise.app`.
> - Connectors: Claude `CarClever` (long-URL, auto-updating). No ChatGPT test connector needed — this is the live submitted app itself.
> - Status: pending Anthropic review (confirm each session, don't assume resolved).
> - Scope: base live-inventory search/comparison, `find_matching_vehicle` as a single self-sufficient all-in-one call including its original VIN Buyer Check path, `resolve_dealer_url`, trim-required hard filtering, model-name auto-correction. Untouched by all V2/V3 work.
>
> **V2** — combined scope of what session notes before Sep 6 called "V2.1" + "V2.2" separately, now shipped as one release: total-matches count-display bug fix, plus the full deterministic Edmunds link redesign (split "Check avail." / "View similar" CTAs, zero live search anywhere, NHTSA trim decode, `lower_risk`/`lowest_mileage` priority axes). **As of Sep 7, 2026 also includes V2.4 (continuous price-proximity scoring + modest Used-value tie-break in `matchScore`) and V2.5 (New/Used/CPO condition label surfaced in the per-listing text summary) — both merged, live in production, confirmed on both Claude and ChatGPT.** Still no new tools.
> - GitHub: `carclever-find-my-car` repo, `release/v2` branch, tip commit `ab617d2` (was `e2ffe66` before the Sep 7 V2.4/V2.5 merge).
> - Vercel: dev/test project `ccfmc-dev-v2` (`ccfmc-dev-v2.vercel.app`), Production auto-redeploys on every push.
> - Connectors: ChatGPT `CarClever V2 Test`, Claude `CarClever V2 Test`.
>
> **V3** — adds the `check_vehicle` tool (NHTSA-only recalls, 4-state: none/severe/routine/unavailable; Buyer Check when a VIN is supplied). **This is what session notes before Sep 6 called "V2.3" — that label is retired; read "V2.3" in any older entry below as V3.**
> - GitHub: `carclever-find-my-car` repo, `feature/v3-check-vehicle` branch, tip commit `719fc13` (branched from V2's pre-merge tip `e2ffe66`). Note: `feature/edmunds-two-button-cta` (the old pre-split combined branch) is confirmed to be the exact same commit as this branch.
> - Vercel: dev/test project `ccfmc-dev-v3` (`ccfmc-dev-v3.vercel.app`).
> - Connectors: ChatGPT `CarClever V3 Test`, Claude `CarClever V3 Test` (renamed Sep 7 from `CarClever Test` for naming consistency with `CarClever V2 Test` — same long-URL, same underlying branch, name only; Claude's connector UI has no rename option, so this required remove-then-recreate).
>
> **Legacy/retired:** GitHub branch `feature/edmunds-two-button-cta` (pre-split combined branch, same commit as V3 above) / Vercel project `ccfmc-dev` / ChatGPT connector `CarClever Test (legacy ccfmc-dev, pre-split branch)` — kept idle for historical reference only, not part of the current V1/V2/V3 test matrix.
>
> **Do not confuse this V3 with "OpenAI_V3.0.0_Submission..."** referenced elsewhere in these files (e.g. PLAYBOOK.md's "V3 readiness checklist," REFERENCE.md's submission-manifest notes) — that is the version number of a *past OpenAI app-submission manifest*, a completely separate numbering scheme.
>
> Full setup, decision history, and live test results: `CARCLEVER_3_APPS_STRATEGIC_ANALYSIS.md` and `TESTING.md`'s Test Run Log (this repo).

---

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

### Sep 6, 2026 — commit `4863368` (`feature/edmunds-two-button-cta`, tested via throwaway branch `t1` on the new `ccfmc-dev` dev/test Vercel project) — Host: ChatGPT (CarClever Test t1 connector)
- Tester: Claude (Engineering lane) + André, live in ChatGPT
- Result: **PASS (root cause of prior widget-rendering failure confirmed and worked around)** — root cause was a dual issue: (1) ChatGPT's Apps SDK sandbox-domain construction collapses a valid multi-label Vercel domain into a single DNS label that can exceed 63 characters (confirmed via direct `DNS_PROBE_FINISHED_NXDOMAIN` on the constructed sandbox URL), specific to preview/branch deployments whose team+project+branch name is too long once dots become dashes; (2) a separate, unrelated blocker — the new dev project's "Vercel Authentication" (Require Log In) Deployment Protection setting was ON by default, blocking OpenAI's server-side connector-creation request entirely (fixed by turning it off).
- Scenario run: `find_matching_vehicle` VIN path — "Find VIN 1FMDE6BH4TLA65389 and tell me if it's a good buy — any red flags?" — full Buyer Check + real NHTSA recall data rendered correctly as text (no widget expected/needed for this path since it went through `check_vehicle`, see finding below).
- **Real finding, not a pass/fail on rendering itself:** this exact prompt routed to `check_vehicle` (correctly, per its own tool description) rather than `find_matching_vehicle`'s VIN path — meaning the listing card/photo/link that used to come back automatically for this kind of question is now missing. Confirmed as the same regression already logged in `SYS-20260906-001` (found on Claude), now reproduced on ChatGPT too — a cross-platform consequence of the four-tool split, not a host-specific quirk. **Open product decision, not yet made — see DECISIONS.md `SYS-20260906-002`.**
- Notes: standing test environment (`ccfmc-dev` project + short throwaway branch, e.g. `t1`) established this session specifically to make ChatGPT-side testing repeatable going forward without the DNS-length problem recurring. See DECISIONS.md `SYS-20260906-002` for the full setup process and gotchas (env var handling, Deployment Protection, branch-name length budget).

---

### Sep 6, 2026 — commit `e2ffe66` (`release/v2`, tested via permanent `ccfmc-dev-v2` dev/test Vercel project) — Host: ChatGPT (CarClever V2 Test connector)
- Tester: Claude (Engineering lane) + André, live in ChatGPT
- Result: **PASS**
- Scenarios run: `find_matching_vehicle` — "find a Honda Civic under $25k near 90210" — real results card rendered (CPO/USED badges, RISK tag, real dealers/VINs, split "Check avail./View similar" CTAs), off the stable production domain `ccfmc-dev-v2.vercel.app` (not a branch-alias preview URL).
- Notes: connector attached via ChatGPT's composer "+" tool picker (typed the app name, selected it as a chip) rather than the documented `@CarClever Test` mention syntax — functionally equivalent, both explicitly attach the app before the message rather than naming it in prose. First-attempt naming-in-prose is NOT reliable (see next entry) — always explicitly attach.

### Sep 6, 2026 — commit `719fc13` (`feature/v3-check-vehicle`, tested via permanent `ccfmc-dev-v3` dev/test Vercel project) — Host: ChatGPT (CarClever V3 Test connector)
- Tester: Claude (Engineering lane) + André, live in ChatGPT
- Result: **FAIL then PASS on retry (real, recorded gotcha, not a data/logic issue)**
- Scenarios run:
  1. First attempt — prompt phrased "Using the CarClever V3 Test app, check VIN ... any recalls or red flags?" (app named in prose only, not explicitly attached). ChatGPT's "Work" mode did NOT invoke the connector at all — instead browsed the web/repo, eventually stating "The CarClever V3 Test app wasn't available in this session." Also used an invalid hand-typed VIN (bad check digit) as a separate, unrelated mistake.
  2. Retry — same VIN corrected to a real checksum-valid one, connector explicitly attached via the "+" picker (chip shown in composer) instead of named in prose → correct `check_vehicle` call → real NHTSA recall campaign numbers returned (`23V704000`, `24V744000`, `24V859000`), correctly non-severe/no "park it" flag, correctly reported no listing/Buyer Check for an unlisted VIN (this is `SYS-20260906-001`'s known regression reproducing exactly as expected, not a new bug).
- **New standing rule for ChatGPT testing, add to Surface C convention below: naming a connector in prose (e.g. "Using the CarClever X Test app...") is NOT reliable in ChatGPT's "Work" mode — it can silently skip the connector entirely and go browsing instead.** Always explicitly attach it first (either `@CarClever Test`-style mention-and-select per the existing convention, or the "+" tool picker — both achieve the same explicit attachment), then send the actual question as a separate/combined message. Confirm the composer shows the connector as an attached chip before sending.

### Sep 6, 2026 — commit `e2ffe66` (`release/v2`, tested via `ccfmc-dev-v2`) — Host: Claude (new CarClever V2 Test connector)
- Tester: Claude (Engineering lane), directed by André
- Result: **PASS**
- Scenarios run: `find_matching_vehicle` — "Using CarClever V2 Test, find a Toyota Camry under $25k near 90210" → correctly resolved to the new connector, real tool call (after standard tool-permission approval), results card rendered natively in Claude's UI, real dealers/VINs/Carfax links, correct split CTAs.
- Notes: this is a newly created connector (Claude previously had no V2-only test path — `CarClever` = V1/production, `CarClever Test` = V3-equivalent, since `feature/edmunds-two-button-cta` and `feature/v3-check-vehicle` are confirmed to be the exact same commit, 0 ahead/behind). Reused the already-verified `ccfmc-dev-v2.vercel.app/mcp` URL rather than an untested production-project preview-branch alias. Tool list briefly showed "no tools available" immediately after connecting — a load delay, resolved on reload, not a real fault.

### Sep 7, 2026 — commit `18ae2a2` (`v2.4/match-score-price-proximity`, tested via a temporary branch-preview connector) — Host: Claude
- Tester: Claude (Engineering lane), directed by André
- Result: **PASS**
- Scenarios run: narrow-spread search ("Toyota Camry under $30k") → 5 results within a ~$200 band → all scored 97%, confirmed as correct near-equal-price behavior, not a bug. Wide-spread search ("Toyota Camry under $45000, no New/Used preference") → clean 3-tier differentiation: $4,985-$5,875 (Used, high-mileage) → 100%; $34,593-$34,988 (Used, near-new demo stock) → 98%; $41,984-$42,149 (New) → 96%. Confirms both the price-proximity grading and the modest Used-value tie-break working as designed — New no longer wins purely mechanically at high budget, without being penalized (still "Strong match" at 96%).
- Setup note: a temporary connector (`TEMP V2.4 Branch Test 2`) was created pointed at this branch's own auto-generated Vercel Preview deployment (`ccfmc-dev-v2-git-v24-match-scor-9ac498-...vercel.app`) — confirms pushing a branch to a project connected to the whole repo auto-triggers its own isolated Preview, separate from Production, no manual action needed. First connector-creation attempt failed with a 404 due to a dropped character in a long hand-typed URL ("broekmans" → "broekmas") — fixed by retyping in smaller chunks and visually zooming in to verify before saving. Removed after merge (superseded by `CarClever V2 Test` once V2.4 landed in `release/v2`).

### Sep 7, 2026 — commit `a2f8ff0` (`v2.5/condition-label-in-summary-text`, tested via a temporary branch-preview connector) — Host: Claude
- Tester: Claude (Engineering lane), directed by André
- Result: **FAIL (on the pre-fix branch) then PASS (post-fix, confirming the fix), both real, not a retry-until-it-works loop**
- Real bug found live while testing V2.4 (not this fix's own branch): a search returned a card with a "USED" badge, but the host model's own text answer said "New" for the same VIN. Root cause confirmed by source read: `condition.inventoryType`/`used`/`cpo` were already present on `structuredContent`, but the per-listing text summary — the part this repo's own code comments already document as "what the host model actually reads and reasons over" (`SYS-20260812-011` #3) — never included condition at all.
- Fix (`SYS-20260907-002`): added a `conditionStr` (New/Used/Certified Pre-Owned (Used)) directly into the existing per-listing text line. Rerun of the exact same query type via a new temporary connector pointed at this branch's own Preview (`ccfmc-dev-v2-git-v25-condition-b53986-...vercel.app`) confirmed fixed: 5/5 results correctly labeled, including the CPO nuance, matching card badges exactly, VIN-verified on all 5.
- Independent of and unrelated to V2.4 — branched separately off `release/v2`.

### Sep 7, 2026 — commit `ab617d2` (`release/v2`, merged, Production on `ccfmc-dev-v2`) — Host: Claude and ChatGPT, both via the standing `CarClever V2 Test` connector
- Tester: Claude (Engineering lane), directed by André; ChatGPT's tools list refreshed by André first
- Result: **PASS on both platforms, identical result**
- Both V2.4 and V2.5 merged cleanly into `release/v2` (one unrelated pre-existing type gap in the new match-score test fixture, found by re-running `tsc --noEmit` after merge — `npm test`'s `tsx` runner doesn't typecheck — fixed same session, not a merge conflict). Full combined suite: 66/66 pass. `ccfmc-dev-v2` Production auto-redeployed.
- Same query ("Toyota Camry under $45000 near 90210, no New/Used preference") run against the **standing production** `CarClever V2 Test` connector (not a temp branch connector) on both Claude and ChatGPT: identical result on both — 5/5 correctly labeled Used/CPO matching card badges, matchScore 98% uniform (tight price cluster in this particular query, consistent with the near-equal-price behavior confirmed above).
- Confirmed before testing: `RESULTS_CARD_RESOURCE_URI` (`lib/results-card.ts`) unchanged at `results-card-v3` — neither merged branch touched the widget's structure/template, only data values and text, so the documented `SYS-20260904-003` caching bug (stale template on an un-bumped URI) does not apply here. No caching issue observed on either platform.
- Post-merge cleanup: the two temporary branch-test connectors removed (superseded). Claude's `CarClever Test` (the long-URL V3-equivalent connector) renamed to `CarClever V3 Test` for naming consistency with `CarClever V2 Test` — required remove-then-recreate since Claude's connector UI has no rename option and blocks a duplicate URL while the old entry still exists.


---


## 11. Real-User Test Surfaces — What Each One Actually Tests

**Not all "testing" catches the same class of bug.** This session found two real issues (Claude's tool-list cache, ChatGPT's widget-rendering DNS collapse) that only showed up on the actual host UI, never in a direct/API-level check. Be precise about which surface a given test actually exercised.

### Surface A: Claude, direct connector call (Claude Engineering-lane session)
When Claude (in a session like this one) has the connector's tools already loaded and calls them directly (e.g. `CarClever Test:find_matching_vehicle(...)`), that's a real, live call to the real server — confirms server logic and data correctness. **It does NOT confirm what a real user actually sees**: it bypasses tool-list discovery/caching, and doesn't render the actual widget in a browser. Useful for fast, thorough logic verification (this is how the 8-scenario V2.3 regression pass was run) — not a substitute for a real host test.

### Surface B: Claude, real user session (web or Chrome extension)
The actual experience: a human types a prompt naturally, Claude decides which tool to call, the widget renders in the real UI. Real prompt convention:
> "Use connector CarClever Test and find me a large SUV under 40k in 90210"

This is the ONLY surface that caught the tool-list caching issue (new tools like `check_vehicle` not showing up even after a fresh deploy) and the ONLY surface that confirms actual widget rendering. **Required after any change that adds/renames a tool, or touches the widget.**

### Surface C: ChatGPT (always a real user session — no API-equivalent shortcut exists)
Real prompt convention:
> Type `@CarClever Test`, select it from the dropdown, then send the actual prompt (e.g. "large suv under 40k in 90210") as a separate/combined message. **Confirmed Sep 6, 2026: naming the connector in prose instead (e.g. "Using the CarClever Test app...") is NOT reliable — ChatGPT's "Work" mode can silently skip the connector entirely and go browsing/searching instead. Always explicitly attach it (via `@`-mention-and-select, or the composer's "+" tool picker) and confirm it shows as an attached chip before sending.**

Every ChatGPT test is inherently Surface-B-equivalent (real UI, real rendering) since there's no way to call ChatGPT's connector tools directly outside the actual chat interface. This is the surface that caught the DNS-sandbox-collapse widget-rendering bug — something Surface A (or any raw MCP call) could never have caught, since the bug is specifically in ChatGPT's own client-side rendering step, not the server.

### Known recurring issues to watch for on each surface
- **Claude tool-list caching:** a disconnect/reconnect does not reliably clear a stale tool list; sometimes only clears after a longer gap (hours) or a full app/browser restart. If a newly-added tool doesn't appear, this is the first thing to suspect — verify server-side correctness independently via a raw `tools/list` call (see `DECISIONS.md` `SYS-20260905-001`) before assuming a code problem.
- **ChatGPT widget rendering on preview/branch deployments:** confirmed root cause is a DNS label-length collapse specific to preview URLs (see `DECISIONS.md` `SYS-20260905-001`/`SYS-20260906-002`) — use the `ccfmc-dev` + short-branch method (section 10 above) for any ChatGPT-side preview testing, never the long-URL branch alias directly.
- **New Vercel projects' Deployment Protection:** "Vercel Authentication" is ON by default and silently blocks external hosts from creating a connector at all — confirm this is OFF before connecting anything new.

## Not Included Here

This document covers the core deterministic and smoke-testing workflow. It does NOT cover:

- GitHub Actions, branch protection, or required status checks (logged as a separate hardening follow-up)
- Full API specification or contract documentation (see `specs/` folder)
- Field audit or provider data completeness tracking (see `specs/Auto_Dev_Field_Audit_v1.md`)
- Business metrics, traffic monitoring, or user-facing analytics

For those topics, see the referenced files and the broader DECISIONS.md / STATE.md project records.
