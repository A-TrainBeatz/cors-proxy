const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],            // Allow all origins
    requireHeader: [],              // Do not require origin headers
    removeHeaders: ['cookie', 'cookie2','set-cookie','set-cookie2'], // Strip cookies
    setHeaders: {
        'X-Frame-Options': '',      // Allow iframes
        'Content-Security-Policy': '', // Remove CSP restrictions
        'Referrer-Policy': 'no-referrer'
    },
    redirectSameOrigin: true,       // Follow redirects even on same origin
    handleInitialRequest: (req, res, proxyReqOpts) => {
        return true; // allow all requests
    },
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 'Mozilla/5.0';
        return proxyReqOpts;
    },
    proxyResHeaderDecorator: (headers, userReq, userRes, proxyReq, proxyRes) => {
        // Pass final URL after redirects
        if (proxyRes.headers['x-request-url']) {
            headers['X-Final-URL'] = proxyRes.headers['x-request-url'];
        } else if (proxyRes.headers['location']) {
            const loc = proxyRes.headers['location'];
            headers['X-Final-URL'] = new URL(loc, `http://${userReq.headers.host}`).href;
        } else {
            headers['X-Final-URL'] = userReq.url.replace(/^\//,'');
        }

        // Remove headers that block iframes
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['set-cookie'];
        delete headers['set-cookie2'];

        return headers;
    },
}).listen(port, host, () => {
    console.log(`🚀 Advanced proxy running on http://${host}:${port}`);
});
