// Runs the REAL scripts/load-feed.sh with a fake `npx`: the loader must only ever receive a PLAIN file whose first line
// is the rich header, and a file whose first line is a car row must be refused before anything reaches the loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FEED_COLUMNS } from "../lib/catalog-db/normalize";

const dir = mkdtempSync(join(tmpdir(), "loadtest-"));
const header = FEED_COLUMNS.join("\t"), row = FEED_COLUMNS.map((_, i) => (i === 0 ? "3d6ffe7e" : "x")).join("\t");
writeFileSync(join(dir, "good.txt.gz"), gzipSync(header + "\n" + row + "\n"));
writeFileSync(join(dir, "bad.txt.gz"), gzipSync(row + "\n" + row + "\n"));
// fake npx: records its arguments and the first line of the file it was given
writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash
echo "ARGS: $*" >> "$LOG"; echo "FIRST: $(head -n1 "$3")" >> "$LOG"; exit 0
`);
chmodSync(join(dir, "npx"), 0o755);
const run = (feed: string, extra: Record<string, string> = {}) => {
  const log = join(dir, "log-" + Math.random().toString(36).slice(2)); writeFileSync(log, "");
  const r = spawnSync("bash", ["scripts/load-feed.sh", join(dir, feed)], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL_DIRECT: "postgres://u:secretpw@h/db", LOG: log, ...extra },
  });
  return { r, log: readFileSync(log, "utf8") };
};

test("load-feed: good feed -> loader gets the plain file, first line is the header, plain file is removed afterwards", () => {
  const { r, log } = run("good.txt.gz");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /27 columns/);
  assert.match(log, /ARGS: tsx scripts\/catalog-load\.ts .*good\.txt --expect-rows 1300000/);
  assert.ok(log.includes("FIRST: " + header));
  assert.ok(!existsSync(join(dir, "good.txt")));
});
test("load-feed: SAMPLE_EVERY switches to test mode", () => {
  const { r, log } = run("good.txt.gz", { SAMPLE_EVERY: "5" });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(log, /--sample-every 5/); assert.ok(!/--expect-rows/.test(log));
});
test("load-feed: first line is a car row -> refused, loader never called, no whole car row printed", () => {
  const { r, log } = run("bad.txt.gz");
  assert.equal(r.status, 1); assert.match(r.stdout, /LOAD REFUSED/); assert.equal(log, "");
  assert.ok(!r.stdout.includes(row)); // at most a few characters of the first line, never a whole car row
});
test("load-feed: never prints the connection string", () => {
  const { r } = run("good.txt.gz"); assert.ok(!/secretpw|postgres:\/\//.test(r.stdout + r.stderr));
});
