// CarClever - Find My Car: MCP Apps result-card widget.
//
// This is a STATIC resource per the MCP Apps spec (SEP-1865) — declared once,
// cacheable by the host, never re-rendered server-side per request. Real
// per-search data (photo, price, badges, links) arrives client-side via the
// `ui/notifications/tool-result` notification after the standard
// ui/initialize <-> ui/notifications/initialized handshake. No SDK/framework
// dependency — hand-rolled against the spec's own documented postMessage
// JSON-RPC pattern, since the spec explicitly says "you don't need an SDK to
// talk MCP with the host." Deliberately vanilla JS: no React runtime, no
// bundler step inside the iframe, matching the "lean/fast, no rendering
// performance issues" requirement.
//
// Photos: dealer/Auto.dev photo URLs are on arbitrary third-party domains we
// don't control, so they can't be safely enumerated in the resource's CSP
// resourceDomains allowlist (default CSP blocks all non-'self' images). They
// are instead proxied through our own deployed origin (see
// app/api/img-proxy/route.ts) — the one first-party domain we declare below —
// so the default restrictive CSP still holds and photos still render.
//
// Text/structuredContent fallback for hosts that don't render this resource
// is completely untouched (see route.ts) — this widget is additive, never a
// replacement for the existing tool response.

export const RESULTS_CARD_RESOURCE_URI = "ui://carclever-find-my-car/results-card";

// Set to the real deployed origin. Used both for the CSP resourceDomains
// declaration and for building proxied photo URLs client-side.
const APP_ORIGIN = "https://carclever-find-my-car.vercel.app";

export function buildResultsCardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{
  /* color-scheme lets light-dark() below follow the iframe's actual
     rendered scheme (host-controlled) automatically — one set of rules,
     no separate light/dark build, per André's "don't have to as long as
     it works in both" ask. Palette matches the flagship CarClever app's
     card language (slate/navy dark, white/slate-100 light; amber "match"
     pill + green score text; blue dealer-name link) rather than the
     original green-badge placeholder palette. */
  color-scheme: light dark;
  --cc-shell-bg-a: light-dark(#eef2f8, #0b2444);
  --cc-shell-bg-b: light-dark(#f8fafc, #08182d);
  --cc-shell-border: light-dark(rgba(15,23,42,.08), rgba(255,255,255,.07));
  --cc-card-a: light-dark(#ffffff, #121d2f);
  --cc-card-b: light-dark(#ffffff, #101827);
  --cc-card-border: light-dark(rgba(15,23,42,.10), rgba(255,255,255,.11));
  --cc-text: light-dark(#0b1320, #f7f9fc);
  --cc-muted: light-dark(#5b6b82, #a8b5c8);
  --cc-subtle: light-dark(#8592a6, #74849b);
  --cc-brand: light-dark(#2b4f7a, #dbe8f8);
  --cc-link: light-dark(#2563eb, #7db4ff);
  /* Amber "match" pill + green score number, matching the flagship's
     STRONG DEAL badge / green DEAL SCORE digits rather than a solid
     green pill. */
  --cc-amber: light-dark(#a5670a, #f4c96b);
  --cc-amber-bg: light-dark(rgba(244,201,107,.22), rgba(244,201,107,.14));
  --cc-amber-border: light-dark(rgba(165,103,10,.30), rgba(244,201,107,.35));
  --cc-green: light-dark(#0f9d58, #34d399);
  --cc-green-bg: light-dark(rgba(15,157,88,.12), rgba(52,211,153,.12));
  --cc-green-border: light-dark(rgba(15,157,88,.22), rgba(52,211,153,.20));
  /* Tiered match-quality colors — score-driven internally, not shown as a
     raw number (see .cc-match variants below and cardHtml's tier logic).
     Green >=90, amber 80-89, red/rose <80. */
  --cc-match-strong-bg: light-dark(rgba(15,157,88,.14), rgba(52,211,153,.14));
  --cc-match-strong-border: light-dark(rgba(15,157,88,.26), rgba(52,211,153,.32));
  --cc-match-strong-text: light-dark(#0f7a45, #6ee7b7);
  --cc-match-good-bg: light-dark(rgba(244,201,107,.22), rgba(244,201,107,.14));
  --cc-match-good-border: light-dark(rgba(165,103,10,.30), rgba(244,201,107,.35));
  --cc-match-good-text: light-dark(#a5670a, #f4c96b);
  --cc-match-fair-bg: light-dark(rgba(225,87,87,.14), rgba(248,113,113,.14));
  --cc-match-fair-border: light-dark(rgba(190,50,50,.26), rgba(248,113,113,.32));
  --cc-match-fair-text: light-dark(#b23b3b, #fca5a5);
  --cc-button-bg: light-dark(#0b1320, #f8fafc);
  --cc-button-text: light-dark(#f8fafc, #0b1320);
  --cc-photo-bg: light-dark(#e5e9f0, #1a2638);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;font-family:var(--font-sans,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);color:var(--color-text-primary,var(--cc-text))}
#cc-root{padding:2px}
.cc-shell{
  color:var(--cc-text);
  background:linear-gradient(135deg,var(--cc-shell-bg-a),var(--cc-shell-bg-b) 68%);
  border:1px solid var(--cc-shell-border);
  border-radius:16px;
  padding:8px 0 10px;
  overflow:hidden;
}
.cc-header{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:5px 14px 6px}
.cc-header-left{min-width:0}
.cc-header-center{text-align:center;color:var(--cc-subtle);font-size:11.5px;white-space:nowrap}
.cc-header-right{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.cc-header-logo{width:22px;height:22px;border-radius:50%;display:block;flex-shrink:0}
.cc-brand{font-size:10px;font-weight:700;letter-spacing:.02em;color:var(--cc-brand);white-space:nowrap}
.cc-scale{font-size:13.5px;line-height:1.2;font-weight:700;letter-spacing:-.02em;color:var(--cc-text)}
.cc-carousel{display:flex;gap:9px;overflow-x:auto;padding:1px 14px 8px;scrollbar-width:none}
.cc-carousel::-webkit-scrollbar{display:none}
.cc-carousel-wrap{position:relative}
.cc-nav{position:absolute;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:999px;border:1px solid var(--cc-card-border);background:var(--cc-card-a);color:var(--cc-text);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);font-size:13px;line-height:1;opacity:.92}
.cc-nav:hover{opacity:1}
.cc-nav-prev{left:4px}
.cc-nav-next{right:4px}
.cc-nav[disabled]{opacity:.25;cursor:default}
.cc-card{flex:0 0 min(76vw,240px);background:linear-gradient(180deg,var(--cc-card-a),var(--cc-card-b));border:1px solid var(--cc-card-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 18px rgba(0,0,0,.10)}
.cc-photo-wrap{height:120px;position:relative;overflow:hidden;background:var(--cc-photo-bg)}
.cc-photo{width:100%;height:100%;object-fit:cover;display:block}
.cc-photo-fallback{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;color:light-dark(#7186ab,#6f8db8);font-size:10px;font-weight:600;background:linear-gradient(160deg,light-dark(#eef2f9,#182842),light-dark(#e1e7f3,#0f1c30))}
.cc-badges{position:absolute;top:8px;left:8px;right:8px;display:flex;justify-content:space-between;gap:6px}
.cc-type{border-radius:999px;border:1px solid rgba(255,255,255,.16);font-size:9.5px;line-height:1;padding:4px 7px;font-weight:700;background:rgba(8,18,31,.82);color:#edf4fc;text-transform:uppercase;letter-spacing:.04em}
.cc-body{padding:10px 10px 9px;display:flex;flex-direction:column;flex:1;min-width:0}
.cc-title{font-size:13.5px;line-height:1.2;font-weight:700;margin:0 0 6px;color:var(--cc-text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px}
.cc-match-row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:7px}
.cc-match{border-radius:6px;font-size:9.5px;line-height:1;padding:4px 7px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.cc-fuel{font-size:9.5px;font-weight:700;color:var(--cc-subtle);text-transform:uppercase;letter-spacing:.03em}
.cc-match.is-strong{background:var(--cc-match-strong-bg);border:1px solid var(--cc-match-strong-border);color:var(--cc-match-strong-text)}
.cc-match.is-good{background:var(--cc-match-good-bg);border:1px solid var(--cc-match-good-border);color:var(--cc-match-good-text)}
.cc-match.is-fair{background:var(--cc-match-fair-bg);border:1px solid var(--cc-match-fair-border);color:var(--cc-match-fair-text)}
.cc-score{font-size:11px;font-weight:800;color:var(--cc-green)}
.cc-price{font-size:20px;line-height:1;font-weight:800;letter-spacing:-.03em;color:var(--cc-text);display:flex;justify-content:space-between;align-items:baseline}
.cc-mileage{font-size:16px;font-weight:700}
.cc-facts{font-size:10.5px;color:var(--cc-muted);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-dealer-row{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-top:3px;min-width:0}
.cc-dealer{font-size:10px;color:var(--cc-link);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize;min-width:0}
.cc-carfax-link{all:unset;cursor:pointer;font-size:9.5px;font-weight:700;color:var(--cc-link);text-decoration:underline;white-space:nowrap;flex-shrink:0}
.cc-chips{display:flex;gap:5px;flex-wrap:nowrap;overflow:hidden;margin-top:7px;min-height:20px}
.cc-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--cc-green-bg);border:1px solid var(--cc-green-border);color:var(--cc-green);font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-chip.is-unverified{background:var(--cc-amber-bg);border-color:var(--cc-amber-border);color:var(--cc-amber)}
.cc-cta{margin-top:auto;padding-top:8px}
.cc-primary{all:unset;box-sizing:border-box;cursor:pointer;width:100%;min-height:36px;border-radius:9px;background:var(--cc-button-bg);color:var(--cc-button-text);display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;font-size:11.5px;font-weight:600;letter-spacing:.005em}
.cc-provider{font-size:9.2px;font-weight:700;color:var(--cc-subtle)}
.cc-footer{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;padding:8px 14px 0;color:var(--cc-subtle);font-size:10.5px;line-height:1.3}
.cc-footer-right{text-align:right}
.cc-similar-link{all:unset;cursor:pointer;font-size:10.5px;font-weight:700;color:var(--cc-link);white-space:nowrap}
.cc-similar-link:hover{text-decoration:underline}
.cc-loading{padding:20px 14px;font-size:12px;color:var(--cc-subtle)}
.cc-loading-stage{padding:2px 14px 0;font-size:10px;color:#4c5f79}
</style>
</head>
<body>
<div id="cc-root"><div class="cc-loading">Loading results…</div><div class="cc-loading-stage" id="cc-stage">connecting…</div></div>
<script>
(function(){
  "use strict";
  // Catch any uncaught script error and surface it visibly on screen —
  // otherwise a JS exception before the handshake even starts would leave
  // the widget silently stuck on "Loading results…" with zero diagnostic
  // trail anywhere, the exact failure mode this whole block exists to rule
  // out.
  window.addEventListener("error", function(e){
    var stageEl = document.getElementById("cc-stage");
    if (stageEl) stageEl.textContent = "script error: " + (e && e.message);
  });
  var APP_ORIGIN = ${JSON.stringify(APP_ORIGIN)};
  var nextId = 1;
  var pending = {};

  function sendRequest(method, params){
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    return new Promise(function(resolve, reject){
      pending[id] = { resolve: resolve, reject: reject };
    });
  }
  function sendNotification(method, params){
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  // Diagnostic logging via the spec's own log channel (notifications/message)
  // so a host-side rendering issue is debuggable from the host's own tool/
  // widget logs, without needing to dig into iframe-scoped DevTools console
  // context. Cheap, always-on, no PII.
  function logDiag(msg){
    // Host diagnostic notification disabled for cross-host compatibility.
  }
  // Real limitation found live (Aug 19): notifications/message delivery to
  // ChatGPT isn't confirmed to surface anywhere a developer can actually
  // see it. So the current handshake stage is ALSO shown directly in the
  // widget's own DOM — visible on screen, no DevTools/host-log access
  // needed at all. This is the primary diagnostic now; notifications/
  // message stays as a free secondary channel in case a host does surface it.
  var currentStage = "connecting…";
  function setStage(text){
    currentStage = text;
    logDiag(text);
    var el = document.getElementById("cc-stage");
    if (el) el.textContent = text;
  }
  var gotToolResult = false;

  window.addEventListener("message", function(event){
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.id != null && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      if (data.error) p.reject(new Error(data.error.message || "MCP Apps host error"));
      else p.resolve(data.result);
      return;
    }
    if (data.method === "ui/notifications/tool-result") {
      gotToolResult = true;
      logDiag("tool-result received, rendering");
      renderResult(data.params || {});
    }
  });

  function money(n){
    if (n == null) return "Price unavailable";
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n); }
    catch(e) { return "$" + n; }
  }
  function miles(n){
    if (n == null) return "Mileage unknown";
    try { return new Intl.NumberFormat("en-US").format(n) + " mi"; }
    catch(e) { return n + " mi"; }
  }
  function compactNum(n){
    if (n == null) return null;
    try { return new Intl.NumberFormat("en-US", { notation: n >= 1000000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n); }
    catch(e) { return String(n); }
  }
  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }
  function proxiedPhoto(cardImageUrl){
    // cardImageUrl is a fully-formed, server-signed /api/img-proxy URL
    // (see media.cardImageUrl, signed in buildResultCard() with
    // lib/image-proxy-sign.ts). The widget never constructs an unsigned
    // proxy URL itself — the proxy requires a valid signature.
    return cardImageUrl || null;
  }
  // Small inline SVG car glyph used whenever a photo is missing or fails
  // to load — no extra network request, no third-party asset/licensing
  // question. Exposed on window so the inline onerror="" attribute (which
  // runs outside this closure) can call it directly.
  // Standard "no image" convention (camera body + slashed lens) rather
  // than a car silhouette — more universally recognized as "no photo"
  // than a custom icon, per André's request.
  var PHOTO_FALLBACK_SVG = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M4 7h2.2l1-1.6c.3-.5.9-.9 1.5-.9h6.6c.6 0 1.2.4 1.5.9l1 1.6H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="13.5" r="3.5" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M2.5 2.5l19 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  "</svg>";
  window.__ccPhotoFallback = function(imgEl){
    var div = document.createElement("div");
    div.className = "cc-photo cc-photo-fallback";
    div.innerHTML = PHOTO_FALLBACK_SVG + "<span>Photo unavailable</span>";
    imgEl.replaceWith(div);
  };
  function openLink(url){
    if (!url) return;
    sendRequest("ui/open-link", { url: url }).catch(function(){ /* host declined or failed; nothing else to do */ });
  }

  function scaleHeaderText(meta){
    // corpusSizeApprox is already human-formatted prose from the server
    // (e.g. "3.6 million" or the fallback "several million") — not a raw
    // number, confirmed against lib/corpus-count.ts. Use it as-is; only
    // totalMatches is a real number that needs compactNum. Running
    // corpusSizeApprox through the numeric formatter was the cause of the
    // "NaN searched" bug found live (Aug 19).
    var searched = meta && meta.corpusSizeApprox;
    var matched = meta && typeof meta.totalMatches === "number" ? meta.totalMatches : null;
    if (searched != null && matched != null) return "Scan " + searched + " → " + compactNum(matched) + " found";
    if (searched != null) return "Scan " + searched;
    return "Best matches for your search";
  }

  function cardHtml(c){
    var id = c.identity || {};
    var listing = c.listing || {};
    var media = c.media || {};
    var links = c.links || {};
    var ranking = c.ranking || {};
    var badges = c.badges || [];
    var title = [id.year, id.make, id.model, id.trim].filter(Boolean).join(" ");
    var location = [listing.city, listing.state].filter(Boolean).join(", ");
    var listingType = c.condition && c.condition.cpo ? "CPO" : (c.condition && c.condition.inventoryType ? c.condition.inventoryType.toUpperCase() : "LISTING");
    var drivetrain = c.powertrain && c.powertrain.drivetrain;
    var vinVerified = badges.indexOf("vin-verified") !== -1;
    var exteriorColor = c.detail && c.detail.exteriorColor;
    var carfaxUrl = c.detail && c.detail.carfaxUrl;
    var photo = proxiedPhoto(media.cardImageUrl);
    var isCarvana = links.isCarvana;
    var primaryUrl = isCarvana ? links.dealerListingUrl : (links.affiliateUrl || links.dealerListingUrl);
    var throughEdmunds = !isCarvana && !!links.affiliateUrl;
    var providerLabel = isCarvana ? "Carvana \\u2197" : (throughEdmunds ? "Edmunds \\u2197" : "Dealer \\u2197");
    var ctaLabel = throughEdmunds ? "Check availability" : "View listing";

    var chips = (c.intentConfirmations || []).slice(0, 2).map(function(v){
      return '<span class="cc-chip">' + esc(v) + "</span>";
    }).join("");

    var closest = badges.indexOf("nhtsa-electrification-confirmed") !== -1 ? false : false; // reserved for future "closest match" signal from server
    // Aug 19 revision: dropped the raw "91/100" number. Real reason, not
    // just a style preference — SYS-20260817-032 is a confirmed, logged
    // bug where matchScore frequently converges to an identical value
    // across structurally different vehicles (independently observed
    // twice in prior testing). Displaying that number here would show the
    // same score on every card in a result set, which looks broken/
    // suspicious to a user even when the underlying match quality genuinely
    // differs — same "don't invent precision the data doesn't support"
    // principle already applied elsewhere (totalMatches, corpus counts).
    // Score is still used internally to pick a color tier (green/amber/
    // red), so it isn't wasted, just not shown as a literal digit. Revert
    // is a one-line change once SYS-20260817-032's differentiation fix
    // ships — see TASKS.md.
    var matchTier = ranking.matchScore == null ? null
      : ranking.matchScore >= 90 ? "strong"
      : ranking.matchScore >= 80 ? "good"
      : "fair";
    // Fuel type: real, already-computed field (c.detail.fuelTypeDisplay,
    // includes the NHTSA electrification cross-check), placed where the
    // raw score number used to sit — André's request, and fuel type is a
    // real decision factor. Suppressed only for plain "Gasoline" (the
    // unremarkable default) to avoid clutter; shown for anything else
    // (Hybrid, Plug-In Hybrid, Electric, Diesel).
    var fuelDisplay = c.detail && c.detail.fuelTypeDisplay;
    var fuelBadge = fuelDisplay && String(fuelDisplay).toLowerCase() !== "gasoline"
      ? '<span class="cc-fuel">' + esc(fuelDisplay) + "</span>"
      : "";
    var matchRow = (matchTier || fuelBadge)
      ? '<div class="cc-match-row">' +
          (matchTier ? '<span class="cc-match is-' + matchTier + '">' + esc(closest ? "Closest match" : (matchTier === "strong" ? "Strong Match" : matchTier === "good" ? "Good Match" : "Fair Match")) + "</span>" : "<span></span>") +
          fuelBadge +
        "</div>"
      : "";

    // Inline SVG placeholder (see window.__ccPhotoFallback above) instead
    // of plain grey text when no photo is present or a photo URL fails to
    // load after render.
    var photoBlock = photo
      ? '<img class="cc-photo" src="' + esc(photo) + '" alt="' + esc(title) + '" loading="lazy" onerror="window.__ccPhotoFallback(this)"/>'
      : '<div class="cc-photo cc-photo-fallback">' + PHOTO_FALLBACK_SVG + "<span>Photo unavailable</span></div>";

    var ctaBlock = primaryUrl
      ? '<div class="cc-cta"><button type="button" class="cc-primary" data-url="' + esc(primaryUrl) + '"><span>' + esc(ctaLabel) + '</span><span class="cc-provider">' + esc(providerLabel) + "</span></button></div>"
      : "";

    return '<article class="cc-card">' +
      '<div class="cc-photo-wrap">' + photoBlock +
        '<div class="cc-badges"><span class="cc-type">' + esc(listingType) + "</span></div>" +
      "</div>" +
      '<div class="cc-body">' +
        '<h3 class="cc-title">' + esc(title) + "</h3>" +
        matchRow +
        '<div class="cc-price">' + esc(money(listing.price)) + (listing.mileage ? '<span class="cc-mileage">' + esc(miles(listing.mileage)) + '</span>' : '') + "</div>" +
        (function(){
          var extras = [];
          // Exterior color only when there's no photo to show it visually
          // — redundant next to a real photo, genuinely useful as a
          // fallback when the visual channel is missing (André's call,
          // Aug 19: photo already tells the color story better than text
          // when present).
          if (!photo && exteriorColor) extras.push(esc(exteriorColor));
          if (drivetrain) extras.push(esc(drivetrain));
          if (vinVerified) extras.push("VIN \\u2713");
          var extrasStr = extras.length ? " \\u00b7 " + extras.join(" \\u00b7 ") : "";
          return '<div class="cc-facts">' + (location ? esc(location) : "") + extrasStr + "</div>";
        })() +
        (listing.dealer || carfaxUrl
          ? '<div class="cc-dealer-row">' +
              (listing.dealer ? '<span class="cc-dealer">' + esc(listing.dealer) + "</span>" : "<span></span>") +
              (carfaxUrl ? '<button type="button" class="cc-carfax-link" data-url="' + esc(carfaxUrl) + '">Carfax report</button>' : "") +
            "</div>"
          : "") +
        "" +
        ctaBlock +
      "</div>" +
    "</article>";
  }

  function render(structuredContent){
    var root = document.getElementById("cc-root");
    var results = (structuredContent && structuredContent.results) || [];
    var meta = structuredContent && structuredContent.meta;
    if (!results.length) {
      root.innerHTML = '<div class="cc-loading">No matching vehicles to show.</div>';
      return;
    }
    var visible = results.slice(0, 5);
    var hasAffiliate = visible.some(function(c){ return c.links && c.links.affiliateUrl; });
    var html = '<section class="cc-shell">' +
      '<header class="cc-header">' +
        '<div class="cc-header-left"><div class="cc-scale">' + esc(scaleHeaderText(meta)) + "</div></div>" +
        '<div class="cc-header-center">Top ' + visible.length + " shown</div>" +
        '<div class="cc-header-right"><img class="cc-header-logo" src="' + APP_ORIGIN + '/cc-logo-round.png" alt="CarClever" width="22" height="22"/><span class="cc-brand">CarClever</span></div>' +
      "</header>" +
      '<div class="cc-carousel-wrap">' +
        '<div class="cc-carousel" id="cc-carousel">' + visible.map(cardHtml).join("") + "</div>" +
        (visible.length > 1
          ? '<button type="button" class="cc-nav cc-nav-prev" id="cc-nav-prev" aria-label="Previous">\\u2039</button>' +
            '<button type="button" class="cc-nav cc-nav-next" id="cc-nav-next" aria-label="Next">\\u203a</button>'
          : "") +
      "</div>" +
      // Collapsed to one grid row (was three stacked rows) - real, useful
      // space saved per André's request. Uses the fallback link already
      // resolved for the top-shown result (a live Edmunds category search
      // for that make/model that never dead-ends, per SYS-20260817-002) as
      // an escape hatch for a listing not actually carried on Edmunds.
      (function(){
        var fallback = visible[0] && visible[0].links && visible[0].links.affiliateFallbackUrl;
        var similarLink = fallback
          ? '<button type="button" class="cc-similar-link" data-url="' + esc(fallback) + '">Similar options on Edmunds</button>'
          : "<span></span>";
        return '<footer class="cc-footer">' +
          "<span>Swipe \\u2192</span>" +
          similarLink +
          '<span class="cc-footer-right">' + (hasAffiliate ? "Edmunds affiliate links" : "Current dealer listings") + "</span>" +
        "</footer>";
      })() +
      "</section>";
    root.innerHTML = html;
    root.querySelectorAll(".cc-primary, .cc-similar-link, .cc-carfax-link").forEach(function(btn){
      btn.addEventListener("click", function(){ openLink(btn.getAttribute("data-url")); });
    });
    // Prev/next nav for screens without swipe/trackpad gestures - same
    // carousel, just an alternate way to scroll it. Cheap, no library.
    var carousel = document.getElementById("cc-carousel");
    var prevBtn = document.getElementById("cc-nav-prev");
    var nextBtn = document.getElementById("cc-nav-next");
    if (carousel && prevBtn && nextBtn) {
      var scrollStep = function(){
        var firstCard = carousel.querySelector(".cc-card");
        return firstCard ? firstCard.getBoundingClientRect().width + 9 : 240;
      };
      prevBtn.addEventListener("click", function(){ carousel.scrollBy({ left: -scrollStep(), behavior: "smooth" }); });
      nextBtn.addEventListener("click", function(){ carousel.scrollBy({ left: scrollStep(), behavior: "smooth" }); });
      var updateNavState = function(){
        prevBtn.disabled = carousel.scrollLeft <= 4;
        nextBtn.disabled = carousel.scrollLeft >= carousel.scrollWidth - carousel.clientWidth - 4;
      };
      carousel.addEventListener("scroll", updateNavState);
      updateNavState();
    }
    reportSize();
  }

  function renderResult(toolResult){
    render(toolResult.structuredContent || {});
  }

  function reportSize(){
    var h = document.body.scrollHeight;
    sendNotification("ui/notifications/size-changed", { width: document.body.scrollWidth, height: h });
  }

  function showFallback(reason){
    var root = document.getElementById("cc-root");
    if (gotToolResult) return; // race: result arrived just as the timeout fired
    // Visible, on-screen diagnosis — no DevTools access required to read it.
    root.innerHTML = '<div class="cc-loading">See results below.</div>' +
      '<div class="cc-loading-stage">Card widget stopped at: "' + currentStage + '" (' + reason + ')</div>';
    logDiag("fallback shown: " + reason + ", last stage: " + currentStage);
  }

  // Hard timeout: never hang the "Loading results…" state indefinitely. If
  // the handshake or tool-result notification doesn't arrive within a few
  // seconds, fall back to a plain, non-blocking message — the host's own
  // text/structuredContent response is unaffected either way and remains
  // the real source of truth for the user.
  var HANDSHAKE_TIMEOUT_MS = 6000;
  var timeoutId = setTimeout(function(){ showFallback("handshake/tool-result timeout after " + HANDSHAKE_TIMEOUT_MS + "ms"); }, HANDSHAKE_TIMEOUT_MS);

  // Handshake: ui/initialize -> wait for host response -> notify initialized.
  // Host then sends ui/notifications/tool-input followed by
  // ui/notifications/tool-result, per SEP-1865 lifecycle.
  setStage("sending ui/initialize…");
  sendRequest("ui/initialize", {
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline"] },
    appInfo: { name: "carclever-find-my-car-results-card", version: "1.0.0" },
  }).then(function(){
    setStage("initialized, waiting for tool-result…");
    sendNotification("ui/notifications/initialized", {});
    reportSize();
  }).catch(function(err){
    // Host didn't complete the handshake as expected — leave the timeout
    // fallback above to fire; the host's own text/structuredContent
    // fallback is still shown in the conversation regardless of what
    // happens in this iframe.
    setStage("ui/initialize request failed: " + (err && err.message));
  });

  var origRender = render;
  render = function(structuredContent){
    clearTimeout(timeoutId);
    origRender(structuredContent);
  };
})();
</script>
</body>
</html>`;
}
