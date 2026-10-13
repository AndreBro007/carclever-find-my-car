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
    // The Node driver already treats require/prefer/verify-ca as verify-full; say so explicitly (silences its warning and
    // keeps the behaviour if the driver later adopts libpq semantics). Hosted Neon certificates are valid, so this is safe.
    const mode = u.searchParams.get("sslmode");
    if (mode === "require" || mode === "prefer" || mode === "verify-ca") u.searchParams.set("sslmode", "verify-full");
    return u.toString();
  } catch {
    return s;
  }
}
