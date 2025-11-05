import express from "express";
import cors from "cors";
import { JSDOM } from "jsdom";
import { http, https } from "follow-redirects";

const app = express();
app.use(cors());
app.use(express.text({ type: "*/*" }));

const PROXY = "https://cors-proxy-s2pk.onrender.com";

function fixURL(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function rewriteHTML(html, baseUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const fix = (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("data:") || val.startsWith("javascript:")) return;
    el.setAttribute(attr, `${PROXY}/${fixURL(val, baseUrl)}`);
  };

  doc.querySelectorAll("[src]").forEach(el => fix(el, "src"));
  doc.querySelectorAll("[href]").forEach(el => fix(el, "href"));

  return dom.serialize();
}

app.use((req, res) => {
  const target = req.url.slice(1);
  if (!target.startsWith("http")) return res.status(400).send("Bad URL");

  const client = target.startsWith("https") ? https : http;

  client.get(target, response => {
    let body = "";
    const contentType = response.headers["content-type"] || "";

    response.on("data", chunk => body += chunk);
    response.on("end", () => {
      res.set("content-type", contentType);

      if (contentType.includes("text/html")) {
        res.send(rewriteHTML(body, target));
      } else {
        res.send(body);
      }
    });
  }).on("error", err => {
    res.status(500).send("Proxy error: " + err.message);
  });
});

app.listen(3000, () => console.log("✅ Unlimited Proxy running on :3000"));
