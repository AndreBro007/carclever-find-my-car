/**
 * R4-2 (10 Nov 2026, André approved Option 1): the Impact Shared ID on every Edmunds link names the PLATFORM and the LINK ROLE, so Impact reports clicks and revenue per platform and per link without any redirect of ours.
 * Tag = "mcp" + platform + role, for example mcpclaudecheck, mcpchatgptsimilar. Impact accepts letters and numbers only (255 at most). The platform is the existing caller class of the current request (registered by usage-events);
 * outside a request (unit tests, scripts) or for anything that is not a plain lowercase word the legacy generic tag "mcpapp" is used, so a link NEVER loses its Shared ID and never carries a malformed one.
 * Roles: "check" = the Check avail. link (including the Edmunds link tool's main link), "similar" = View similar and the similar-vehicles links.
 */
export type SharedIdRole = "check" | "similar";
export const LEGACY_SHARED_ID = "mcpapp";

let platformProvider: (() => string | null) | null = null;
export function setSharedIdPlatformProvider(fn: (() => string | null) | null): void { platformProvider = fn; }
export function getSharedIdPlatformProvider(): (() => string | null) | null { return platformProvider; }

export function sharedIdTag(role: SharedIdRole): string {
  try {
    const p = platformProvider ? platformProvider() : null;
    if (typeof p !== "string" || !/^[a-z]{1,12}$/.test(p)) return LEGACY_SHARED_ID;
    return `mcp${p}${role}`;
  } catch {
    return LEGACY_SHARED_ID;
  }
}
