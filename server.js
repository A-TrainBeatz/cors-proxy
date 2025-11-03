// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.text({ type: "*/*", limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const HOST = `http://localhost:${PORT}`; // used for injected helper urls

// Serve static frontend UI
app.use(express.static(path.join(__dirname, "public")));

// Root quick landing
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/**
 * Proxy route
 * Example usage:
 *   /proxy/https://calvin-hobbes.fandom.com/
 */
app.all("/proxy/*", async (req, res) => {
  try {
    // target is the remainder after /proxy/
    const target = req.url.replace(/^\/proxy\//, "");
    if (!/^https?:\/\//i.test(target)) {
      return res.status(400).send("Invalid target. Use /proxy/https://example.com/...");
    }

    // perform upstream fetch
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: {
        // strip host - set to upstream host
        ...req.headers,
        host: new URL(target).host
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual"
    });

    const contentType = upstreamRes.headers.get("content-type") || "";

    // For non-HTML, just pipe through (but still return through this server so the URL stays same-origin)
    if (!contentType.includes("text/html")) {
      // set headers
      upstreamRes.headers.forEach((v, k) => {
        // don't forward hop-by-hop headers
        if (["content-encoding", "transfer-encoding", "connection"].includes(k)) return;
        res.setHeader(k, v);
      });
      const buffer = await upstreamRes.arrayBuffer();
      return res.status(upstreamRes.status).send(Buffer.from(buffer));
    }

    // HTML rewriting + injection
    const html = await upstreamRes.text();
    const finalUrl = upstreamRes.url || target; // may be redirected

    const rewritten = await rewriteAndInject(html, finalUrl);
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.status(200).send(rewritten);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).send("Proxy error: " + err.message);
  }
});

async function rewriteAndInject(htmlText, baseUrl) {
  // parse
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // Add <base> so relative URLs resolve in injected DOM context
  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", baseUrl);
  const head = doc.querySelector("head") || doc.documentElement;
  head.insertBefore(baseEl, head.firstChild);

  // Rewrite attributes to point to our proxy endpoint
  const rewriteAttr = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val) return;
    if (/^data:|^blob:|^javascript:/i.test(val)) return;
    try {
      const abs = new URL(val, baseUrl).href;
      el.setAttribute(attr, `/proxy/${abs}`); // same-origin path back to this server
    } catch (e) {
      // ignore
    }
  };

  // Attributes to rewrite
  const ATTR_TAGS = [
    ["img", "src"],
    ["script", "src"],
    ["iframe", "src"],
    ["link", "href"],
    ["source", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["embed", "src"],
    ["object", "data"],
    ["a", "href"]
  ];

  ATTR_TAGS.forEach(([tag, attr]) => {
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => rewriteAttr(el, attr));
  });

  // Rewrite inline styles url(...)
  doc.querySelectorAll("[style]").forEach(el => {
    const s = el.getAttribute("style");
    if (!s) return;
    const replaced = s.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (m, u) => {
      if (/^data:|^blob:|^javascript:/i.test(u)) return m;
      try {
        const abs = new URL(u, baseUrl).href;
        return `url("/proxy/${abs}")`;
      } catch {
        return m;
      }
    });
    el.setAttribute("style", replaced);
  });

  // Inline CSS files: convert <link rel="stylesheet"> to <link href="/proxy/..." /> (we already rewrote href)
  // For @import / url(...) inside <style> blocks, rewrite them:
  doc.querySelectorAll("style").forEach(styleEl => {
    const css = styleEl.textContent;
    const replaced = css.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (m, u) => {
      if (/^data:|^blob:|^javascript:/i.test(u)) return m;
      try {
        const abs = new URL(u, baseUrl).href;
        return `url("/proxy/${abs}")`;
      } catch {
        return m;
      }
    });
    styleEl.textContent = replaced;
  });

  // Inject agent script just before </head>
  const agentCode = generateAgentScript(baseUrl);
  const scriptEl = doc.createElement("script");
  scriptEl.textContent = agentCode;
  head.appendChild(scriptEl);

  // Also add a small meta removal for CSP that can break injected script running inside iframe
  doc.querySelectorAll('meta[http-equiv]').forEach(m => {
    const v = m.getAttribute('http-equiv') || '';
    if (/content-security-policy/i.test(v)) m.remove();
  });

  return dom.serialize();
}

function generateAgentScript(baseUrl) {
  // This script runs inside the proxied page (same-origin to parent because served at /proxy/...)
  // It forwards console logs and network calls, listens for parent commands via postMessage.
  return `
(function(){
  try {
    // avoid double-injection
    if(window.__PROXY_AGENT_INJECTED) return;
    window.__PROXY_AGENT_INJECTED = true;

    // helper to post to parent
    function post(type, payload) {
      try { window.top.postMessage({__proxy_agent__:true, type: type, payload: payload, __url__: location.href}, '*'); } catch(e) {}
    }

    // Console forwarding
    ['log','info','warn','error','debug'].forEach(fn=>{
      const orig = console[fn];
      console[fn] = function(...args){
        try { post('console', {level:fn, args: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))) }); } catch(e){}
        try { orig.apply(console, args); } catch(e){}
      };
    });

    // Intercept fetch
    const origFetch = window.fetch;
    window.fetch = async function(...args){
      const start = Date.now();
      try {
        const res = await origFetch.apply(this, args);
        const clone = res.clone();
        let text = '';
        try { text = await clone.text(); if(text.length>5000) text = text.slice(0,5000)+'...[truncated]'; } catch(e){}
        post('network', {type:'fetch', url: args[0], ok:res.ok, status:res.status, duration: Date.now()-start, bodyPreview: text});
        return res;
      } catch(err) {
        post('network', {type:'fetch', url: args[0], error: String(err)});
        throw err;
      }
    };

    // Intercept XHR
    (function(){
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method,url){
        this.__proxy_xhr_method = method;
        this.__proxy_xhr_url = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body){
        const xhr = this;
        const start = Date.now();
        this.addEventListener('load', function(){
          let preview = xhr.responseText;
          try { if(preview && preview.length>5000) preview = preview.slice(0,5000) + '...[truncated]'; } catch(e){}
          post('network', {type:'xhr', method: xhr.__proxy_xhr_method, url: xhr.__proxy_xhr_url, status: xhr.status, duration: Date.now()-start, bodyPreview: preview});
        });
        this.addEventListener('error', function(){
          post('network', {type:'xhr', method: xhr.__proxy_xhr_method, url: xhr.__proxy_xhr_url, error:true});
        });
        return origSend.apply(this, arguments);
      };
    })();

    // Listen for parent commands
    window.addEventListener('message', async (ev) => {
      const msg = ev.data || {};
      if(msg && msg.__from_parent__){
        const cmd = msg.cmd;
        try {
          if(cmd === 'querySelectorInfo'){
            const sel = msg.selector;
            const el = document.querySelector(sel);
            const info = el ? {
              tag: el.tagName,
              html: el.outerHTML.slice(0,2000),
              rect: el.getBoundingClientRect ? el.getBoundingClientRect().toJSON() : null,
              computed: window.getComputedStyle ? (function(){
                const cs = window.getComputedStyle(el);
                const out = {};
                for(let i=0;i<cs.length;i++){ out[cs[i]] = cs.getPropertyValue(cs[i]); }
                return out;
              })() : {}
            } : null;
            post('inspect', {selector: sel, info});
          } else if(cmd === 'runJS') {
            let result;
            try {
              result = eval(msg.code);
              if(typeof result === 'object') {
                try { result = JSON.stringify(result); } catch(e) {}
              }
            } catch(e){ result = 'ERROR: '+e.message; }
            post('exec', {result});
          } else if(cmd === 'applyStyle') {
            const {selector, cssText} = msg;
            const el = document.querySelector(selector);
            if(el) {
              el.style.cssText += ';' + cssText;
              post('applyStyle', {ok:true, selector});
            } else post('applyStyle', {ok:false, selector});
          }
        } catch(e){
          post('agent_error', {message: e.message});
        }
      }
    });

    // Notify parent we're alive
    post('agent_ready', {href: location.href});

  } catch(e){
    try { window.top.postMessage({__proxy_agent__:true, type:'agent_error', payload: {message: e.message}}, '*'); } catch(e){}
  }
})();
`;
}

app.listen(PORT, () => {
  console.log(`✅ Proxy + UI server running: http://localhost:${PORT}`);
  console.log(`→ Use /proxy/https://example.com/... to browse through proxy`);
});
