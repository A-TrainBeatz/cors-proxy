const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],        // allow all origins
     // disables origin/x-requested-with requirement
    removeHeaders: ['cookie', 'cookie2'],  // strip cookies
    setHeaders: {               // strip frame-blocking headers
        'X-Frame-Options': '',
        'Content-Security-Policy': ''
    }
}).listen(port, host, () => {
    console.log(`🚀 Render CORS proxy running on http://${host}:${port}`);
});
