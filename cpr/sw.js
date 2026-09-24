/* sw.js — 離線快取與更新（急救現場網路可能很差，app 殼層必須離線可用） */
const VERSION = 'cpr-v0.2.0';
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
// 第三方（Leaflet、字型）與 AED 資料：有網路時更新、離線時用快取
const CACHE_ON_USE = [/unpkg\.com\/leaflet/, /fonts\.(googleapis|gstatic)\.com/, /\/data\/aed\.json$/, /\/model\//];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 頁面按「更新」時送來的訊息
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (/tile\.openstreetmap\.org/.test(url)) return; // 地圖圖磚：純網路

  if (CACHE_ON_USE.some((re) => re.test(url))) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 殼層：cache-first，背景更新；找不到快取時走網路
  if (new URL(url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
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
