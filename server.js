// server.js
const cors_proxy = require("cors-anywhere");

const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;

cors_proxy.createServer({
  originWhitelist: [], // Allow all origins
  // Comment out the next line to not require headers
  // requireHeader: ["origin", "x-requested-with"],
  removeHeaders: ["cookie", "cookie2", "x-frame-options", "content-security-policy"],
}).listen(port, host, function () {
  console.log("🚀 CORS Anywhere proxy running at http://" + host + ":" + port);
});
