import express from "express";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import { WebSocketServer } from "ws";
import { createProxyServer } from "http-proxy";

const app = express();
const PORT = process.env.PORT || 8080;

// Device spoofing profiles
const PROFILES = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
};

// Allow large body streaming
app.use(express.raw({ type: "*/*", limit: "1gb" }));

/* =================== HTTP/S PROXY =================== */
app.all("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing ?url= parameter");

    const target = new URL(targetUrl);
    const profile = req.query.profile || "iphone";

    // Agent for HTTPS / HTTP
    const agent = target.protocol === "https:" ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();

    // Build headers
    const headers = { ...req.headers, "user-agent": PROFILES[profile] };
    delete headers["host"];
    delete headers["origin"];
    delete headers["referer"];

    const proxyRes = await fetch(target.href, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "follow",
      agent
    });

    // Forward headers (omit CSP/X-Frame-Options)
    proxyRes.headers.forEach((v, k) => {
      if (["content-security-policy","x-frame-options"].includes(k.toLowerCase())) return;
      res.setHeader(k, v);
    });

    res.writeHead(proxyRes.status);

    if (proxyRes.body) {
      proxyRes.body.pipe(res);
      proxyRes.body.on("error", e => { console.error("Stream error", e); res.end(); });
    } else res.end();

  } catch (err) {
    console.error("HTTP Proxy error:", err);
    res.status(500).send("Proxy failed: " + err.message);
  }
});

/* =================== WEBSOCKET PROXY =================== */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = urlObj.searchParams.get("url");
  const profile = urlObj.searchParams.get("profile") || "iphone";

  if (!targetUrl) return socket.destroy();

  const proxy = createProxyServer({ target: targetUrl, ws: true, changeOrigin: true });
  proxy.on("error", e => console.error("WS Proxy Error:", e));

  proxy.ws(req, socket, head, {
    headers: { "user-agent": PROFILES[profile] }
  });
});

/* =================== START SERVER =================== */
server.listen(PORT, () => console.log(`Warp Proxy running on port ${PORT}`));
