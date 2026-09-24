/**
 * detect.test.mjs — 呼吸辨識模組的單元測試（Node 內建 test runner）
 *   node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MotionAnalyzer } from '../js/detect/motion.js';
import { GaspDetector } from '../js/detect/audio.js';
import { decide } from '../js/detect/fusion.js';
import { findPeaks, profileShift, movingAverage } from '../js/detect/signal.js';
import { synthFrames, pulse, mulberry32 } from './synth.mjs';

function runMotion(scenario) {
  const an = new MotionAnalyzer({ width: scenario.w || 320, height: scenario.h || 240, windowSec: 15 });
  for (const { gray, tMs } of synthFrames(scenario)) an.pushFrame(gray, tMs);
  return an.getMetrics();
}

test('signal: profileShift 能回復已知位移（含次像素）', () => {
  const n = 80;
  const base = Array.from({ length: n * 8 }, (_, i) => Math.sin(i / 23) * 20 + Math.sin(i / 7.3) * 8 + 100);
  const sample = (shift) => Array.from({ length: n }, (_, i) => base[((Math.round((i - shift) * 8) % (n * 8)) + n * 8) % (n * 8)]);
  for (const s of [-3, -1.5, -0.5, 0, 0.5, 1.25, 3]) {
    const est = profileShift(sample(0), sample(s), 6);
    assert.ok(Math.abs(est - s) < 0.35, `shift ${s} 估計為 ${est.toFixed(2)}`);
  }
});

test('signal: findPeaks 找到正弦波的每個峰', () => {
  const fs = 20;
  const y = Array.from({ length: fs * 12 }, (_, i) => Math.sin((2 * Math.PI * 0.25 * i) / fs));
  const peaks = findPeaks(y, { minDistance: fs, minProminence: 0.5 });
  assert.equal(peaks.length, 3);
});

test('signal: movingAverage 長度與均值守恆', () => {
  const y = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const m = movingAverage(y, 3);
  assert.equal(m.length, y.length);
  assert.ok(Math.abs(m[4] - 5) < 1e-9);
});

test('motion: 規律呼吸 15 次/分 → normal', () => {
  const m = runMotion({ seconds: 12, fps: 15, chest: (t) => 1.5 * Math.sin(2 * Math.PI * 0.25 * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'normal', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.ok(m.rate > 11 && m.rate < 19, `rate=${m.rate}`);
  assert.equal(d.recommendCPR, false);
});

test('motion: 較慢的規律呼吸 10 次/分，12 秒只看到 2 次 → 要求延長觀察', () => {
  const m = runMotion({ seconds: 12, fps: 12, chest: (t) => 1.2 * Math.sin(2 * Math.PI * (10 / 60) * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'unknown', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.equal(d.extend, true);
});

test('motion: 較慢的規律呼吸 10 次/分，延長到 16 秒 → normal', () => {
  const m = runMotion({ seconds: 16, fps: 12, chest: (t) => 1.2 * Math.sin(2 * Math.PI * (10 / 60) * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'normal', JSON.stringify({ d, m: { ...m, series: undefined } }));
});

test('motion: 以「擴張」為主的俯拍呼吸 → normal', () => {
  const m = runMotion({ seconds: 12, fps: 15, expand: (t) => 1.2 * Math.sin(2 * Math.PI * 0.3 * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'normal', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.equal(m.signalName, 'exp');
});

test('motion: 完全沒有起伏 → none', () => {
  const m = runMotion({ seconds: 12, fps: 15, chest: () => 0, noise: 2.5 });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'none', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.equal(d.recommendCPR, true);
});

test('motion: 稀疏不規則的喘息 → agonal', () => {
  const chest = (t) => pulse(t, 0.8, 0.3, 2.5) + pulse(t, 5.5, 0.4, 3.2) + pulse(t, 12.9, 0.3, 1.8);
  const m = runMotion({ seconds: 14, fps: 15, chest });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'agonal', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.equal(d.recommendCPR, true);
});

test('motion: 短促但間隔規律的喘息（每 5.6 秒一次）仍 → agonal（活動比例低）', () => {
  const chest = (t) => pulse(t, 1.2, 0.35, 2.5) + pulse(t, 6.8, 0.4, 3) + pulse(t, 12.5, 0.3, 2.2);
  const m = runMotion({ seconds: 14, fps: 15, chest });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'agonal', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.ok(m.activeFrac < 0.45, `activeFrac=${m.activeFrac}`);
});

test('motion: 每 10 秒一次的喘息 → agonal', () => {
  const chest = (t) => pulse(t, 2.0, 0.5, 3) + pulse(t, 11.5, 0.5, 2.6);
  const m = runMotion({ seconds: 14, fps: 15, chest });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'agonal', JSON.stringify({ d, m: { ...m, series: undefined } }));
});

test('motion: 手持晃動下的規律呼吸仍為 normal', () => {
  const rng = mulberry32(7);
  let g = 0;
  const shakes = [];
  for (let i = 0; i < 400; i++) {
    g = g * 0.9 + (rng() - 0.5) * 1.6;
    shakes.push(g);
  }
  const shake = (t) => shakes[Math.min(shakes.length - 1, Math.floor(t * 15))];
  const m = runMotion({ seconds: 12, fps: 15, shake, chest: (t) => 1.6 * Math.sin(2 * Math.PI * 0.27 * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'normal', JSON.stringify({ d, m: { ...m, series: undefined } }));
});

test('motion: 畫面太暗 → unknown（但仍建議 CPR）', () => {
  const m = runMotion({ seconds: 12, fps: 15, brightness: 6, contrast: 2, noise: 1 });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'unknown', JSON.stringify({ d, m: { ...m, series: undefined } }));
  assert.equal(d.recommendCPR, true);
});

test('motion: 觀察時間不足 → unknown', () => {
  const m = runMotion({ seconds: 4, fps: 15, chest: (t) => 1.5 * Math.sin(2 * Math.PI * 0.25 * t) });
  const d = decide({ motion: m });
  assert.equal(d.verdict, 'unknown');
});

function feedLevels(det, fn, seconds, stepMs = 40) {
  for (let t = 0; t <= seconds * 1000; t += stepMs) det.pushLevel(fn(t / 1000), t);
  return det.getMetrics(seconds * 1000);
}

test('audio: 間歇性喘息聲 → gaspLike', () => {
  const rng = mulberry32(3);
  const det = new GaspDetector();
  const fn = (t) => {
    let v = 0.003 + rng() * 0.001;
    for (const c of [2.0, 7.5, 12.8]) if (t > c && t < c + 0.4) v = 0.08;
    return v;
  };
  const a = feedLevels(det, fn, 14);
  assert.equal(a.bursts, 3, JSON.stringify(a));
  assert.equal(a.gaspLike, true);
});

test('audio: 安靜 → 沒有爆發', () => {
  const rng = mulberry32(5);
  const det = new GaspDetector();
  const a = feedLevels(det, () => 0.003 + rng() * 0.001, 14);
  assert.equal(a.bursts, 0);
  assert.equal(a.gaspLike, false);
});

test('audio: 說話（密集爆發）→ 不算喘息', () => {
  const rng = mulberry32(9);
  const det = new GaspDetector();
  const fn = (t) => {
    const phase = t % 0.7;
    return phase < 0.35 ? 0.06 + rng() * 0.02 : 0.003 + rng() * 0.001;
  };
  const a = feedLevels(det, fn, 14);
  assert.equal(a.gaspLike, false, JSON.stringify(a));
});

test('fusion: 影像無起伏 + 聲音喘息 → agonal', () => {
  const m = runMotion({ seconds: 12, fps: 15, chest: () => 0, noise: 2.5 });
  const audio = { windowSec: 12, gaspLike: true, bursts: 3, noisy: false };
  const d = decide({ motion: m, audio });
  assert.equal(d.verdict, 'agonal');
  assert.equal(d.recommendCPR, true);
});

test('fusion: 模型不能把 none 改成 normal', () => {
  const m = runMotion({ seconds: 12, fps: 15, chest: () => 0, noise: 2.5 });
  const model = { available: true, pAgonal: 0.05, pNormal: 0.9, pNone: 0.05, confidence: 0.9 };
  const d = decide({ motion: m, model });
  assert.equal(d.verdict, 'none');
});

test('fusion: 模型可以把 normal 改成 agonal', () => {
  const m = runMotion({ seconds: 12, fps: 15, chest: (t) => 1.5 * Math.sin(2 * Math.PI * 0.25 * t) });
  const model = { available: true, pAgonal: 0.85, pNormal: 0.1, pNone: 0.05, confidence: 0.85 };
  const d = decide({ motion: m, model });
  assert.equal(d.verdict, 'agonal');
});
