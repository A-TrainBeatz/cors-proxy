import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.text({ type: "*/*" }));

// Home page avoids CANNOT GET /
app.get("/", (req, res) => {
  res.send("✅ Proxy running. Use /https://site.com");
});

// --- HTML + CSS REWRITE ENGINE ---
function rewriteHtml(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
  // Inject console hook
  const script = doc.createElement("script");
  script.textContent = `
    (function(){
      const orig = console.log;
      console.log = (...a)=>{ try{ parent.postMessage({proxyConsole:a.join(" ")}, "*") }catch(e){}; orig(...a) };
    })();
  `;
  doc.head.appendChild(script);

  const rewrite = (el, attr) => {
    let v = el.getAttribute(attr);
    if (!v || v.startsWith("javascript:") || v.startsWith("data:")) return;
    try {
      const u = new URL(v, baseUrl).href;
      el.setAttribute(attr, '/' + u);
    } catch(e){}
  };

  doc.querySelectorAll("[src]").forEach(el => rewrite(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => rewrite(el, "href"));

  // Rewrite CSS url(...)
  doc.querySelectorAll("style,link[rel=stylesheet]").forEach(node=>{
    if (node.tagName === "STYLE") {
      node.textContent = node.textContent.replace(/url\\(["']?(.*?)["']?\\)/g, (m, p)=>{
        if (p.startsWith("data:")) return m;
        try { return `url(/${new URL(p, baseUrl).href})`; } catch {}
        return m;
      });
    }
  });

  return dom.serialize();
}

// --- Proxy Handler ---
app.use(async (req, res) => {
  const target = req.url.slice(1);
  if (!target.startsWith("http"))
    return res.status(400).send("❌ Format: /https://example.com");

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
      body: req.method !== "GET" ? req.body : undefined
    });

    const type = upstream.headers.get("content-type") || "";
    res.set("content-type", type);

    let body = await upstream.text();

    if (type.includes("text/html"))
      return res.send(rewriteHtml(body, target));

    return res.send(body);
  } catch(err) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Proxy live on :${PORT}`));
