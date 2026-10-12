/**
 * Connection-string tidy-up for hosted PostgreSQL (Neon). Neon's strings end in "?sslmode=require&channel_binding=require";
 * the Node driver does not implement channel binding, so that option is dropped. Pure function, never logs the string.
 */
export function cleanConnectionString(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return s;
  }
}
