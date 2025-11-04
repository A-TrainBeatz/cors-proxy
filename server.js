import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";

const app = express();
app.use(cors());
app.use(express.text({ type: "**" }));

const PORT = process.env.PORT || 3000;
const PROXY_BASE = "https://cors-proxy-s2pk.onrender.com/"; // Replace with your deployed URL

// Rewrite all HTML resources to go through proxy
function rewriteHtml(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const rewrite = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("data:") || val.startsWith("javascript:") || val.startsWith("#")) return;
    try {
      const url = new URL(val, baseUrl).href;
      el.setAttribute(attr, `${PROXY_BASE}/${url}`);
    } catch {}
  };

  doc.querySelectorAll("[src]").forEach(el => rewrite(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => rewrite(el, "href"));

  // Rewrite inline styles with url(...)
  doc.querySelectorAll("[style]").forEach(el => {
    const style = el.getAttribute("style");
    const newStyle = style.replace(new RegExp('url\\(\\s*[\'"]?(.*?)[\'"]?\\s*\\)', 'gi'), (m, u) => {
      if(u.startsWith("data:") || u.startsWith("javascript:")) return m;
      try { return `url(${PROXY_BASE}/${new URL(u, baseUrl).href})`; } catch { return m; }
    });
    el.setAttribute("style", newStyle);
  });

  return dom.serialize();
}

// Proxy all requests
app.use(async (req, res) => {
  const target = req.url.slice(1); // Remove leading "/"
  if (!target.startsWith("http")) return res.status(400).send("Bad URL");

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
      body: req.method !== "GET" ? req.body : undefined
    });

    const contentType = upstream.headers.get("content-type") || "";
    res.set("content-type", contentType);

    const data = await upstream.text();

    if (contentType.includes("text/html")) {
      return res.send(rewriteHtml(data, target));
    }

    res.send(data);
  } catch (err) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

app.listen(PORT, () => console.log(`✅ CORS Proxy running on port ${PORT}`));
