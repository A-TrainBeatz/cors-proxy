const cors_proxy = require('cors-anywhere');
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],        // Allow all origins
    requireHeader: [],          // Disable origin/x-requested-with requirement
    removeHeaders: ['cookie', 'cookie2'],  // Strip cookies
    setHeaders: {
        'X-Frame-Options': '',          // Allow iframes
        'Content-Security-Policy': ''   // Remove CSP frame restrictions
    },
    redirectSameOrigin: true,   // Follow redirects even on same origin
    handleInitialRequest: (req, res, proxyReqOpts) => {
        // No extra handling needed for initial request
    },
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        // Add user-agent header for sites that reject missing UA
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 'Mozilla/5.0';
        return proxyReqOpts;
    },
    proxyResHeaderDecorator: (headers, userReq, userRes, proxyReq, proxyRes) => {
        // Pass final URL after redirects to frontend
        if (proxyRes.headers['x-request-url']) {
            headers['X-Final-URL'] = proxyRes.headers['x-request-url'];
        } else if (proxyRes.headers['location']) {
            // If redirect location exists, combine with initial request
            const loc = proxyRes.headers['location'];
            headers['X-Final-URL'] = new URL(loc, `http://${userReq.headers.host}`).href;
        } else {
            headers['X-Final-URL'] = userReq.url.replace(/^\//,''); // fallback
        }
        return headers;
    },
}).listen(port, host, () => {
    console.log(`🚀 Advanced proxy running on http://${host}:${port}`);
});
