const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],          // allow all origins
    requireHeader: [],            // disable origin/x-requested-with requirement
    removeHeaders: ['cookie','cookie2'], // strip cookies
    setHeaders: {                 // allow iframes
        'X-Frame-Options': '',
        'Content-Security-Policy': ''
    },
    redirectSameOrigin: true,     // follow redirects
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 'Mozilla/5.0';
        return proxyReqOpts;
    },
    proxyReqBodyDecorator: (bodyContent, srcReq) => bodyContent
}).listen(port, host, () => {
    console.log(`🚀 Full iframe-compatible CORS proxy running at http://${host}:${port}`);
});
