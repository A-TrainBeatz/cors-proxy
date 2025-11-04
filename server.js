// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import mime from "mime-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------- CONFIG -----------------
const PROXY_PREFIX = "/proxy/"; // safer encoded form
const MAX_REDIRECTS = 1000;     // very large - practical 'unlimited' (adjust as needed)
// ------------------------------------------

app.use(cors());
app.use(express.text({ type: "*/*", limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// helpers
function decodeTargetFromRequest(req) {
  // Support two styles:
  // 1) /proxy/<encodeURIComponent(absoluteUrl)>
  // 2) /https://example.com/path?qs...  (user-requested raw format)
  const orig = req.originalUrl || req.url || "";
  if (orig.startsWith(PROXY_PREFIX)) {
    const encoded = orig.slice(PROXY_PREFIX.length);
    try { return decodeURIComponent(encoded); } catch { return null; }
  }
  // orig starts with '/https://...' or '/http://...'
  // strip leading '/'
  const maybe = orig.startsWith("/") ? orig.slice(1) : orig;
  if (maybe.startsWith("http://") || maybe.startsWith("https://")) {
    // orig already contains path+query (originalUrl includes querystring)
    return maybe;
  }
  return null;
}

function filterForwardHeaders(inHeaders) {
  const hopByHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade"
  ]);
  const out = {};
  Object.keys(inHeaders || {}).forEach(k => {
    if (hopByHop.has(k.toLowerCase())) return;
    // Skip host header — we'll set host by fetch target
    if (k.toLowerCase() === "host") return;
    out[k] = inHeaders[k];
  });
  return out;
}

function buildProxyPathForAbsolute(absUrl) {
  // Two supported outputs:
  // - raw style: /https://host/path...
  // - encoded style: /proxy/<encoded>
  // We'll write links in HTML to the raw style (user's example)
  // That means attributes will be set to '/' + absUrl (unencoded)
  // Express will receive that as req.originalUrl starting with '/https://...'
  return "/" + absUrl; // unencoded absolute in path (matches user's example)
}

// HTML rewrite
function rewriteHtml(htmlText, baseUrl) {
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // Ensure base tag exists so relative URLs resolve
  if (!doc.querySelector("base")) {
    const baseEl = doc.createElement("base");
    baseEl.setAttribute("href", baseUrl);
    (doc.querySelector("head") || doc.documentElement).insertBefore(baseEl, (doc.querySelector("head") || doc.documentElement).firstChild);
  }

  // attributes to rewrite
  const ATTRS = [
    ["img","src"], ["script","src"], ["iframe","src"], ["link","href"],
    ["source","src"], ["video","src"], ["audio","src"], ["embed","src"],
    ["object","data"], ["a","href"]
  ];

  for (const [tag, attr] of ATTRS) {
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
      const val = el.getAttribute(attr);
      if (!val) return;
      if (/^(data:|blob:|javascript:|mailto:|#)/i.test(val)) return;
      try {
        const abs = new URL(val, baseUrl).href;
        // Use raw absolute path format (user example):
        el.setAttribute(attr, buildProxyPathForAbsolute(abs));
        // ensure anchors navigate in same frame
        if (tag === "a") el.setAttribute("target", "_self");
      } catch (e) {
        // ignore
      }
    });
  }

  // rewrite inline style url(...) occurrences
  doc.querySelectorAll("[style]").forEach(el => {
    const s = el.getAttribute("style") || "";
    const replaced = s.replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)','gi'), (m, u) => {
      if (!u || /^(data:|blob:|javascript:)/i.test(u)) return m;
      try { const abs = new URL(u, baseUrl).href; return `url("${buildProxyPathForAbsolute(abs)}")`; } catch { return m; }
    });
    el.setAttribute("style", replaced);
  });

  // rewrite <style> blocks (url(...) and @import)
  doc.querySelectorAll("style").forEach(styleEl => {
    const css = styleEl.textContent || "";
    const replaced = css
      .replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)','gi'), (m,u) => {
        if (!u || /^(data:|blob:|javascript:)/i.test(u)) return m;
        try { const abs = new URL(u, baseUrl).href; return `url("${buildProxyPathForAbsolute(abs)}")`; } catch { return m; }
      })
      .replace(new RegExp('@import\\s+[\'"]?(.*?)[\'"]?;','gi'), (m,u)=>{
        if (!u) return m;
        try { const abs = new URL(u, baseUrl).href; return `@import url("${buildProxyPathForAbsolute(abs)}");`; } catch { return m; }
      });
    styleEl.textContent = replaced;
  });

  // inject a tiny helper script (console forwarding + agentReady)
  const helper = doc.createElement("script");
  helper.textContent = `
    (function(){ if(window.__PP_INJECTED__) return; window.__PP_INJECTED__ = true;
      function post(t,p){ try{ window.top.postMessage({__pp_agent__:true, type:t, payload:p, url:location.href}, '*'); }catch(e){} }
      ['log','info','warn','error','debug'].forEach(function(fn){ const o = console[fn].bind(console); console[fn] = function(){ try{ post('console',{level:fn,args:Array.from(arguments)}); }catch(e){}; o.apply(console, arguments); };});
      post('agentReady',{href: location.href});
    })();
  `;
  (doc.querySelector("head") || doc.documentElement).appendChild(helper);

  return dom.serialize();
}

// Main handler supporting both /proxy/<encoded> and /https://... forms
app.use(async (req, res, next) => {
  // If request matches static files in public, let express.static serve (that's earlier)
  // Only handle proxied requests here:
  const target = decodeTargetFromRequest(req);
  if (!target) return next(); // not a proxied path

  try {
    // Prepare headers for upstream request
    const upstreamHeaders = filterForwardHeaders(req.headers);
    // Set a realistic browser UA if none present
    upstreamHeaders['user-agent'] = upstreamHeaders['user-agent'] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
    upstreamHeaders['accept'] = upstreamHeaders['accept'] || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    upstreamHeaders['accept-language'] = upstreamHeaders['accept-language'] || "en-US,en;q=0.9";
    // Remove origin to avoid upstream rejecting CORS preflight mismatches
    delete upstreamHeaders.origin;
    delete upstreamHeaders.referer; // we'll set referer to target sometimes below

    // If client provided a Range header, forward it (important for video)
    if (req.headers.range) upstreamHeaders.range = req.headers.range;

    // Use fetch with a very high follow limit to effectively allow many redirects
    const fetchOptions = {
      method: req.method,
      headers: upstreamHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "follow",
      follow: MAX_REDIRECTS,
      compress: true,
    };

    const upstreamRes = await fetch(target, fetchOptions);

    // If fetch failed because max redirects exceeded, upstreamRes will throw — catch below
    // Forward status & headers (but rewrite Location and strip hop-by-hop)
    const contentType = upstreamRes.headers.get("content-type") || "";

    // If upstream returned Set-Cookie, forward to client (cookies stored under proxy origin)
    const setCookieHeaders = upstreamRes.headers.raw && upstreamRes.headers.raw()['set-cookie'];
    if (setCookieHeaders && setCookieHeaders.length) {
      for (const sc of setCookieHeaders) {
        res.append('Set-Cookie', sc);
      }
    }

    // If upstream responded with a redirect (3xx) and node-fetch followed to final, we still have final content here.
    // But if it returns a Location header for some reason, rewrite it to proxy-style so client will follow through proxy.
    const loc = upstreamRes.headers.get("location");
    if (loc) {
      try {
        const absLoc = new URL(loc, target).href;
        // rewrite so browser follows via proxy
        res.setHeader("Location", buildProxyPathForAbsolute(absLoc));
      } catch (e) {
        // ignore
      }
    }

    // HTML -> rewrite and inject
    if (contentType.includes("text/html")) {
      const text = await upstreamRes.text();
      const finalUrl = upstreamRes.url || target;
      const rewritten = rewriteHtml(text, finalUrl);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.status(upstreamRes.status).send(rewritten);
    }

    // Binary or other -> stream buffer and forward content-type and range headers
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    // forward a few headers
    upstreamRes.headers.forEach((v,k) => {
      if (["transfer-encoding","connection"].includes(k)) return;
      res.setHeader(k, v);
    });
    res.setHeader("content-type", contentType || mime.lookup(target) || "application/octet-stream");
    return res.status(upstreamRes.status).send(buffer);

  } catch (err) {
    // If node-fetch throws due to too many redirects, return a helpful error
    console.error("Proxy fetch error:", err && err.message ? err.message : err);
    if (err && String(err).toLowerCase().includes("maximum redirect")) {
      return res.status(508).send("Proxy error: maximum redirects exceeded (increase MAX_REDIRECTS if necessary)");
    }
    return res.status(502).send("Proxy fetch error: " + (err && err.message ? err.message : String(err)));
  }
});

// Fallback: serve index.html at root if exists
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start
app.listen(PORT, () => {
  console.log(`✅ Proxy listening on http://localhost:${PORT}`);
  console.log(`Supports /proxy/<encoded> and /https://... style paths.`);
});
