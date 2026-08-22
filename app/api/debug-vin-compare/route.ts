// TEMPORARY diagnostic route — SYS-20260824 empirical validation only.
// Compares GET /listings?vin=<VIN> against GET /listings/{vin} for a given
// VIN, to determine whether the exact-VIN search endpoint returns a
// different (canonical) price than the full-detail endpoint. Deleted after
// the one-time measurement this task requires — not a permanent feature.
export const runtime = "nodejs";

const AUTO_DEV_BASE_URL = "https://api.auto.dev";

function apiKey(): string {
  const key = process.env.AUTO_DEV_API_KEY;
  if (!key) throw new Error("AUTO_DEV_API_KEY is not set");
  return key;
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const vin = searchParams.get("vin");
  if (!vin) return new Response("Missing vin param", { status: 400 });

  const headers = { Authorization: `Bearer ${apiKey()}` };

  const [searchRes, fullRes] = await Promise.all([
    fetch(`${AUTO_DEV_BASE_URL}/listings?vin=${encodeURIComponent(vin)}&limit=1`, {
      headers,
      signal: AbortSignal.timeout(15000),
    }).then(async (r) => ({ status: r.status, body: await r.text() })).catch((e) => ({ status: 0, body: String(e) })),
    fetch(`${AUTO_DEV_BASE_URL}/listings/${encodeURIComponent(vin)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    }).then(async (r) => ({ status: r.status, body: await r.text() })).catch((e) => ({ status: 0, body: String(e) })),
  ]);

  let searchPrice: unknown = null;
  let fullPrice: unknown = null;
  try {
    const searchJson = JSON.parse(searchRes.body);
    const first = Array.isArray(searchJson?.data) ? searchJson.data[0] : searchJson?.data?.[0];
    searchPrice = first?.retailListing?.price ?? null;
  } catch {}
  try {
    const fullJson = JSON.parse(fullRes.body);
    fullPrice = fullJson?.data?.retailListing?.price ?? null;
  } catch {}

  return new Response(
    JSON.stringify(
      {
        vin,
        searchEndpoint: { status: searchRes.status, price: searchPrice, rawSnippet: searchRes.body.slice(0, 1500) },
        fullDetailEndpoint: { status: fullRes.status, price: fullPrice, rawSnippet: fullRes.body.slice(0, 1500) },
      },
      null,
      2,
    ),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
