import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { URL } from "url";
import path from "path";

const app = express();
app.use(cors());
app.use(express.text({ limit: "50mb" }));

// ✅ Serve index.html from same server
app.use(express.static(path.resolve("./public")));

app.get("/proxy/*", async (req, res) => {
  try {
    let target = req.url.replace("/proxy/", "");

    if (!target.startsWith("http")) {
      target = "https://" + target;
    }

    const response = await fetch(target, {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0"
      }
    });

    // ✅ redirect handling
    if (response.status >= 300 && response.status < 400) {
      const redirectURL = response.headers.get("location");
      const proxied = redirectURL.startsWith("http")
        ? `/proxy/${redirectURL}`
        : `/proxy/${new URL(redirectURL, target).href}`;

      res.set("Location", proxied);
      return res.status(response.status).send();
    }

    const body = await response.text();
    res.set("Content-Type", response.headers.get("content-type") || "text/html");
    res.send(body);
    
  } catch (err) {
    res.status(500).send("Proxy error: " + err.toString());
  }
});

app.listen(3000, () => console.log("✅ Proxy + Web server on :3000"));
