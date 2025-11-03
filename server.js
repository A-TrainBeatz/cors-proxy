import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { JSDOM } from "jsdom";

const app = express();
app.use(cors());
app.use(express.text({ type: "*/*" }));

// 👇 Base proxy URL
const PROXY = "https://your-domain.com";

function rewriteHtml(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const rewrite = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("data:") || val.startsWith("javascript:")) return;
    try {
      const url = new URL(val, baseUrl).href;
      el.setAttribute(attr, `${PROXY}/${url}`);
    } catch {}
  };

  doc.querySelectorAll("[src]").forEach(el => rewrite(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => rewrite(el, "href"));

  return "<!-- rewritten -->\n" + dom.serialize();
}

app.use(async (req, res) => {
  const target = req.url.slice(1); 
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

app.listen(3000, () => console.log("✅ Proxy running on :3000"));
