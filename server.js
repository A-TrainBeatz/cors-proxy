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
const PROXY_PREFIX = "/proxy/"; // route used by UI: /proxy/<encodeURIComponent(https://...)>

app.use(cors());
app.use(express.text({ type: "*/*", limit: "40mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

/**
 * In-memory cookie jar per session token.
 * This is simple and ephemeral — for production use persistent storage & auth.
 * Structure: Map<sessionId, Map<host, cookieString>>
 */
const sessionJars = new Map();

function getSessionIdFromReq(req, res) {
  // Read or set a session cookie on the proxy origin so we can track client's cookie-jar
  const cookies = cookie.parse(req.headers.cookie || "");
  let sid = cookies.__ppsession;
  if (!sid) {
    sid = Math.random().toString(36).slice(2);
    // set cookie for proxy origin
    res.setHeader("Set-Cookie", cookie.serialize("__ppsession", sid, { path: "/", httpOnly: false }));
  }
  if (!sessionJars.has(sid)) sessionJars.set(sid, new Map());
  return sid;
}

function storeCookiesForSession(sid, targetHost, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  const jar = sessionJars.get(sid) || new Map();
  // We store raw cookie header(s) for the host (simple implementation)
  const existing = jar.get(targetHost) || [];
  // merge: replace cookies with same name
  const updated = existing.slice();
  setCookieHeaders.forEach(sc => {
    // parse cookie name
    const cname = sc.split("=")[0];
    // remove any previous with same name
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].startsWith(cname + "=")) updated.splice(i, 1);
    }
    updated.push(sc.split(";")[0]); // store name=value only
  });
  jar.set(targetHost, updated);
  sessionJars.set(sid, jar);
}

function getCookieHeaderForSession(sid, targetHost) {
  const jar = sessionJars.get(sid);
  if (!jar) return "";
  const cookies = jar.get(targetHost) || [];
  return cookies.join("; ");
}

// Helper to decode proxied target path
function decodeTargetFromPath(reqPath) {
  if (!reqPath.startsWith(PROXY_PREFIX)) return null;
  const enc = reqPath.slice(PROXY_PREFIX.length);
  try { return decodeURIComponent(enc); } catch { return null; }
}

// Safe HTML rewriting using JSDOM
function rewriteHtml(htmlText, baseUrl, proxyPrefix) {
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // Ensure base tag to help relative resolution
  if (!doc.querySelector("base")) {
    const baseEl = doc.createElement("base");
    baseEl.setAttribute("href", baseUrl);
    const head = doc.querySelector("head") || doc.documentElement;
    head.insertBefore(baseEl, head.firstChild);
  }

  // Attributes to rewrite to point back through proxy
  const ATTRS = [
    ["img","src"], ["script","src"], ["iframe","src"], ["link","href"],
    ["source","src"], ["video","src"], ["audio","src"], ["embed","src"],
    ["object","data"], ["a","href"]
  ];

  for (const [tag, attr] of ATTRS) {
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el=>{
      const v = el.getAttribute(attr);
      if (!v) return;
      if (/^data:|^blob:|^javascript:|^mailto:/i.test(v)) return;
      try {
        const abs = new URL(v, baseUrl).href;
        el.setAttribute(attr, `${proxyPrefix}${encodeURIComponent(abs)}`);
        // for anchors, ensure navigation stays in same frame by default
        if (tag === "a") el.setAttribute("target", "_self");
      } catch(e){}
    });
  }

  // Inline style attributes: rewrite url(...)
  doc.querySelectorAll("[style]").forEach(el=>{
    const s = el.getAttribute("style") || "";
    const replaced = s.replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)','gi'), (m,u)=>{
      if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
      try { const abs = new URL(u, baseUrl).href; return `url("${proxyPrefix}${encodeURIComponent(abs)}")`; } catch { return m; }
    });
    el.setAttribute("style", replaced);
  });

  // <style> blocks: rewrite url(...) and @import
  doc.querySelectorAll("style").forEach(styleEl=>{
    const css = styleEl.textContent || "";
    const replaced = css
      .replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)','gi'), (m,u)=>{
        if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
        try { const abs = new URL(u, baseUrl).href; return `url("${proxyPrefix}${encodeURIComponent(abs)}")`; } catch { return m; }
      })
      .replace(new RegExp('@import\\s+[\'"]?(.*?)[\'"]?;','gi'), (m,u)=>{
        if (!u) return m;
        try { const abs = new URL(u, baseUrl).href; return `@import url("${proxyPrefix}${encodeURIComponent(abs)}");`; } catch { return m; }
      });
    styleEl.textContent = replaced;
  });

  // Inject small helper script for console/network forwarding & to help login (lightweight)
  const helper = doc.createElement("script");
  helper.textContent = `
    (function(){
      if(window.__PP_INJECTED__) return; window.__PP_INJECTED__ = true;
      function send(type,p){ try{ window.top.postMessage({__pp_agent__:true,type:type,payload:p,url:location.href}, "*"); }catch(e){} }
      ['log','info','warn','error','debug'].forEach(function(fn){
        const orig = console[fn].bind(console);
        console[fn] = function(){ try{ send('console',{level:fn,args:Array.from(arguments)}); }catch(e){}; orig.apply(console, arguments); };
      });
      // notify ready
      send('agentReady',{href:location.href});
    })();
  `;
  (doc.querySelector("head") || doc.documentElement).appendChild(helper);

  return dom.serialize();
}

// Proxy route: supports Range for video, forwards cookies (store per session), rewrites HTML
app.use("/proxy/*", async (req, res) => {
  const target = decodeTargetFromPath(req.path);
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("❌ Invalid proxied URL. Use /proxy/<encodeURIComponent(https://example.com/...)>");
  }

  // session handling
  const sid = getSessionIdFromReq(req, res);

  try {
    // prepare headers for upstream
    const upstreamHeaders = Object.assign({}, req.headers);
    // Remove host to avoid confusion, set upstream host explicitly
    delete upstreamHeaders.host;

    // include cookies from our session jar for this upstream host
    try {
      const targetHost = new URL(target).host;
      const cookieHeader = getCookieHeaderForSession(sid, targetHost);
      if (cookieHeader) upstreamHeaders['cookie'] = cookieHeader;
    } catch(e){}

    // forward Range requests (important for video)
    const range = req.headers.range;
    if (range) upstreamHeaders.range = range;

    // Use manual redirect mode so we can rewrite Location headers rather than following blindly
    const upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual"
    });

    // If upstream returns Set-Cookie headers, store cookies for this session and host
    const setCookie = upstream.headers.raw()['set-cookie'] || [];
    if (setCookie.length > 0) {
      const host = new URL(target).host;
      storeCookiesForSession(sid, host, setCookie);
      // Also forward the set-cookie to the browser to persist in proxy origin
      setCookie.forEach(sc => res.append('Set-Cookie', sc));
    }

    // Handle redirects: rewrite Location to proxy path (so client follows via proxy)
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (!loc) return res.status(502).send("Bad redirect from upstream (no location)");
      const abs = new URL(loc, target).href;
      const proxied = `${PROXY_PREFIX}${encodeURIComponent(abs)}`;
      res.setHeader('Location', proxied);
      return res.status(upstream.status).send();
    }

    const contentType = upstream.headers.get("content-type") || "";

    // If HTML -> rewrite and inject helpers
    if (contentType.includes("text/html")) {
      const text = await upstream.text();
      const rewritten = rewriteHtml(text, upstream.url || target, PROXY_PREFIX);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.status(upstream.status).send(rewritten);
    }

    // Non-HTML (binary or CSS/JS): stream bytes
    // Support Range responses for video/audio (pass through upstream response)
    if (upstream.status === 206 || upstream.headers.get('accept-ranges') || upstream.headers.get('content-range')) {
      // It's a ranged response or supports it — stream buffer
      const buf = Buffer.from(await upstream.arrayBuffer());
      // copy relevant headers
      upstream.headers.forEach((v,k) => {
        if (["transfer-encoding","connection"].includes(k)) return;
        res.setHeader(k, v);
      });
      return res.status(upstream.status).send(buf);
    }

    // Default: send buffer content with content-type
    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader("content-type", contentType || mime.lookup(target) || "application/octet-stream");
    return res.status(upstream.status).send(buffer);

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(502).send("Proxy error: " + err.message);
  }
});

// Google search bypass — fetch search results and rewrite links to keep proxied navigation
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.status(400).send("Missing q parameter");
  const googleUrl = "https://www.google.com/search?q=" + encodeURIComponent(q);
  try {
    const response = await fetch(googleUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await response.text();
    const rewritten = rewriteHtml(html, googleUrl, PROXY_PREFIX);
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.send(rewritten);
  } catch (e) {
    console.error(e);
    return res.status(502).send("Search proxy error: " + e.message);
  }
});

// small landing
app.get("/", (req,res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => console.log(`✅ Proxy running at http://localhost:${PORT}`));
