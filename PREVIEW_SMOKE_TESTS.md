## SECTION H: PREVIEW VALIDATION SMOKE TESTS

### Preview Deployment Status
- **Branch:** `hardening/regression-gate-and-test-process`
- **Commit:** 8558960
- **Expected Preview URL:** https://carclever-find-my-car-hardening-regression-gate-and-test-process.vercel.app
- **Status:** Deployed (automatic via GitHub integration)

### Smoke Test Scenarios

All tests should be run against the preview endpoint using the MCP protocol (direct JSON-RPC calls).

#### Test 1: Generic SUV / bodyType-only search
**Request:**
```json
{
  "bodyType": "SUV"
}
```

**Expected Results:**
- ✅ Real results returned (should be 5-9 cards visible)
- ✅ No raw runtime exception ("1958", "[object Object]" leakage)
- ✅ Cards render with price, mileage, make/model/trim
- ✅ Affiliate links present and route correctly
- ✅ No output validation error (response matches FindMatchingVehicleOutputSchema)

**Why this test:** Reproduces the original provider-string-runtime-safety bug (bare bodyType search would crash on malformed trim values)

---

#### Test 2: Locked Discovery Scenario
**Request:**
```json
{
  "priorityAxis": "best_for_budget",
  "bodyType": "SUV",
  "fuel": "Hybrid",
  "priceMax": 40000,
  "location": "90210",
  "radiusMiles": 50
}
```

**Expected Results:**
- ✅ Real results for reliable hybrid SUVs under $40k
- ✅ Match scores present and varied (not all identical)
- ✅ Price ranges stay under $40k ceiling
- ✅ Hybrid fuel designation preserved or reasonably inferred
- ✅ No totalMatches showing "0 in the area" (regression check)

**Why this test:** Validates best-for-budget ranking, fair-pool logic for condition-neutral searches, and locked scenario reproducibility

---

#### Test 3: Hard Trim/Variant Search
**Request:**
```json
{
  "make": "Toyota",
  "model": "CR-V",
  "trim": "EX",
  "priceMax": 35000
}
```

**Expected Results:**
- ✅ Real CR-V EX models returned
- ✅ Trim match candidates present
- ✅ Price ceiling respected
- ✅ No crash on trim-specific matching logic

**Why this test:** Validates trim-aware filtering and link-resolution fallback (Edmunds trim-safe URL construction)

---

#### Test 4: Lowest-Mileage Behavior
**Request:**
```json
{
  "priorityAxis": "lowest_mileage"
}
```

**Expected Results:**
- ✅ Results prioritized by low mileage (earliest candidates have lowest miles)
- ✅ Used vehicles included (lowest_mileage defaults to used:true when condition unspecified)
- ✅ Match scores present and not overriding mileage sort
- ✅ Real results, no crash

**Why this test:** Validates the lowest_mileage default behavior fix and that Match Score doesn't silently override lean ranking

---

#### Test 5: Lower-Risk F-150 Scenario
**Request:**
```json
{
  "make": "Ford",
  "model": "F-150",
  "priorityAxis": "lower_risk",
  "priceMax": 50000
}
```

**Expected Results:**
- ✅ Results ranked by risk tier (positive → unknown → amber → red order)
- ✅ Cards with accident history get amber/red RISK badge (never green)
- ✅ Data-conflict-only cards do NOT get a RISK badge (conflict = verification info, not purchase-risk)
- ✅ Real inventory matching criteria
- ✅ No crash on risk classification logic

**Why this test:** Validates the buyer-risk-vs-data-quality fix (data conflicts should NOT appear in risk tier classification, only in needsVerification)

---

#### Test 6: Exact VIN Buyer Check
**Request:**
```json
{
  "vin": "4T1BF3EK7BU748352"
}
```

**Expected Results:**
- ✅ Exact VIN lookup succeeds
- ✅ Card shows abbreviated VIN (last 5 chars: 48352)
- ✅ Full 17-char VIN not visible in card text
- ✅ Buyer Check outcome present (promising/verify_before_proceeding/caution/significant_concern)
- ✅ Real history data (accidents, CPO status, etc.) displayed
- ✅ VIN verified checkmark present (if VIN cross-check succeeds)

**Why this test:** Validates exact-VIN Buyer Check pipeline and VIN display abbreviation rules

---

#### Test 7: Outbound Link Sanity
**For any returned result card, verify:**
- ✅ Primary CTA ("View listing" or "Check availability") routes to Edmunds affiliate URL
- ✅ "View similar" button (when present) routes to Edmunds category/fallback URL
- ✅ NO user-facing links route to dealerListingUrl directly (internal only)
- ✅ Carvana listings do NOT bypass to dealer site (affiliate routing policy respected)

**Why this test:** Validates the Carvana/affiliate-routing overhaul and link-resolution correctness

---

### Smoke Test Execution

Run each test sequentially using direct MCP JSON-RPC calls (curl or equivalent):

```bash
# Example (requires preview URL):
curl -X POST https://carclever-find-my-car-hardening-regression-gate-and-test-process.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "resources/read",
    "params": {
      "uri": "..." 
    }
  }'
```

### Acceptance Criteria

- ✅ All 7 test scenarios complete without error
- ✅ No "1958" or "[object Object]" leakage (provider-string safety)
- ✅ No raw exception traces in responses (error boundary working)
- ✅ Links route according to settled affiliate policy (no dealerListingUrl as primary)
- ✅ Risk badges appear only for amber/red (not green, not on data-conflict-only)
- ✅ VINs abbreviated and not exposed in full
- ✅ lower-risk ranking respects risk tier (not Match Score override)

### If Any Test Fails

1. Check Vercel deployment logs (build status, runtime errors)
2. Verify the exact error against the list of known expected behaviors (above)
3. If the error is a real regression (not expected), stop and report before proceeding to merge
4. If the error is expected behavior (e.g., no results for an extreme query), note and continue
5. Do NOT modify production implementation to make a preview test pass — investigate the root cause

---

**Status:** Ready for preview testing. Branch is pushed and preview deployment is automatic.
**Next:** Run the 7 smoke tests above against the live preview, verify all pass, then proceed to Section I (scope safety checks).
