/**
 * app.js — 呼救 CPR 主程式：路由、鏡頭呼吸檢查、結果、CPR 引導、AED 地圖、設定
 */
import { MotionAnalyzer, DEFAULT_ROI, rgbaToGray } from './detect/motion.js';
import { GaspDetector, rmsOf } from './detect/audio.js';
import { decide, labelOf } from './detect/fusion.js';
import { loadModel, modelState, predict, motionSeriesFeature } from './detect/model.js';
import { Metronome } from './cpr/metronome.js';
import { voice } from './cpr/voice.js';
import { loadAED, nearest, fmtKm, navUrl, getPosition, ensureMap, renderMap, escapeHtml } from './aed/aed.js';

export const APP_VERSION = '0.1.0';

/* ============================== 設定 ============================== */
const DEFAULT_SETTINGS = {
  bpm: 110,
  voice: true,
  vibrate: true,
  vent: false, // 30:2
  mic: true,
  debug: false,
};
const settings = loadSettings();
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem('cpr.settings') || '{}') || {}) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem('cpr.settings', JSON.stringify(settings));
  } catch (e) {
    /* ignore */
  }
}

/* ============================== 共用工具 ============================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch (e) {
    /* 不支援或被拒絕 */
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (current === 'cpr' || current === 'check-breath')) requestWakeLock();
});

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ============================== 路由 ============================== */
const screens = {};
let current = null;
let lastResult = null; // 最近一次判讀結果

function parseHash() {
  const h = location.hash.replace(/^#/, '') || 'home';
  const [name, qs] = h.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  return { name, params };
}

export function navigate(target) {
  location.hash = target;
}

function showScreen() {
  const { name, params } = parseHash();
  const el = $(`.screen[data-screen="${name}"]`) || $('.screen[data-screen="home"]');
  const next = el.dataset.screen;
  if (current && screens[current]?.leave) screens[current].leave();
  $$('.screen').forEach((s) => (s.hidden = s !== el));
  current = next;
  window.scrollTo(0, 0);
  if (screens[next]?.enter) screens[next].enter(params);
}

window.addEventListener('hashchange', showScreen);
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    navigate(nav.dataset.nav);
    return;
  }
  const back = e.target.closest('[data-back]');
  if (back) {
    e.preventDefault();
    if (history.length > 1) history.back();
    else navigate('home');
  }
});

/* ============================== 定位（結果頁 / CPR 頁共用） ============================== */
let lastPos = null;
async function fillLocation(el) {
  if (!el) return;
  try {
    el.textContent = '定位中…';
    const pos = lastPos && Date.now() - lastPos.at < 60000 ? lastPos : { ...(await getPosition()), at: Date.now() };
    lastPos = pos;
    const link = `https://maps.google.com/?q=${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
    let near = '';
    try {
      const d = await loadAED();
      const list = nearest(d.items, pos.lat, pos.lng, 1, 3);
      if (list.length) near = `<br>最近 AED：${escapeHtml(list[0].name)}（約 ${fmtKm(list[0].km)}）${d.sample ? '（範例資料）' : ''}`;
    } catch (e) {
      /* ignore */
    }
    el.innerHTML =
      `緯度 ${pos.lat.toFixed(5)}，經度 ${pos.lng.toFixed(5)}（誤差約 ${Math.round(pos.acc || 0)} 公尺）` +
      ` <a href="${link}" target="_blank" rel="noopener">地圖</a>` +
      near;
  } catch (e) {
    el.textContent = '無法取得定位。請直接告訴 119 你看到的路名、門牌或明顯地標。';
  }
}

/* ============================== 檢查呼吸（鏡頭） ============================== */
const AW = 240; // 分析解析度（直式）
const AH = 320;
const cam = {
  stream: null,
  audioStream: null,
  audioCtx: null,
  analyserNode: null,
  timeData: null,
  raf: 0,
  lastFrameAt: 0,
  analyzer: new MotionAnalyzer({ width: AW, height: AH, roi: DEFAULT_ROI, windowSec: 18 }),
  gasp: new GaspDetector({ windowSec: 18 }),
  gray: new Uint8ClampedArray(AW * AH),
  off: null,
  offCtx: null,
  observing: false,
  obsStart: 0,
  obsDuration: 10000,
  extended: false,
  practice: false,
  finishing: false,
  manualTimer: null,
  frames: 0,
  fpsAt: 0,
  fps: 0,
};

async function startCamera() {
  const video = $('#cam');
  const msg = $('#camMsg');
  msg.hidden = false;
  msg.textContent = '正在開啟鏡頭…';
  $('#btnManualTimer').hidden = true;
  const videoC = { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  const audioC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    // 一次要鏡頭＋麥克風（只跳一次權限視窗）；失敗再退回只要鏡頭
    let stream = null;
    if (settings.mic) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: audioC });
      } catch (e) {
        stream = null;
      }
    }
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: false });
    cam.stream = stream;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      cam.audioStream = new MediaStream(audioTracks);
      $('#hudMic').textContent = '🎤 待機';
    } else if (settings.mic) {
      $('#hudMic').textContent = '🎤 關';
    }
    video.srcObject = new MediaStream(stream.getVideoTracks());
    await video.play().catch(() => {});
    msg.hidden = true;
    cam.lastFrameAt = 0;
    cam.raf = requestAnimationFrame(frameLoop);
  } catch (e) {
    msg.textContent = `無法開啟鏡頭（${e.name || e}）。請允許相機權限，或改用手動觀察。`;
    $('#btnManualTimer').hidden = false;
    $('#btnStartObs').disabled = true;
  }
}

function stopCamera() {
  cancelAnimationFrame(cam.raf);
  cam.raf = 0;
  if (cam.stream) {
    cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
  }
  stopMic();
  cam.observing = false;
  if (cam.manualTimer) {
    clearInterval(cam.manualTimer);
    cam.manualTimer = null;
  }
}

async function startMic() {
  if (!settings.mic) return false;
  try {
    if (!cam.audioStream) {
      cam.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    cam.audioCtx = cam.audioCtx || new AC();
    if (cam.audioCtx.state === 'suspended') await cam.audioCtx.resume();
    const src = cam.audioCtx.createMediaStreamSource(cam.audioStream);
    cam.analyserNode = cam.audioCtx.createAnalyser();
    cam.analyserNode.fftSize = 1024;
    cam.timeData = new Float32Array(cam.analyserNode.fftSize);
    src.connect(cam.analyserNode);
    $('#hudMic').textContent = '🎤 開';
    return true;
  } catch (e) {
    $('#hudMic').textContent = '🎤 關';
    return false;
  }
}

function stopMic() {
  if (cam.audioStream) {
    cam.audioStream.getTracks().forEach((t) => t.stop());
    cam.audioStream = null;
  }
  cam.analyserNode = null;
}

function frameLoop(now) {
  cam.raf = requestAnimationFrame(frameLoop);
  const video = $('#cam');
  if (!video.videoWidth || video.readyState < 2) return;
  if (now - cam.lastFrameAt < 45) return; // ~20 fps 上限
  cam.lastFrameAt = now;

  if (!cam.off) {
    cam.off = document.createElement('canvas');
    cam.off.width = AW;
    cam.off.height = AH;
    cam.offCtx = cam.off.getContext('2d', { willReadFrequently: true });
  }
  // 以 cover 方式裁切影像，讓分析區域與畫面顯示一致
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const target = AW / AH;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (vw / vh > target) {
    sw = Math.round(vh * target);
    sx = Math.round((vw - sw) / 2);
  } else {
    sh = Math.round(vw / target);
    sy = Math.round((vh - sh) / 2);
  }
  cam.offCtx.drawImage(video, sx, sy, sw, sh, 0, 0, AW, AH);
  const img = cam.offCtx.getImageData(0, 0, AW, AH);
  rgbaToGray(img.data, AW, AH, cam.gray);
  const sample = cam.analyzer.pushFrame(cam.gray, now);

  // 聲音
  if (cam.analyserNode) {
    cam.analyserNode.getFloatTimeDomainData(cam.timeData);
    cam.gasp.pushLevel(rmsOf(cam.timeData), now);
  }

  // fps
  cam.frames++;
  if (now - cam.fpsAt > 1000) {
    cam.fps = cam.frames / ((now - cam.fpsAt) / 1000);
    cam.frames = 0;
    cam.fpsAt = now;
    $('#hudFps').textContent = `${cam.fps.toFixed(0)} fps`;
  }

  drawOverlay(now, sample);

  if (cam.observing) {
    const elapsed = now - cam.obsStart;
    const remain = Math.max(0, cam.obsDuration - elapsed);
    $('#liveText').textContent = `觀察中… ${Math.ceil(remain / 1000)} 秒`;
    $('#liveSub').textContent = sample.shaking ? '⚠️ 手機晃動，請拿穩' : '請保持手機穩定，看著胸口';
    if (elapsed >= cam.obsDuration) finishObservation(now);
  }
}

function drawOverlay(now, sample) {
  const c = $('#overlay');
  const wrap = $('#camWrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // ROI 框
  const r = DEFAULT_ROI;
  const x = r.x * W;
  const y = r.y * H;
  const w = r.w * W;
  const h = r.h * H;
  ctx.strokeStyle = cam.observing ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 3;
  ctx.setLineDash(cam.observing ? [] : [10, 8]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('對準胸口／上腹', x + 8, y - 8);

  // 即時波形（最近 8 秒的位移）
  const s = cam.analyzer.samples;
  if (s.length > 5) {
    const t0 = now - 8000;
    const pts = s.filter((v) => v.t >= t0);
    const key = 'cumDy';
    const vals = pts.map((v) => v[key]);
    const sorted = vals.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const amp = Math.max(1, Math.max(...vals.map((v) => Math.abs(v - med))));
    const baseY = H - 34;
    const scale = 26 / amp;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const px = ((v.t - t0) / 8000) * W;
      const py = baseY - (v[key] - med) * scale;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '12px sans-serif';
    ctx.fillText('胸口起伏', 8, H - 8);
  }

  // 觀察倒數環
  if (cam.observing) {
    const frac = Math.min(1, (now - cam.obsStart) / cam.obsDuration);
    const cx = W - 34;
    const cy = 44 + 30;
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#ff5252';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.ceil((cam.obsDuration - (now - cam.obsStart)) / 1000)), cx, cy + 5);
    ctx.textAlign = 'left';
  }

  // 畫質提示
  if (sample) {
    const q = sample.contrast < 4 ? '低（缺乏細節）' : sample.bright < 15 ? '太暗' : sample.shaking ? '晃動' : '良好';
    $('#hudQuality').textContent = `畫質 ${q}`;
  }
}

async function beginObservation() {
  if (!cam.stream) return;
  const btn = $('#btnStartObs');
  btn.disabled = true;
  btn.textContent = '觀察中…';
  $('#camGuide').hidden = true;
  $('#liveStatus').hidden = false;
  voice.speak('開始觀察十秒，請把手機拿穩，看著胸口。', { rate: 1.1 }); // 在手勢內呼叫（iOS 解鎖語音）
  await startMic(); // AudioContext 需要使用者手勢（此處由按鈕觸發）
  cam.analyzer.reset();
  cam.gasp.reset();
  cam.extended = false;
  cam.obsDuration = 10000;
  cam.obsStart = performance.now();
  cam.observing = true;
}

async function finishObservation(now) {
  if (cam.finishing) return; // 模型推論是非同步的，避免下一幀重複進入
  cam.finishing = true;
  try {
    await finishObservationInner(now);
  } finally {
    cam.finishing = false;
  }
}

async function finishObservationInner(now) {
  const motion = cam.analyzer.getMetrics();
  const audio = cam.analyserNode ? cam.gasp.getMetrics(now) : null;
  let model = null;
  if (modelState().available) {
    try {
      model = await predict({ motionSeries: motionSeriesFeature(motion.series) });
    } catch (e) {
      model = null;
    }
  }
  const result = decide({ motion, audio, model });
  if (result.extend && !cam.extended) {
    cam.extended = true;
    cam.obsDuration += 5000;
    $('#liveText').textContent = '疑似有呼吸，再觀察 5 秒確認…';
    voice.speak('再觀察五秒。', { rate: 1.1 });
    return;
  }
  cam.observing = false;
  lastResult = { ...result, at: Date.now(), practice: cam.practice, manual: false };
  if (result.recommendCPR) voice.speak('沒有正常呼吸。請立刻撥打一一九，開始壓胸。', { rate: 1.05 });
  else voice.speak('偵測到規律呼吸。請撥打一一九並持續觀察。', { rate: 1.05 });
  navigate('result');
}

function startManualTimer() {
  $('#camGuide').hidden = true;
  $('#liveStatus').hidden = false;
  $('#btnManualTimer').hidden = true;
  let remain = 10;
  $('#liveText').textContent = `手動觀察 ${remain} 秒`;
  $('#liveSub').textContent = '看胸口有沒有規律起伏、聽有沒有正常呼吸聲';
  cam.manualTimer = setInterval(() => {
    remain--;
    if (remain > 0) {
      $('#liveText').textContent = `手動觀察 ${remain} 秒`;
      return;
    }
    clearInterval(cam.manualTimer);
    cam.manualTimer = null;
    $('#liveText').textContent = '10 秒到了：有「規律」的呼吸嗎？';
    $('#liveSub').innerHTML = '';
    const foot = $('.screen[data-screen="check-breath"] .actions');
    foot.innerHTML = '';
    const yes = document.createElement('button');
    yes.className = 'btn btn-success btn-xl';
    yes.textContent = '有規律呼吸';
    yes.onclick = () => {
      lastResult = manualResult('normal');
      navigate('result');
    };
    const no = document.createElement('button');
    no.className = 'btn btn-primary btn-xl';
    no.textContent = '沒有／只有喘息／不確定 → CPR';
    no.onclick = () => {
      lastResult = manualResult('unknown');
      navigate('result');
    };
    foot.append(yes, no);
  }, 1000);
}

function manualResult(verdict) {
  return {
    verdict,
    label: verdict === 'normal' ? '你判斷：有規律呼吸' : '你判斷：呼吸不正常或不確定',
    confidence: 0,
    recommendCPR: verdict !== 'normal',
    reasons: ['手動觀察（未使用鏡頭）'],
    motion: null,
    audio: null,
    manual: true,
    at: Date.now(),
  };
}

function resetCheckFooter() {
  const foot = $('.screen[data-screen="check-breath"] .actions');
  foot.innerHTML = '';
  const start = document.createElement('button');
  start.className = 'btn btn-primary btn-xl';
  start.id = 'btnStartObs';
  start.textContent = '開始 10 秒觀察';
  start.onclick = beginObservation;
  const skip = document.createElement('button');
  skip.className = 'btn btn-danger btn-xl';
  skip.id = 'btnSkipCPR';
  skip.textContent = '呼吸不正常／不確定 → 立即 CPR';
  skip.onclick = () => {
    lastResult = manualResult('unknown');
    lastResult.label = '你判斷：呼吸不正常或不確定';
    startCprFromGesture('c');
  };
  const manual = document.createElement('button');
  manual.className = 'btn btn-ghost';
  manual.id = 'btnManualTimer';
  manual.hidden = true;
  manual.textContent = '沒有鏡頭？用 10 秒計時手動觀察';
  manual.onclick = startManualTimer;
  foot.append(start, skip, manual);
}

screens['check-breath'] = {
  enter(params) {
    cam.practice = params.practice === '1';
    $('.screen[data-screen="check-breath"] .step-title').textContent = cam.practice
      ? '練習模式：對自己或朋友試試看'
      : '步驟 2／3　檢查呼吸（10 秒）';
    resetCheckFooter();
    $('#camGuide').hidden = false;
    $('#liveStatus').hidden = true;
    $('#hudMic').textContent = settings.mic ? '🎤 待機' : '🎤 關';
    requestWakeLock();
    startCamera();
    if (cam.practice) toast('練習模式：把框對準自己的胸口，正常呼吸、憋氣各試一次');
    else getPosition({ timeout: 20000 }).then((p) => (lastPos = { ...p, at: Date.now() })).catch(() => {}); // 先取得定位，結果頁直接顯示
  },
  leave() {
    stopCamera();
    releaseWakeLock();
  },
};

/* ============================== 結果 ============================== */
function drawResultWave(series) {
  const c = $('#resultWave');
  const W = (c.width = c.clientWidth * (window.devicePixelRatio || 1));
  const H = (c.height = 80 * (window.devicePixelRatio || 1));
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!series || !series.y || series.y.length < 4) {
    c.parentElement.hidden = true;
    return;
  }
  c.parentElement.hidden = false;
  const y = series.y;
  const amp = Math.max(0.5, Math.max(...y.map((v) => Math.abs(v))));
  ctx.beginPath();
  y.forEach((v, i) => {
    const px = (i / (y.length - 1)) * W;
    const py = H / 2 - (v / amp) * (H / 2 - 6);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = '#c62828';
  ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
  ctx.stroke();
}

function startCprFromGesture(step = 'c') {
  // 在使用者手勢內先建立 AudioContext 並解鎖語音，之後才能自動播放節拍與口令
  metro.ensureContext();
  voice.unlock();
  cprAutoStart = true;
  navigate(`cpr?step=${step}`);
}

screens.result = {
  enter() {
    const r = lastResult;
    const card = $('#verdictCard');
    const actions = $('#resultActions');
    actions.innerHTML = '';
    if (!r) {
      navigate('check-breath');
      return;
    }
    const v = r.verdict;
    card.className = 'verdict-card ' + (v === 'normal' ? 'ok' : v === 'unknown' ? 'unknown' : 'cpr');
    $('#verdictKicker').textContent = r.practice ? '練習模式' : r.manual ? '手動觀察' : '鏡頭判讀（10 秒）';
    $('#verdictTitle').textContent = r.label || labelOf(v);
    const body = {
      agonal: '這種喘息不是正常呼吸，代表心臟可能已經停止。立刻撥打 119（開擴音），然後開始壓胸。不用再確認，開始就對了。',
      none: '沒有偵測到呼吸。立刻撥打 119（開擴音），然後開始壓胸。',
      unknown: '無法確定，就當作沒有呼吸：撥打 119，開始壓胸。對有心跳的人做 CPR 傷害很小，不做才危險。',
      normal: '病患沒有反應但有呼吸：撥打 119；讓他側躺（復甦姿勢）避免嘔吐物嗆到；每分鐘看一次胸口。呼吸一停止或變成喘息，立刻開始 CPR。',
    }[v];
    $('#verdictBody').textContent = body;
    const ul = $('#verdictReasons');
    ul.innerHTML = '';
    (r.reasons || []).forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    const m = r.motion;
    const chips = [];
    if (m && m.ok) {
      chips.push(`起伏 ${m.breaths} 次／${m.durationSec.toFixed(0)} 秒`);
      chips.push(`約 ${m.rate.toFixed(0)} 次/分`);
      chips.push(`影像品質 ${(m.quality * 100).toFixed(0)}%`);
      if (settings.debug) {
        chips.push(`規律 ${(m.regularity * 100).toFixed(0)}%`);
        chips.push(`活動比 ${(m.activeFrac * 100).toFixed(0)}%`);
        chips.push(`訊號 ${m.signalName} snr ${m.snr.toFixed(1)}`);
        chips.push(`${m.fps.toFixed(0)} fps`);
      }
    }
    if (r.audio) chips.push(`喘息聲 ${r.audio.bursts} 次${r.audio.noisy ? '（噪音大）' : ''}`);
    if (r.confidence) chips.push(`系統信心 ${(r.confidence * 100).toFixed(0)}%`);
    $('#verdictMetrics').innerHTML = chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('');
    drawResultWave(m && m.series);

    const call = document.createElement('a');
    call.className = 'btn btn-call btn-xl';
    call.href = 'tel:119';
    call.textContent = '📞 撥打 119（開擴音）';
    if (r.recommendCPR) {
      const go = document.createElement('button');
      go.className = 'btn btn-primary btn-xl';
      go.textContent = '開始壓胸（節拍引導）';
      go.onclick = () => startCprFromGesture('c');
      const redo = document.createElement('button');
      redo.className = 'btn btn-ghost';
      redo.textContent = '重新檢查';
      redo.onclick = () => navigate('check-breath');
      actions.append(call, go, redo);
    } else {
      const redo = document.createElement('button');
      redo.className = 'btn btn-outline btn-xl';
      redo.textContent = '再檢查一次呼吸';
      redo.onclick = () => navigate('check-breath');
      const go = document.createElement('button');
      go.className = 'btn btn-ghost';
      go.textContent = '情況變了 → 開始 CPR';
      go.onclick = () => startCprFromGesture('c');
      actions.append(call, redo, go);
    }
    if (!r.practice) fillLocation($('#locBody'));
    else $('#locBody').textContent = '練習模式不定位。';
  },
};

/* ============================== CPR 引導 ============================== */
const metro = new Metronome({
  bpm: settings.bpm,
  accentEvery: 30,
  vibrate: settings.vibrate,
  sound: true,
  onBeat: onBeat,
});
let cprAutoStart = false;
const cpr = {
  startedAt: 0,
  timer: null,
  cycle: 0,
  inCycle: 0,
  total: 0,
  breathPause: null,
  lastSwapReminder: 0,
  lastCue: 0,
  muted: false,
  vent: settings.vent,
};

function onBeat({ count, accent }) {
  const ring = $('#metroRing');
  ring.classList.remove('beat', 'accent');
  void ring.offsetWidth; // 重新觸發動畫
  ring.classList.add('beat');
  if (accent) ring.classList.add('accent');
  setTimeout(() => ring.classList.remove('beat', 'accent'), 90);

  cpr.total++;
  cpr.inCycle = ((count - 1) % 30) + 1;
  $('#metroCount').textContent = String(cpr.inCycle);
  const elapsed = Date.now() - cpr.startedAt;

  if (cpr.inCycle === 30) {
    cpr.cycle++;
    if (cpr.vent) {
      // 30:2：暫停節拍給 2 口氣（約 4 秒）
      metro.stop();
      $('#metroCycle').textContent = '吹 2 口氣（每口 1 秒），然後繼續壓';
      $('#metroCount').textContent = '吹氣';
      if (!cpr.muted) voice.speak('吹兩口氣。', { rate: 1.1 });
      cpr.breathPause = setTimeout(() => {
        if (current !== 'cpr') return;
        metro.start();
        $('#metroCycle').textContent = `第 ${cpr.cycle + 1} 組`;
        if (!cpr.muted) voice.speak('繼續壓。', { rate: 1.1 });
      }, 4000);
    } else {
      $('#metroCycle').textContent = `已壓 ${cpr.total} 下・持續不要停`;
    }
  }

  // 每 2 分鐘提醒換手
  if (elapsed - cpr.lastSwapReminder >= 120000) {
    cpr.lastSwapReminder = elapsed;
    if (!cpr.muted) voice.speak('兩分鐘了。如果有人可以換手，換手。AED 到了就用。', { rate: 1.05 });
    toast('⏱ 兩分鐘：可換手，確認 AED 是否到了');
  } else if (elapsed - cpr.lastCue >= 30000 && cpr.inCycle === 10) {
    cpr.lastCue = elapsed;
    if (!cpr.muted) voice.speak('用力壓、快快壓、讓胸口回彈。', { rate: 1.1, dedupeMs: 20000 });
  }
}

function toggleMetro() {
  const btn = $('#btnMetro');
  if (metro.running) {
    metro.stop();
    clearTimeout(cpr.breathPause);
    btn.textContent = '▶ 繼續節拍';
    $('#metroCycle').textContent = '已暫停：中斷不要超過 10 秒';
  } else {
    metro.sound = !cpr.muted;
    metro.start();
    btn.textContent = '⏸ 暫停';
    $('#metroCycle').textContent = cpr.vent ? `第 ${cpr.cycle + 1} 組（30 下後吹 2 口）` : '持續壓，不要停';
    if (!cpr.muted) voice.speak('開始壓胸。跟著節拍：用力壓、快快壓。', { rate: 1.1 });
  }
}

function setStep(step) {
  $$('#stepTabs button').forEach((b) => b.classList.toggle('active', b.dataset.step === step));
  $$('.step-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === step));
  window.scrollTo(0, 0);
  if (step === 'call2') fillLocation($('#locBodyCpr'));
}

function updateBpm(bpm) {
  settings.bpm = Math.max(100, Math.min(120, bpm));
  saveSettings();
  metro.setBpm(settings.bpm);
  $('#metroBpm').textContent = String(settings.bpm);
  const out = $('#setBpmOut');
  if (out) out.textContent = String(settings.bpm);
  const rng = $('#setBpm');
  if (rng) rng.value = String(settings.bpm);
}

screens.cpr = {
  enter(params) {
    requestWakeLock();
    if (!cpr.startedAt) {
      cpr.startedAt = Date.now();
      cpr.total = 0;
      cpr.cycle = 0;
    }
    if (!cpr.timer) cpr.timer = setInterval(() => ($('#cprTimer').textContent = fmtTime(Date.now() - cpr.startedAt)), 500);
    cpr.vent = settings.vent;
    $('#ventToggle').checked = cpr.vent;
    metro.vibrate = settings.vibrate;
    updateBpm(settings.bpm);
    setStep(params.step || 'call1');
    $('#btnMetro').textContent = metro.running ? '⏸ 暫停' : '▶ 開始節拍';
    if (cprAutoStart && !metro.running) {
      cprAutoStart = false;
      toggleMetro();
    }
  },
  leave() {
    // 離開 CPR 畫面不停止節拍與計時（使用者可能只是去看 AED 地圖）；回首頁才重置
    if (parseHash().name === 'home') {
      metro.stop();
      clearTimeout(cpr.breathPause);
      clearInterval(cpr.timer);
      cpr.timer = null;
      cpr.startedAt = 0;
      voice.cancel();
    }
    releaseWakeLock();
  },
};

/* ============================== AED 地圖 ============================== */
screens.aed = {
  async enter() {
    const status = $('#aedStatus');
    const list = $('#aedList');
    list.innerHTML = '';
    const waitLeaflet = () =>
      new Promise((res) => {
        if (window.L) return res();
        const t = setInterval(() => {
          if (window.L) {
            clearInterval(t);
            res();
          }
        }, 100);
        setTimeout(() => {
          clearInterval(t);
          res();
        }, 6000);
      });
    await waitLeaflet();
    if (!ensureMap($('#map'))) {
      $('#map').innerHTML =
        '<div class="map-fallback">地圖元件載入失敗（可能離線）。下方清單仍可使用，或撥 119 詢問最近的 AED。</div>';
    }
    status.textContent = '載入 AED 資料…';
    const d = await loadAED();
    status.textContent = d.sample
      ? '⚠️ 目前為範例資料。請執行 tools/fetch_aed.py 產生 data/aed.json'
      : `AED 資料 ${d.items.length.toLocaleString()} 筆（更新：${d.updated || '—'}）`;
    const locate = async () => {
      status.textContent = '定位中…';
      try {
        const pos = await getPosition();
        lastPos = { ...pos, at: Date.now() };
        const near = nearest(d.items, pos.lat, pos.lng, 20, 5);
        renderMap(pos, near);
        list.innerHTML = near.length
          ? near
              .map(
                (a) =>
                  `<li><div class="aed-name">${escapeHtml(a.name)}</div><div class="aed-dist">${fmtKm(a.km)}</div>` +
                  `<div class="aed-addr">${escapeHtml(a.place || '')} ${escapeHtml(a.addr || '')}${a.hours ? '・' + escapeHtml(a.hours) : ''}</div>` +
                  `<a class="btn btn-outline btn-sm aed-nav" href="${navUrl(a.lat, a.lng)}" target="_blank" rel="noopener">導航</a></li>`
              )
              .join('')
          : '<li>5 公里內沒有資料。請撥 119 詢問最近的 AED。</li>';
        status.textContent = d.sample ? '⚠️ 範例資料（非真實 AED 位置）' : `最近 ${near.length} 台 AED（5 公里內）`;
      } catch (e) {
        status.textContent = '無法定位：請允許定位權限，或在地圖上手動查看。';
        renderMap(null, []);
      }
    };
    $('#btnLocate').onclick = locate;
    locate();
  },
};

/* ============================== 設定 ============================== */
screens.settings = {
  enter() {
    $('#setBpm').value = String(settings.bpm);
    $('#setBpmOut').textContent = String(settings.bpm);
    $('#setVoice').checked = settings.voice;
    $('#setVibrate').checked = settings.vibrate;
    $('#setVent').checked = settings.vent;
    $('#setMic').checked = settings.mic;
    $('#setDebug').checked = settings.debug;
    $('#setVersion').textContent = APP_VERSION;
    const ms = modelState();
    $('#setModel').textContent = ms.available ? '已載入 TF.js 模型' : ms.error ? `載入失敗：${ms.error}` : '未載入（使用啟發式判斷）';
  },
};

function bindSettings() {
  $('#setBpm').addEventListener('input', (e) => updateBpm(Number(e.target.value)));
  $('#setVoice').addEventListener('change', (e) => {
    settings.voice = e.target.checked;
    voice.setEnabled(settings.voice);
    saveSettings();
  });
  $('#setVibrate').addEventListener('change', (e) => {
    settings.vibrate = e.target.checked;
    metro.vibrate = settings.vibrate;
    saveSettings();
  });
  $('#setVent').addEventListener('change', (e) => {
    settings.vent = e.target.checked;
    saveSettings();
  });
  $('#setMic').addEventListener('change', (e) => {
    settings.mic = e.target.checked;
    saveSettings();
  });
  $('#setDebug').addEventListener('change', (e) => {
    settings.debug = e.target.checked;
    saveSettings();
  });
  $('#btnReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    saveSettings();
    screens.settings.enter();
    toast('已重設');
  });
}

function bindCpr() {
  $('#btnMetro').addEventListener('click', toggleMetro);
  $('#bpmDown').addEventListener('click', () => updateBpm(settings.bpm - 2));
  $('#bpmUp').addEventListener('click', () => updateBpm(settings.bpm + 2));
  $('#ventToggle').addEventListener('change', (e) => {
    cpr.vent = e.target.checked;
    settings.vent = cpr.vent;
    saveSettings();
  });
  $('#btnMute').addEventListener('click', () => {
    cpr.muted = !cpr.muted;
    metro.sound = !cpr.muted;
    $('#btnMute').textContent = cpr.muted ? '🔇' : '🔊';
    if (cpr.muted) voice.cancel();
  });
  $$('#stepTabs button').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.step)));
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-step-next]');
    if (n) setStep(n.dataset.stepNext);
  });
}

/* ============================== 啟動 ============================== */
function init() {
  voice.init();
  voice.setEnabled(settings.voice);
  bindSettings();
  bindCpr();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  loadModel().then((ok) => {
    if (ok) toast('AI 模型已載入');
  });
  showScreen();
}

init();

// 供測試／除錯使用
window.__cpr = { settings, cam, metro, decide, get lastResult() { return lastResult; }, set lastResult(v) { lastResult = v; } };
