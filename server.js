const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],        // allow all origins
    requireHeader: [],          // disable origin/x-requested-with requirement
    removeHeaders: ['cookie', 'cookie2'],  // strip cookies
    setHeaders: {
        'X-Frame-Options': '',           // remove frame blocking
        'Content-Security-Policy': ''    // remove CSP frame restrictions
    },
    redirectSameOrigin: true,   // follow redirects even if same origin
    proxyReqBodyDecorator: function(bodyContent, srcReq) {
        // Keep the body intact for POST requests
        return bodyContent;
    },
    proxyReqOptDecorator: function(proxyReqOpts, srcReq) {
        // Add user-agent so some sites allow connection
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 'Mozilla/5.0';
        return proxyReqOpts;
    }
}).listen(port, host, () => {
    console.log(`🚀 Full iframe-compatible CORS proxy running on http://${host}:${port}`);
});
