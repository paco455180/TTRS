/**
 * audio.js — 以麥克風音量包絡偵測「間歇性喘息／鼾聲」(gasp-like bursts)
 *
 * 瀕死呼吸的聲音特徵：短促（約 0.2–1.5 秒）、聲音突然出現又消失、
 * 兩次之間常隔數秒的靜默。這個模組只做啟發式的「音量爆發」偵測，
 * 用來輔助影像判斷；正式產品應以 docs/AI_MODEL_PLAN.md 的聲音模型取代。
 *
 * 沒有 DOM/WebAudio 依賴：pushLevel(rms, tMs) 由外部餵入每幀 RMS。
 */

export class GaspDetector {
  /**
   * @param {object} opts
   * @param {number} opts.windowSec 分析視窗（秒）
   * @param {number} opts.onsetRatio 爆發起始門檻（相對雜訊底）
   * @param {number} opts.offsetRatio 爆發結束門檻（相對雜訊底）
   * @param {number} opts.absMin 絕對最小 RMS（避免極安靜環境下的假警報）
   * @param {number} opts.minBurstMs 最短爆發長度
   * @param {number} opts.maxBurstMs 最長爆發長度（超過視為持續噪音／說話）
   */
  constructor(opts = {}) {
    this.windowSec = opts.windowSec || 15;
    this.onsetRatio = opts.onsetRatio || 4;
    this.offsetRatio = opts.offsetRatio || 2;
    this.absMin = opts.absMin ?? 0.008;
    this.minBurstMs = opts.minBurstMs || 80;
    this.maxBurstMs = opts.maxBurstMs || 2000;
    this.reset();
  }

  reset() {
    this.floor = null;
    this.bursts = []; // {start, end, peak}
    this.levels = []; // {t, rms}
    this.inBurst = false;
    this.burstStart = 0;
    this.burstPeak = 0;
    this.belowSince = null;
    this.longNoiseMs = 0; // 累積的過長爆發（說話、交通）時間
  }

  /**
   * @param {number} rms 0..1 的音量 RMS
   * @param {number} tMs 時間戳（毫秒）
   */
  pushLevel(rms, tMs) {
    this.levels.push({ t: tMs, rms });
    const cutoff = tMs - this.windowSec * 1000;
    while (this.levels.length && this.levels[0].t < cutoff) this.levels.shift();
    while (this.bursts.length && this.bursts[0].end < cutoff) this.bursts.shift();

    // 雜訊底追蹤：往下快、往上慢
    if (this.floor === null) this.floor = rms;
    else if (rms < this.floor) this.floor = this.floor * 0.7 + rms * 0.3;
    else this.floor += (rms - this.floor) * 0.004;
    const floor = Math.max(this.floor, 1e-4);

    const onset = Math.max(floor * this.onsetRatio, this.absMin);
    const offset = Math.max(floor * this.offsetRatio, this.absMin * 0.6);

    let event = null;
    if (!this.inBurst) {
      if (rms > onset) {
        this.inBurst = true;
        this.burstStart = tMs;
        this.burstPeak = rms;
        this.belowSince = null;
      }
    } else {
      this.burstPeak = Math.max(this.burstPeak, rms);
      if (rms < offset) {
        if (this.belowSince === null) this.belowSince = tMs;
        else if (tMs - this.belowSince >= 120) {
          const end = this.belowSince;
          const dur = end - this.burstStart;
          this.inBurst = false;
          this.belowSince = null;
          if (dur >= this.minBurstMs && dur <= this.maxBurstMs) {
            const b = { start: this.burstStart, end, peak: this.burstPeak, dur };
            this.bursts.push(b);
            event = b;
          } else if (dur > this.maxBurstMs) {
            this.longNoiseMs += dur;
          }
        }
      } else {
        this.belowSince = null;
      }
      // 爆發拖太久：視為持續噪音，直接結束
      if (this.inBurst && tMs - this.burstStart > this.maxBurstMs * 2) {
        this.inBurst = false;
        this.longNoiseMs += tMs - this.burstStart;
        this.belowSince = null;
      }
    }
    return { burst: event, floor, inBurst: this.inBurst };
  }

  getMetrics(nowMs) {
    const bursts = this.bursts.slice();
    const intervals = [];
    for (let i = 1; i < bursts.length; i++) intervals.push((bursts[i].start - bursts[i - 1].end) / 1000);
    const minInterval = intervals.length ? Math.min(...intervals) : Infinity;
    const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const floor = Math.max(this.floor || 0, 1e-4);
    const peakRatio = bursts.length ? Math.max(...bursts.map((b) => b.peak)) / floor : 0;
    const windowSec = this.levels.length ? (nowMs - this.levels[0].t) / 1000 : 0;
    const noisy = this.longNoiseMs > windowSec * 1000 * 0.3;
    // 喘息樣態：2–8 次短促爆發，彼此至少間隔 1.5 秒（排除說話）
    const gaspLike = !noisy && bursts.length >= 2 && bursts.length <= 8 && minInterval >= 1.5;
    return {
      bursts: bursts.length,
      intervals,
      minInterval: Number.isFinite(minInterval) ? minInterval : 0,
      meanInterval,
      meanBurstMs: bursts.length ? bursts.reduce((a, b) => a + b.dur, 0) / bursts.length : 0,
      peakRatio,
      floor,
      noisy,
      gaspLike,
      windowSec,
    };
  }
}

/** 由時域取樣（-1..1 或 0..255 Uint8）計算 RMS */
export function rmsOf(buf, isUint8 = false) {
  let s = 0;
  const n = buf.length;
  if (isUint8) {
    for (let i = 0; i < n; i++) {
      const v = (buf[i] - 128) / 128;
      s += v * v;
    }
  } else {
    for (let i = 0; i < n; i++) s += buf[i] * buf[i];
  }
  return Math.sqrt(s / n);
}
