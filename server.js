// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import mime from "mime-types";
import cookie from "cookie";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve UI/static if you have public directory
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.use(cors());
app.use(express.text({ type: "*/*", limit: "50mb" }));

// In-memory simple session cookie jar: Map<sid, Map<host, [name=value, ...]>>
const sessionJars = new Map();

function ensureSession(req, res) {
  const cookies = cookie.parse(req.headers.cookie || "");
  let sid = cookies.__ppsession;
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    // not httpOnly so client-side can inspect if needed; set path /
    res.setHeader("Set-Cookie", cookie.serialize("__ppsession", sid, { path: "/", sameSite: "Lax" }));
  }
  if (!sessionJars.has(sid)) sessionJars.set(sid, new Map());
  return sid;
}

function saveSetCookieForSession(sid, targetHost, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  const jar = sessionJars.get(sid) || new Map();
  const existing = jar.get(targetHost) || [];
  setCookieHeaders.forEach(sc => {
    // store name=value only to send later as Cookie header
    const nv = sc.split(";")[0];
    const name = nv.split("=")[0];
    // replace any existing same-name cookie
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i].startsWith(name + "=")) existing.splice(i, 1);
    }
    existing.push(nv);
  });
  jar.set(targetHost, existing);
  sessionJars.set(sid, jar);
}

function getCookieHeaderForSession(sid, targetHost) {
  const jar = sessionJars.get(sid);
  if (!jar) return "";
  const cookies = jar.get(targetHost) || [];
  return cookies.join("; ");
}

// Helper: given incoming request path (req.originalUrl), extract proxied target.
// Supports two forms:
// 1) /proxy/<encodedAbsoluteUrl>  (older encoded style)
// 2) /https://example.com/...      (raw style; path begins with 'http')
// This function returns the absolute URL string or null.
function extractTargetFromRequest(req) {
  const prefixEncoded = "/proxy/";
  const full = req.originalUrl || req.url || "";
  // remove potential leading slash from full path when needed
  if (full.startsWith(prefixEncoded)) {
    const enc = full.slice(prefixEncoded.length);
    // enc may include query string; express originalUrl includes query string — keep it
    try { return decodeURIComponent(enc); } catch { return enc; }
  }

  // raw style: path starts with /http...
  // originalUrl includes leading slash; try to match "/http" or "/https"
  const rawMatch = full.match(/^\/(https?:\/\/.+)$/i);
  if (rawMatch) {
    return rawMatch[1];
  }

  return null;
}

// Rewrite HTML: convert absolute resource URLs into proxied raw-style URLs like /https://host/...
function rewriteHtmlToProxy(htmlText, baseUrl, proxyPrefixRaw = "/") {
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // Ensure base tag for relative URLs
  if (!doc.querySelector("base")) {
    const base = doc.createElement("base");
    base.setAttribute("href", baseUrl);
    (doc.querySelector("head") || doc.documentElement).insertBefore(base, (doc.querySelector("head") || doc.documentElement).firstChild);
  }

  const ATTRS = [
    ["img","src"], ["script","src"], ["iframe","src"], ["link","href"],
    ["source","src"], ["video","src"], ["audio","src"], ["embed","src"],
    ["object","data"], ["a","href"]
  ];

  for (const [tag, attr] of ATTRS) {
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
      const v = el.getAttribute(attr);
      if (!v) return;
      if (/^data:|^blob:|^javascript:|^mailto:/i.test(v)) return;
      try {
        const abs = new URL(v, baseUrl).href;
        // Use raw style (no encode) so the user-visible URL matches your required format:
        // example: https://cors-proxy.../https://site.com/path
        el.setAttribute(attr, `${proxyPrefixRaw}${abs}`);
        if (tag === "a") el.setAttribute("target", "_self");
      } catch (e) {
        // ignore
      }
    });
  }

  // rewrite in-style url(...) uses RegExp built with constructor to avoid escaping issues
  doc.querySelectorAll("[style]").forEach(el => {
    const s = el.getAttribute("style") || "";
    const re = new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)', 'gi');
    const replaced = s.replace(re, (m, u) => {
      if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
      try { const abs = new URL(u, baseUrl).href; return `url("${proxyPrefixRaw}${abs}")`; } catch { return m; }
    });
    el.setAttribute("style", replaced);
  });

  // <style> blocks
  doc.querySelectorAll('style').forEach(styleEl => {
    const css = styleEl.textContent || "";
    const re = new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)', 'gi');
    const impRe = new RegExp('@import\\s+[\'"]?(.*?)[\'"]?;', 'gi');
    const replaced = css
      .replace(re, (m, u) => {
        if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
        try { const abs = new URL(u, baseUrl).href; return `url("${proxyPrefixRaw}${abs}")`; } catch { return m; }
      })
      .replace(impRe, (m, u) => {
        if (!u) return m;
        try { const abs = new URL(u, baseUrl).href; return `@import url("${proxyPrefixRaw}${abs}");`; } catch { return m; }
      });
    styleEl.textContent = replaced;
  });

  // Inject a minimal agent for console->parent forwarding and to signal ready (safe, small)
  const script = doc.createElement('script');
  script.textContent = `
    (function(){
      if(window.__PP_AGENT__) return; window.__PP_AGENT__ = true;
      function post(t,p){ try{ window.top.postMessage({__pp_agent__:true, type:t, payload:p, href:location.href}, "*"); }catch(e){} }
      ['log','info','warn','error','debug'].forEach(fn=>{
        const orig = console[fn].bind(console);
        console[fn] = function(){ post('console',{level:fn,args:Array.from(arguments)}); try{ orig.apply(console, arguments); }catch(e){} };
      });
      post('agentReady',{href:location.href});
    })();
  `;
  (doc.querySelector('head') || doc.documentElement).appendChild(script);

  return dom.serialize();
}

// MAIN: catch-all proxy route for both raw /https://... style and /proxy/<encoded>
app.use(async (req, res, next) => {
  // allow static files to be served
  const maybeStatic = path.join(__dirname, 'public', req.path);
  // Don't pre-check file existence here; let static middleware handle it earlier

  const target = extractTargetFromRequest(req);
  if (!target) return next(); // not a proxied path; continue to static handlers

  // Ensure we have a valid absolute URL
  let url;
  try { url = new URL(target).href; } catch (e) {
    // If target doesn't include scheme, try adding https
    try { url = new URL('https://' + target).href; } catch { return res.status(400).send('Invalid target URL'); }
  }

  // session and cookie jar
  const sid = ensureSession(req, res);
  const targetHost = new URL(url).host;

  try {
    // We'll follow redirects manually until final; detect loops with visited set.
    const visited = new Set();
    let cur = url;
    let upstreamRes = null;

    while (true) {
      // Prevent infinite immediate loops: if cur already seen -> break with error
      if (visited.has(cur)) {
        return res.status(508).send('Too many redirects (redirect loop detected)');
      }
      visited.add(cur);

      // Prepare headers for upstream; copy most request headers except hop-by-hop
      const headers = {};
      // Copy a small set of headers that help upstream think this is a real browser
      headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
      headers['accept'] = req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
      headers['accept-language'] = req.headers['accept-language'] || 'en-US,en;q=0.9';
      // forward referer if present but adjust to proxied origin if necessary
      if (req.headers.referer) headers['referer'] = req.headers.referer;
      // forward Range if present (video)
      if (req.headers.range) headers['range'] = req.headers.range;

      // Attach cookies from our session jar for this target host
      const cookieHeader = getCookieHeaderForSession(sid, targetHost);
      if (cookieHeader) headers['cookie'] = cookieHeader;

      // perform upstream request (manual redirect mode)
      upstreamRes = await fetch(cur, {
        method: req.method,
        headers,
        body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
        redirect: 'manual',
      });

      // If upstream returned Set-Cookie, store them for the session (and forward to browser too)
      const setCookies = upstreamRes.headers.raw ? (upstreamRes.headers.raw()['set-cookie'] || []) : [];
      if (setCookies && setCookies.length) {
        saveSetCookieForSession(sid, new URL(cur).host, setCookies);
        // forward Set-Cookie so browser stores proxy-scoped cookie copies if needed
        setCookies.forEach(sc => res.append('Set-Cookie', sc));
      }

      // If upstream returned a redirect (3xx) with Location -> rewrite location to proxied raw-style and loop
      const status = upstreamRes.status;
      if (status >= 300 && status < 400) {
        const loc = upstreamRes.headers.get('location');
        if (!loc) {
          // no location header, can't continue
          return res.status(502).send('Upstream redirect with no Location header');
        }
        // resolve to absolute
        let abs;
        try { abs = new URL(loc, cur).href; } catch { abs = loc; }
        // if we have not visited, set cur to abs and loop to request it
        cur = abs;
        // continue loop (no response to client yet)
        continue;
      }

      // Not a redirect -> final resource obtained in upstreamRes
      break;
    } // end redirect follow loop

    // At this point upstreamRes is the final response
    const contentType = upstreamRes.headers.get('content-type') || '';

    // If HTML -> rewrite links to the proxy raw-style and inject helper
    if (contentType.includes('text/html')) {
      const html = await upstreamRes.text();
      const finalUrl = upstreamRes.url || url;
      const rewritten = rewriteHtmlToProxy(html, finalUrl, '/');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(upstreamRes.status).send(rewritten);
    }

    // If range/partial or binary -> stream bytes
    // send appropriate headers (content-type, content-length, accept-ranges, content-range)
    upstreamRes.headers.forEach((v,k) => {
      // Ignore hop-by-hop transfer headers
      if (['transfer-encoding','connection'].includes(k.toLowerCase())) return;
      res.setHeader(k, v);
    });

    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.status(upstreamRes.status).send(buffer);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).send('Proxy fetch error: ' + err.message);
  }
});

// Any other static routes fallback to index
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
  console.log(`Try: http://localhost:${PORT}/https://calvin-hobbes.fandom.com/wiki/Calvin`);
});
