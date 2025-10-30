import express from "express";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import { WebSocketServer } from "ws";
import url from "url";

const app = express();

// Spoofed device identity (iPhone hotspot profile)
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

// Allow large body streaming
app.use(express.raw({ type: "*/*", limit: "500mb" }));

// Core reverse proxy handler
app.all("/proxy", async (req, res) => {
  try {
    const target = new URL(req.query.url);
    const requestHeaders = { ...req.headers };

    // Rewrite UA → iPhone hotspot device
    requestHeaders["user-agent"] = MOBILE_UA;

    // Remove hop-by-hop headers
    [
      "host","origin","referer","sec-fetch-site",
      "sec-fetch-mode","sec-fetch-dest","sec-fetch-user"
    ].forEach(h => delete requestHeaders[h]);

    // Forward request
    const proxyRes = await fetch(target, {
      method: req.method,
      headers: requestHeaders,
      body: req.method === "GET" ? undefined : req.body,
      redirect: "follow",
      agent: target.protocol === "https:" ? https : http
    });

    // Stream headers
    proxyRes.headers.forEach((v, k) => {
      // Let iframe behave as real network
      if (k === "content-security-policy") return; 
      if (k === "x-frame-options") return;
      res.setHeader(k, v);
    });

    res.writeHead(proxyRes.status);

    // Stream body
    proxyRes.body.pipe(res);

  } catch (err) {
    res.status(500).send("Proxy error: " + err);
  }
});

// WebSocket tunneling (Warp-style)
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const urlObj = new URL(req.url, "http://localhost");
  if (!urlObj.searchParams.get("url")) return socket.destroy();
  const targetUrl = urlObj.searchParams.get("url");
  const target = new URL(targetUrl);

  const wsProxy = new WebSocketServer({ server });
  wss.handleUpgrade(req, socket, head, ws => {
    const upstream = new WebSocket(target, {
      headers: { "user-agent": MOBILE_UA }
    });

    ws.on("message", msg => upstream.send(msg));
    upstream.on("message", msg => ws.send(msg));
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Warp-proxy online : " + PORT));
