// server.js

// Load environment variables
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

const cors_proxy = require('cors-anywhere');

// Create the CORS Anywhere server
cors_proxy.createServer({
  // Allow all origins
  originWhitelist: [],

  // Require at least one header, but we’ll configure frontend to add it automatically
  requireHeader: ['origin', 'x-requested-with'],

  // Strip cookies for security
  removeHeaders: ['cookie', 'cookie2'],

  // Handle redirects automatically
  redirectSameOrigin: true,

  // Add debug logging
  httpProxyOptions: {
    followRedirects: true
  }
}).listen(port, host, () => {
  console.log(`🚀 CORS Anywhere proxy running at http://${host}:${port}`);
});
