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

app.use(cors());
app.use(express.text({ type: "*/*", limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Helper: decode proxied target from path "/proxy/<encoded>"
function decodeTargetFromPath(reqPath) {
  const prefix = "/proxy/";
  if (!reqPath.startsWith(prefix)) return null;
  const encoded = reqPath.slice(prefix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

// Main proxy route: catch-all under /proxy/
app.use("/proxy/*", async (req, res) => {
  const target = decodeTargetFromPath(req.path);
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("Invalid proxied URL. Use /proxy/<encodeURIComponent(https://example.com/page)>");
  }

  try {
    // Fetch upstream
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: {
        // Forward some headers but set Host for upstream
        ...filterForwardHeaders(req.headers),
        host: new URL(target).host
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual"
    });

    const contentType = upstreamRes.headers.get("content-type") || "";
    res.status(upstreamRes.status);

    // For HTML, rewrite and inject agent
    if (contentType.includes("text/html")) {
      let text = await upstreamRes.text();
      const finalUrl = upstreamRes.url || target;
      const rewritten = await rewriteHtmlAndInjectAgent(text, finalUrl);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.send(rewritten);
    }

    // For other content (images, fonts, CSS, JS, etc.) stream bytes and set content-type
    const buffer = await upstreamRes.arrayBuffer();
    const buf = Buffer.from(buffer);
    // set content-type if present or infer from path
    const contentTypeHeader = upstreamRes.headers.get("content-type") || mime.lookup(target) || "application/octet-stream";
    res.setHeader("content-type", contentTypeHeader);
    return res.send(buf);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(502).send("Proxy error: " + err.message);
  }
});

// small helper to filter out hop-by-hop headers
function filterForwardHeaders(headers) {
  const out = {};
  const hopByHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade"
  ]);
  Object.keys(headers).forEach(k => {
    if (hopByHop.has(k.toLowerCase())) return;
    out[k] = headers[k];
  });
  return out;
}

// HTML rewrite + agent injection
async function rewriteHtmlAndInjectAgent(htmlText, baseUrl) {
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // Remove problematic CSP meta tags
  doc.querySelectorAll('meta[http-equiv]').forEach(m => {
    const ev = m.getAttribute('http-equiv') || "";
    if (/content-security-policy/i.test(ev)) m.remove();
  });

  // Insert <base> if not present to help resource resolution inside the rewritten DOM
  if (!doc.querySelector('base')) {
    const baseEl = doc.createElement('base');
    baseEl.setAttribute('href', baseUrl);
    const head = doc.querySelector('head') || doc.documentElement;
    head.insertBefore(baseEl, head.firstChild);
  }

  // rewrite resource attributes to point back to /proxy/<encodedAbsoluteUrl>
  const ATTRS = [
    {sel: 'img[src]', attr: 'src'},
    {sel: 'script[src]', attr: 'src'},
    {sel: 'iframe[src]', attr: 'src'},
    {sel: 'link[href]', attr: 'href'},
    {sel: 'source[src]', attr: 'src'},
    {sel: 'video[src]', attr: 'src'},
    {sel: 'audio[src]', attr: 'src'},
    {sel: 'embed[src]', attr: 'src'},
    {sel: 'object[data]', attr: 'data'},
    {sel: 'a[href]', attr: 'href'}
  ];

  for (const {sel, attr} of ATTRS) {
    doc.querySelectorAll(sel).forEach(el => {
      const val = el.getAttribute(attr);
      if (!val) return;
      if (/^data:|^blob:|^javascript:/i.test(val)) return;
      try {
        const abs = new URL(val, baseUrl).href;
        el.setAttribute(attr, `/proxy/${encodeURIComponent(abs)}`);
        // For anchors, ensure clicks are safe: keep target default (let agent handle)
      } catch (e) {
        // ignore
      }
    });
  }

  // Rewrite inline style attributes url(...) -> proxied
  doc.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style') || '';
    const replaced = s.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (m, u) => {
      if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
      try {
        const abs = new URL(u, baseUrl).href;
        return `url("/proxy/${encodeURIComponent(abs)}")`;
      } catch { return m; }
    });
    el.setAttribute('style', replaced);
  });

  // Process <style> blocks: rewrite url(...) and @import
  doc.querySelectorAll('style').forEach(styleEl => {
    const css = styleEl.textContent || '';
    const replaced = css.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (m, u) => {
      if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
      try {
        const abs = new URL(u, baseUrl).href;
        return `url("/proxy/${encodeURIComponent(abs)}")`;
      } catch { return m; }
    }).replace(/@import\s+['"]?(.*?)['"]?;/gi, (m, u) => {
      if (!u) return m;
      try {
        const abs = new URL(u, baseUrl).href;
        return `@import url("/proxy/${encodeURIComponent(abs)}");`;
      } catch { return m; }
    });
    styleEl.textContent = replaced;
  });

  // Convert <link rel=stylesheet href=> (we already rewrote href to /proxy/...) — keep as-is
  // Inject the agent script at end of head
  const agentScript = doc.createElement('script');
  agentScript.textContent = generateAgentScript();
  (doc.querySelector('head') || doc.documentElement).appendChild(agentScript);

  return dom.serialize();
}

// The agent runs inside every proxied page (same-origin relative to the UI because of /proxy/ path)
function generateAgentScript() {
  // Keep this fairly small and defensive.
  return `
(function(){
  if(window.__POWER_PROXY_AGENT__) return;
  window.__POWER_PROXY_AGENT__ = true;

  function post(type, payload){ try { window.top.postMessage({__power_proxy_agent__:true, type:type, payload:payload, url:location.href}, "*"); } catch(e){} }

  // Console forwarding
  ['log','info','warn','error','debug'].forEach(fn=>{
    const orig = console[fn].bind(console);
    console[fn] = function(...args){
      try { post('console', {level:fn, args: args.map(a => safeSerialize(a))}); } catch(e){}
      try { orig(...args); } catch(e){}
    };
  });

  function safeSerialize(v){
    try {
      if (typeof v === 'string') return v;
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch(e){ return String(v); }
  }

  // Intercept fetch
  if(window.fetch){
    const origFetch = window.fetch.bind(window);
    window.fetch = async function(...args){
      const start = Date.now();
      try {
        const res = await origFetch(...args);
        const clone = res.clone();
        let txt = "";
        try { txt = await clone.text(); if(txt && txt.length > 2000) txt = txt.slice(0,2000) + '...[truncated]'; } catch(e){}
        post('network', {type:'fetch', url: args[0], ok: res.ok, status: res.status, duration: Date.now()-start, preview: txt});
        return res;
      } catch(err){
        post('network', {type:'fetch', url: args[0], error: String(err)});
        throw err;
      }
    };
  }

  // Intercept XHR
  (function(){
    const X = window.XMLHttpRequest;
    if(!X) return;
    const origOpen = X.prototype.open;
    const origSend = X.prototype.send;
    X.prototype.open = function(m, url){
      this.__pp_method = m; this.__pp_url = url;
      return origOpen.apply(this, arguments);
    };
    X.prototype.send = function(body){
      const xhr = this;
      const start = Date.now();
      this.addEventListener('load', function(){
        let preview = '';
        try { preview = xhr.responseText; if(preview && preview.length > 2000) preview = preview.slice(0,2000) + '...[truncated]'; } catch(e){}
        post('network', {type:'xhr', method: xhr.__pp_method, url: xhr.__pp_url, status: xhr.status, duration: Date.now()-start, preview});
      });
      this.addEventListener('error', function(){ post('network', {type:'xhr', method: xhr.__pp_method, url: xhr.__pp_url, error:true}); });
      return origSend.apply(this, arguments);
    };
  })();

  // Inspect / DOM commands from parent via postMessage
  window.addEventListener('message', async ev => {
    const msg = ev.data || {};
    if(!msg || !msg.__from_proxy_ui__) return;

    try {
      if(msg.cmd === 'query') {
        const sel = msg.selector;
        const el = document.querySelector(sel);
        const info = el ? {
          tag: el.tagName,
          outerHTML: el.outerHTML.slice(0,2000),
          rect: el.getBoundingClientRect ? el.getBoundingClientRect().toJSON() : null,
          computed: window.getComputedStyle ? extractComputedStyle(el) : {}
        } : null;
        post('inspect', {selector: sel, info});
      } else if(msg.cmd === 'run') {
        let res;
        try { res = eval(msg.code); if(typeof res === 'object') res = JSON.stringify(res); } catch(e){ res = 'ERROR: ' + e.message; }
        post('runResult', {result: String(res)});
      } else if(msg.cmd === 'applyStyle') {
        const el = document.querySelector(msg.selector);
        if(el){ el.style.cssText += ';' + msg.css; post('applyStyle', {ok:true}); }
        else post('applyStyle', {ok:false});
      } else if(msg.cmd === 'getResources') {
        // Collect images/scripts/stylesheets with proxied URLs (if present)
        const resources = Array.from(document.querySelectorAll('img,script,link[rel=stylesheet],video,source'))
          .map(n => ({tag: n.tagName, src: n.src || n.href || n.getAttribute('src') || n.getAttribute('href')}));
        post('resources', {resources});
      } else if(msg.cmd === 'enableClickInspect') {
        // set a one-time click listener
        const handler = function(ev2){
          ev2.preventDefault(); ev2.stopPropagation();
          const el = ev2.target;
          let sel = elementToSelector(el);
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect().toJSON() : null;
          post('clickInspect', {selector: sel, rect, outerHTML: el.outerHTML.slice(0,2000)});
          document.removeEventListener('click', handler, true);
        };
        document.addEventListener('click', handler, true);
        post('inspectListener', {ok:true});
      }
    } catch(e){
      post('agentError', {message: e.message});
    }
  });

  function extractComputedStyle(el){
    const cs = window.getComputedStyle(el);
    const out = {};
    for(let i=0;i<cs.length;i++){ out[cs[i]] = cs.getPropertyValue(cs[i]); }
    return out;
  }

  function elementToSelector(el){
    if(!el) return null;
    let s = el.tagName.toLowerCase();
    if(el.id) s += '#'+el.id;
    if(el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\\s+/).join('.');
    return s;
  }

  // Notify ready
  post('agentReady', {href: location.href});

})();
`;
}

app.listen(PORT, () => {
  console.log(`✅ Power Proxy (GOD MODE) running at http://localhost:${PORT}`);
  console.log(`→ Browse via http://localhost:${PORT}/ (enter a URL in the UI)`);
});
