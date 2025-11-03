import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";

const app = express();
app.use(cors());
app.use(express.text({ type: "*/*" }));

// Root Page to avoid CANNOT GET /
app.get("/", (req, res) => {
  res.send(`
    ✅ Proxy Online<br>
    Usage: /https://example.com<br><br>
    Example:<br>
    <a href="/https://calvin-hobbes.fandom.com">Browse Fandom</a>
  `);
});

// Proxy handler
async function handleProxy(req, res) {
  const target = req.url.slice(1);

  if (!target.startsWith("http")) {
    return res.status(400).send("❌ Invalid URL. Format: /https://site.com");
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
      body: req.method !== "GET" ? req.body : undefined
    });

    const contentType = upstream.headers.get("content-type") || "";
    res.set("content-type", contentType);

    let body = await upstream.text();

    if (contentType.includes("text/html")) {
      body = rewriteHtml(body, target);
    }

    res.send(body);
  } catch (err) {
    res.status(500).send("Proxy error: " + err.message);
  }
}

function rewriteHtml(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const PROXY = ""; // relative so links rewrite correctly

  const rewrite = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("data:") || val.startsWith("javascript:")) return;
    try {
      const url = new URL(val, baseUrl).href;
      el.setAttribute(attr, `/${url}`);
    } catch {}
  };

  doc.querySelectorAll("[src]").forEach(el => rewrite(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => rewrite(el, "href"));

  return dom.serialize();
}

// Important — catch ALL routes
app.use(handleProxy);

app.listen(3000, () => console.log("✅ Proxy running on http://localhost:3000"));
