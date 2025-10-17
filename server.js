// server.js
const cors_proxy = require("cors-anywhere");

const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;

cors_proxy.createServer({
  originWhitelist: [],           // allow all origins
  requireHeader: [],             // remove requirement for origin/x-requested-with
  removeHeaders: ["cookie", "cookie2", "x-frame-options", "content-security-policy"],
  redirectSameOrigin: true,      // follow redirects automatically
  handleInitialRequest: function(req, res, location) {
    // prepend https if missing
    if (location && !/^https?:\/\//i.test(location)) {
      location = "https://" + location;
    }
    return location;
  },
  proxyReqOptDecorator: function(proxyReqOpts, srcReq) {
    proxyReqOpts.headers["User-Agent"] =
      srcReq.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36";
    return proxyReqOpts;
  },
  proxyResHeaderDecorator: function(headers, req, res) {
    // Expose final URL after redirects
    if (req.url) headers["X-Final-URL"] = req.url;
    return headers;
  }
}).listen(port, host, function() {
  console.log(`🚀 Fully permissive CORS Anywhere running at http://${host}:${port}`);
});
