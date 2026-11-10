/**
 * R4-1 SPIKE (10 Nov 2026, approved by André in the R4-1 design note): does the server see ANY request header that tells the Claude and ChatGPT surfaces apart (web, desktop, code, agent), or Lite from Claude chats?
 * STEP 1 recorded ONLY THE NAMES of the request headers. STEP 2 (André approved Option A, 10 Nov 2026) ALSO records the VALUE of ONE header, x-anthropic-client, and only if it matches the safe pattern letters, numbers, dot and dash, at most 40 characters;
 * a value that does not match is NOT logged (only its length and which kinds of character it holds, so the pattern can be widened with André's approval). Never any other header value (x-openai-session and x-openai-subject are identifiers), never the user agent text, no IP, no VIN, no ZIP; once per distinct combination per server instance,
 * and ONLY on PREVIEW builds (VERCEL_ENV=preview). It never runs on the live address. THROWAWAY: it is removed before release 4 goes live (a test checks it stays off outside preview).
 */
const seen = new Set<string>();

export function headerNamesLine(headers: Pick<Headers, "forEach">, caller: string): string {
  const names = new Set<string>();
  headers.forEach((_value, name) => { names.add(String(name).trim().toLowerCase()); });
  return `[hdr-names] caller=${caller} names=${[...names].sort().join(",")}`;
}

export function maybeLogHeaderNames(headers: Pick<Headers, "forEach">, caller: string): void {
  try {
    if (process.env.VERCEL_ENV !== "preview") return;
    const line = headerNamesLine(headers, caller);
    if (seen.has(line)) return;
    if (seen.size >= 200) return;
    seen.add(line);
    console.warn(line);
  } catch { /* never affects a request */ }
}

const CLIENT_HEADER = "x-anthropic-client";
const SAFE_CLIENT_VALUE = /^[A-Za-z0-9.\-]{1,40}$/;
export function clientHeaderLine(value: string, caller: string): string {
  const v = value.trim();
  if (SAFE_CLIENT_VALUE.test(v)) return `[hdr-client] caller=${caller} ${CLIENT_HEADER}=${v}`;
  const kinds = [/[A-Za-z]/.test(v) && "letters", /[0-9]/.test(v) && "digits", /[.\-]/.test(v) && "dot-dash", /[^A-Za-z0-9.\-]/.test(v) && "other"].filter(Boolean).join("+");
  return `[hdr-client] caller=${caller} ${CLIENT_HEADER}=<not logged: length ${v.length}, ${kinds || "empty"}>`;
}
export function maybeLogClientHeader(headers: Pick<Headers, "get">, caller: string): void {
  try {
    if (process.env.VERCEL_ENV !== "preview") return;
    const raw = headers.get(CLIENT_HEADER);
    if (raw == null) return;
    const line = clientHeaderLine(raw, caller);
    if (seen.has(line) || seen.size >= 200) return;
    seen.add(line);
    console.warn(line);
  } catch { /* never affects a request */ }
}

export function _resetHeaderSpikeForTests(): void { seen.clear(); }
