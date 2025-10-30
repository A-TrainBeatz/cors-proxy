const CACHE_NAME = 'warp-proxy-cache-v1';
const BACKEND = 'https://cors-proxy-s2pk.onrender.com/proxy?url='; // absolute URL

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.url.endsWith('sw.js')) return;

  e.respondWith(handleRequest(req));
});

async function handleRequest(req){
  try {
    const cached = await caches.match(req);
    if(cached) return cached;

    const profile = req.headers.get('x-carrier-profile') || 'iphone';
    const proxyUrl = BACKEND + encodeURIComponent(req.url) + '&profile=' + profile;

    const proxyRes = await fetch(proxyUrl, {
      method: req.method,
      headers: req.headers,
      body: req.method==='GET'?undefined:await req.clone().arrayBuffer(),
      redirect:'follow'
    });

    const resClone = proxyRes.clone();

    if(proxyRes.headers.get('content-type')?.includes('text/html')){
      let text = await proxyRes.text();
      text = text.replace(/<script[^>]*(adsbygoogle|googletagmanager|analytics|doubleclick)[^>]*>[\s\S]*?<\/script>/gi,'')
                 .replace(/<iframe[^>]*(ads|doubleclick)[^>]*>[\s\S]*?<\/iframe>/gi,'');
      const response = new Response(text,{
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: proxyRes.headers
      });
      const cache = await caches.open(CACHE_NAME);
      cache.put(req,response.clone());
      return response;
    }

    const cache = await caches.open(CACHE_NAME);
    cache.put(req,resClone.clone());
    return resClone;

  } catch(err){
    return new Response('<body style="font-family:sans-serif;color:#bbb;"><h3>Offline / Network Error</h3></body>',{
      headers:{'Content-Type':'text/html'}
    });
  }
}
