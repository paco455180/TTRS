/**
 * motion.js — 以手機鏡頭影像估計胸腹起伏（呼吸動作）
 *
 * 核心想法：
 *  1. 把畫面縮小成灰階（預設 320×240），在使用者對準的 ROI（胸口／上腹）內，
 *     計算每一列的平均亮度 → 得到一條「列剖面」(row profile)。
 *  2. 目前影像與「參考幀」(keyframe，每 2.5 秒或位移過大時更新) 的列剖面做 SSD 比對
 *     （含次像素拋物線內插），得到 ROI 內容在垂直方向的位移。
 *  3. 用 ROI 之外（上、下兩條帶狀區域）的位移當作「鏡頭晃動」的估計，把它從 ROI 位移中扣掉，
 *     得到胸口相對於背景的「局部位移」dy。
 *  4. 另外把 ROI 分成上下兩半，下半位移減上半位移得到「擴張」訊號 exp：
 *     鏡頭由上往下拍時，胸口靠近鏡頭會讓影像放大，這個訊號對整體平移天生免疫。
 *  5. 位移曲線去趨勢後找峰值 → 每個峰值視為一次呼吸；另計算「活動比例」
 *     （訊號明顯偏離基線的時間比例）以區分連續的正常呼吸與短促稀疏的喘息。
 *
 * 這個模組沒有 DOM 依賴：pushFrame() 只吃灰階像素陣列與時間戳，方便在 Node 測試。
 */

import {
  profileShift,
  resample,
  detrendMedian,
  findPeaks,
  mad,
  mean,
  std,
  cv,
  clamp,
  median,
} from './signal.js';

/** ROI 預設位置（畫面比例）：置中偏上，符合直式手機對準胸口的習慣 */
export const DEFAULT_ROI = { x: 0.18, y: 0.28, w: 0.64, h: 0.44 };

/** RGBA → 灰階（luma） */
export function rgbaToGray(rgba, w, h, out) {
  const n = w * h;
  out = out || new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

function rowProfile(gray, w, x0, x1, y0, y1) {
  const rows = y1 - y0;
  const out = new Float64Array(rows);
  const cols = x1 - x0;
  for (let y = 0; y < rows; y++) {
    let s = 0;
    const base = (y0 + y) * w + x0;
    for (let x = 0; x < cols; x++) s += gray[base + x];
    out[y] = s / cols;
  }
  return out;
}

function colProfile(gray, w, x0, x1, y0, y1) {
  const cols = x1 - x0;
  const out = new Float64Array(cols);
  const rows = y1 - y0;
  for (let x = 0; x < cols; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += gray[y * w + x0 + x];
    out[x] = s / rows;
  }
  return out;
}

function regionStats(gray, w, x0, x1, y0, y1) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const v = gray[y * w + x];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
}

function absDiffMean(a, b, w, x0, x1, y0, y1) {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * w + x;
      s += Math.abs(a[i] - b[i]);
      n++;
    }
  }
  return s / n;
}

export class MotionAnalyzer {
  /**
   * @param {object} opts
   * @param {number} opts.width  分析解析度寬（預設 320）
   * @param {number} opts.height 分析解析度高（預設 240）
   * @param {object} opts.roi    ROI 比例 {x,y,w,h}
   * @param {number} opts.maxShift 位移搜尋範圍（像素）
   * @param {number} opts.windowSec 保留的分析視窗秒數
   */
  constructor(opts = {}) {
    this.w = opts.width || 320;
    this.h = opts.height || 240;
    this.roi = opts.roi || DEFAULT_ROI;
    this.maxShift = opts.maxShift || 8;
    this.windowSec = opts.windowSec || 15;
    this.keyframeMs = opts.keyframeMs || 2500; // 參考幀更新間隔
    this.maxVelocity = opts.maxVelocity || 40; // 像素/秒；超過視為估計離群值
    this.reset();
  }

  reset() {
    this.prevGray = null;
    this.ref = null; // 參考幀（keyframe）的剖面
    this.refT = 0;
    this.offset = { dy: 0, exp: 0 }; // 切換參考幀時累加的位移
    this.last = { dy: 0, exp: 0 };
    this.samples = []; // {t, dy, exp, gx, gy, energy, bright, contrast, cumDy, cumExp, shaking}
    this.frames = 0;
  }

  /** ROI 像素矩形 */
  roiRect() {
    const r = this.roi;
    const x0 = Math.round(r.x * this.w);
    const y0 = Math.round(r.y * this.h);
    const x1 = Math.round((r.x + r.w) * this.w);
    const y1 = Math.round((r.y + r.h) * this.h);
    return { x0, y0, x1, y1 };
  }

  /**
   * 餵入一張灰階影像。
   * @param {Uint8ClampedArray|Uint8Array} gray 長度 w*h
   * @param {number} tMs 時間戳（毫秒）
   */
  pushFrame(gray, tMs) {
    const w = this.w;
    const h = this.h;
    const { x0, y0, x1, y1 } = this.roiRect();
    const ms = this.maxShift;

    // 各區域的剖面
    const roiRows = rowProfile(gray, w, x0, x1, y0, y1);
    const midY = (y0 + y1) >> 1;
    const upperRows = rowProfile(gray, w, x0, x1, y0, midY);
    const lowerRows = rowProfile(gray, w, x0, x1, midY, y1);

    // 背景帶（ROI 上方與下方），用於估計鏡頭晃動
    const topRows = y0 > ms * 3 + 3 ? rowProfile(gray, w, 0, w, 0, y0) : null;
    const botRows = h - y1 > ms * 3 + 3 ? rowProfile(gray, w, 0, w, y1, h) : null;
    const fullCols = colProfile(gray, w, 0, w, 0, h);

    const stats = regionStats(gray, w, x0, x1, y0, y1);

    const cur = { roiRows, upperRows, lowerRows, topRows, botRows, fullCols };
    const sample = {
      t: tMs,
      dy: 0,
      exp: 0,
      gx: 0,
      gy: 0,
      energy: 0,
      bright: stats.mean,
      contrast: stats.std,
      cumDy: this.offset.dy,
      cumExp: this.offset.exp,
      shaking: false,
    };

    if (this.prevGray) sample.energy = absDiffMean(this.prevGray, gray, w, x0, x1, y0, y1);

    if (!this.ref) {
      this.ref = cur;
      this.refT = tMs;
    } else {
      // 相對於「參考幀」(keyframe) 的位移：比逐幀累加更不易受次像素偏差與雜訊累積影響
      const r = this.ref;
      const roiShift = profileShift(r.roiRows, roiRows, ms);
      const upShift = profileShift(r.upperRows, upperRows, ms);
      const loShift = profileShift(r.lowerRows, lowerRows, ms);

      // 全域（背景）位移：上下帶狀區域的平均；沒有背景可用時退回 0
      const bgShifts = [];
      if (topRows && r.topRows) bgShifts.push(profileShift(r.topRows, topRows, ms));
      if (botRows && r.botRows) bgShifts.push(profileShift(r.botRows, botRows, ms));
      const gy = bgShifts.length ? mean(bgShifts) : 0;
      const gx = profileShift(r.fullCols, fullCols, ms);

      sample.gy = gy;
      sample.gx = gx;
      const dy = roiShift - gy; // 胸口相對背景的垂直位移
      const exp = loShift - upShift; // 擴張（靠近鏡頭）
      sample.dy = dy;
      sample.exp = exp;

      // 鏡頭大幅晃動時這一幀不可信：沿用上一個值
      const shaking = Math.abs(gy) > ms * 0.6 || Math.abs(gx) > ms * 0.6;
      sample.shaking = shaking;
      const prevT = this.samples.length ? this.samples[this.samples.length - 1].t : tMs;
      const dt = Math.max(0.02, (tMs - prevT) / 1000);
      const maxStep = this.maxVelocity * dt; // 呼吸動作不可能瞬間跳很多像素 → 視為離群值
      const candDy = this.offset.dy + dy;
      const candExp = this.offset.exp + exp;
      const outlier = Math.abs(candDy - this.last.dy) > maxStep || Math.abs(candExp - this.last.exp) > maxStep;
      sample.outlier = outlier;
      if (shaking || outlier) {
        sample.cumDy = this.last.dy;
        sample.cumExp = this.last.exp;
      } else {
        sample.cumDy = candDy;
        sample.cumExp = candExp;
      }
      this.last = { dy: sample.cumDy, exp: sample.cumExp };

      // 更新參考幀：太久、位移接近搜尋上限、或剛經歷晃動
      const stale = tMs - this.refT > this.keyframeMs;
      const nearLimit = Math.abs(roiShift) > ms * 0.5 || Math.abs(gy) > ms * 0.5;
      if (stale || nearLimit || shaking) {
        this.ref = cur;
        this.refT = tMs;
        // 切換參考幀時的位移基準用最近幾幀的中位數，避免把單幀離群值永久烙進曲線
        const recent = this.samples.slice(-4).map((v) => [v.cumDy, v.cumExp]);
        recent.push([sample.cumDy, sample.cumExp]);
        this.offset = {
          dy: median(recent.map((r) => r[0])),
          exp: median(recent.map((r) => r[1])),
        };
        // 讓曲線連續：目前幀相對新參考幀位移為 0，所以目前值就是 offset
        sample.cumDy = this.offset.dy;
        sample.cumExp = this.offset.exp;
        this.last = { dy: sample.cumDy, exp: sample.cumExp };
      }
    }

    this.prevGray = gray.slice ? gray.slice() : Uint8ClampedArray.from(gray);
    this.samples.push(sample);
    this.frames++;

    // 修剪視窗
    const cutoff = tMs - this.windowSec * 1000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();

    return sample;
  }

  /**
   * 分析目前視窗內的資料。
   * @param {object} opts
   * @param {number} opts.fs 重取樣頻率（Hz）
   * @param {number} opts.minIntervalSec 兩次呼吸最短間隔（秒）
   * @param {number} opts.floorPx 峰值最小突出度下限（像素）
   * @param {number} opts.promK 峰值突出度須高於雜訊的倍數
   * @param {number} opts.detrendSec 去趨勢視窗（秒）
   */
  getMetrics(opts = {}) {
    const fs = opts.fs || 20;
    const minIntervalSec = opts.minIntervalSec || 0.9;
    const floorPx = opts.floorPx ?? 0.35;
    const promK = opts.promK ?? 5;
    const detrendSec = opts.detrendSec || 5;

    const s = this.samples;
    const n = s.length;
    const empty = {
      ok: false,
      durationSec: 0,
      fps: 0,
      quality: 0,
      breaths: 0,
      rate: 0,
      regularity: 0,
      ampCV: 0,
      maxGapSec: 0,
      peaks: [],
      activeFrac: 0,
      signalName: 'dy',
      snr: 0,
      shakeFrac: 0,
      jitter: 0,
      contrast: 0,
      bright: 0,
      series: { t: [], y: [] },
    };
    if (n < 5) return empty;

    const t0 = s[0].t;
    const durationSec = (s[n - 1].t - t0) / 1000;
    if (durationSec < 1) return { ...empty, durationSec };
    const fps = (n - 1) / durationSec;

    const tArr = s.map((v) => (v.t - t0) / 1000);
    const shakeFrac = s.filter((v) => v.shaking).length / n;
    // 手震程度：背景位移的逐幀變化量（MAD）。晃動越大，補償後殘留的假位移也越大 → 提高峰值門檻
    const gyDiff = [];
    for (let i = 1; i < n; i++) gyDiff.push(s[i].gy - s[i - 1].gy);
    const jitter = mad(gyDiff);
    const floorEff = floorPx + jitter;
    const contrast = median(s.map((v) => v.contrast));
    const bright = median(s.map((v) => v.bright));

    const analyze = (key) => {
      const raw = s.map((v) => v[key]);
      const { y } = resample(tArr, raw, fs);
      if (y.length < fs * 2) return null;
      const hp = detrendMedian(y, Math.round(detrendSec * fs));
      // 雜訊估計：用「原始逐幀取樣」一階差分的 MAD
      //（平滑的呼吸波形逐幀差分很小；白雜訊的差分變異為 2σ²，故除以 √2）
      const diff = new Float64Array(raw.length - 1);
      for (let i = 0; i < diff.length; i++) diff[i] = raw[i + 1] - raw[i];
      const noise = mad(diff) / Math.SQRT2;
      const minProminence = Math.max(promK * noise, floorEff);
      let peaks = findPeaks(hp, {
        minDistance: Math.round(minIntervalSec * fs),
        minProminence,
      });
      // 去掉相對於最大峰值太小的峰（去趨勢的副瓣、雜訊）
      if (peaks.length > 1) {
        const maxProm = Math.max(...peaks.map((p) => p.p));
        peaks = peaks.filter((p) => p.p >= 0.25 * maxProm);
      }
      const peakT = peaks.map((p) => p.i / fs);
      const proms = peaks.map((p) => p.p);
      const snr = noise > 0 ? median(proms) / noise : proms.length ? 99 : 0;
      // 活動比例：|訊號| 超過峰高 30% 的時間比例。正弦式的正常呼吸約 0.8；短促喘息＋長時間平坦約 0.1–0.3
      let activeFrac = 0;
      if (peaks.length) {
        const thr = 0.3 * median(peaks.map((p) => p.h));
        let c = 0;
        for (let i = 0; i < hp.length; i++) if (Math.abs(hp[i]) > thr) c++;
        activeFrac = c / hp.length;
      }
      return { key, y: hp, peakT, proms, noise, snr, activeFrac, len: y.length / fs };
    };

    const cands = [analyze('cumDy'), analyze('cumExp')].filter(Boolean);
    if (!cands.length) return { ...empty, durationSec, fps };

    // 選擇「峰值振幅較大」的訊號（平移 dy 或擴張 exp）；同分時取峰值較多者
    const ampOf = (c) => (c.proms.length ? median(c.proms) : 0);
    cands.sort((a, b) => ampOf(b) - ampOf(a) || b.peakT.length - a.peakT.length);
    const best = cands[0];

    const peakT = best.peakT;
    const breaths = peakT.length;
    const winSec = best.len;
    const intervals = [];
    for (let i = 1; i < peakT.length; i++) intervals.push(peakT[i] - peakT[i - 1]);
    // 每分鐘次數：有 2 個以上間隔時用平均間隔（不受視窗邊緣影響），否則用次數／視窗長度
    const rate = intervals.length >= 2 ? 60 / mean(intervals) : (breaths / winSec) * 60;

    // 規律性：相鄰呼吸間隔的變異係數
    let regularity = 0;
    if (intervals.length >= 2) regularity = clamp(1 - cv(intervals), 0, 1);
    else if (intervals.length === 1) regularity = 0.5;

    const ampCV = best.proms.length >= 2 ? cv(best.proms) : 0;

    // 最長無呼吸間隔（含視窗首尾）
    let maxGapSec = winSec;
    if (peakT.length) {
      const edges = [0, ...peakT, winSec];
      maxGapSec = 0;
      for (let i = 1; i < edges.length; i++) maxGapSec = Math.max(maxGapSec, edges[i] - edges[i - 1]);
    }

    // 影像品質分數
    const fpsScore = clamp((fps - 5) / 7, 0, 1); // 5fps→0，12fps→1
    const shakeScore = 1 - clamp((shakeFrac - 0.1) / 0.4, 0, 1); // 晃動幀 >50% → 0
    const contrastScore = clamp((contrast - 3) / 9, 0, 1); // 需要一些紋理
    const brightScore = bright < 15 ? 0 : bright > 245 ? 0 : 1;
    const quality = fpsScore * shakeScore * contrastScore * brightScore;

    return {
      ok: true,
      durationSec,
      fps,
      quality,
      breaths,
      rate,
      regularity,
      ampCV,
      maxGapSec,
      peaks: peakT,
      activeFrac: best.activeFrac,
      signalName: best.key === 'cumDy' ? 'dy' : 'exp',
      snr: best.snr,
      noise: best.noise,
      shakeFrac,
      jitter,
      contrast,
      bright,
      series: { t: Array.from({ length: best.y.length }, (_, i) => i / fs), y: Array.from(best.y) },
    };
  }
}
