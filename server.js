import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { URL } from "url";

const app = express();
app.use(cors());
app.use(express.text({ limit: "50mb" }));

app.get("/proxy/*", async (req, res) => {
  try {
    let target = req.url.replace("/proxy/", "");

    if (!target.startsWith("http")) {
      target = "https://" + target;
    }

    const response = await fetch(target, {
      method: "GET",
      redirect: "manual", // ✅ Do NOT follow redirects automatically
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // ✅ Handle redirect manually
    if (response.status >= 300 && response.status < 400) {
      const redirectLocation = response.headers.get("location");

      if (!redirectLocation) {
        return res.status(500).send("Redirect but no Location header");
      }

      // ✅ If Fandom redirects → follow it through proxy
      const proxiedRedirect = redirectLocation.startsWith("http")
        ? `/proxy/${redirectLocation}`
        : `/proxy/${new URL(redirectLocation, target).href}`;

      res.setHeader("Location", proxiedRedirect);
      return res.status(response.status).send();
    }

    // ✅ Normal site response
    const content = await response.text();

    res.setHeader("Content-Type", response.headers.get("content-type") || "text/html");
    res.send(content);
  } catch (err) {
    res.status(500).send("Proxy Error: " + err.toString());
  }
});

app.listen(3000, () =>
  console.log("✅ CORS Proxy running at http://localhost:3000")
);
