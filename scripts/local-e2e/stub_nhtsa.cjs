// TEST STUB: answers api.nhtsa.gov SafetyRatings calls with MADE-UP ratings in the real response layout (the sandbox cannot reach that host).
// Everything else (including vpic.nhtsa.dot.gov VIN decoding) goes to the real network.
const real = globalThis.fetch;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/^https:\/\/api\.nhtsa\.gov\/SafetyRatings\/modelyear\/(\d{4})\/make\/([^/]+)\/model\/([^/?]+)/i);
  if (m) {
    const [, y, mk, md] = m; let h = 0; for (const c of (y + mk + md).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    if (h % 5 === 0) return json({ Count: 0, Message: "No results found for this request", Results: [] });
    const base = (10000 + (h % 5000)) & ~1;
    const n = decodeURIComponent(mk) + " " + decodeURIComponent(md);
    return json({ Count: 2, Message: "Results returned successfully", Results: [{ VehicleDescription: `${y} ${n} SUV FWD`, VehicleId: base }, { VehicleDescription: `${y} ${n} SUV AWD`, VehicleId: base + 1 }] });
  }
  const v = u.match(/SafetyRatings\/VehicleId\/(\d+)/i);
  if (v) { const id = +v[1]; const r = ["5", "4", "Not Rated", "3", "5"][(id >> 1) % 5];
    return json({ Count: 1, Message: "Results returned successfully", Results: [{ OverallRating: r, RecallsCount: (id >> 1) % 4, ComplaintsCount: 10, VehicleDescription: "stub", VehicleId: id }] }); }
  return real(url, init);
};
