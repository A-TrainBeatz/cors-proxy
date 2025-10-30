import express from "express";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import { createProxyServer } from "http-proxy";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

app.get("/sw.js", (req,res)=>res.sendFile(path.resolve("./sw.js")));

const PROFILES = {
  iphone:"Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  android:"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Mobile Safari/537.36",
  desktop:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
};

app.use(express.raw({ type:"*/*", limit:"1gb" }));

/* ===== Helper to rewrite links/forms ===== */
function rewriteLinks(html, baseUrl, profile) {
  html = html.replace(/<a\s+([^>]*?)href=["'](.*?)["']/gi, (m, attrs, href)=>{
    if(href.startsWith('#') || href.startsWith('javascript:')) return m;
    try{
      const full = new URL(href, baseUrl).href;
      return `<a ${attrs} href="/proxy?url=${encodeURIComponent(full)}&profile=${profile}"`;
    } catch(e){ return m; }
  });

  html = html.replace(/<form\s+([^>]*?)action=["'](.*?)["']/gi, (m, attrs, action)=>{
    if(action.startsWith('javascript:')) return m;
    try{
      const full = new URL(action, baseUrl).href;
      return `<form ${attrs} action="/proxy?url=${encodeURIComponent(full)}&profile=${profile}"`;
    } catch(e){ return m; }
  });

  return html;
}

/* ===== HTTP/S Proxy ===== */
app.all("/proxy", async (req,res)=>{
  try{
    const targetUrl = req.query.url;
    if(!targetUrl || !/^https?:\/\//i.test(targetUrl))
      return res.status(400).send("Invalid or missing ?url= parameter.");

    const profile = req.query.profile || 'iphone';
    const target = new URL(targetUrl);
    const agent = target.protocol==='https:'? new https.Agent({rejectUnauthorized:false}): new http.Agent();
    const headers = {...req.headers, "user-agent": PROFILES[profile]};
    delete headers.host; delete headers.origin; delete headers.referer;

    const proxyRes = await fetch(target.href,{
      method:req.method,
      headers,
      body:req.method==='GET'||req.method==='HEAD'?undefined:req.body,
      redirect:'follow',
      agent
    });

    const contentType = proxyRes.headers.get("content-type") || "";
    let body = await proxyRes.text();

    if(contentType.includes("text/html")){
      body = rewriteLinks(body, target.href, profile);
      res.setHeader("content-type","text/html");
      return res.send(body);
    }

    proxyRes.headers.forEach((v,k)=>{
      if(["content-security-policy","x-frame-options"].includes(k.toLowerCase())) return;
      res.setHeader(k,v);
    });
    res.status(proxyRes.status);
    if(proxyRes.body){ proxyRes.body.pipe(res); proxyRes.body.on('error',()=>res.end()); }
    else res.end();

  } catch(err){ 
    res.status(500).send("Proxy failed: "+err.message); 
  }
});

/* ===== WebSocket Proxy ===== */
const server = http.createServer(app);
const wss = new createProxyServer({ ws:true });

server.on("upgrade",(req,socket,head)=>{
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = urlObj.searchParams.get("url");
  if(!targetUrl || !/^https?:\/\//i.test(targetUrl)) return socket.destroy();
  const profile = urlObj.searchParams.get('profile') || 'iphone';

  wss.ws(req,socket,head,{
    target: targetUrl,
    changeOrigin: true,
    headers: { "user-agent": PROFILES[profile] }
  });
});

server.listen(PORT,()=>console.log(`Warp Proxy running on port ${PORT}`));
