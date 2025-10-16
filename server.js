const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],           // allow all origins
    requireHeader: [],             // no header requirement (iframe safe)
    removeHeaders: ['cookie', 'cookie2'],
    setHeaders: {
        'X-Frame-Options': '',     // strip frame-blocking
        'Content-Security-Policy': '' // strip CSP
    },
    redirectSameOrigin: true,      // follow same-origin redirects
    proxyReqOptDecorator: function(proxyReqOpts, srcReq) {
        // Ensure a modern UA for FB/IG/Reddit/etc
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' + 
          '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';
        return proxyReqOpts;
    },
    proxyResHeaderDecorator: function(headers, req, res) {
        // Strip frame-breaking headers
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['cross-origin-opener-policy'];
        delete headers['cross-origin-resource-policy'];
        delete headers['cross-origin-embedder-policy'];

        // Add info header for client to read redirect target
        if (req.url) {
            headers['X-Proxied-URL'] = req.url;
        }
        return headers;
    }
}).listen(port, host, () => {
    console.log(`🚀 Full iframe-compatible proxy running on http://${host}:${port}`);
});
