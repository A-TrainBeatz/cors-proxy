// server.js
const cors_proxy = require("cors-anywhere");
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;

// --------------- CORS Proxy -----------------
cors_proxy.createServer({
  originWhitelist: [], // allow all origins
  requireHeader: ['origin', 'x-requested-with'],
  removeHeaders: ['cookie', 'cookie2', 'x-frame-options', 'content-security-policy'],
  redirectSameOrigin: true,
  handleInitialRequest: (req, res, location) => {
    // Normalize URLs to always have https
    if (location && !/^https?:\/\//i.test(location)) {
      location = 'https://' + location;
    }
    return location;
  }
}).listen(port, host, () => {
  console.log(`🚀 CORS Anywhere running at http://${host}:${port}`);
});

// --------------- Puppeteer Dynamic Loader -----------------
app.get("/dynamic", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing URL");

  try {
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36"
    );

    await page.goto(target, { waitUntil: "networkidle2" });

    // Optional: For Twitch or video sites, remove CSP/X-Frame restrictions
    await page.evaluate(() => {
      const metas = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      metas.forEach(m => m.remove());
      document.querySelectorAll("iframe").forEach(f => f.setAttribute("sandbox", ""));
    });

    const content = await page.content();
    await browser.close();
    res.set("Content-Type", "text/html");
    res.send(content);

  } catch (err) {
    console.error("Puppeteer error:", err);
    res.status(500).send("Failed to load dynamic content");
  }
});

// --------------- Express Root ---------------
// You can serve your frontend static files if desired
app.use(express.static("public"));

app.listen(port + 1, host, () => {
  console.log(`🚀 Dynamic loader running at http://${host}:${port + 1}`);
});
