// Regression: run #2 and #3 of the daily job failed with "feed header is missing column id" and showed a CAR ROW instead
// of the header, a different one each time. Cause: the line reader was created BEFORE the database connection was awaited,
// so lines emitted in that gap were lost. readLines() is lazy: even after a long pause, the first line is still the header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readLines } from "../lib/catalog-db/lines";

const dir = mkdtempSync(join(tmpdir(), "lines-"));
const HEADER = "id\ttitle\tcondition";
const N = 150_000;
const body = Array.from({ length: N }, (_, i) => `row${i}\t2023 Nissan Rogue ${i}\tused\tGlacier White,Charcoal padding padding`).join("\n");
const text = HEADER + "\n" + body + "\n";
const plain = join(dir, "feed.txt"), gz = join(dir, "feed.txt.gz");
writeFileSync(plain, text); writeFileSync(gz, gzipSync(text));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const [name, file] of [["plain file", plain], ["gzip file", gz]] as const) {
  test(`readLines (${name}): header is the first line even after a 300 ms pause, and no line is lost`, async () => {
    const lines = readLines(file);
    await pause(300); // stands in for pool.connect() + CREATE TABLE + TRUNCATE
    let n = 0, first = "", last = "";
    for await (const l of lines) { if (n === 0) first = l; last = l; n++; }
    assert.equal(first, HEADER);
    assert.equal(n, N + 1);
    assert.equal(last.split("\t")[0], `row${N - 1}`);
  });
}
test("readLines: stopping early closes the file without hanging", async () => {
  for await (const l of readLines(plain)) { assert.equal(l, HEADER); break; }
});
