// The server still answers the previous widget URI (v3) with the current widget (22 Oct 2026), so a host with an older tool list or cache does not get "Resource not found".
import test from "node:test";
import assert from "node:assert/strict";
process.env.LISTING_SOURCE = "catalog_db"; process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://unused"; process.env.AUTO_DEV_API_KEY = "k"; process.env.IMAGE_PROXY_SECRET = "s3cret";
import { RESULTS_CARD_RESOURCE_URI, RESULTS_CARD_LEGACY_RESOURCE_URIS } from "../lib/results-card";

const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const { POST } = await import("../app/[transport]/route");
  const r = await POST(new Request("http://localhost/mcp", { method: "POST", headers: hdr, body: JSON.stringify(body) }));
  const t = await r.text(); const m = t.match(/data: (.*)/); return JSON.parse(m ? m[1] : t);
}
const read = (id: number, uri: string) => rpc({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } });

test("the current widget is v4 and v3 is the one legacy URI", () => {
  assert.equal(RESULTS_CARD_RESOURCE_URI, "ui://carclever-find-my-car/results-card-v4");
  assert.deepEqual([...RESULTS_CARD_LEGACY_RESOURCE_URIS], ["ui://carclever-find-my-car/results-card-v3"]);
});
test("resources/read of v3 returns the CURRENT widget, identical to v4, with the same type and metadata", async () => {
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const v4: any = await read(2, RESULTS_CARD_RESOURCE_URI);
  const v3: any = await read(3, RESULTS_CARD_LEGACY_RESOURCE_URIS[0]);
  assert.ok(!v3.error, JSON.stringify(v3.error)); assert.ok(!v4.error);
  const a = v4.result.contents[0], b = v3.result.contents[0];
  assert.equal(b.uri, RESULTS_CARD_LEGACY_RESOURCE_URIS[0], "answers under the URI that was asked for");
  assert.equal(b.mimeType, "text/html;profile=mcp-app"); assert.equal(b.mimeType, a.mimeType);
  assert.equal(b.text, a.text, "same widget HTML");
  assert.ok(a.text.length > 10000);
  assert.deepEqual(b._meta, a._meta, "same CSP and border metadata");
});
test("a version that was never served is still 'not found'", async () => {
  const r: any = await read(4, "ui://carclever-find-my-car/results-card-v2");
  assert.ok(r.error, "v2 is not served"); assert.match(String(r.error.message), /not found/i);
});
test("the tools still name v4, not v3", async () => {
  const l: any = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
  for (const t of l.result.tools.filter((x: any) => x.name !== "get_edmunds_vehicle_link")) assert.equal(t._meta?.ui?.resourceUri, RESULTS_CARD_RESOURCE_URI, t.name);
});

test("resources/list shows exactly ONE widget, the current v4: the v3 alias is readable but not listed (23 Oct 2026)", async () => {
  const r: any = await rpc({ jsonrpc: "2.0", id: 40, method: "resources/list" });
  const uris = r.result.resources.map((x: any) => x.uri);
  assert.deepEqual(uris, ["ui://carclever-find-my-car/results-card-v4"], `listed: ${uris.join(", ")}`);
  assert.equal(r.result.resources[0].mimeType, "text/html;profile=mcp-app");
});
test("the unlisted v3 alias still answers resources/read with the same content as v4", async () => {
  const [a, b]: any[] = await Promise.all([read(41, "ui://carclever-find-my-car/results-card-v3"), read(42, "ui://carclever-find-my-car/results-card-v4")]);
  assert.equal(a.result.contents[0].text, b.result.contents[0].text); assert.equal(a.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(a.result.contents[0].uri, "ui://carclever-find-my-car/results-card-v3", "the reply names the address that was asked for");
});
