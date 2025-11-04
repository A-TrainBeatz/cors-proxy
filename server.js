import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";

const app = express();
app.use(cors());
app.use(express.text({ type: "*/*" }));

const PROXY = "https://cors-proxy-s2pk.onrender.com";

function rewriteHtml(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const fixLink = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("data:") || val.startsWith("javascript:")) return;
    try {
      const url = new URL(val, baseUrl).href;
      el.setAttribute(attr, `${PROXY}/${url}`);
    } catch {}
  };

  doc.querySelectorAll("[src]").forEach(el => fixLink(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => fixLink(el, "href"));

  return dom.serialize();
}

app.use(async (req, res) => {
  let target = req.url.slice(1);

  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    return res.status(400).send("❌ Invalid URL. Must start with https://");
  }

  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
      body: req.method !== "GET" ? req.body : undefined
    });

    const type = r.headers.get("content-type") || "";
    res.set("content-type", type);

    const text = await r.text();

    if (type.includes("text/html")) {
      return res.send(rewriteHtml(text, target));
    }

    res.send(text);
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.listen(3000, () => console.log("✅ Proxy running on :3000"));
