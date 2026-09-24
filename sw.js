/* sw.js — 離線快取（急救現場網路可能很差，app 殼層必須離線可用） */
const VERSION = 'cpr-v0.1.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/detect/signal.js',
  './js/detect/motion.js',
  './js/detect/audio.js',
  './js/detect/fusion.js',
  './js/detect/model.js',
  './js/cpr/metronome.js',
  './js/cpr/voice.js',
  './js/aed/aed.js',
  './data/aed.sample.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];
// 第三方（Leaflet）與 AED 資料：有網路時更新、離線時用快取
const CACHE_ON_USE = [/unpkg\.com\/leaflet/, /\/data\/aed\.json$/, /\/model\//];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  // 地圖圖磚：純網路（避免快取暴增）
  if (/tile\.openstreetmap\.org/.test(url)) return;

  if (CACHE_ON_USE.some((re) => re.test(url))) {
    // network-first，失敗退回快取
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 殼層：cache-first，背景更新
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && new URL(url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
