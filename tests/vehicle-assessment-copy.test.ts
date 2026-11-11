// Run: npx tsx --test tests/vehicle-assessment-copy.test.ts
// The assessment module is a byte-for-byte copy of the one built and tested for T134 (Stage 1 demo and Test build). Provenance is in
// lib/vehicle-assessment.manifest.json, NOT in the file, so the file stays identical. This test fails if either one changes.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));

test("lib/vehicle-assessment.ts is byte-identical to the pinned origin (git blob f2e9b12c)", () => {
  const manifest = JSON.parse(read("lib/vehicle-assessment.manifest.json").toString("utf8"));
  const file = read(manifest.file);
  const blob = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${file.length}\0`), file])).digest("hex");
  assert.equal(blob, manifest.gitBlobSha1);
  assert.equal(file.length, manifest.byteLength);
});

test("the module has no imports, no network, no storage and no environment access (it is pure logic)", () => {
  const src = read("lib/vehicle-assessment.ts").toString("utf8");
  assert.ok(!/^\s*import\s/m.test(src) && !/require\(/.test(src), "no imports");
  for (const bad of ["fetch(", "XMLHttpRequest", "process.env", "localStorage", "sessionStorage", "document.", "window.", "console."]) assert.ok(!src.includes(bad), bad);
});
