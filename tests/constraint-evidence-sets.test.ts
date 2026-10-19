import test from "node:test";
import assert from "node:assert/strict";
import { buildConstraintChecks, aggregateSearchConstraintStatus } from "../lib/constraint-evidence";

const none = new Set<string>();
const status = (req: Record<string, unknown>, act: Record<string, unknown>, field: string) =>
  buildConstraintChecks(req as never, act as never, none).find((c) => c.field === field)?.status;

test("trimRequired with several acceptable trims: any listed trim verifies, others mismatch", () => {
  const req = { trimRequired: "AMG GLA 35, AMG GLA 45" };
  assert.equal(status(req, { trim: "AMG GLA 35" }, "trimRequired"), "verified");
  assert.equal(status(req, { trim: "AMG GLA 45" }, "trimRequired"), "verified");
  assert.equal(status(req, { trim: "GLA 250" }, "trimRequired"), "mismatch");
  assert.equal(status(req, { trim: null }, "trimRequired"), "unknown");
  assert.equal(status({ trimRequired: "EX" }, { trim: "EX" }, "trimRequired"), "verified");   // single trim unchanged
  assert.equal(status({ trimRequired: "EX" }, { trim: "EX-L" }, "trimRequired"), "mismatch"); // exactness unchanged
});

test("drivetrain sets: every accepted drivetrain verifies, AWD and 4WD are one group, silent data is unknown", () => {
  assert.equal(status({ drivetrain: "AWD, FWD" }, { drivetrain: "FWD" }, "drivetrain"), "verified");
  assert.equal(status({ drivetrain: "AWD, FWD" }, { drivetrain: "AWD" }, "drivetrain"), "verified");
  assert.equal(status({ drivetrain: "AWD, FWD" }, { drivetrain: "4WD" }, "drivetrain"), "verified");
  assert.equal(status({ drivetrain: "AWD, FWD" }, { drivetrain: "RWD" }, "drivetrain"), "mismatch");
  assert.equal(status({ drivetrain: "AWD" }, { drivetrain: "FWD" }, "drivetrain"), "mismatch");
  assert.equal(status({ drivetrain: "AWD" }, { drivetrain: "4WD" }, "drivetrain"), "verified");
  assert.equal(status({ drivetrain: "AWD" }, { drivetrain: null }, "drivetrain"), "unknown");
  assert.equal(status({ drivetrain: "FWD" }, { drivetrain: "4x2" }, "drivetrain"), "unknown"); // 4x2 does not say front or rear
  assert.equal(status({ drivetrain: "banana" }, { drivetrain: "AWD" }, "drivetrain"), undefined); // not applied, so no claim
});

test("an eligible car no longer makes the whole result a mismatch", () => {
  const checks = buildConstraintChecks({ trimRequired: "AMG GLA 35, AMG GLA 45", drivetrain: "AWD, FWD" } as never, { trim: "AMG GLA 35", drivetrain: "FWD" } as never, none);
  assert.equal(aggregateSearchConstraintStatus(checks), "verified");
});
