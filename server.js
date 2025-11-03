const cors_proxy = require('cors-anywhere');
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],
    requireHeader: [],
    removeHeaders: [
        'cookie', 'cookie2', 
        'x-frame-options', 
        'content-security-policy'
    ],
    setHeaders: {
        'X-Frame-Options': '', 
        'Content-Security-Policy': ''
    },
    redirectSameOrigin: true,
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 'Mozilla/5.0';
        return proxyReqOpts;
    },
    proxyResHeaderDecorator: (headers, userReq, userRes, proxyReq, proxyRes) => {
        headers['X-Final-URL'] = proxyRes.headers['x-request-url'] || userReq.url.replace(/^\//,'');
        return headers;
    }
}).listen(port, host, () => {
    console.log(`🚀 Advanced proxy running on http://${host}:${port}`);
});
