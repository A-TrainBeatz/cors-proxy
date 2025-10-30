import express from 'express';
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 8080;

// Spoof mobile device
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

app.all('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing ?url= parameter");

    const target = new URL(targetUrl);

    // Setup agent for https or http
    const agent = target.protocol === 'https:' ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();

    // Build headers
    const headers = { ...req.headers };
    headers['user-agent'] = MOBILE_UA;
    delete headers['host'];
    delete headers['origin'];
    delete headers['referer'];

    // Fetch from target
    const proxyRes = await fetch(target.href, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'follow',
      agent,
    });

    // Forward headers
    proxyRes.headers.forEach((value, key) => {
      if (['content-security-policy','x-frame-options'].includes(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    // Forward status
    res.writeHead(proxyRes.status);

    // Stream body
    if (proxyRes.body) {
      proxyRes.body.pipe(res);
      proxyRes.body.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      res.end();
    }

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send('Proxy failed: ' + err.message);
  }
});

app.listen(PORT, () => console.log('Warp Proxy running on port', PORT));
