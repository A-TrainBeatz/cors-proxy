const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],          // allow all origins
    requireHeader: [],            // no header requirement
    removeHeaders: ['cookie', 'cookie2'],
    setHeaders: {
        'X-Frame-Options': '',          // unblock iframes
        'Content-Security-Policy': ''   // remove CSP frame restrictions
    },
    redirectSameOrigin: true,
    handleInitialRequest: function(req, res, location) {
        // Normalize URLs to always include protocol
        if (location && !/^https?:\/\//i.test(location)) {
            location = 'https://' + location;
        }
        // Pass along so cors-anywhere can continue
        return location;
    },
    proxyReqOptDecorator: function(proxyReqOpts, srcReq) {
        // Add UA so sites don’t reject us
        proxyReqOpts.headers['User-Agent'] = srcReq.headers['user-agent'] || 
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36';
        return proxyReqOpts;
    },
    proxyResHeaderDecorator: function(headers, req, res) {
        // Expose final resolved URL to client
        if (req.url) {
            headers['X-Final-URL'] = req.url;
        }
        return headers;
    }
}).listen(port, host, () => {
    console.log(`🚀 CORS Proxy running on http://${host}:${port}`);
});
