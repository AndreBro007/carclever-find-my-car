// TEMPORARY, PREVIEW-ONLY diagnostic route — DO NOT MERGE TO MAIN.
// Purpose: server-side (real Vercel runtime) fetch of live-constructed
// Edmunds URLs to check redirect behavior, final status, and whether
// Edmunds blocks/rate-limits automated requests differently than a
// browser. This cannot be tested from the sandbox this investigation
// runs in (no egress to *.vercel.app or edmunds.com from that
// environment) — see getcarwise-docs PLAN_CARCLEVER_CONNECTOR_ANALYSIS...
// "Edmunds raw-fetch/redirect spike" section for why this exists.
//
// To be deleted once the probe's findings are recorded in DECISIONS.md.
// Never wired into any user-facing flow — reachable only by hitting this
// path directly on the preview deployment.

import { NextResponse } from 'next/server';
import {
  buildEdmundsUrl,
  buildEdmundsCategoryUrl,
  wrapWithCJ,
} from '@/lib/edmunds-cj';

type ProbeResult = {
  label: string;
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  redirected: boolean;
  contentType: string | null;
  bodyBytes: number | null;
  error: string | null;
};

async function probe(label: string, url: string): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // Realistic browser UA — the point of this probe is to observe
        // Edmunds' real behavior toward an automated request, not to
        // masquerade; if Edmunds treats a plain server fetch differently
        // than this, that's exactly the signal we're checking for.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      cache: 'no-store',
    });
    const body = await res.text();
    return {
      label,
      requestedUrl: url,
      finalUrl: res.url,
      status: res.status,
      redirected: res.redirected,
      contentType: res.headers.get('content-type'),
      bodyBytes: body.length,
      error: null,
    };
  } catch (e) {
    return {
      label,
      requestedUrl: url,
      finalUrl: null,
      status: null,
      redirected: false,
      contentType: null,
      bodyBytes: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function GET() {
  // Fixed, known-real test vehicles — not randomized, so results are
  // reproducible and comparable across runs.
  const vinVehicle = {
    vin: '1GNSKCKD9NR000000', // format-valid VIN shape; real-listing status is exactly what this probe checks
    make: 'Chevrolet',
    model: 'Tahoe',
    year: 2022,
  };
  const categoryVehicle = { make: 'Chevrolet', model: 'Tahoe', year: 2022, trim: 'LS' };
  const rareVehicle = { make: 'Audi', model: 'A3 Sportback e-tron', year: 2016 };

  const vinUrl = buildEdmundsUrl(vinVehicle);
  const categoryUrl = buildEdmundsCategoryUrl(categoryVehicle, { used: true });
  const rareCategoryUrl = buildEdmundsCategoryUrl(rareVehicle, { used: true });

  const targets: { label: string; url: string | null }[] = [
    { label: 'vin-featured-listing', url: vinUrl },
    { label: 'category-used-with-trim', url: categoryUrl },
    { label: 'category-used-rare-no-trim', url: rareCategoryUrl },
    { label: 'cj-wrapped-vin', url: vinUrl ? wrapWithCJ(vinUrl) : null },
  ];

  const results = await Promise.all(
    targets.map((t) => (t.url ? probe(t.label, t.url) : Promise.resolve({
      label: t.label,
      requestedUrl: '(null — URL builder returned null)',
      finalUrl: null,
      status: null,
      redirected: false,
      contentType: null,
      bodyBytes: null,
      error: 'url-build-failed',
    }))),
  );

  return NextResponse.json({
    probeVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local-dev',
    ranAt: new Date().toISOString(),
    results,
  });
}
