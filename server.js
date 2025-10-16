const cors_proxy = require('cors-anywhere');
const http = require('http');
const https = require('https');
const { parse } = require('url');

// Enhanced server wrapper
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

const server = cors_proxy.createServer({
    originWhitelist: [],       // allow all origins
    requireHeader: [],         // allow requests without headers
    removeHeaders: [
        'cookie', 'cookie2',
        'x-frame-options',
        'content-security-policy',
        'cross-origin-embedder-policy',
        'cross-origin-opener-policy',
        'cross-origin-resource-policy'
    ],
    setHeaders: {
        'X-Frame-Options': '',
        'Content-Security-Policy': '',
        'Cross-Origin-Opener-Policy': '',
        'Cross-Origin-Embedder-Policy': '',
        'Cross-Origin-Resource-Policy': ''
    },
    redirectSameOrigin: true
});

// Wrap response to rewrite HTML resources
const handler = (req, res) => {
    const url = req.url.slice(1); // remove leading slash
    if (!/^https?:\/\//i.test(url)) {
        res.writeHead(400);
        return res.end("Invalid target URL");
    }

    // Use proxy normally
    const proxyReq = (url.startsWith("https") ? https : http).get(url, proxyRes => {
        let body = [];
        proxyRes.on('data', chunk => body.push(chunk));
        proxyRes.on('end', () => {
            body = Buffer.concat(body).toString();

            // If HTML, rewrite resource URLs
            if ((proxyRes.headers['content-type'] || '').includes('text/html')) {
                const base = `<base href="${url}">`;
                if (body.includes("<head>")) {
                    body = body.replace("<head>", `<head>${base}`);
                } else {
                    body = base + body;
                }

                // Rewrite relative URLs to pass back through proxy
                body = body.replace(/(src|href)=["'](\/[^"']+)["']/g,
                    (m, attr, path) => `${attr}="${req.headers.host}/${url}${path}"`);
            }

            // Clean headers
            const headers = { ...proxyRes.headers };
            delete headers['x-frame-options'];
            delete headers['content-security-policy'];

            res.writeHead(proxyRes.statusCode, headers);
            res.end(body);
        });
    });

    proxyReq.on('error', err => {
        res.writeHead(500);
        res.end("Proxy error: " + err.message);
    });
};

http.createServer(handler).listen(port, host, () => {
    console.log(`🚀 Enhanced proxy running at http://${host}:${port}`);
});
