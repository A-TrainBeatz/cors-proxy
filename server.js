// server.js

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;

const cors_proxy = require('cors-anywhere');

// Create proxy server
cors_proxy.createServer({
  // Allow all origins
  originWhitelist: [],

  // Require headers to stop abuse, but frontend adds these automatically
  requireHeader: ['origin', 'x-requested-with'],

  // Strip cookies for security
  removeHeaders: ['cookie', 'cookie2'],

  // Make sure redirects work properly
  httpProxyOptions: {
    followRedirects: true,
    maxRedirects: 10,
    changeOrigin: true
  },

  // Extra proxy options for video/audio support
  httpsOptions: {
    rejectUnauthorized: false, // allow self-signed SSL if encountered
  },

  // Rewrites for proper formatting
  // Fixes relative paths in scripts, CSS, and images
  handleInitialRequest: (req, res, location) => {
    console.log("Proxying request to:", location);

    // Twitch, YouTube, Reddit, etc. use video chunk requests
    // Ensure range headers are preserved for video streaming
    if (req.headers['range']) {
      res.setHeader('accept-ranges', 'bytes');
    }

    // Allow CORS for any embedded resource
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

    return true;
  }
}).listen(port, host, () => {
  console.log(`🚀 Enhanced CORS Anywhere proxy running at http://${host}:${port}`);
});
