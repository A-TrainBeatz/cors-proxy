import express from "express";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

// Serve Service Worker
app.get("/sw.js", (req,res)=>res.sendFile(path.resolve("./sw.js")));

// Device profiles
const PROFILES = {
  iphone:"Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  android:"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Mobile Safari/537.36",
  desktop:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
};

// Large body support
app.use(express.raw({ type:"*/*", limit:"1gb" }));

/* ====== HTTP PROXY WITH RESOURCE REWRITE ====== */
app.all("/proxy", async (req,res)=>{
  try {
    const targetUrl = req.query.url;
    if(!targetUrl || !/^https?:\/\//i.test(targetUrl)) return res.status(400).send("Invalid or missing ?url= parameter");

    const profile = req.query.profile || 'iphone';
    const target = new URL(targetUrl);
    const agent = target.protocol==='https:' ? new https.Agent({rejectUnauthorized:false}) : new http.Agent();

    const headers = {...req.headers, "user-agent": PROFILES[profile]};
    delete headers.host;
    delete headers.origin;
    delete headers.referer;

    const proxyRes = await fetch(target.href, {
      method: req.method,
      headers,
      body: req.method==='GET'||req.method==='HEAD'?undefined:req.body,
      redirect: 'follow',
      agent
    });

    const contentType = proxyRes.headers.get('content-type') || '';

    let body;
    if(contentType.includes('text/html')){
      body = await proxyRes.text();

      // Rewrite all relative links, forms, iframes, scripts to go through proxy
      body = body.replace(/<a\s+([^>]*?)href=["'](.*?)["']/gi, (m, attrs, href)=>{
        if(href.startsWith('http')) return `<a ${attrs} href="/proxy?url=${encodeURIComponent(href)}&profile=${profile}"`;
        return `<a ${attrs} href="/proxy?url=${encodeURIComponent(new URL(href, target.href).href)}&profile=${profile}"`;
      });

      body = body.replace(/<form\s+([^>]*?)action=["'](.*?)["']/gi, (m, attrs, action)=>{
        if(action.startsWith('http')) return `<form ${attrs} action="/proxy?url=${encodeURIComponent(action)}&profile=${profile}"`;
        return `<form ${attrs} action="/proxy?url=${encodeURIComponent(new URL(action, target.href).href)}&profile=${profile}"`;
      });

      body = body.replace(/<(iframe|script|link|img)\s+([^>]*(src|href)=["'](.*?)["'][^>]*)/gi, (m, tag, attrs, attrName, url)=>{
        if(url.startsWith('http')) return `<${tag} ${attrs.replace(url, `/proxy?url=${encodeURIComponent(url)}&profile=${profile}`)}`;
        return `<${tag} ${attrs.replace(url, `/proxy?url=${encodeURIComponent(new URL(url, target.href).href)}&profile=${profile}`)}`;
      });
    } else {
      body = proxyRes.body;
    }

    proxyRes.headers.forEach((v,k)=>{
      if(["content-security-policy","x-frame-options"].includes(k.toLowerCase())) return;
      res.setHeader(k,v);
    });

    res.status(proxyRes.status);
    if(typeof body === 'string') res.send(body);
    else if(body) body.pipe(res);
    else res.end();

  } catch(err){
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed: "+err.message);
  }
});

app.listen(PORT,()=>console.log(`Warp Proxy running on port ${PORT}`));
