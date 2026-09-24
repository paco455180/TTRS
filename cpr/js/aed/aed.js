/**
 * aed.js — 附近 AED 地圖（Leaflet + OpenStreetMap）
 *
 * 資料格式 data/aed.json（由 tools/fetch_aed.py 從衛福部開放資料轉出）：
 * {
 *   "updated": "2026-09-23",
 *   "source": "https://tw-aed.mohw.gov.tw/openData?t=csv",
 *   "sample": false,
 *   "items": [[lat, lng, "場所名稱", "地址", "放置地點", "開放時間"], ...]
 * }
 */

let data = null;
let map = null;
let userMarker = null;
let markerLayer = null;

export async function loadAED() {
  if (data) return data;
  for (const url of ['data/aed.json', 'data/aed.sample.json']) {
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) continue;
      data = await res.json();
      data.items = data.items || [];
      return data;
    } catch (e) {
      /* try next */
    }
  }
  data = { items: [], sample: true, updated: null };
  return data;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearest(items, lat, lng, k = 20, maxKm = 5) {
  const out = [];
  for (const it of items) {
    const d = haversineKm(lat, lng, it[0], it[1]);
    if (d <= maxKm) out.push({ lat: it[0], lng: it[1], name: it[2], addr: it[3], place: it[4], hours: it[5], km: d });
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, k);
}

export function fmtKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} 公尺` : `${km.toFixed(1)} 公里`;
}

export function navUrl(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
}

export function getPosition(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('此裝置不支援定位'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: opts.timeout || 12000, maximumAge: 30000 }
    );
  });
}

/** 建立或重用地圖 */
export function ensureMap(el) {
  if (!window.L) return null;
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    return map;
  }
  map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.setView([23.7, 121], 7); // 台灣全島
  markerLayer = L.layerGroup().addTo(map);
  return map;
}

export function renderMap(user, list) {
  if (!map) return;
  markerLayer.clearLayers();
  if (user) {
    if (userMarker) userMarker.remove();
    userMarker = L.circleMarker([user.lat, user.lng], { radius: 9, color: '#1565c0', fillColor: '#1565c0', fillOpacity: 0.9 })
      .addTo(map)
      .bindPopup('你在這裡');
  }
  const bounds = [];
  if (user) bounds.push([user.lat, user.lng]);
  for (const a of list) {
    const m = L.circleMarker([a.lat, a.lng], { radius: 8, color: '#c62828', fillColor: '#ef5350', fillOpacity: 0.95 });
    m.bindPopup(
      `<b>${escapeHtml(a.name)}</b><br>${escapeHtml(a.place || '')}<br>${escapeHtml(a.addr || '')}<br>` +
        `<a href="${navUrl(a.lat, a.lng)}" target="_blank" rel="noopener">導航 ${fmtKm(a.km)}</a>`
    );
    markerLayer.addLayer(m);
    bounds.push([a.lat, a.lng]);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
  else if (bounds.length === 1) map.setView(bounds[0], 16);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
