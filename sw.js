// Notion Quick の Service Worker
// 圏外（地下など）でもアプリ自体を開けるように、画面とライブラリを端末にとっておく。
// Notion や OpenAI への通信はここでは扱わない（そのまま通す）。
const CACHE = "notion-quick-v2";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === "cdn.jsdelivr.net";
  if (!sameOrigin && !isLib) return;            // Supabase・OpenAI などはそのまま
  if (url.searchParams.has("check")) return;    // 新しい版の確認はそのまま

  // 画面（index.html）は「まずネット、だめなら端末の分」。新しい版があればすぐ反映される
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);   // 電波が弱いときは4秒で諦めて端末の分を使う
        const res = await fetch(req, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) cache.put("./index.html", res.clone());
        return res;
      } catch {
        return (await cache.match("./index.html", { ignoreSearch: true })) || (await cache.match("./", { ignoreSearch: true }))
          || (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // アイコン・ライブラリなどは「端末の分をすぐ使い、裏で新しくしておく」
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
