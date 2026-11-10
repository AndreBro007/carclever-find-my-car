/**
 * R4-1 SPIKE (10 Nov 2026, approved by André in the R4-1 design note): does the server see ANY request header that tells the Claude and ChatGPT surfaces apart (web, desktop, code, agent), or Lite from Claude chats?
 * This records ONLY THE NAMES of the request headers (never a value, never the user agent text, no IP, no VIN, no ZIP) plus the existing caller class, once per distinct combination per server instance,
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

export function _resetHeaderSpikeForTests(): void { seen.clear(); }
