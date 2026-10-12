import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFtpName, safePath } from "../lib/catalog-source";

const PW = ["plainPass123", "pa@ss", "pa/ss", "p@s/s:word", "x:y@z"];

test("safeFtpName never returns the user name or password, whatever characters the password holds", () => {
  for (const pw of PW) {
    const out = safeFtpName(`ftp://ps-ftp_1234567:${pw}@products.impact.com/Edmunds/Edmunds-Product-Feed_CUSTOM.txt.gz`);
    assert.ok(!out.includes(pw.replace(/[@/:]/g, "")) || pw.replace(/[@/:]/g, "").length < 3, `leak check failed for ${pw}: ${out}`);
    assert.ok(!out.includes("ps-ftp_"), `user name leaked: ${out}`);
    assert.ok(!out.includes("@") && !out.includes(":"), `unsafe characters survived: ${out}`);
    assert.match(out, /products\.impact\.com \/ Edmunds-Product-Feed_CUSTOM\.txt\.gz/);
  }
});

test("safeFtpName handles strings without credentials and odd input", () => {
  assert.equal(safeFtpName("ftp://products.impact.com/Edmunds/Edmunds-Product-Feed_IR.txt.gz"), "products.impact.com / Edmunds-Product-Feed_IR.txt.gz");
  assert.match(safeFtpName("???"), /hidden/);
});

test("safePath keeps only the last two plain segments and hides anything suspicious", () => {
  assert.equal(safePath("/Edmunds/Edmunds-Product-Feed_CUSTOM.txt.gz"), "Edmunds / Edmunds-Product-Feed_CUSTOM.txt.gz");
  assert.equal(safePath("/a/b/c/Edmunds_IR.txt.gz?token=SECRET"), "c / Edmunds_IR.txt.gz");
  assert.match(safePath("/user:pass@host/file.gz"), /hidden/);
});
