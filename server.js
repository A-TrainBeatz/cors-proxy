// Listen on a specific host via the HOST environment variable
var host = process.env.HOST || '0.0.0.0';
// Listen on a specific port via the PORT environment variable
var port = process.env.PORT || 8080;

var cors_proxy = require('cors-anywhere');

cors_proxy.createServer({
    originWhitelist: [], // Allow all origins
    requireHeader: ['origin', 'x-requested-with'], // official demo headers
    removeHeaders: ['cookie', 'cookie2'],           // strip cookies
    setHeaders: {                                   // strip frame-breaking headers
        'X-Frame-Options': '',
        'Content-Security-Policy': ''
    }
}).listen(port, host, function() {
    console.log('Running CORS Anywhere on ' + host + ':' + port);
});
