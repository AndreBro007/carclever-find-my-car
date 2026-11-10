/**
 * R4-6 SPIKE S1 (10 Nov 2026, André approved the design note DESIGN_R4_6_S1_HOST_SPIKE_20261110.md and this throwaway build): do the hosts see an ADDED tool
 * on an existing connector without reconnecting? One harmless tool, no input, no database, no caller data, one fixed sentence. Registered ONLY on PREVIEW builds
 * (VERCEL_ENV=preview); it never exists on the live address. THROWAWAY: removed together with the other R4 spike code before release 4 goes live (a test keeps it off outside preview).
 */
export const S1_TOOL_NAME = "spike_added_tool";
export const S1_REPLY = "S1 spike: this added tool was reached. It reads no data and changes nothing.";

export function s1SpikeEnabled(): boolean { return process.env.VERCEL_ENV === "preview"; }

export function registerS1Spike(server: { registerTool: (...a: any[]) => any }): boolean {
  if (!s1SpikeEnabled()) return false;
  server.registerTool(
    S1_TOOL_NAME,
    {
      title: "Spike: added-tool visibility check",
      description: "Test-only check that a tool added after a connector was set up is visible to the host. Takes no input and returns one fixed sentence. Not for shoppers.",
      inputSchema: {},
      annotations: { title: "Spike: added-tool visibility check", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      try { console.warn("[s1-spike] spike_added_tool called"); } catch { /* never affects a call */ }
      return { content: [{ type: "text" as const, text: S1_REPLY }] };
    },
  );
  return true;
}
