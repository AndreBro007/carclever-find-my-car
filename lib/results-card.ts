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
  --cc-bg-0:#08182d;
  --cc-bg-1:#0b2444;
  --cc-card:#101827;
  --cc-card-2:#121d2f;
  --cc-border:rgba(255,255,255,.11);
  --cc-text:#f7f9fc;
  --cc-muted:#a8b5c8;
  --cc-subtle:#74849b;
  --cc-green:#34d399;
  --cc-green-bg:rgba(52,211,153,.12);
  --cc-amber:#f4c96b;
  --cc-amber-bg:rgba(244,201,107,.12);
  --cc-button:#f8fafc;
  --cc-button-text:#0b1320;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;font-family:var(--font-sans,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);color:var(--color-text-primary,var(--cc-text))}
#cc-root{padding:2px}
.cc-shell{
  color:var(--cc-text);
  background:linear-gradient(135deg,var(--cc-bg-1),var(--cc-bg-0) 68%);
  border:1px solid rgba(255,255,255,.07);
  border-radius:16px;
  padding:12px 0 10px;
  overflow:hidden;
}
.cc-header{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;padding:0 14px 10px}
.cc-brand{font-size:10.5px;font-weight:700;letter-spacing:.02em;color:#dbe8f8;margin-bottom:4px}
.cc-scale{font-size:13.5px;line-height:1.2;font-weight:700;letter-spacing:-.02em}
.cc-sub{font-size:10px;color:var(--cc-subtle);white-space:nowrap;padding-bottom:1px}
.cc-carousel{display:flex;gap:9px;overflow-x:auto;padding:1px 14px 8px;scrollbar-width:none}
.cc-carousel::-webkit-scrollbar{display:none}
.cc-card{flex:0 0 min(76vw,240px);background:linear-gradient(180deg,var(--cc-card-2),var(--cc-card));border:1px solid var(--cc-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 18px rgba(0,0,0,.18)}
.cc-photo-wrap{height:120px;position:relative;overflow:hidden;background:#1a2638}
.cc-photo{width:100%;height:100%;object-fit:cover;display:block}
.cc-photo-fallback{display:flex;align-items:center;justify-content:center;height:100%;color:var(--cc-subtle);font-size:11px;background:linear-gradient(135deg,#263b57,#121c2b)}
.cc-badges{position:absolute;top:8px;left:8px;right:8px;display:flex;justify-content:space-between;gap:6px}
.cc-type,.cc-match{border-radius:999px;border:1px solid rgba(255,255,255,.16);font-size:9.5px;line-height:1;padding:4px 7px;font-weight:700}
.cc-type{background:rgba(8,18,31,.82);color:#edf4fc;text-transform:uppercase;letter-spacing:.04em}
.cc-match{background:rgba(12,40,32,.9);border-color:rgba(52,211,153,.35);color:#b9f4d8}
.cc-match.is-closest{background:rgba(58,45,18,.92);border-color:rgba(244,201,107,.35);color:#ffe4a4}
.cc-body{padding:10px 10px 9px;display:flex;flex-direction:column;flex:1;min-width:0}
.cc-title{font-size:13.5px;line-height:1.2;font-weight:700;margin:0 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px}
.cc-price{font-size:20px;line-height:1;font-weight:800;letter-spacing:-.03em}
.cc-facts{font-size:10.5px;color:var(--cc-muted);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-dealer{font-size:10px;color:var(--cc-subtle);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-chips{display:flex;gap:5px;flex-wrap:nowrap;overflow:hidden;margin-top:7px;min-height:20px}
.cc-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--cc-green-bg);border:1px solid rgba(52,211,153,.2);color:#c8f6df;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-chip.is-unverified{background:var(--cc-amber-bg);border-color:rgba(244,201,107,.22);color:#f5ddb0}
.cc-cta{margin-top:auto;padding-top:8px}
.cc-primary{all:unset;box-sizing:border-box;cursor:pointer;width:100%;min-height:36px;border-radius:9px;background:var(--cc-button);color:var(--cc-button-text);display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;font-size:11px;font-weight:800}
.cc-provider{font-size:9.2px;font-weight:700;color:#4c5f79}
.cc-footer{display:flex;justify-content:space-between;gap:12px;padding:6px 14px 0;color:#788aa4;font-size:8.8px;line-height:1.3}
.cc-loading{padding:20px 14px;font-size:12px;color:var(--cc-subtle)}
</style>
</head>
<body>
<div id="cc-root"><div class="cc-loading">Loading results…</div></div>
<script>
(function(){
  "use strict";
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
    try { sendNotification("notifications/message", { level: "info", data: "[find-my-car-widget] " + msg }); }
    catch(e) { /* best-effort only */ }
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
  function proxiedPhoto(url){
    if (!url) return null;
    return APP_ORIGIN + "/api/img-proxy?u=" + encodeURIComponent(url);
  }
  function openLink(url){
    if (!url) return;
    sendRequest("ui/open-link", { url: url }).catch(function(){ /* host declined or failed; nothing else to do */ });
  }

  function scaleHeaderText(meta){
    var searched = meta && meta.corpusSizeApprox;
    var matched = meta && typeof meta.totalMatches === "number" ? meta.totalMatches : null;
    if (searched != null && matched != null) return compactNum(searched) + " searched \\u2192 " + compactNum(matched) + " matched";
    if (searched != null) return compactNum(searched) + " live listings searched";
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
    var photo = proxiedPhoto(media.primaryImage);
    var isCarvana = links.isCarvana;
    var primaryUrl = isCarvana ? links.dealerListingUrl : (links.affiliateUrl || links.dealerListingUrl);
    var throughEdmunds = !isCarvana && !!links.affiliateUrl;
    var providerLabel = isCarvana ? "Carvana \\u2197" : (throughEdmunds ? "Edmunds \\u2197" : "Dealer \\u2197");
    var ctaLabel = throughEdmunds ? "Check availability" : "View listing";

    var chips = (c.intentConfirmations || []).slice(0, 2).map(function(v){
      return '<span class="cc-chip">' + esc(v) + "</span>";
    }).join("");

    var closest = badges.indexOf("nhtsa-electrification-confirmed") !== -1 ? false : false; // reserved for future "closest match" signal from server
    var matchBadge = ranking.matchScore != null
      ? '<span class="cc-match' + (closest ? " is-closest" : "") + '">' + esc(ranking.matchScore) + " " + esc(ranking.matchScoreLabel || "Match") + "</span>"
      : "";

    var photoBlock = photo
      ? '<img class="cc-photo" src="' + esc(photo) + '" alt="' + esc(title) + '" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\\'div\\'),{className:\\'cc-photo cc-photo-fallback\\',textContent:\\'Photo unavailable\\'}))"/>'
      : '<div class="cc-photo cc-photo-fallback">Photo unavailable</div>';

    var ctaBlock = primaryUrl
      ? '<div class="cc-cta"><button type="button" class="cc-primary" data-url="' + esc(primaryUrl) + '"><span>' + esc(ctaLabel) + '</span><span class="cc-provider">' + esc(providerLabel) + "</span></button></div>"
      : "";

    return '<article class="cc-card">' +
      '<div class="cc-photo-wrap">' + photoBlock +
        '<div class="cc-badges"><span class="cc-type">' + esc(listingType) + "</span>" + matchBadge + "</div>" +
      "</div>" +
      '<div class="cc-body">' +
        '<h3 class="cc-title">' + esc(title) + "</h3>" +
        '<div class="cc-price">' + esc(money(listing.price)) + "</div>" +
        '<div class="cc-facts">' + esc(miles(listing.mileage)) + (location ? " \\u00b7 " + esc(location) : "") + "</div>" +
        (listing.dealer ? '<div class="cc-dealer">' + esc(listing.dealer) + "</div>" : "") +
        (chips ? '<div class="cc-chips">' + chips + "</div>" : "") +
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
      '<header class="cc-header"><div><div class="cc-brand">CarClever \\u00b7 Find My Car</div>' +
      '<div class="cc-scale">' + esc(scaleHeaderText(meta)) + "</div></div>" +
      '<div class="cc-sub">Top ' + visible.length + " shown</div></header>" +
      '<div class="cc-carousel">' + visible.map(cardHtml).join("") + "</div>" +
      '<footer class="cc-footer"><span>Swipe for more \\u2192</span><span>' +
      (hasAffiliate ? "Dealer links via Edmunds \\u00b7 Paid link" : "Current dealer listings") +
      "</span></footer></section>";
    root.innerHTML = html;
    root.querySelectorAll(".cc-primary").forEach(function(btn){
      btn.addEventListener("click", function(){ openLink(btn.getAttribute("data-url")); });
    });
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
    root.innerHTML = '<div class="cc-loading">See results below.</div>';
    logDiag("fallback shown: " + reason);
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
  logDiag("sending ui/initialize");
  sendRequest("ui/initialize", {
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline"] },
    clientInfo: { name: "carclever-find-my-car-results-card", version: "1.0.0" }
  }).then(function(){
    logDiag("ui/initialize acknowledged, sending initialized notification");
    sendNotification("ui/notifications/initialized", {});
  }).catch(function(err){
    // Host didn't complete the handshake as expected — leave the timeout
    // fallback above to fire; the host's own text/structuredContent
    // fallback is still shown in the conversation regardless of what
    // happens in this iframe.
    logDiag("ui/initialize failed: " + (err && err.message));
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
