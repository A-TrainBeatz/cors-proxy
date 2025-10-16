const cors_proxy = require("cors-anywhere");

const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;

cors_proxy.createServer({
  originWhitelist: [],        // allow all origins
  requireHeader: [],          // disable header check
  removeHeaders: ["cookie", "cookie2"], // strip cookies
  setHeaders: {               // strip frame-breaking headers
    "X-Frame-Options": "",
    "Content-Security-Policy": ""
  }
}).listen(port, host, () => {
  console.log(`🚀 Proxy running at http://${host}:${port}`);
});
