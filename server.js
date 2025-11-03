import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

// Force proxy URL format: /https://site.com/page
app.get("/*", async (req, res) => {
  let target = req.originalUrl.slice(1); // remove leading "/"

  if (!target.startsWith("http")) {
    return res.status(400).send("Invalid proxy request");
  }

  try {
    const response = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    // Return raw if not HTML
    if (!contentType.includes("text/html")) {
      res.set("content-type", contentType);
      return res.send(text);
    }

    // Load & rewrite HTML
    const $ = cheerio.load(text);
    const base = new URL(target).origin;

    // Rewrite <a>, <img>, <script>, <link>, <iframe>, <source>, CSS url(...)
    $("a[href], img[src], script[src], link[href], iframe[src], source[src]").each(function () {
      const attr = $(this).attr("href") ? "href" : "src";
      let url = $(this).attr(attr);
      if (!url) return;

      try {
        url = new URL(url, target).href;
        $(this).attr(attr, `/${url}`);
      } catch {}
    });

    // Inline style URL rewriter
    $("*").each(function () {
      let style = $(this).attr("style");
      if (!style) return;
      style = style.replace(/url\(['"]?(.*?)['"]?\)/g, (m, u) => {
        try {
          const full = new URL(u, target).href;
          return `url(/${full})`;
        } catch {
          return m;
        }
      });
      $(this).attr("style", style);
    });

    // Inject base and script
    $("head").prepend(`<base href="${base}/">`);
    $("body").append(`
<script>
document.addEventListener("click", e => {
  let a = e.target.closest("a[href]");
  if (!a) return;
  let url = a.getAttribute("href");
  if (!url.startsWith("http")) return;
  e.preventDefault();
  window.top.postMessage({ proxyNav: url }, "*");
});
</script>
`);

    res.set("content-type", "text/html");
    res.send($.html());

  } catch (err) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
