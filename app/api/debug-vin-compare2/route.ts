// TEMPORARY diagnostic route — SYS-20260824 empirical validation only.
// Test 1: GET /listings?vehicle.vin=<VIN>&limit=1
// Test 2 (only if Test 1 rejected/wrong VIN): narrowest possible normal
// /listings query (make/model/year/used/state) with the target VIN located
// among the bounded result rows, never substituted or returned as a
// different vehicle. No widening. Deleted after this one-time measurement.
export const runtime = "nodejs";

const AUTO_DEV_BASE_URL = "https://api.auto.dev";

function apiKey(): string {
  const key = process.env.AUTO_DEV_API_KEY;
  if (!key) throw new Error("AUTO_DEV_API_KEY is not set");
  return key;
}

async function fetchJson(path: string) {
  try {
    const res = await fetch(`${AUTO_DEV_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(body);
    } catch {}
    return { status: res.status, json, rawSnippet: body.slice(0, 800) };
  } catch (e) {
    return { status: 0, json: null, rawSnippet: String(e) };
  }
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const vin = searchParams.get("vin");
  if (!vin) return new Response("Missing vin param", { status: 400 });

  // Test 1: vehicle.vin= on the normal /listings search endpoint.
  const test1 = await fetchJson(`/listings?vehicle.vin=${encodeURIComponent(vin)}&limit=1`);
  const test1Rows: any[] = Array.isArray(test1.json?.data) ? test1.json.data : [];
  const test1ReturnedVin = test1Rows[0]?.vin ?? null;
  const test1Price = test1Rows[0]?.retailListing?.price ?? null;
  const test1ExactMatch = test1ReturnedVin === vin;

  const result: any = {
    vin,
    test1_vehicleVinParam: {
      status: test1.status,
      returnedVin: test1ReturnedVin,
      exactMatch: test1ExactMatch,
      price: test1Price,
      rowCount: test1Rows.length,
      rawSnippet: test1.rawSnippet,
    },
  };

  // Test 2: only run if Test 1 didn't cleanly return the exact VIN.
  if (!test1ExactMatch) {
    // Full-detail record supplies the narrowing fields — known from the
    // prior task's measurement (GET /listings/{vin}).
    const fullDetail = await fetchJson(`/listings/${encodeURIComponent(vin)}`);
    const full = fullDetail.json?.data;
    const make = full?.vehicle?.make;
    const model = full?.vehicle?.model;
    const year = full?.vehicle?.year;
    const used = full?.retailListing?.used;
    const state = full?.retailListing?.state;

    const params = new URLSearchParams();
    if (make) params.set("vehicle.make", make);
    if (model) params.set("vehicle.model", model);
    if (year != null) params.set("vehicle.year", `${year}-${year}`);
    if (used != null) params.set("retailListing.used", used ? "true" : "false");
    if (state) params.set("retailListing.state", String(state).toUpperCase());
    params.set("limit", "100");

    const test2 = await fetchJson(`/listings?${params.toString()}`);
    const test2Rows: any[] = Array.isArray(test2.json?.data) ? test2.json.data : [];
    const found = test2Rows.find((r) => r.vin === vin) ?? null;

    result.test2_narrowedSearch = {
      queryUsed: params.toString(),
      status: test2.status,
      totalRowsReturned: test2Rows.length,
      totalReported: test2.json?.total ?? null,
      exactVinFound: !!found,
      // Only the target VIN's own price is reported — other VINs in the
      // bounded row set are evidence-only, never surfaced beyond a count.
      foundVinPrice: found?.retailListing?.price ?? null,
    };
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
