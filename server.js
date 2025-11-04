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
const PROXY_PREFIX = "/proxy/"; // client uses: /proxy/<encodeURIComponent(https://example.com/path)>

app.use(cors());
app.use(express.text({ type: "*/*", limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// helper: decode proxied target
function decodeTarget(reqPath) {
  if (!reqPath.startsWith(PROXY_PREFIX)) return null;
  const encoded = reqPath.slice(PROXY_PREFIX.length);
  try { return decodeURIComponent(encoded); } catch { return null; }
}

function filterForwardHeaders(headers) {
  const out = {};
  const hopByHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade"
  ]);
  Object.keys(headers || {}).forEach(k => {
    if (hopByHop.has(k.toLowerCase())) return;
    out[k] = headers[k];
  });
  return out;
}

// rewrite HTML helper (keeps simple and safe)
function rewriteHtml(htmlText, baseUrl) {
  const dom = new JSDOM(htmlText);
  const doc = dom.window.document;

  // ensure <base> exists so relative URLs resolve
  if (!doc.querySelector("base")) {
    const baseEl = doc.createElement("base");
    baseEl.setAttribute("href", baseUrl);
    const head = doc.querySelector("head") || doc.documentElement;
    head.insertBefore(baseEl, head.firstChild);
  }

  // rewrite resource attributes to proxied paths
  const ATTRS = [
    ["img","src"],["script","src"],["iframe","src"],["link","href"],
    ["source","src"],["video","src"],["audio","src"],["embed","src"],["object","data"],["a","href"]
  ];
  for (const [tag, attr] of ATTRS) {
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
      const val = el.getAttribute(attr);
      if (!val) return;
      if (/^data:|^blob:|^javascript:|^#/i.test(val)) return;
      try {
        const abs = new URL(val, baseUrl).href;
        el.setAttribute(attr, `${PROXY_PREFIX}${encodeURIComponent(abs)}`);
      } catch(e){}
    });
  }

  // rewrite inline styles url(...)
  doc.querySelectorAll("[style]").forEach(el => {
    const s = el.getAttribute("style") || "";
    const replaced = s.replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)','gi'), (m,u) => {
      if (!u || /^data:|^blob:|^javascript:/i.test(u)) return m;
      try { const abs = new URL(u, baseUrl).href; return `url("${PROXY_PREFIX}${encodeURIComponent(abs)}")`; } catch { return m; }
    });
    el.setAttribute("style", replaced);
  });

  return dom.serialize();
}

// Main proxy handler (follows redirects safely)
app.use("/proxy/*", async (req, res) => {
  const target = decodeTarget(req.path);
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("❌ Invalid proxied URL. Use /proxy/<encodeURIComponent(https://example.com/...)>");
  }

  try {
    // Let node-fetch follow redirects up to a limit (set redirect: 'follow')
    // If you want to manually limit, you can implement a loop; node-fetch default max is 20.
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: { ...filterForwardHeaders(req.headers), host: new URL(target).host },
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "follow" // follow redirects automatically
    });

    // If upstream responded with a redirect chain that node-fetch followed, we get the final resource here.
    // Still handle non-HTML types by streaming buffer.
    const contentType = upstreamRes.headers.get("content-type") || "";

    // Forward some headers (but don't forward hop-by-hop)
    upstreamRes.headers.forEach((v,k) => {
      if (["content-encoding","transfer-encoding","connection"].includes(k)) return;
      // If upstream provided a Location header (rare when redirect:follow), rewrite it so clients follow via proxy
      if (k.toLowerCase() === "location") {
        try {
          const loc = new URL(v, target).href;
          res.setHeader("location", `${PROXY_PREFIX}${encodeURIComponent(loc)}`);
        } catch {
          res.setHeader("location", v);
        }
        return;
      }
      res.setHeader(k, v);
    });

    // If content is HTML, rewrite asset URLs and inject minimal fixes
    if (contentType.includes("text/html")) {
      const text = await upstreamRes.text();
      const finalUrl = upstreamRes.url || target;
      const rewritten = rewriteHtml(text, finalUrl);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.status(upstreamRes.status).send(rewritten);
    }

    // For binary/non-HTML content, pipe raw bytes
    const buffer = await upstreamRes.arrayBuffer();
    const buf = Buffer.from(buffer);
    res.setHeader("content-type", contentType || mime.lookup(target) || "application/octet-stream");
    return res.status(upstreamRes.status).send(buf);

  } catch (err) {
    console.error("Proxy fetch error:", err);
    // If error mentions maximum redirect, send helpful message
    return res.status(502).send("Proxy fetch error: " + err.message);
  }
});

app.get("/", (req,res) => res.send("Power proxy running. Use /proxy/<encodeURIComponent(https://example.com/...)>"));
app.listen(PORT, () => console.log(`Proxy listening on http://localhost:${PORT}`));
