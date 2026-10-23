/**
 * Limits on what the public endpoint will read and validate (R4-01, 23 Oct 2026).
 * Why: @modelcontextprotocol/server 2.0.0 to 2.2.0 puts no limit on the number of array elements or object keys it validates (advisory GHSA-46jr-4wx8-v453, CVSS 7.5, no authentication).
 * Measured on this route before the guard: a 391 KB request with 200,000 wrong-typed elements took 1.5 s and 445 MB, a 2.9 MB request (under Vercel's 4.5 MB body limit) took 14.8 s and
 * 1.5 GB. The limits below are far above anything a real tool call needs (a call is a few KB: at most a few dozen short strings) and far below what hurts, and they work whatever version of
 * the SDK is installed. They run BEFORE the SDK sees the body.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_BATCH_MESSAGES = 20;
export const ARGUMENT_LIMITS = { maxDepth: 6, maxNodes: 1500, maxArrayLength: 200, maxObjectKeys: 100, maxStringLength: 4000 } as const;

/** The request body as text, or null when it is larger than `maxBytes` (declared or actual: a missing or lying content-length does not get past it). Reads no more than maxBytes + one chunk. */
export async function readBodyCapped(req: Request, maxBytes: number = MAX_REQUEST_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { void reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Null when a parsed JSON value is within the limits, otherwise a short reason. Walks with its own stack, so a deeply nested value cannot overflow the call stack. */
export function argumentLimitProblem(value: unknown): string | null {
  const L = ARGUMENT_LIMITS;
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++nodes > L.maxNodes) return `more than ${L.maxNodes} values in one request`;
    if (typeof v === "string") { if (v.length > L.maxStringLength) return `a text value longer than ${L.maxStringLength} characters`; continue; }
    if (v === null || typeof v !== "object") continue;
    if (depth >= L.maxDepth) return `nesting deeper than ${L.maxDepth} levels`;
    if (Array.isArray(v)) {
      if (v.length > L.maxArrayLength) return `a list of more than ${L.maxArrayLength} items`;
      for (const x of v) stack.push([x, depth + 1]);
    } else {
      const keys = Object.keys(v as object);
      if (keys.length > L.maxObjectKeys) return `an object with more than ${L.maxObjectKeys} fields`;
      for (const k of keys) stack.push([(v as Record<string, unknown>)[k], depth + 1]);
    }
  }
  return null;
}

export function requestTooLargeResponse(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request too large (limit ${MAX_REQUEST_BODY_BYTES / 1024} KB)` } }), { status: 413, headers: { "content-type": "application/json" } });
}
export function invalidParamsResponse(id: unknown, problem: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code: -32602, message: `Invalid params: ${problem}` } }), { status: 400, headers: { "content-type": "application/json" } });
}
