// Runs the REAL scripts/fetch-feed.sh with a fake `curl` that serves small fixture files, to prove the route logic:
// it accepts only the rich 27-column feed, falls back from SFTP to FTP when SFTP serves a wrong file, refuses when both do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FEED_COLUMNS } from "../lib/catalog-db/normalize";

const dir = mkdtempSync(join(tmpdir(), "feedtest-"));
const rich = join(dir, "rich.gz"), poor = join(dir, "poor.gz");
writeFileSync(rich, gzipSync(FEED_COLUMNS.join("\t") + "\n" + FEED_COLUMNS.map(() => "x").join("\t") + "\n"));
writeFileSync(poor, gzipSync(["Unique Merchant SKU", "Product Name", "Product URL"].join("\t") + "\n" + "a\tb\tc\n"));
writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash
out=""; url=""; list=0
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --list-only) list=1; shift;; sftp://*|ftp://*) url="$1"; shift;; *) shift;; esac; done
if [ "$list" = 1 ]; then echo "Edmunds-Product-Feed_CUSTOM.txt.gz"; exit 0; fi
case "$url" in sftp://*) src="$SFTP_FILE";; *) src="$FTP_FILE";; esac
[ -n "$out" ] && cp "$src" "$out"; exit 0
`);
chmodSync(join(dir, "curl"), 0o755);
const run = (sftp: string, ftp: string) => spawnSync("bash", ["scripts/fetch-feed.sh", join(dir, "out.gz")], {
  encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMPACT_FTP_USER: "u", IMPACT_FTP_PASS: "p", MIN_BYTES: "10", SFTP_FILE: sftp, FTP_FILE: ftp },
});

test("fetch-feed: SFTP serves the rich file -> accepted over SFTP", () => {
  const r = run(rich, poor); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /ACCEPTED: SFTP/); assert.ok(existsSync(join(dir, "out.gz")));
});
test("fetch-feed: SFTP serves a WRONG file, FTP serves the rich one -> falls back and says so", () => {
  const r = run(poor, rich); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /not the 27-column rich format/); assert.match(r.stdout, /ACCEPTED: plain FTP/);
});
test("fetch-feed: both routes serve the wrong file -> refused, exit 1, nothing left behind", () => {
  const r = run(poor, poor); assert.equal(r.status, 1); assert.match(r.stdout, /REFUSED/); assert.match(r.stdout, /Unique Merchant SKU/); assert.ok(!existsSync(join(dir, "out.gz")));
});
test("fetch-feed: never prints the credentials", () => {
  const r = run(rich, poor); assert.ok(!/[:\s]p@|IMPACT_FTP_PASS=/.test(r.stdout + r.stderr));
});
