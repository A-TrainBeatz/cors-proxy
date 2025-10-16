const cors_proxy = require('cors-anywhere');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [],           // allow all origins
    requireHeader: [],             // disable missing headers
    removeHeaders: ['cookie','cookie2'],
    setHeaders: {
        'X-Frame-Options': '',
        'Content-Security-Policy': ''
    },
    redirectSameOrigin: true,      // follow redirects
    handleInitialRequest: function(req, res, location) {
        console.log(`Requesting: ${req.url}`);
        return true; // allow all requests
    },
    // Optional: rewrite HTML to proxy-relative URLs for resources
    decorateHtmlResponse: function(req, res, html) {
        if(!html) return html;
        // Rewrite <a href> and <link/src> URLs to go through proxy
        return html
            .replace(/href="(http[s]?:\/\/[^"]+)"/g, `href="${req.protocol}//${req.headers.host}/$1"`)
            .replace(/src="(http[s]?:\/\/[^"]+)"/g, `src="${req.protocol}//${req.headers.host}/$1"`);
    }
}).listen(port, host, () => {
    console.log(`🚀 Full-featured CORS proxy running on http://${host}:${port}`);
});
