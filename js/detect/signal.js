/**
 * signal.js — 純函式的訊號處理工具（無 DOM 依賴，可在 Node 測試）
 *
 * 所有函式都接受一般陣列或 TypedArray。
 */

export function mean(a) {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
  return Math.sqrt(s / (a.length - 1));
}

export function median(a) {
  if (!a.length) return 0;
  const b = Array.from(a).sort((x, y) => x - y);
  const mid = b.length >> 1;
  return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}

/** Median absolute deviation，乘上 1.4826 後可視為穩健的標準差估計 */
export function mad(a) {
  if (!a.length) return 0;
  const m = median(a);
  const dev = Array.from(a, (v) => Math.abs(v - m));
  return median(dev) * 1.4826;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 置中移動平均（邊界縮短視窗） */
export function movingAverage(x, n) {
  const out = new Float64Array(x.length);
  const half = Math.floor(n / 2);
  let sum = 0;
  let count = 0;
  // 初始視窗
  for (let i = 0; i <= Math.min(half, x.length - 1); i++) {
    sum += x[i];
    count++;
  }
  for (let i = 0; i < x.length; i++) {
    out[i] = sum / count;
    const addIdx = i + half + 1;
    const remIdx = i - half;
    if (addIdx < x.length) {
      sum += x[addIdx];
      count++;
    }
    if (remIdx >= 0) {
      sum -= x[remIdx];
      count--;
    }
  }
  return out;
}

/** 置中移動中位數（對稀疏脈衝更穩健的基線估計） */
export function movingMedian(x, n) {
  const out = new Float64Array(x.length);
  const half = Math.floor(n / 2);
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length, i + half + 1);
    out[i] = median(Array.prototype.slice.call(x, a, b));
  }
  return out;
}

/** 去趨勢：減掉 n 點移動中位數（脈衝式訊號不會產生副瓣） */
export function detrendMedian(x, n) {
  const base = movingMedian(x, n);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - base[i];
  return out;
}

/** 去趨勢：減掉 n 點移動平均（等效於簡單高通） */
export function detrend(x, n) {
  const base = movingAverage(x, n);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - base[i];
  return out;
}

/**
 * 將不等間隔取樣的 (t, x) 線性內插為固定取樣率 fs 的序列。
 * 回傳 { t0, fs, y }。
 */
export function resample(t, x, fs) {
  if (t.length < 2) return { t0: t[0] || 0, fs, y: new Float64Array(0) };
  const t0 = t[0];
  const t1 = t[t.length - 1];
  const n = Math.max(1, Math.floor((t1 - t0) * fs) + 1);
  const y = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = t0 + i / fs;
    while (j < t.length - 2 && t[j + 1] < ti) j++;
    const ta = t[j];
    const tb = t[j + 1];
    const w = tb > ta ? clamp((ti - ta) / (tb - ta), 0, 1) : 0;
    y[i] = x[j] * (1 - w) + x[j + 1] * w;
  }
  return { t0, fs, y };
}

/**
 * 峰值的「突出度」(prominence)：峰高減去左右兩側到更高點前的最低點中較高者。
 */
export function prominence(x, i) {
  const h = x[i];
  let leftMin = h;
  for (let k = i - 1; k >= 0; k--) {
    if (x[k] > h) break;
    if (x[k] < leftMin) leftMin = x[k];
  }
  let rightMin = h;
  for (let k = i + 1; k < x.length; k++) {
    if (x[k] > h) break;
    if (x[k] < rightMin) rightMin = x[k];
  }
  return h - Math.max(leftMin, rightMin);
}

/**
 * 找峰值。
 * @param x 序列
 * @param opts.minDistance 相鄰峰值最小距離（樣本數）
 * @param opts.minProminence 最小突出度
 * @returns 峰值索引陣列（遞增）
 */
export function findPeaks(x, { minDistance = 1, minProminence = 0 } = {}) {
  const cand = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > x[i - 1] && x[i] >= x[i + 1]) {
      const p = prominence(x, i);
      if (p >= minProminence) cand.push({ i, p, h: x[i] });
    }
  }
  // 以突出度排序，貪婪選擇並排除距離過近者
  cand.sort((a, b) => b.p - a.p);
  const chosen = [];
  for (const c of cand) {
    if (chosen.every((k) => Math.abs(k.i - c.i) >= minDistance)) chosen.push(c);
  }
  chosen.sort((a, b) => a.i - b.i);
  return chosen;
}

/** 正規化自相關（lag 0..maxLag） */
export function autocorrelation(x, maxLag) {
  const n = x.length;
  const m = mean(x);
  let denom = 0;
  for (let i = 0; i < n; i++) denom += (x[i] - m) * (x[i] - m);
  const out = new Float64Array(maxLag + 1);
  if (denom === 0) return out;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (x[i] - m) * (x[i + lag] - m);
    out[lag] = s / denom;
  }
  return out;
}

/**
 * 以 SSD（差平方和）估計兩個 1D 剖面之間的位移（含次像素拋物線內插）。
 * 剖面會先做零均值、單位變異數正規化，並可選擇使用一階差分以抵抗亮度變化。
 * @returns 位移量（正值表示 cur 相對 prev 往索引增加方向移動）
 */
export function profileShift(prev, cur, maxShift, { useGradient = true } = {}) {
  const a = normalizeProfile(prev, useGradient);
  const b = normalizeProfile(cur, useGradient);
  const n = a.length;
  if (n < maxShift * 3 + 3) return 0;
  const costs = new Float64Array(2 * maxShift + 1);
  for (let s = -maxShift; s <= maxShift; s++) {
    let ssd = 0;
    let cnt = 0;
    const start = Math.max(0, -s);
    const end = Math.min(n, n - s);
    for (let i = start; i < end; i++) {
      const d = b[i] - a[i + s];
      ssd += d * d;
      cnt++;
    }
    costs[s + maxShift] = cnt ? ssd / cnt : Infinity;
  }
  let best = 0;
  for (let k = 1; k < costs.length; k++) if (costs[k] < costs[best]) best = k;
  let shift = best - maxShift;

  // 次像素精修：在整數最佳位移 ±1 px 範圍內，以 1/8 px 為步進、用 Catmull-Rom 三次內插
  // 重新取樣 a 並比較 SSD，最後在最佳步進附近做拋物線內插。
  // 比直接對整數 SSD 做拋物線內插更不容易有「整數像素鎖定」偏差。
  const STEP = 1 / 8;
  const fine = [];
  for (let k = -8; k <= 8; k++) {
    const s = shift + k * STEP;
    let ssd = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const pos = i + s;
      const j = Math.floor(pos);
      if (j < 1 || j + 2 >= n) continue;
      const f = pos - j;
      ssd += (b[i] - cubic(a[j - 1], a[j], a[j + 1], a[j + 2], f)) ** 2;
      cnt++;
    }
    fine.push(cnt ? ssd / cnt : Infinity);
  }
  let fb = 0;
  for (let k = 1; k < fine.length; k++) if (fine[k] < fine[fb]) fb = k;
  let delta = (fb - 8) * STEP;
  if (fb > 0 && fb < fine.length - 1) {
    const c0 = fine[fb - 1];
    const c1 = fine[fb];
    const c2 = fine[fb + 1];
    const denom = c0 - 2 * c1 + c2;
    if (denom > 1e-12) {
      const d = (0.5 * (c0 - c2)) / denom;
      if (Math.abs(d) <= 1) delta += d * STEP;
    }
  }
  shift += delta;

  // cur 的內容 b[i] 對應 a[i+s]：表示影像往「索引減少」方向移動了 s；轉成直觀的位移方向
  return -shift;
}

/** Catmull-Rom 三次內插 */
function cubic(p0, p1, p2, p3, t) {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

function normalizeProfile(p, useGradient) {
  let src = p;
  if (useGradient) {
    const g = new Float64Array(p.length - 1);
    for (let i = 0; i < g.length; i++) g[i] = p[i + 1] - p[i];
    src = g;
  }
  const m = mean(src);
  const s = std(src) || 1;
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = (src[i] - m) / s;
  return out;
}

/** 變異係數 */
export function cv(a) {
  const m = mean(a);
  return m === 0 ? 0 : std(a) / Math.abs(m);
}
