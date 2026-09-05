/**
 * Fixture-based smoke test (session request, 2026-09-05): confirms (1) the
 * existing V2.2 NHTSA electrification/trim-decode path is unaffected by
 * this session's changes, and (2) the new check_vehicle recall logic
 * (nhtsa-recalls-client.ts + buyer-check.ts's recall integration) behaves
 * correctly. Uses mocked fetch responses shaped exactly like real,
 * previously-captured NHTSA payloads (module doc comments in nhtsa-client.ts
 * and the recalls handoff doc) — NOT a live network call. This sandbox's
 * egress proxy blocks vpic.nhtsa.dot.gov / api.nhtsa.gov entirely (confirmed
 * via direct curl: both return 403), so a genuine live call can only happen
 * from an actual Vercel deploy or a host session — this test verifies the
 * code logic, not live NHTSA reachability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeNhtsaElectrification } from "../lib/nhtsa-client";
import { fetchRecallStatus, recallKey } from "../lib/nhtsa-recalls-client";
import { buildBuyerCheck } from "../lib/buyer-check";

const originalFetch = global.fetch;

function mockFetchOnce(body: unknown, ok = true) {
  global.fetch = (async () => ({
    ok,
    json: async () => body,
  })) as typeof fetch;
}

test("V2.2 regression check: NHTSA electrification + trim decode still parses correctly", async () => {
  // Shaped like a real Kia Sportage Hybrid vPIC response (per nhtsa-client.ts's
  // own module doc — ambiguous comma-separated trim, real electrification signal).
  mockFetchOnce({
    Results: [
      {
        ErrorCode: "0",
        Make: "KIA",
        Model: "SPORTAGE",
        ModelYear: "2024",
        ElectrificationLevel: "HEV (Hybrid Electric Vehicle) - Level Unknown",
        FuelTypePrimary: "Gasoline",
        FuelTypeSecondary: "Electric",
        EngineCylinders: "4",
        DriveType: "AWD",
        Trim: "EX, X-Line",
      },
    ],
  });

  const result = await decodeNhtsaElectrification("KNDRDCA2XR7000000", "Kia", "Sportage Hybrid", 4);
  assert.ok(result, "decode should succeed");
  assert.equal(result!.electrificationLevel, "HEV (Hybrid Electric Vehicle) - Level Unknown");
  assert.deepEqual(result!.trimOptions, ["EX", "X-Line"]);
  assert.equal(result!.cylindersConflict, false);
  assert.equal(result!.modelConflict, false); // "Sportage Hybrid" startsWith "Sportage" prefix-tolerant match
});

test("V2.2 regression check: NHTSA decode fails open (bad VIN / non-zero ErrorCode) — never throws", async () => {
  mockFetchOnce({ Results: [{ ErrorCode: "6", ErrorText: "Incomplete VIN" }] });
  const result = await decodeNhtsaElectrification("BADVIN0000000000", "Toyota", "Camry", 4);
  assert.equal(result, null, "non-zero ErrorCode must resolve to null, not throw or fabricate data");
});

test("check_vehicle recalls: Count=0 maps to 'none' with approved copy", async () => {
  mockFetchOnce({ Count: 0, results: [] });
  const recall = await fetchRecallStatus("Toyota", "Camry", 2024);
  assert.equal(recall.state, "none");
  assert.equal(recall.label, "Recalls: None found");
});

test("check_vehicle recalls: parkIt/parkOutSide maps to 'severe' (Ford Bronco fixture from the recalls handoff)", async () => {
  mockFetchOnce({
    Count: 8,
    results: [
      {
        NHTSACampaignNumber: "25V788000",
        parkIt: true,
        parkOutSide: false,
        Component: "ELECTRICAL SYSTEM: INSTRUMENT CLUSTER/PANEL",
        Summary: "Ford Motor Company (Ford) is recalling certain 2025-2026 Bronco and Bronco Sport vehicles.",
        Remedy: "The instrument panel cluster software will be updated free of charge.",
      },
    ],
  });
  const recall = await fetchRecallStatus("Ford", "Bronco", 2026);
  assert.equal(recall.state, "severe");
  assert.equal(recall.label, "Recalls: Attention required");
  assert.equal(recall.severeCount, 1);
});

test("check_vehicle recalls: recalls exist but none severity-flagged maps to 'routine' (needs verification), not 'severe'", async () => {
  mockFetchOnce({
    Count: 2,
    results: [
      { NHTSACampaignNumber: "24V100000", parkIt: false, parkOutSide: false, Component: "AIRBAGS" },
      { NHTSACampaignNumber: "24V100001", parkIt: false, parkOutSide: false, Component: "FUEL SYSTEM" },
    ],
  });
  const recall = await fetchRecallStatus("Honda", "Accord", 2023);
  assert.equal(recall.state, "routine");
  assert.equal(recall.label, "Recalls: Verify status");
});

test("check_vehicle recalls: API failure fails open to 'unavailable', never throws", async () => {
  global.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const recall = await fetchRecallStatus("Ford", "F-150", 2023);
  assert.equal(recall.state, "unavailable");
  assert.equal(recall.label, "Recalls: Data unavailable");
});

test("check_vehicle recalls: non-2xx response fails open to 'unavailable', never throws", async () => {
  mockFetchOnce({}, false);
  const recall = await fetchRecallStatus("Ford", "F-150", 2023);
  assert.equal(recall.state, "unavailable");
});

test("recallKey: dedup key is stable across case/whitespace, null when incomplete", () => {
  assert.equal(recallKey("Ford", "F-150", 2023), recallKey(" ford ", " f-150 ", 2023));
  assert.equal(recallKey(null, "F-150", 2023), null);
});

test("buildBuyerCheck: severe recall pushes outcome to at least 'caution' even with otherwise clean evidence", () => {
  const card = {
    verification: { identityVerificationStatus: "verified_match" as const, conflictingAttributes: [], unknownAttributes: [] },
    history: { state: "known_clean" as const, note: "No accidents or issues reported.", ownerNote: null },
    condition: { cpoEvidenceState: "unknown" as const },
    detail: { carfaxUrl: null },
    dataConflicts: [] as string[],
  };
  const severeRecall = {
    state: "severe" as const,
    label: "Recalls: Attention required",
    detail: "Open recall identified — immediate attention recommended",
    count: 1,
    severeCount: 1,
    campaigns: [],
    nhtsaSourceUrl: "https://www.nhtsa.gov/recalls",
  };
  const bc = buildBuyerCheck(card, severeRecall);
  assert.equal(bc.outcome, "caution", "a severe recall must not be silently masked by otherwise-clean evidence");
  assert.ok(bc.concerns.some((c) => c.includes("immediate attention")));
});

test("buildBuyerCheck: routine recall goes to needsVerification, not concerns — does not block 'promising' by itself the way severe does", () => {
  const card = {
    verification: { identityVerificationStatus: "verified_match" as const, conflictingAttributes: [], unknownAttributes: [] },
    history: { state: "known_clean" as const, note: "No accidents or issues reported.", ownerNote: null },
    condition: { cpoEvidenceState: "unknown" as const },
    detail: { carfaxUrl: null },
    dataConflicts: [] as string[],
  };
  const routineRecall = {
    state: "routine" as const,
    label: "Recalls: Verify status",
    detail: "Recall reported — status needs verification.",
    count: 1,
    severeCount: 0,
    campaigns: [],
    nhtsaSourceUrl: "https://www.nhtsa.gov/recalls",
  };
  const bc = buildBuyerCheck(card, routineRecall);
  assert.equal(bc.outcome, "promising", "a routine recall alone must not block 'promising' — same as any other needsVerification-only item (e.g. missing Carfax) in this codebase");
  assert.ok(bc.needsVerification.some((n) => n.includes("needs verification")));
  assert.equal(bc.concerns.length, 0, "a routine recall must never be presented as a concern");
});

test("buildBuyerCheck: recall lookup failure ('unavailable') is disclosed honestly, never silently dropped", () => {
  const card = {
    verification: { identityVerificationStatus: "verified_match" as const, conflictingAttributes: [], unknownAttributes: [] },
    history: { state: "known_clean" as const, note: "No accidents or issues reported.", ownerNote: null },
    condition: { cpoEvidenceState: "unknown" as const },
    detail: { carfaxUrl: null },
    dataConflicts: [] as string[],
  };
  const unavailableRecall = {
    state: "unavailable" as const,
    label: "Recalls: Data unavailable",
    detail: "Recall status unavailable",
    count: 0,
    severeCount: 0,
    campaigns: [],
    nhtsaSourceUrl: "https://www.nhtsa.gov/recalls",
  };
  const bc = buildBuyerCheck(card, unavailableRecall);
  assert.ok(bc.needsVerification.some((n) => n.toLowerCase().includes("recall status could not be retrieved")));
  // Failed-open recall must NOT be conflated with a genuine data problem —
  // rest of the Buyer Check (outcome) proceeds on its own real evidence.
  assert.equal(bc.outcome, "promising");
});

test("buildBuyerCheck: backwards compatible — no recall arg at all behaves exactly as before (find_matching_vehicle's existing direct-VIN path)", () => {
  const card = {
    verification: { identityVerificationStatus: "verified_match" as const, conflictingAttributes: [], unknownAttributes: [] },
    history: { state: "known_clean" as const, note: "No accidents or issues reported.", ownerNote: null },
    condition: { cpoEvidenceState: "unknown" as const },
    detail: { carfaxUrl: null },
    dataConflicts: [] as string[],
  };
  const bc = buildBuyerCheck(card); // no second arg — same call shape as the existing find_matching_vehicle site
  assert.equal(bc.outcome, "promising");
  assert.equal(bc.recall, null);
});

test.after(() => {
  global.fetch = originalFetch;
});
