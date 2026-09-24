/**
 * metronome.js — WebAudio 節拍器（100–120 下/分），含前瞻排程與震動
 *
 * 用 AudioContext 的時間軸排程 click，避免 setInterval 漂移。
 * 必須在使用者手勢（點擊）後呼叫 start()，iOS 才允許播放聲音。
 */

export class Metronome {
  /**
   * @param {object} opts
   * @param {number} opts.bpm
   * @param {(info:{count:number, accent:boolean, time:number})=>void} opts.onBeat
   * @param {number} opts.accentEvery 每 N 拍重音（0 = 不重音）
   * @param {boolean} opts.vibrate
   * @param {boolean} opts.sound
   */
  constructor(opts = {}) {
    this.bpm = opts.bpm || 110;
    this.onBeat = opts.onBeat || (() => {});
    this.accentEvery = opts.accentEvery ?? 30;
    this.vibrate = opts.vibrate ?? true;
    this.sound = opts.sound ?? true;
    this.ctx = null;
    this.running = false;
    this.count = 0;
    this.nextTime = 0;
    this.timer = null;
    this.lookahead = 0.12; // 秒
    this.tick = 25; // ms
    this.scheduled = [];
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setBpm(bpm) {
    this.bpm = Math.max(60, Math.min(160, bpm));
  }

  start() {
    const ctx = this.ensureContext();
    if (this.running) return;
    this.running = true;
    this.count = 0;
    this.nextTime = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), this.tick);
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scheduled = [];
  }

  schedule() {
    const ctx = this.ctx;
    while (this.nextTime < ctx.currentTime + this.lookahead) {
      const count = this.count + 1;
      const accent = this.accentEvery > 0 && count % this.accentEvery === 0;
      if (this.sound) this.click(this.nextTime, accent);
      // 視覺／震動回呼盡量對齊聲音時間
      const delay = Math.max(0, (this.nextTime - ctx.currentTime) * 1000);
      const t = this.nextTime;
      setTimeout(() => {
        if (!this.running) return;
        if (this.vibrate && navigator.vibrate) {
          try {
            navigator.vibrate(accent ? 70 : 35);
          } catch (e) {
            /* ignore */
          }
        }
        this.onBeat({ count, accent, time: t });
      }, delay);
      this.count = count;
      this.nextTime += 60 / this.bpm;
    }
  }

  click(time, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1400 : 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.08);
  }
}
