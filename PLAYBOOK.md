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

# PLAYBOOK.md — Master Execution Guide

**Status:** Single source of truth for all SOPs  
**Location:** `/mnt/project/PLAYBOOK.md`  
**Search:** Use `grep "[task-name]" PLAYBOOK.md` to find section  
**Last Updated:** Sep 21, 2026  

---

## STARTUP — Session Initialization (2–3 min)

**MANDATORY PRE-WORK VERIFICATION CHECKLIST**

Before proceeding to ANY task execution, complete these in order and report results in chat:

- [ ] **1. FILE VERIFICATION** — Adopted Sep 18, 2026 (see Task #56, TASKS.md), connector-access item retired Sep 21, 2026 (confirmed stable, no more per-session check needed): reads go through the GitHub MCP connector for all three repos, `carclever-widget` included. 7 admin files fetched per the SHA-check gate (full fetch only if checkpoint missing/behind), FULL getcarwise-docs inventory listed, and all changes since **this lane's** checkpoint read in full (or a FULL fetch if the checkpoint is missing/uncertain). Task-relevant docs read in full regardless of age. (see below)
- [ ] **1b. ACCOUNT_MEMORY_TRANSFER.md read once per new account** — standing rules and past lessons that aren't written anywhere else; skip re-reading once familiar, but never skip on a brand-new account/session type (e.g. first Claude Team session)
- [ ] **2. STATE.md read in full** — (2 min) Summarize current status + blockers in chat
- [ ] **2a. CHECK THE 🔴 TOP-OF-STATE.md BANNER FOR OPEN GATED WORK** — if STATE.md has an unresolved "held pending X" item (e.g. a fix on a branch awaiting app review to conclude), explicitly ask André whether that condition has changed BEFORE starting any new coding task. Never let a new task begin while an old one sits silently gated — ask first, every session.
- [ ] **3. PLAYBOOK.md task index scanned** — Identify task section number
- [ ] **4. RELEVANT DOCUMENT read in full** — Check STATE.md/TASKS.md for which doc applies (e.g., WORKFLOW_ARCHITECTURE.md, DECISIONS.md context, REFERENCE.md); read entire document before questions
- [ ] **5. Checklist completion reported** — Confirm all items above complete before proceeding

**BLOCKING RULE:** Do not proceed to task execution until checklist is complete and visible in response.

---

**MANDATORY FIRST ACTION: FILE VERIFICATION**

### Step 1 — `carclever-widget` (7 admin files)

**Connector access confirmed stable as of Sep 21, 2026** (App properly installed since Sep 18, reads/writes both work across all three repos). No per-session access check needed — just use `get_file_contents` directly.

**SHA-check gate (added Sep 21, 2026 -- token-efficiency fix, see DECISIONS.md):**
Before fetching all 7 files in full, compare the repo's current tip SHA
(`GET /repos/AndreBro007/carclever-widget/commits/main`) against Claude's
own `carclever-widget` checkpoint in STATE.md's SESSION REVIEW CHECKPOINTS
table.

- **Checkpoint SHA present and matches current tip** -> admin docs are
  unchanged since last session. Skip the full 7-file fetch. State this
  explicitly in the session report (which SHA, confirmed unchanged).
- **Checkpoint SHA present but behind current tip** -> run
  `GET /repos/AndreBro007/carclever-widget/compare/{checkpoint}...main`.
  Fetch in full only the files that appear as added/modified/renamed in
  the compare result. Inspect renames/deletions for affected references,
  same as the `getcarwise-docs` procedure.
- **Checkpoint missing, empty, or the compare/tip call itself fails** ->
  fall back to fetching all 7 files in full, unchanged from the original
  procedure. Never guess a lookback window.

This gate does not change item 1b (`ACCOUNT_MEMORY_TRANSFER.md` read once
per new account) -- that file is still exempt from routine re-reading on
its own separate rule.

Use `get_file_contents` (connector) for whichever files the gate above says
to fetch. bash+PAT remains available as a fallback only if the connector
regresses on a given call — log any such regression in TASKS.md rather
than reverting to PAT-by-default.

### Step 2 — `getcarwise-docs` (connector only — no PAT for this repo)

1. **List the full inventory** — `get_file_contents(owner="AndreBro007", repo="getcarwise-docs", path="/")`. Discovery is never narrowed by a checkpoint; this always lists everything.
2. **Diff since this lane's checkpoint.** The connector has no `/compare` equivalent, so this is reconstructed from commit history rather than falling back to PAT:
   - `list_commits(owner, repo, sha="main")`, paginating back until the checkpoint SHA is reached; collect every commit after it.
   - **Safety valve:** if that's more than ~40 commits, don't walk them all — treat it the same as a missing checkpoint (full fetch below) rather than burning dozens of calls.
   - For each collected commit, `get_commit(detail="stats")` and union the `added`/`modified`/`renamed` filenames across all of them — this is the connector-only equivalent of the old `/compare` call. Note any `removed` filenames too — inspect live references before relying on them.
   - Missing/empty/uncertain checkpoint, or this reconstruction fails/errors → **full fetch** of every file in the inventory. Never guess a lookback window.
3. **Fetch full contents** (`get_file_contents` per file) of everything new, changed, or task-relevant — task-relevant docs are read in full regardless of age, exactly as before.

### Step 3 — `carclever-find-my-car`

All reads (file contents, branches, commits, etc.) via the connector tools — confirmed working, same pattern as Step 2.

### Writes — UPDATED Sep 21, 2026, all three repos

**GitHub MCP connector is the standing method for reads AND writes**, all three repos (see TASKS.md Task #56/#56b closure). bash+PAT is kept only as a fallback if the connector regresses on a specific call — test the connector first, log any regression in TASKS.md, and fall back to bash+PAT for that call only rather than reverting to PAT-by-default.

---

**Then:**
1. Read STATE.md (2 min) — current status + blockers
2. Find your task in QUICK TASK INDEX below
3. Follow instructions in that section

⚠️ **Don't skip FILE VERIFICATION.** It's mandatory. Follow the steps exactly.

---

## FILE SEARCH QUICK TIP

**Google Drive files needed during a session?**

Use the Claude Google Drive search tool:
```
Query: "title contains '[FILENAME_PATTERN]' and parentId = '1_umn5j1VA8XZ4wNoTFj8nP0UktOfhTEf'"
```

Example: Find all Reddit SOPs
```
Query: "title contains 'REDDIT' and parentId = '1_umn5j1VA8XZ4wNoTFj8nP0UktOfhTEf'"
→ Returns: v3.4, v3.3, v3.0 SOPs all versions, sorted by modifiedTime
```

**Note:** Static file indexes (GOOGLE_DRIVE_FILE_INDEX.md, PROJECT_FOLDER_FILE_INDEX.md) are deprecated as of July 4, 2026. Live search is faster and always current.

---

## QUICK TASK INDEX

| Task | Section | Time |
|------|---------|------|
| Session startup | STARTUP | 2–3 min |
| **Session end (push to GitHub)** | **SESSION_END** | **3–5 min** |
| **Retrieve old doc from past chat** | **BACKFILL_DOCUMENTATION** | **5–15 min** |
| Add decision to log | DECISIONS | 5 min |
| Build/fix widget | WIDGETS | 15–30 min |
| Create blog post | BLOG | 2–3 hours |
| Reddit comment | REDDIT | 10 min |
| Weekly monitoring | MONITORING | 25 min |
| File naming | FILES | 2 min |
| Draft a code agent prompt | CODE_AGENT_PROMPT | 30–60 min |
| Self-audit a prompt before sending | PROMPT_SELF_AUDIT | 15 min |
| Provenance rules for claims | PROMPT_EVIDENCE | reference |
| Verify a deploy | DEPLOY_VERIFY | 20–40 min |

**To find instructions:** `grep -A 20 "TASK: your-task-name" PLAYBOOK.md`

---

**Note (fixed Sep 2, 2026):** this used to contain a second, stale, partially-corrupted copy of the STARTUP section (broken by an unterminated markdown code span) — contradicted the authoritative version at the top of this file (e.g. claimed files are read "instant, local" rather than fetched fresh from GitHub each session). Removed. **The STARTUP section at the top of this file is the only one — always use that one.**

---

## TASK: SESSION_END — Hardened Document Push to GitHub

**When:** At the end of every session (before signing off)  
**Duration:** ~2 minutes  
**Purpose:** Persist all session work to GitHub for next session's access  
**Critical:** Verify files ACTUALLY arrived on GitHub — don't assume success

---

### BEFORE You Start (Session Setup)

**At the very beginning of your session**, run this once:

```bash
# Clone BOTH repos locally (working directories)
if [ ! -d ~/carclever-widget ]; then
  git clone https://github.com/AndreBro007/carclever-widget.git ~/carclever-widget
fi
cd ~/carclever-widget && git pull origin main

if [ ! -d ~/getcarwise-docs ]; then
  git clone https://github.com/AndreBro007/getcarwise-docs.git ~/getcarwise-docs
fi
cd ~/getcarwise-docs && git pull origin main
```

**Why:** Core state files (STATE/DECISIONS/TASKS/PLAYBOOK/REFERENCE) go in
`~/carclever-widget/`. **New session documentation (audits/plans/protocols/guides/
investigations) goes in `~/getcarwise-docs/`, NOT `~/carclever-widget/`** — this
distinction was wrong in earlier versions of this section (fixed Sep 2, 2026; the
BACKFILL_DOCUMENTATION task below always had this right — this section now matches it).

---

### DURING Session: File Creation Rule

**Core state files → `~/carclever-widget/`. New documentation → `~/getcarwise-docs/`, named per convention `[TYPE]_[TITLE]_[DATE].md`:**

```bash
# ✅ CORRECT — new documentation goes in getcarwise-docs, properly named
cat > ~/getcarwise-docs/AUDIT_WEBSITE_APP_INFRASTRUCTURE_20260902.md << 'EOF'
# Content here
EOF

# ❌ WRONG — do not put new docs in carclever-widget (that's core state files only)
cat > ~/carclever-widget/WEBSITE_APP_INFRASTRUCTURE_AUDIT.md << 'EOF'
# Wrong repo AND wrong naming — no TYPE_/DATE convention
EOF

# ❌ WRONG — files in /tmp/ won't be pushed to GitHub either way
cat > /tmp/WEBSITE_APP_INFRASTRUCTURE_AUDIT.md << 'EOF'
# This will be lost
EOF
```

---

### AT Session End: Push & Verify

**DO NOT skip the verification step.** This is what failed last time.

1. **Use the hardened SESSION_END script:** `SESSION_END_PROTOCOL_V2.md` (in `carclever-widget` repo)
2. **Push core files to `carclever-widget`, new docs to `getcarwise-docs`** — two separate pushes, two separate repos
3. **Verify output:** Look for ✅ on every file, in both repos
4. **If you see ❌ for any file:** Do NOT close session, debug first
5. **Exit code must be 0** (not 1)
6. **Record this lane's two review checkpoints in STATE.md's checkpoint table:**
   - `getcarwise-docs` SHA and `carclever-widget` SHA **actually reviewed** this session
   - Record the snapshot you reviewed — **not** the repo tip if you did not review it,
     and not the commit that saves the checkpoint itself (self-referential; impossible)
   - **Update only the Claude row.** Re-read STATE.md fresh and preserve ChatGPT's
     values verbatim. Never advance or initialize the other lane's checkpoints.
   - The `carclever-widget` checkpoint covers the admin/relevant-commit review —
     it is **not** a claim that every application-code change was audited

**Quick checklist:**
- [ ] Core state files in ~/carclever-widget/ (not /tmp/)
- [ ] New documentation in ~/getcarwise-docs/, named `[TYPE]_[TITLE]_[DATE].md` (not /tmp/, not carclever-widget/)
- [ ] Ran: `bash SESSION_END.sh` (hardened script from SESSION_END_PROTOCOL_V2.md)
- [ ] Saw: All files marked with ✅, in both repos
- [ ] No messages starting with: ❌
- [ ] Exit code: 0

---

### What Gets Pushed

**Core state files (always, to `carclever-widget`):**
- STATE.md
- DECISIONS.md
- TASKS.md
- PLAYBOOK.md
- REFERENCE.md

**NEW documentation (this session only, to `getcarwise-docs`, named `[TYPE]_[TITLE]_[DATE].md`):**
- Investigation reports: `AUDIT_*.md`, `INVESTIGATION_*.md`
- Strategy/plans: `PLAN_*.md`
- Protocols/guides: `PROTOCOL_*.md`, `GUIDE_*.md`
- Anything else created during this session that has reference value beyond today

**NOT pushed:**
- Temporary scratch files
- Working notes
- Intermediate versions (keep only latest)
- Files older than this session

---

### Cross-Reference New Docs (So Next Session Can Find Them)

After creating any new doc in `getcarwise-docs`, add a reference in the core files (in `carclever-widget`):

**In STATE.md:**
```markdown
✅ Priority #3: Website Review — Docs: PLAN_PRIORITY_3_WEBSITE_REVIEW_20260826.md (getcarwise-docs)
```

**In TASKS.md:**
```markdown
| 3 | Website review | ✅ COMPLETE | Docs: PLAN_PRIORITY_3_WEBSITE_REVIEW_20260826.md (getcarwise-docs) |
```

**In DECISIONS.md:**
```markdown
**Related docs:** PLAN_PRIORITY_3_WEBSITE_REVIEW_20260826.md (getcarwise-docs, full strategy)
```

**Why:** Next session, I search STATE/TASKS/DECISIONS, see the link and which repo it's in, fetch the doc immediately. No hunting, no wrong-repo guessing.

---

### Detailed Implementation

For complete step-by-step instructions, troubleshooting, and fallback procedures, see:

**File:** `SESSION_END_PROTOCOL_V2.md` (in this repo)

Contains:
- Full copy-paste bash scripts (SESSION_START.sh, SESSION_END.sh)
- Troubleshooting guide (push failed? file not found? git issues?)
- Verification checklist (before you sign off)
- Manual fallback (if automation breaks)

**Key sections:**
- Session START — setup (run once per session)
- During SESSION — file location rules
- Session END — hardened push with API verification
- Verification step (critical — this fixes the Aug 26 bug)
- Troubleshooting (common failures + fixes)

---

### Why This Fix Works

**Aug 26 problem:** Script said "pushed to GitHub" → no verification → 3 docs silently lost

**v2 fix:**
1. Repo cloned at session START → all files in working directory
2. Verification step → curl GitHub API for each file after push
3. Fail-fast → if ANY file missing → exit 1, don't close session
4. Clear messaging → ✅ or ❌ on every file

**Result:** No silent failures. Either all files are there, or session doesn't close.

---

**Status:** Ready to use. See SESSION_END_PROTOCOL_V2.md for full implementation.


## TASK: BACKFILL_DOCUMENTATION — Retrieve & Store Docs from Past Chats

**When:** Anytime you find a doc in a past chat that should be stored  
**Duration:** 5–15 minutes (depending on doc complexity)  
**Purpose:** Add old documentation to getcarwise-docs with proper naming and cross-references

### How to Trigger This

**In ANY chat (current or next session), just tell me:**

```
"I found a document in a past chat that should be stored.

Chat: [chat name/date or ID]
Document: [doc name or description]
Type: [AUDIT / PLAN / PROTOCOL / GUIDE / INVESTIGATION]
Reason: [why it belongs in getcarwise-docs]

[Optional: Paste the content or describe what it contains]"
```

### Examples of Prompt Formats

**If you paste the content:**
```
I found this document in our Aug 15 chat about Reddit strategy:

Type: PLAN
Title: Reddit Phase 2c Launch Strategy
Content:
[paste the full markdown here]

Please store this in getcarwise-docs with proper naming and add cross-references to STATE/DECISIONS.
```

**If you reference it from memory:**
```
In the Aug 10 chat about website design, I created a document mapping all the page templates and design patterns. 

Type: GUIDE
Title: Website Design System Reference

Can you retrieve that chat, find the document, and add it to getcarwise-docs with cross-references?
```

**If you give me a chat ID/link:**
```
Chat: /mnt/transcripts/2026-08-15-chat-id.txt (or I can search via read_conversation)

I created a competitive analysis document in this chat about AutoTrader features.

Type: INVESTIGATION
Title: AutoTrader Feature Competitive Analysis

Store it in getcarwise-docs and add references where relevant.
```

### What I Do When You Ask

**Step 1: Locate the document**
- If you pasted it → use directly
- If you gave chat ID → fetch via `read_conversation` or `conversation_search`
- If you described it → search past chats for matching content

**Step 2: Evaluate for storage**
- Is it task-related? (audit, plan, strategy, reference, or investigation)
- Is it substantial enough? (minimum ~1 KB, something you'd want next session)
- Does it have context value? (useful for future reference or closed items)
- Is it complete? (final version, not working draft)

**If YES to all:** Proceed to Step 3  
**If NO:** I'll tell you why and ask if you still want it stored

**Step 3: Prepare the document**
```
1. Name it per convention: [TYPE]_[TITLE]_[DATE].md
   └─ TYPE: AUDIT_, PLAN_, PROTOCOL_, GUIDE_, INVESTIGATION_
   └─ TITLE: snake_case version of title
   └─ DATE: YYYYMMDD (today's date or original date? → I ask)

2. Add header metadata:
   └─ Original chat date (if different from storage date)
   └─ Session context (why it was created)
   └─ Related items (links to other docs)

3. Copy to /tmp/getcarwise-docs/
```

**Step 4: Add cross-references**
```
1. Add entry to DECISIONS.md → SYS-[DATE]-XXX
   └─ Document backfilled: [filename]
   └─ Type: [AUDIT/PLAN/etc]
   └─ Original context: [brief explanation]
   └─ Related items: [links to other docs]

2. Update STATE.md if doc relates to current status
   └─ Example: "ℹ️ Reference docs: GUIDE_WEBSITE_DESIGN_SYSTEM_20260810.md"

3. Update TASKS.md if doc relates to pending work
   └─ Example: Add doc reference to relevant task line
```

**Step 5: Commit and push**
```bash
cd /tmp/getcarwise-docs
git add [NEW_FILENAME]
git commit -m "Backfill documentation: [TYPE]_[TITLE]_[DATE]

Original context: [one-line summary]
Retrieved from: [chat date or source]
Cross-referenced in: DECISIONS.md (SYS-[DATE]-XXX)

[Optional: why this doc was valuable to retrieve and store]"
git push origin main
```

**Step 6: Report to André**
- Document name and type
- Where it was found (original chat date)
- Why it was stored (context/value)
- Cross-references added

### Examples from Real Scenarios

**Scenario 1: You find a competitor analysis document from Aug 10**
```
Me: "In the Aug 10 chat I created a detailed analysis of CarMax listings vs. Edmunds 
structure. That's something we should keep for reference."

You: "Please store the CarMax/Edmunds analysis doc from Aug 10 chat in getcarwise-docs 
with proper naming and references."

I do:
1. Fetch Aug 10 chat → find the document
2. Rename: INVESTIGATION_CARMAX_VS_EDMUNDS_STRUCTURE_20260810.md
3. Copy to getcarwise-docs/
4. Add SYS entry to DECISIONS.md explaining what it is
5. Update STATE.md if it relates to current competitive landscape
6. Commit and push with context message
7. Report back: "✅ Stored INVESTIGATION_CARMAX_VS_EDMUNDS_STRUCTURE_20260810.md 
   and added to DECISIONS.md as SYS-20260826-005"
```

**Scenario 2: You remember a protocol document but not exact date**
```
You: "In one of the earlier chats, I created a detailed WordPress automation protocol 
that I think we should keep. It was thorough. Can you search for it and store it?"

I do:
1. Search past chats for "WordPress automation protocol"
2. Find the document
3. Determine original date from chat
4. Rename: PROTOCOL_WORDPRESS_AUTOMATION_[DATE].md
5. Same process as Scenario 1 (copy, reference, commit, report)
```

**Scenario 3: You paste a doc from memory/screenshot**
```
You: "I want to store this document I created about site audit findings. Here it is:

[full markdown content]

Type: AUDIT
Title: August Site Audit Findings
Original date: Aug 22, 2026"

I do:
1. Accept the pasted content
2. Rename: AUDIT_AUGUST_SITE_AUDIT_FINDINGS_20260822.md
3. Process normally
```

### What Gets Stored vs. What Doesn't

**STORE (task-related, reference value):**
- ✅ Audits, analysis, investigations (competitive, infrastructure, technical)
- ✅ Plans, strategies, roadmaps (feature, marketing, product)
- ✅ Protocols, SOPs, automation procedures
- ✅ Guides, reference materials, system documentation
- ✅ Decisions with supporting research or rationale
- ✅ Data findings (markets, competitors, user research)

**DON'T STORE (temporary, working, or covered elsewhere):**
- ❌ Working notes, brainstorms, incomplete drafts
- ❌ Chat turn-by-turn conversation (already in transcript)
- ❌ Duplicate information (already in STATE/DECISIONS/TASKS)
- ❌ Debugging output, error logs, temporary test results
- ❌ Items that are fully integrated into current state files

**MAYBE (ask me to evaluate):**
- ❓ Exploratory analysis (might be useful, might be superseded)
- ❓ Process documentation (is it current, or outdated?)
- ❓ Code comments/snippets (usually in GitHub, not here)

### Integration with SESSION_END

**Every session end, I check for:**
- New docs created this session → stored with proper naming
- Cross-references added to state files
- All pushed to getcarwise-docs

**When you backfill old docs:**
- Same process applies → rename, reference, commit, push
- Gets same treatment as session-created docs
- Next session's FILE VERIFICATION fetches all (old + new)

### Quick Reference — Prompt Templates

**Short version (just give me the essentials):**
```
Store this from [CHAT_DATE]: [DOC_NAME]
Type: [AUDIT/PLAN/PROTOCOL/GUIDE/INVESTIGATION]
Reason: [one sentence why]
```

**Medium version (add context):**
```
Store this from [CHAT_DATE]: [DOC_NAME]
Type: [AUDIT/PLAN/etc]
Summary: [what the doc contains]
Relates to: [task/item/decision if applicable]
```

**Full version (paste & let me evaluate):**
```
Please evaluate and store this document:

Original chat: [DATE]
Title: [NAME]
Type: [AUDIT/PLAN/etc]
Content: [paste full markdown]
Reason: [why you want it stored]
```

---

**When:** Before creating any file  
**Files:** The 4 active files + archive  

**The 4 Active Files (EXACT NAMES):**
- `STATE.md` — This week's status (update every session end)
- `DECISIONS.md` — Decision history (append-only)
- `REFERENCE.md` — Static tech refs (update only when creds change)
- `PLAYBOOK.md` — This file (update when SOPs change)

**Before Creating a File:**
1. Stop. Is this a new file or updating an existing one?
2. Check the 4-file list above. Use exact name if it's one of these.
3. If new file: Name format is `DESCRIPTIVE_NAME_v1.md` with version at END
4. Copy-paste the name (don't type from memory)
5. Then call create_file with confirmed name

**Validation:** `wc -c STATE.md DECISIONS.md REFERENCE.md PLAYBOOK.md`  
Expected: All files exist and size increases over time (never shrinks)

---

## TASK: DECISIONS — Add Decision to Log

**When:** At end of session, after every decision  
**Format:** ID + Date + Owner + Decision + Context + Alternatives + Rationale + Outcome + Impact + What would invalidate  

**Step 1: Create Decision ID**
- Format: `[TYPE]-YYYYMMDD-NNN`
- Types: EXEC, BLOG, REDDIT, UX, GSC, LEGAL, ARCH, PROC, etc.
- Example: `REDDIT-20260624-001` (first reddit decision on June 23)

**Step 2: Write Entry (5 fields, ~10 lines)**
```
### [ID]: [One-sentence decision]

**Date:** Tuesday, June 23, 2026  
**Owner:** [Name or Claude]  
**Status:** ✅ LOCKED / ⏳ PENDING  

**Decision:** [Restate decision clearly]

**Context:** [Why this arose — 2–3 sentences]

**Alternatives Considered:**
| Alt | Approach | Pros | Cons |
|-----|----------|------|------|
| A | Option A | ... | ... |
| B (CHOSEN) | Option B | ... | ... |

**Rationale:** [Why this choice — 2–3 sentences]

**Outcome:** [What changed, what was implemented]

**Impact:** [Consequences, what this enables]

**What would invalidate this:** [Condition forcing reconsideration]
```

**Step 3: Append to DECISIONS.md**
- Go to TOP of file (reverse chronological)
- Paste your entry
- Add `---` separator below
- Save

**Step 4: Validate**
- `grep "^###" DECISIONS.md | wc -l` — should increment
- `grep "^###" DECISIONS.md | head -3` — your entry should be first 3

---

## TASK: WIDGETS — Build, Fix, or Test

**When:** Building new widget (Mode A), fixing live widget (Mode B), or updating WordPress (Mode C)  

### Mode A: Claude Code (New Widget)

**When:** Building something new from scratch  
**Time:** 4–8 hours, 5–10 PRs  
**Tool:** claude.ai/code (never desktop app)  

**Process:**
1. Write full spec in chat
2. Claude Code creates files + PRs (DRAFT)
3. You review each PR
4. Click "Ready for review" on each PR
5. Merge → auto-deploy to Vercel (~2 min)
6. Test on vercel.app, then on getcarwise.app embed

**Don't:** Use GitHub web editor for new builds (can only edit 1 file at a time)

### Mode B: GitHub Web Editor (Fix Live Widget)

**When:** Fixing bug in existing live widget (single file, ≤50 lines)  
**Time:** 5–15 minutes  
**Tool:** GitHub web editor (via Chrome extension)  

**Process:**
1. Identify exact file and changes (write down old + new text)
2. Go to github.com/AndreBro007/carclever-widget
3. Use Ctrl+K to search for file (e.g., "lib/intentDecoder.ts")
4. Open file, press Ctrl+H (Find & Replace)
5. Find: [OLD TEXT] → Replace: [NEW TEXT]
6. Verify exactly 1 match before clicking Replace (not Replace All)
7. Write commit message: "fix: [brief description]"
8. Click "Commit directly to main"
9. Wait 2–3 min for Vercel auto-deploy
10. Verify on vercel.app

**Key Rule:** Use Find & Replace (Ctrl+H), NEVER manual selection + typing (CodeMirror bug)

### Mode C: WordPress REST API (Create/Update Pages & CSS)

**When:** Creating WordPress pages or updating Global Styles CSS  
**Time:** 2–5 minutes  
**Tool:** Python + urllib in bash_tool (from this chat)  

**Example: Update page content**
```bash
python3 <<'EOF'
import urllib.request, json, base64

url = "https://getcarwise.app/wp-json/wp/v2/posts/453"  # Deal Score page ID
auth = base64.b64encode(b"claude-automation:uHxI INoa qgTg iD8t Eein GgbU").decode()

data = {
    "content": "<p>New page content here</p>",
    "featured_media": 406,
    "status": "publish"
}

req = urllib.request.Request(url, data=json.dumps(data).encode(), 
                            headers={
                                "Authorization": f"Basic {auth}",
                                "Content-Type": "application/json"
                            },
                            method="POST")

with urllib.request.urlopen(req) as response:
    print(response.status, response.read().decode()[:200])
EOF
```

**Then:** Refresh WordPress page to verify changes rendered correctly.

---

## TASK: BLOG — Create & Publish Blog Post

**When:** Creating new blog post  
**Time:** 2–3 hours  

**Phase 1: Write Content**
- Format: HTML (not Markdown)
- Structure: Article container with H2/H3 headings, blue gradient dividers, callout boxes
- Images: 3 required (featured + 2 body images, 1200×600px each)
- CTA: Link to /carclever-lite/ at bottom
- Match style: Use Post 2 or 4 as reference for CSS/layout

**Phase 2: Upload Images**
- Featured image: 1200×630 px (blog card + header)
- Body images: 1200×600 px each (3 total)
- Alt text required: Descriptive, <125 chars, accessible
- Upload to WordPress Media Library via REST API or UI

**Phase 3: Create WordPress Post**
- API endpoint: POST /wp-json/wp/v2/posts
- Fields: title, content, category (113 = Essential Guides), author (ID 1), featured_media (406), status (draft)
- Author: ID 1 (André Broekman), NOT ID 2 (claude-automation)

**Phase 4: Global Styles CSS**
- File: Global Styles ID 5 (scoped to `.single-post`)
- Update: Match font, colors, spacing from prior posts
- Fonts: Sora (headings), Plus Jakarta Sans (body), Courier New (code)
- Colors: #2563eb (blue), #dc2626 (red), #16a34a (green)

**Phase 5: Publish**
- Set status to "publish" via REST API or UI
- Refresh site to verify rendering
- Share decision log entry

**Reference:** BLOG_POST_COMPLETE_REFERENCE.md (on Drive)

---


## TASK: REDDIT (v3.4 ACTIVE)

**Owned by:** Claude (execution) + André (decisions)  
**Reference:** REDDIT_SOP_V3_4_COMPLETE.md (Google Drive, July 4, 2026) — [link](https://drive.google.com/drive/u/0/folders/1lPBih8ohBX_tyaDRFRyZ_bj9KA5h1Vgo5wxjAH4cPow)  
**Status:** Phase 2a (Days 11–14 final sprint) ACTIVE, on track for July 11 close

### EXECUTION TIMELINE

| Phase | Days | Dates | Activity | Rules | Owner |
|-------|------|-------|----------|-------|-------|
| Phase 2a | 1–14 | Jun 28–Jul 11 | 2–3 comments/day (pure help) | ZERO mentions | Claude |
| Phase 2b | 15–24 | Jul 12–21 | 3–5 comments/day + 1 text post | Still no mentions | Claude |
| Phase 2c | 25–30 | Jul 22–27 | First mentions (6-step formula) | Max 1/week + real data | Claude |
| Phase 3 | 31+ | Jul 28+ | 3–5 comments/day, sustainable | 1–2 mentions/week | Claude |
| Phase 6 | 45+ | Aug 11+ | Conversation Ads, Free-Form Ads | CPA tracking | Claude + André |

### DECISIONS LOCKED (June 28)

1. **Early paid ads:** Escalate if 75%+ engagement; primary August 11+
2. **Blog integration:** Weekly companion blog posts (July 22+) linked to Reddit + carclever-lite
3. **Keywords:** Current list, review weekly, update if trending 5+/week
4. **Dashboard:** Google Sheet (`REDDIT_METRICS_DASHBOARD_v1_20260712.gs`), Mondays 9 AM

### CRITICAL RULES

- Fresh DuckDuckGo profile (no VPN, ever)
- Days 1–14 = ZERO mentions (pure help only through July 11)
- 7+ min spacing between all posts
- 90/10 rule: 9 help : 1 promotional (account-wide)
- PDF baseline export after every post (health monitoring)
- Blog integration: Each Reddit post gets companion blog post
- Soft CTA only (practical advice + blog link, no hard sell)

### WEEKLY CHECKLIST (Starting July 12)

- [ ] Monday: Dashboard update (9 AM Brisbane)
- [ ] Monday: Reddit Pro keyword review
- [ ] Daily: 2–3 comments (Phase 2a) or 3–5 (Phase 2b+)
- [ ] Daily: 7+ min spacing between posts
- [ ] Daily: PDF baseline export after final post
- [ ] Weekly: Check for shadowban signals (frozen view counts)
- [ ] Weekly: Monitor 75%+ engagement for early ads trigger
- [ ] Phase transition (July 12, 22, 28): Review SOP for new phase

### BLOG INTEGRATION

- **Strategy:** Reddit post (teaser) → Blog post (deep dive) → CarClever tool (calculator)
- **Start:** July 22 (Phase 2c)
- **Frequency:** 1 blog post per week (minimum)
- **Topics:** Branded titles, financing, market values, pre-purchase inspections
- **Links:** Each blog post links to carclever-lite free tool
- **SEO:** Blog posts indexed, build domain authority, create Reddit backlinks

### NEXT MILESTONES

- **July 11:** Phase 2a completion (14–21 total comments, healthy view growth)
- **July 12:** Phase 2b start + weekly dashboard launch (first update)
- **July 22:** Phase 2c start + breakthrough formula activation + first blog post
- **July 28:** Phase 3 start (account 30+ days old) + early ads window opens
- **August 11:** Phase 6 start (primary ads timeline, if not triggered earlier)

### CONTACTS & ESCALATIONS

- **Decision escalation:** If 75%+ engagement hit, notify André (early ads approval)
- **Shadowban detected:** Stop posting, save PDF evidence, appeal to reddit.com/message
- **Dashboard questions:** Check REDDIT_SOP_V3_1_DECISIONS_FINAL.md or Google Sheet


## TASK: MONITORING — Weekly Metrics Read

**When:** Every Monday morning Brisbane time (or when doing session startup)  
**Time:** 20–25 minutes  

**Platforms (in order):**

1. **GA4** (5 min)
   - Navigate: https://analytics.google.com
   - Read: Active users (7d), Event count, Engagement time, Top pages, Traffic by country/city
   - Export: Optional (for Cowork, but not needed if just checking in chat)

2. **Clarity** (3 min)
   - Navigate: https://clarity.microsoft.com
   - Read: Sessions (excluding bots), Pages/session, Scroll depth, Dead clicks %, Rage clicks %
   - Note: Dead clicks >20% = UX flag

3. **GSC** (3 min)
   - Navigate: https://search.google.com/search-console
   - Read: Total clicks, Impressions, Avg CTR, Avg position, Top queries
   - Note: Position <15 = page 1; >16 = page 2 (target <15)

4. **AI Visibility / Copilot Citations** (2 min)
   - Dashboard: Microsoft Clarity → AI Visibility tab
   - Read: Total citations, Top cited pages, Citing platforms

5. **CJ Affiliate** (2 min — PERMANENT, added July 4 2026 per V3 readiness checklist)
   - Navigate: https://members.cj.com → Reports → Performance
   - Read: Clicks (week), Commissions/revenue, EPC
   - Note: Separate founder-test clicks from real clicks (see baseline test click logged in DECISIONS)
   - Flag: First non-founder click = milestone, log in STATE.md

6. **LLM Citations** (5 min — added July 4 2026 per Ecosystem Decision #2)
   - Protocol + log table: LLM_CITATION_TRACKING_TEMPLATE_v1.md (Google Drive project folder)
   - Copilot cumulative, ChatGPT clicks (GSC), 4 Perplexity spot-check queries, GA4 AI-referral sources

7. **Optional:** Semrush or Bing (if time)
   - Semrush: Site Audit, backlinks, ranking keywords
   - Bing: Submissions, crawl stats

**Document:** Update STATE.md with snapshot of key metrics.  
**Validate:** `grep "GA4\|Clarity\|GSC" STATE.md` — should show latest values

**Cadence:** Every Monday, same time  
**Comparison:** This week vs. previous week (track trends)

---

## CRITICAL RULES (Never Break)

1. ✅ File names: Use exact names from FILES section above
2. ✅ Decisions: Append to DECISIONS.md, newest first, always validate
3. ✅ Reddit: 90/10 rule (≥90% help, ≤10% brand), incognito verify every post
4. ✅ Widgets Mode B: Use Find & Replace (Ctrl+H), never manual typing
5. ✅ WordPress: Always `featured_media: 406` on blog posts, author ID 1
6. ✅ Monitoring: Same day every week (Monday), document snapshot
7. ✅ Startup: Follow the STARTUP checklist at the top of this file (file verification across all three repos, STATE.md, ACCOUNT_MEMORY_TRANSFER.md as needed) — do not shortcut to just STATE.md + PLAYBOOK.md
8. ✅ Vercel production promotion (carclever-anth / -oai / -meta): see "TASK: VERCEL PRODUCTION SAFETY" below — this is a hard gate, not a reminder

---

## TASK: VERCEL PRODUCTION SAFETY — Read before ANY promotion or `autoAssignCustomDomains` change

This section exists because of two real incidents where it wasn't followed: `SYS-20260917-001` (Sep 17) and a second occurrence in a Sep 24 session (superseding "prevention" text logged that same day turned out to be insufficient on its own — this section is the actual enforced version).

**Root cause of both incidents:** a deployment was pointed at a live custom domain (`carclever-anth.getcarwise.app`, `carclever-oai.getcarwise.app`, or `carclever-meta.getcarwise.app`) without that deployment being the current tip of the domain's own tracked branch — i.e. a manual "pin" sitting outside normal branch history. This creates two competing sources of truth for what's live (the branch, and the pin). Nothing keeps them in sync, and nothing warns you when a later, unrelated push to the tracked branch — especially with `autoAssignCustomDomains` on — silently overrides the pin with whatever the branch currently contains, which may be missing the very fix the pin was put there to deliver.

**Hard rules, no exceptions:**

1. **Never point a live custom domain at a deployment built from a branch other than that domain's own tracked production branch.** If a fix needs to go live, merge it into the actual tracked branch first (a real commit, `git merge` or equivalent) — then promote the resulting branch-tip build. Never use "Promote to Production" on an unmerged feature/test branch as a way to ship something live.
2. **Before touching `autoAssignCustomDomains` (on any of the 3 projects: `carclever-find-my-car`, `ccfmc-dev-v2`, `carclever-meta`) or promoting anything to production on any of them, first fetch and show, in the response, the current live commit + full alias list for all 3 domains.** This is not a mental check — the actual command output must be produced and shown before proceeding. (Method: `GET /v6/deployments?projectId=X&limit=1` for the latest `target: production` entry per project, then `GET /v2/deployments/{uid}/aliases` to confirm it actually holds the real custom domain, not just an auto-generated URL.)
3. **`autoAssignCustomDomains` defaults to OFF on all 3 projects, and this is now permanent, not a "toggle when needed" setting.** Corrected Sep 24, 2026 (see `DECISIONS.md` `SYS-20260924-012`): the standard, preferred method to promote a build onto a live domain is `POST /v10/projects/{projectId}/promote/{deploymentId}` (Vercel's dedicated manual-promote endpoint). Vercel's own documentation confirms this endpoint is specifically designed to work while `autoAssignCustomDomains` is OFF ("Promote a staged production build... to use this option, you must turn off the auto-assignment of domains") — so the setting never needs to be touched at all for a normal promotion. Toggling it on is a fallback only, for the rare case the promote endpoint doesn't apply, and if used, must be turned off again immediately in the same session.
4. **After any promotion, verify by hitting the live domain itself** (a real functional check relevant to what changed — e.g. an affiliate-link format check, a tool call, or a raw MCP `initialize` call checking `serverInfo.version` against the exact expected commit) — not just the Vercel dashboard's "Production" badge. That badge only records that a deployment *was* promoted at some point; it does not mean it currently holds the domain, and it is never updated if the domain is later reassigned elsewhere. Note (Sep 24, 2026): a prior version of this rule framed the badge itself as inherently confusing — the badge's meaning is simple and stated correctly above; the actual discipline required is just to check the live alias directly before making any claim about what's live, every time, without exception.

---

**Last Updated:** Sep 21, 2026  
**Next Update:** When a new SOP changes or task changes  
**Backup:** This file syncs to Drive at session end  


---

## REDDIT EXECUTION SOP v3.4 (JULY 4, 2026)

**DO NOT READ THIS SECTION.** The embedded SOP is outdated.

**→ Read the canonical SOP instead:**  
**File:** REDDIT_SOP_V3_4_COMPLETE.md  
**Location:** Google Drive (project folder, dated July 4, 2026, 1,546 lines)  
**Link:** [REDDIT_SOP_V3_4_COMPLETE.md](https://drive.google.com/file/d/1lPBih8ohBX_tyaDRFRyZ_bj9KA5h1Vgo5wxjAH4cPow/view)

**What changed since v3.2:**
- 5 ecosystem decisions approved (CAPI, LLM citation tracking, auto-draft listening, AMA strategy, developer tier)
- Viral hooks method validated + integrated into Phase 2b (Days 25–30)
- Chrome extension workflow documented (v3.3)
- Phase 2a metrics + strategy finalized (17 comments, Day 11, on track)

**Quick reference:** Top-level comments only (Days 6–14) | 7-min spacing | US peak posting 3–5 AM Brisbane | Zero brand mentions Days 1–14 | Search specific trim names before searches (PHEV keyword issue documented)


---

## TASK: CODE_AGENT_PROMPT — Drafting a brief for the Fractal code agent

Fractal allows one agent session per day. A brief that contains a wrong premise, a self-contradiction, or an unverifiable claim costs a full day. The checks below exist because each one has already cost one.

### Before writing — establish provenance for every claim

Tag every problem statement as one of three, and write the tag in your notes:

| Tag | Meaning | Allowed to become a "Change required" |
|---|---|---|
| **Observed** | I ran it and read the output | Yes |
| **Computed** | I derived it from observed numbers | Yes, if the arithmetic is shown |
| **Reported** | Someone else told me (ChatGPT, a review, a memory) | **No** — must be reproduced first, or written as investigate-only |

Never let a Reported claim become an implementation instruction. Two R1 tasks were built on reported claims that did not reproduce, and one refutation of a reported claim was itself wrong because it used the tool's own output as ground truth for whether that tool was correct.

**A diagnosis resting on two data points is a hypothesis.** Run the third query. The `vehicle.type` fault looked like "the filter is broken" from two samples and turned out to be "the field is a segment taxonomy" on the fifth.

### While writing — structure each task the same way

```
## TASK n — one-line symptom
**Problem.**        plain language, no jargon, no history
**Repro.**          exact parameters, exact current output
**Change required.** what must be true afterwards, not how to code it
**Expected outcome.** an assertion someone else could check
**Preserve.**       what must not change
```

Investigate-only tasks say so in the heading and state explicitly that reporting a negative finding is a successful outcome. Otherwise an agent measured on green ticks will implement something rather than report that the premise was wrong.

### Before handing over — adversarial pass (separate pass, not a reread)

Run these as literal greps, not as a careful reading:

1. **Conditionals and their siblings.** For every task with two paths or an "if", grep every other mention of that task — expected outcome, regression test, execution order, cross-references. Fixing the branch in front of you and leaving a sibling assuming one outcome has happened four times.
2. **Cross-references.** grep `TASK \d` and confirm each points where intended after any renumbering.
3. **Numbers you computed rather than observed.** Recompute each one. Two shipped wrong: a percentage against the wrong denominator, and a total that double-counted a term already included.
4. **Truthiness and null assumptions.** Any claim about why code behaves a certain way — check the logic actually holds. An "empty string skips the block" theory was backwards; empty string is falsy, so the block runs.
5. **Aggregations.** Sums across batches or pages usually double-count. State whether a figure is exact, an upper bound, or unavailable, and handle the unavailable case downstream.
6. **Protected areas.** Every DO NOT TOUCH item should be adjacent to something a task actually edits. If no task goes near it, delete it — the agent has no context for why it's there.
7. **Chat-only context.** grep for dates, "previously", "as we discussed", session references, internal task IDs. The agent has none of it.

### Before handing over: run PROMPT_SELF_AUDIT

Ten grep-based checks, and PROMPT_EVIDENCE for provenance. Do not skip it because the document feels finished — the checks exist precisely for documents that feel finished.

### Verify your own edits by content, never by exit code

`str.replace` returns silently when nothing matches. A script that exits 0 proves nothing. After every edit batch, `grep -c` for the new string and for the absence of the old one. This has produced a false "applied" report.

---

## TASK: DEPLOY_VERIFY — Confirming a code agent run actually worked

"Typecheck passed" and "build succeeded" are not evidence of behavioural correctness. R1 reported both and had two failed tasks and three partials.

### Order of operations

1. **Fetch `tools/list` directly from the endpoint** — do not trust a client's cached schema. Clients hold pre-deploy tool definitions and will show you the old version. Use the MCP init → notifications/initialized → tools/list sequence with a `User-Agent` header.
1b. **The same distrust applies to MCP App UI resources (`resources/read`), not just tools — and this one is unresolved as of Aug 31, 2026.** A widget-HTML fix (`carclever-find-my-car`, `fix/total-matches-count-bug`) was verified correct in source and verified deployed on Vercel, yet still rendered old content through every combination tried live in Claude: same chat, new chat, a bumped resource URI, and a full Disconnect+reconnect of the custom connector. Full history: DECISIONS.md `SYS-20260831-001` (in the sibling `carclever-find-my-car` repo). **Lesson banked either way this resolves:** don't trust a rendered widget as proof of what's deployed — confirm with a raw `resources/read` call (see the MCP raw-call template in `TASK: MCP_LIVE_TEST_VIA_CHAT` below) before concluding a widget fix did or didn't ship.
2. **Grep descriptions for the exact strings the brief targeted** — both the new strings present and the old ones absent.
3. **Check annotations** — `readOnlyHint`, `destructiveHint`, `openWorldHint` per tool.
4. **Run the repro for every task**, not a sample. Paste output.
5. **Read the widget payload, not only the assistant text.** Several fields — `mileage_assessment`, `condition_class`, `is_cpo`, negotiation figures — never appear in the compact text output. A field looking wrong or missing in the text may simply not be surfaced there. Use a tool that exposes raw structured content, or verify independently against the provider API.
6. **Test both branches of any threshold rule.** A rule can pass its false-positive test and fail its true-positive test — R1's delivery-mileage fix stopped mislabelling high-mileage cars and simultaneously stopped labelling genuine ones.
7. **Compare against a control.** New-vehicle behaviour only reads as wrong beside a used-vehicle equivalent run.

### Classify every assertion before running

- **Deterministic** — schema limits, arithmetic reconciliation, routing, wording. A failure is a failure.
- **Live smoke** — listing counts, current prices, whether a VIN is still listed, market diversity. A failure is an investigation warning, not a release blocker, unless a structural invariant broke.

---

## SESSION-END: stale-copy guard

The files fetched at session start are **not safe to append to at session end** if the session ran long. A parallel session may have written to GitHub in between.

Immediately before appending: re-fetch all five files, diff against your local copies, and check for entries covering the same date or topic. Then append to the fresh copies.

The byte-count rule stands and is not optional: **new file size must be ≥ remote size, or abort.** This guard has now prevented one truncation event on top of the three already in DECISIONS.md.


---

---

## SESSION WORK STORAGE & END-OF-SESSION PROTOCOL

**Effective:** August 27, 2026  
**Status:** Locked, canonical  
**Change control:** Update only with explicit decision in DECISIONS.md  

---

### Where Session Work Goes

**All session work → GitHub repository root (carclever-widget)**

Not in `/mnt/user-data/outputs/`  
Not in temp folders  
Not in Google Drive  

**Why?** Version control, persistence, available next session, audit trail.

---

### Naming Convention

Use the **tier system** + date prefix:

```
999_SESSION_YYYY-MM-DD_[DESCRIPTION].md
```

Examples:
- `999_SESSION_20260827_CLEANUP_REPORT.md` — Today's cleanup work
- `999_SESSION_20260827_ARCHITECTURE_DECISIONS.md` — Issues logged
- `999_SESSION_20260827_AUDIT_RESULTS.md` — Verification output

**Rationale:** 999_ tier puts it after core (000_/002_/010_/020_) but immediately visible. Date makes it sortable and searchable. Description ties to the work.

---

### What Gets Stored (Persistent)

✅ **STORE on GitHub:**
- Session summaries (what was done, duration, status)
- Cleanup/audit reports (with audit trails)
- Architecture issues (for later discussion + DECISIONS entry)
- Decision logs (reference + decision number)
- Verification reports (proof files made it)

❌ **DO NOT STORE** (ephemeral):
- Temporary working files
- Draft notes for internal use only
- Debugging output (unless part of audit)
- Personal TODOs (goes in TASKS.md instead)

---

### End-of-Session Process

**At session end, follow this order:**

1. **Gather all session work files** (reports, summaries, audits created during session)
2. **Name them** with `999_SESSION_YYYY-MM-DD_` prefix
3. **Create a session summary entry** in DECISIONS.md (reverse chronological)
4. **Stage all files** for GitHub commit
5. **Commit to GitHub** with message: `Session work: [YYYY-MM-DD] [brief description]`
6. **Push to GitHub** (verified with live endpoint check)
7. **Verify all files made it** (curl/API check on GitHub)
8. **Clean up temp files** (delete from /tmp/)

**Result:** Everything persisted on GitHub, version-controlled, available next session.

---

### Example: This Session (Aug 27, 2026)

**What I should have done:**

1. ✅ Create `999_SESSION_20260827_CLEANUP_REPORT.md` (summary of cleanup work)
2. ✅ Create `999_SESSION_20260827_ARCHITECTURE_ISSUE.md` (project files access model)
3. ✅ Add entry to DECISIONS.md:
   ```
   DECISION-SESSION-20260827-001: Session Work Storage Protocol
   - Adopted 999_SESSION_ prefix for all session work
   - GitHub root is home for all session files
   - Commit + push at session end
   - Verified with API check
   ```
4. ✅ Commit both files to GitHub
5. ✅ Push with message: "Session work: 2026-08-27 Option C cleanup complete"
6. ✅ Verify both files exist on GitHub with curl
7. ✅ Delete /tmp/ working copies

**Instead I did:**
- ❌ Created files in /mnt/user-data/outputs/ (not persistent)
- ❌ Never committed to GitHub
- ❌ Never pushed
- ❌ Never verified

---

### Verification Checklist

**Before closing session:**

```bash
# 1. List all 999_ files created
git log --oneline | grep "Session work"

# 2. Verify each file exists
for file in 999_SESSION_*.md; do
  curl -s -H "Auth: token $PAT"     https://api.github.com/repos/AndreBro007/carclever-widget/contents/$file     | grep -q '"sha"' && echo "✅ $file" || echo "❌ $file"
done

# 3. Check DECISIONS.md updated
grep "DECISION-SESSION-$(date +%Y%m%d)" DECISIONS.md

# 4. Clean temp
rm -f /tmp/SESSION_* /tmp/ARCHITECTURE_* /tmp/*_REPORT.md
```

**All checks pass → session complete ✅**

---

### Why This Works

| Aspect | Benefit |
|--------|---------|
| **GitHub storage** | Version-controlled, persistent, available next session |
| **999_ prefix** | Sortable, visible after core files, signals "session artifact" |
| **Date in name** | Searchable by session, audit trail built in |
| **DECISIONS.md entry** | Every session logged, decision trail recorded |
| **Verification step** | Proof files made it, no assumptions |
| **Clean temp** | No orphaned files, no pollution |

---

### Changes from Previous Model

| Old (BROKEN) | New (FIXED) |
|---|---|
| Files in `/mnt/user-data/outputs/` | Files in GitHub root with 999_ prefix |
| No version control | Full git history |
| Lost after session | Persistent forever |
| No audit trail | Timestamp + decision number |
| Manual download needed | Auto-available in git |

---

### Policy

**Non-negotiable:**
- All session work → GitHub
- Name it with 999_ prefix + date
- Verify it's there before closing
- Add decision entry to DECISIONS.md

**If session work is important, it goes to GitHub. If it goes to /mnt/user-data/outputs/ without GitHub commit, it doesn't persist.**

---


## TASK: PROMPT_SELF_AUDIT — Run this on every code-agent brief before handing it over

Do this as a **separate pass with greps**, not a careful re-read. Re-reading finds nothing; you inherit your own framing. Every check below exists because it cost a review round.

### 1. Claim versus heading

The single most frequent failure. The body qualifies the evidence correctly; the heading or opening sentence above it states more than was proven. Six corrections in one session came from this alone.

Read **only** the headings and the first sentence of each Problem section, stripped of their bodies, and ask what each asserts. Then check the body actually proves it.

Examples of the failure, all real:
- Body: "did not vary by year or mileage in the controlled test." Heading: "ignores age, mileage **or warranty**" — warranty was never supplied.
- Body: "the controlled test supplied no `inventory_type`." Heading: "ignores age **and condition**."
- Body: "inspect whether a configured MSRP field exists." Heading: "**There is no** configured MSRP."

Rule: if the body says "in the controlled test" or "investigate whether", the heading may not say "ignores", "never" or "there is no".

### 2. Conditionals and their siblings

If a task has two outcomes — Path A/B, "if achievable", "if still reachable", "BLOCKED BY PROVIDER DATA" — then **every** other mention of that task must branch the same way. Check the expected outcome, the regression test, the execution order and any cross-reference.

This failed five times across two rounds. The shape is always the same: the branch in front of you gets fixed, a sibling elsewhere still assumes one outcome, and an agent doing the right thing fails its own test.

```
grep -n -iE "if (no|none|neither|not )|depends on|Dependency on|BLOCKED" prompt.md
```
For each hit, grep the task number and confirm every mention branches.

### 3. Cross-references — including misdirected ones

A dangling-reference check passes when a reference resolves to *a* task. It does not catch a reference pointing at the *wrong* task after renumbering. Inserting a task mid-document silently redirected two pointers in one session.

```python
defined={int(m) for m in re.findall(r"^## TASK (\d+)", s, re.M)}
refd={int(m) for m in re.findall(r"TASKS? (\d+)", s)}
print(sorted(refd-defined))            # dangling
# then print each "per TASK n" with the title of task n and read them
```

### 4. Instructions that cannot all be true

Accumulated edits produce contradictions no single edit introduced. One session produced three coexisting instructions for the same condition — suppress the factor, give it a neutral contribution, redistribute its weight — each added separately, each sensible alone.

After any multi-round revision, list every instruction attached to one condition and confirm they describe one behaviour.

### 5. Protections that block required work

`DO NOT TOUCH` entries written to prevent drift can also forbid a task in the same document. Two occurrences in one brief: budget-fit protection versus a task adding budget fit to a new path; `inventory_type` override protection versus a task adding inventory type to the risk path.

For each protected item, grep it across the task bodies. Any hit needs an explicit carve-out.

### 6. Numbers you computed rather than observed

Recompute every one. Two shipped wrong in a single session — a percentage against the wrong denominator, and a total that double-counted a term already included. Separately, a scoring curve and its acceptance target were written in different turns and contradicted each other arithmetically.

Where a prompt specifies both a formula and a target outcome, calculate the outcome from the formula and confirm they agree.

### 7. Aggregations

Sums across batches or pages almost always double-count. State whether a figure is exact, an upper bound, or unavailable — and define the unavailable case downstream, including pagination flags.

### 8. Every task needs a concrete repro, every non-report task needs a test

```
grep -c "^## TASK" prompt.md
```
Then confirm each has parameters someone else could run, and a matching regression item. Three tasks in one draft had neither.

### 9. Chat-only context

```
grep -n -iE "previously|last round|as we discussed|R[0-9]|earlier session|Aug|2026-" prompt.md
```
The agent has none of it. Reword self-contained.

### 10. Verify edits by content, never by exit code

`str.replace` returns silently when nothing matches. A script that exits 0 proves nothing. After every edit batch:

```
grep -c "new string" prompt.md    # expect >=1
grep -c "old string" prompt.md    # expect 0
```

This produced a false "applied" report in the same session it was written down.

---

## TASK: PROMPT_EVIDENCE — Provenance rules for anything asserted to a code agent

Tag every claim before it enters a brief:

| Tag | Meaning | May become a "Change required"? |
|---|---|---|
| **Observed** | I ran it and read the output | Yes |
| **Computed** | Derived from observed numbers, arithmetic shown | Yes |
| **Reported** | Someone else said so — another model, a review, a memory | **No** — reproduce first, or write it as investigate-only |

Two tasks in one round were built on reported claims that did not reproduce. One refutation of a reported claim was itself wrong, because it used the tool's own output as evidence that the tool was correct — circular.

**Controlled tests beat opportunistic comparisons.** Comparing a new Toyota against an old Cadillac proved nothing about age sensitivity; the difference was make-based. Holding make, model and price constant while varying only age and mileage proved it in one call. Vary one thing.

**A diagnosis resting on two data points is a hypothesis.** Run the third query. A body-filter fault looked like "the parameter is broken" from two samples and turned out to be "the field is a mixed segment taxonomy" on the fifth.

**Do not name a mechanism you have not verified.** A field called `createdAt` is not evidence of when a price was checked. Prefer "the age of X is unknown" over a plausible-sounding attribution.

**State what a test does not prove**, in the brief itself. "The formula does not vary by year or mileage for the same make and model. No warranty or inventory-type data was supplied, so their treatment is untested." That sentence prevents an agent from fixing something that was never measured.

---

## TASK: MCP_LIVE_TEST_VIA_CHAT — Smoke-testing an MCP App by naming the connector in chat

Established Aug 31, 2026 (`carclever-find-my-car`, `fix/total-matches-count-bug` — see DECISIONS.md `SYS-20260831-001`). This is now the standard method for live-testing any V2 MCP App tool against a real preview deployment, without needing dev tooling.

### How it works
1. Point a custom connector (e.g. `CarClever Test`) at the preview URL, `.../mcp` path included — a Vercel git-branch alias domain (`<repo>-git-<branch-slug>-<team>.vercel.app`) always resolves to that branch's latest deployment automatically.
2. In any Claude chat, name the connector explicitly and phrase the request naturally: `"use connector CarClever Test, <natural-language request>"`. Naming it explicitly means Claude calls it directly — no search/suggest round-trip.
3. This exercises the real, complete path: real Auto.dev data, real widget rendering, real narration — not a mocked payload. It's the cheapest way to catch bugs that only exist at the seam between server output and client rendering (exactly how the widget-header bug in `SYS-20260831-001` was found — invisible to offline jsdom tests, obvious in one screenshot).

### Claude can and should run this itself — not just wait for André to test and report back
This is not only a human-driven method. If the `CarClever Test` connector is already connected in the current chat, **Claude has direct tool access to it** (`CarClever Test:find_matching_vehicle`, `CarClever Test:resolve_dealer_url`) and should call it proactively as part of its own verification — the same way `npm test`/`typecheck`/`build` get run before reporting a fix as done, not just described as steps for a human to run separately.

**Concretely, after shipping any fix to `carclever-find-my-car` in a session where the connector is available:** call the connector directly with 1-2 representative queries covering the scenario the fix targets (e.g. a broad, unconstrained search to exercise the `BROAD_SHORTLIST_SIZE=8` path; a tight multi-constraint search to exercise verification/drift exclusion) before telling the human the fix is confirmed working live. Don't stop at offline tests passing and describe a manual chat prompt for the human to try — run it. This was done successfully mid-session on Aug 31 (the "large SUV under 60k in 90210" and follow-up broad-SUV queries were called directly by Claude, not relayed to André to run) and is how fix #1 (the count-narration bug) got confirmed live in the same turn it was investigated, rather than in a follow-up round-trip.

**Caveat inherited from `SYS-20260831-001`'s open item:** a widget rendering fine in this self-run test is evidence the *tool call and text response* are current — it is explicitly **not** sufficient evidence that widget *HTML/JS* changes are live, given the unresolved caching mystery. For widget-content changes specifically, self-running the connector call is still worth doing (confirms the data/text path), but only the raw `resources/read` template below actually confirms widget-HTML freshness.

### Raw MCP call template — for when the chat client itself is a suspect
Needed when a fix is verified correct in source and verified deployed, but doesn't appear to be working live (see the `DEPLOY_VERIFY` 1b caveat above — this is exactly that situation, currently open). Bypasses Claude's connector/client layer entirely so the server's actual raw response can be inspected.

**Requires network access to the target `*.vercel.app` domain** — the sandboxed engineering environment's `bash_tool` does not have this (allowlisted to package registries + GitHub only), so this must be run from an environment with general internet access (a real terminal, or a future sandbox with broader egress).

```bash
BASE_URL="https://<preview-domain>.vercel.app/mcp"

# 1. Initialize
curl -s -X POST "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "User-Agent: mcp-manual-verify/1.0" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-verify","version":"1.0"}}}'
# → capture the returned session/mcp-session-id if the server sets one (often in a response header)

# 2. notifications/initialized (some servers require this before further calls)
curl -s -X POST "$BASE_URL" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3a. tools/list — confirm the live tool schema/description matches the branch tip
curl -s -X POST "$BASE_URL" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3b. resources/read — the critical one for widget-content mysteries. Use the
# EXACT resourceUri a tools/call response declares in its _meta.ui.resourceUri
# (or the constant in the relevant repo's results-card.ts / equivalent).
curl -s -X POST "$BASE_URL" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://carclever-find-my-car/results-card-v2"}}'
```

Read the `resources/read` response's `contents[0].text` directly and grep it for the string in question (e.g. `"Top 5 of"` vs `"Top 5 shown"`). If the raw server response already has the wrong text, the bug is server-side regardless of what earlier investigation concluded — trust this over any prior "confirmed deployed" claim. If it has the right text, the mismatch is entirely in Anthropic's client/connector layer and is not fixable from this codebase.

**Note: this exact template is untested from within this sandbox** (network restriction above) — treat the JSON-RPC method names/params as standard MCP protocol shape, but verify against whatever MCP SDK version this repo's `package.json` pins if the first attempt gets a protocol-mismatch error.

---

## TASK: GITHUB_ADMIN_FILE_EDIT — Editing STATE.md/TASKS.md/DECISIONS.md/PLAYBOOK.md safely via API

The discipline actually used throughout Aug 30-31 sessions, every time. Skipping any step here is how silent truncation/overwrite happens (see the existing byte-count rule under SESSION-END: stale-copy guard, which this extends).

1. **Fresh fetch immediately before editing** — even if you fetched at session start, re-fetch right before this specific edit. Diff against whatever copy you last had; if there's drift, read what changed before writing on top of it.
2. **Edit the freshly-fetched local copy**, not an old one from earlier in the session.
3. **Push via a request-body file, not an inline shell argument.** `curl -d "{...large base64 blob...}"` hits `Argument list too long` once file content exceeds a few hundred KB (hit this directly, twice, this session). Always: write the JSON payload (with base64-encoded content + current `sha`) to a temp file with Python/`json.dump`, then `curl --data-binary "@payload.json"`.
4. **Re-fetch after every push and diff byte-for-byte against what you intended to write.** Do not trust the push API's response body alone — it can report success while something else silently differs. This session: every single push (6 total across STATE/TASKS/DECISIONS) was re-verified this way before being reported as done.
5. **Get the current `sha` fresh in step 3, not reused from step 1's fetch**, if any time has passed — GitHub's content API rejects a stale `sha` as a conflict.

---

## TASK: V1_V2_BRANCH_ISOLATION — Working on a new app version while the current one is live or in review

Established Aug 31, 2026 while `carclever-find-my-car` was IN REVIEW with Anthropic. Reusable checklist for any future situation where V2 work needs to happen on a repo whose `main`/production is live, under review, or otherwise untouchable.

**Confirm, don't assume, each of these — and say which you checked:**
- [ ] `git fetch origin main && git log origin/main --oneline -1` before AND after every push to the feature branch — confirms `main`'s tip genuinely hasn't moved, not just that you didn't intend to move it.
- [ ] Work stays on a named feature branch; PR (if opened) is marked **draft** with an explicit "DO NOT MERGE YET" line in the PR body itself, not just remembered verbally.
- [ ] Preview deployment resolves to a **distinct domain** from whatever endpoint the live/reviewed version actually serves from (Vercel git-branch-alias domains satisfy this automatically) — confirm this explicitly, don't assume a "preview" is automatically a different URL.
- [ ] Shared resources (API keys, rate limits, quotas) between the preview and production are identified explicitly — Vercel env vars are project-level, not branch-scoped, so a preview shares production's API keys/quota by default. Flag this to the human and get an explicit call on whether that's acceptable before hammering it with tests; it usually is, but it's their resource to spend, not an assumption to make silently.
- [ ] **Preview-deployment protection is disabled (or rescoped away from `preview`) before the URL is used as a live MCP connector target.** Vercel Authentication (SSO) and Password Protection can each be scoped independently to `all`/`preview`/`production` — disabling one for Production does not disable it for Preview. **Note (Aug 31, 2026): initially misdiagnosed as the cause of a real live failure this session — it wasn't, see `SYS-20260831-002`'s retraction. Still a genuine thing to check (it's a real Vercel feature that could bite in a future project), but don't assume it's the cause of a symptom without verifying the actual project settings first — check the domain-hardcoding item below before this one, since it's the one that was actually correct.**
- [ ] **Any hardcoded production domain in widget metadata (CSP `resourceDomains`, `openai/widgetDomain`, `_meta.ui.domain`, or a constant like `APP_ORIGIN`) is derived dynamically instead**, before a preview URL is used as a live MCP connector target. This is the *actual*, code-confirmed cause of a real "Unable to reach"/"fetch it, then fail to display it" failure on Aug 31, 2026 — full diagnosis in DECISIONS.md `SYS-20260831-002`, which also matches an earlier-documented precedent (`SYS-20260825`) for the identical symptom class. Use Vercel's own `VERCEL_ENV`/`VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_BRANCH_URL` system env vars, with the current hardcoded value kept as the production-path fallback so production's declared domain never changes as a side effect. **Do NOT use `VERCEL_URL` for the non-production branch** — it's the deployment's own unique *per-deployment* hash URL, not the stable branch alias a connector is actually configured against; confusing these two is a second, subtler version of the exact same bug (`SYS-20260831-004`), caught only by directly comparing a raw `resources/read`/`initialize` response's declared domain against `window.location.origin` on the live page — verify this explicitly, don't assume the fix is correct just because it deploys and typechecks.
- [ ] **Verify with `serverInfo.version` (a live commit SHA, `SYS-20260831-005`) before trusting any test result, positive or negative.** One raw `initialize` call answers "is this actually current code?" before spending further effort investigating a symptom that might already be fixed, or celebrating a fix that isn't actually live yet.
- [ ] **When a live test result seems to contradict a verified-correct code fix, consider caching before assuming a new bug.** Full pattern and resolution: DECISIONS.md `SYS-20260901-001`. Test in ChatGPT as a fast, lower-caching-sensitivity comparison point; if truly stuck, delete+recreate the connector **and** fully close every Claude surface (desktop app fully quit, all web sessions closed) together — confirmed, not just theorized, to actually clear it.
- [ ] The only irreversible step (merge, or promoting a deployment to the production domain/alias) stays explicitly gated on human confirmation, re-checked at the start of every session — not inferred from anything else changing.

## TASK: CODE_COMMIT_HYGIENE — two small git/build gotchas hit repeatedly, Sept 1 2026

Not big enough for their own DECISIONS.md entries individually, but real and easy to re-hit without a note.

- [ ] **`npm run build` silently modifies `tsconfig.json` and creates `tsconfig.tsbuildinfo`/`next-env.d.ts` as build artifacts.** Before every commit: `git checkout -- tsconfig.json && rm -f tsconfig.tsbuildinfo next-env.d.ts`, then `git status --short` to confirm the diff contains only intentional source changes — never a generated build artifact.
- [ ] **Backticks inside a `git commit -m "..."` message get interpreted by the shell as command substitution, silently stripping content.** Easy to miss — bash prints something like `command-name: not found` to stderr, but the commit still succeeds with the backtick content quietly gone. Any commit message referencing code identifiers (which routinely use backticks) should be written to a file first and committed with `git commit -F file.txt`, never inline `-m`.


---

## V3 Card-First Hybrid Design Handoff (Sep 7, 2026)

Detailed specification and tomorrow's Claude handoff: getcarwise-docs/HANDOFF_V3_CARD_FIRST_HYBRID_BUILD_20260907.md. Supporting design: getcarwise-docs/DESIGN_V3_HYBRID_TOOL_INTEGRATION_AND_CARD_FIRST_20260907.md.

Approved direction: separate tools for discoverability, one shared vehicle-context contract, card-first responses, AI text after the card, standalone and follow-up modes, intent-driven labels/actions, calm dealer-verification messaging, and no major frontend rebuild. Start with V3.1–V3.3: shared contract, card-first check_vehicle, and standalone VIN actions. Comparison and affordability remain later phases. V1 and V2 remain frozen.
