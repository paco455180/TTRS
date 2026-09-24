/**
 * app.js — 呼救 CPR 主程式 v0.2
 * 路由、首次導覽與權限預先授權、鏡頭呼吸檢查（手電筒／穩定度／即時起伏）、結果、
 * CPR 引導（節拍、換手倒數、AED 暫停／繼續、結束流程）、AED 地圖、設定、離線更新。
 */
import { MotionAnalyzer, DEFAULT_ROI, rgbaToGray } from './detect/motion.js';
import { GaspDetector, rmsOf } from './detect/audio.js';
import { decide, labelOf } from './detect/fusion.js';
import { loadModel, modelState, predict, motionSeriesFeature } from './detect/model.js';
import { Metronome } from './cpr/metronome.js';
import { voice } from './cpr/voice.js';
import { loadAED, nearest, fmtKm, navUrl, getPosition, ensureMap, renderMap, escapeHtml } from './aed/aed.js';

export const APP_VERSION = '0.2.0';

/* ============================== 設定 ============================== */
const DEFAULT_SETTINGS = {
  bpm: 110,
  voice: true,
  vibrate: true,
  vent: false, // 30:2
  mic: true,
  torch: true, // 太暗時自動開手電筒
  theme: 'auto', // auto | light | dark
  textScale: 1,
  debug: false,
  onboarded: false,
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
function applyAppearance() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  root.style.setProperty('--scale', String(settings.textScale || 1));
}

/* ============================== 共用工具 ============================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let toastTimer = null;
export function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function announce(text) {
  const el = $('#announcer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => (el.textContent = text), 50);
}
function haptic(pattern = 30) {
  try {
    if (settings.vibrate && navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {
    /* ignore */
  }
}
function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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

// 全域錯誤：不要讓畫面白掉
let lastErrAt = 0;
function reportError(msg) {
  if (Date.now() - lastErrAt < 8000) return;
  lastErrAt = Date.now();
  console.error(msg);
  toast('發生錯誤，功能可能受影響。若畫面異常請重新整理。', 4000);
}
window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

/* ============================== 路由 ============================== */
const screens = {};
let current = null;
let lastResult = null;
let introReturn = null;

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
  // 第一次使用先看導覽（緊急時導覽頁有「直接開始」）
  if (!settings.onboarded && name !== 'intro') {
    introReturn = name === 'home' ? null : location.hash.slice(1);
    location.replace('#intro');
    return;
  }
  const el = $(`.screen[data-screen="${name}"]`) || $('.screen[data-screen="home"]');
  const next = el.dataset.screen;
  if (current && screens[current]?.leave) screens[current].leave(next);
  $$('.screen').forEach((s) => (s.hidden = s !== el));
  current = next;
  window.scrollTo(0, 0);
  if (screens[next]?.enter) screens[next].enter(params);
}
window.addEventListener('hashchange', showScreen);

let unlocked = false;
function unlockOnce() {
  if (unlocked) return;
  unlocked = true;
  voice.unlock();
}
document.addEventListener('click', (e) => {
  unlockOnce();
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    haptic(15);
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

/* ============================== 定位 ============================== */
let lastPos = null;
function warmLocation() {
  getPosition({ timeout: 20000 })
    .then((p) => (lastPos = { ...p, at: Date.now() }))
    .catch(() => {});
}
async function fillLocation(el) {
  if (!el) return;
  try {
    el.textContent = '定位中…';
    const pos = lastPos && Date.now() - lastPos.at < 90000 ? lastPos : { ...(await getPosition()), at: Date.now() };
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
      ` <a href="${link}" target="_blank" rel="noopener">開地圖</a>` +
      near;
  } catch (e) {
    el.textContent = '無法取得定位。請直接告訴 119 你看到的路名、門牌或明顯地標。';
  }
}

/* ============================== 首次導覽 ============================== */
const intro = { slide: 0 };
function introShow(i) {
  intro.slide = Math.max(0, Math.min(2, i));
  $$('.intro-slide').forEach((s) => s.classList.toggle('active', Number(s.dataset.slide) === intro.slide));
  $$('#introDots span').forEach((d, k) => d.classList.toggle('on', k === intro.slide));
  const next = $('#btnIntroNext');
  next.innerHTML = intro.slide < 2 ? `下一步 ${icon('next')}` : `${icon('check')}開始使用`;
  if (intro.slide === 2) refreshPermStates();
  window.scrollTo(0, 0);
}
async function refreshPermStates() {
  const set = (id, state, text) => {
    const el = $(id);
    el.className = 'state ' + state;
    el.textContent = text;
  };
  if (!navigator.permissions?.query) return;
  const map = [
    ['camera', '#permCam'],
    ['microphone', '#permMic'],
    ['geolocation', '#permLoc'],
  ];
  for (const [name, id] of map) {
    try {
      const st = await navigator.permissions.query({ name });
      if (st.state === 'granted') set(id, 'ok', '已允許');
      else if (st.state === 'denied') set(id, 'no', '被拒絕');
      else set(id, '', '尚未設定');
    } catch (e) {
      /* 不支援查詢（iOS） */
    }
  }
}
async function grantPerms() {
  const btn = $('#btnGrantPerms');
  btn.disabled = true;
  const set = (id, state, text) => {
    const el = $(id);
    el.className = 'state ' + state;
    el.textContent = text;
  };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
    set('#permCam', 'ok', '已允許');
    set('#permMic', s.getAudioTracks().length ? 'ok' : 'no', s.getAudioTracks().length ? '已允許' : '未取得');
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      set('#permCam', 'ok', '已允許');
      v.getTracks().forEach((t) => t.stop());
      set('#permMic', 'no', '被拒絕（可略過）');
    } catch (e2) {
      set('#permCam', 'no', '被拒絕：請到系統設定開啟');
      set('#permMic', 'no', '被拒絕');
    }
  }
  try {
    await getPosition({ timeout: 15000 });
    set('#permLoc', 'ok', '已允許');
  } catch (e) {
    set('#permLoc', 'no', e && e.code === 1 ? '被拒絕（可略過）' : '取得失敗（可略過）');
  }
  btn.disabled = false;
  btn.innerHTML = `${icon('check')}再試一次`;
}
function finishIntro(target) {
  settings.onboarded = true;
  saveSettings();
  const to = target || introReturn || 'home';
  introReturn = null;
  location.replace('#' + to);
  showScreen();
}
screens.intro = {
  enter(params) {
    introShow(0);
    $('#btnIntroSkip').textContent = params.again ? '返回' : '略過';
  },
};

/* ============================== 檢查呼吸（鏡頭） ============================== */
const AW = 240;
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
  lastLiveAt: 0,
  liveBreaths: 0,
  torchTrack: null,
  torchOn: false,
  darkSince: 0,
  readyState: '',
  facing: 'environment',
};

function setChip(id, state, text) {
  const el = $(id);
  if (!el) return;
  el.className = 'hud-chip ' + (state || '');
  el.lastElementChild.textContent = text;
}

async function startCamera() {
  const video = $('#cam');
  const msg = $('#camMsg');
  msg.hidden = false;
  msg.innerHTML = '<div class="spin"></div><div>正在開啟鏡頭…</div>';
  $('#btnManualTimer').hidden = true;
  const videoC = { facingMode: { ideal: cam.facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  const audioC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
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
      setChip('#hudMic', '', '麥克風待機');
    } else {
      setChip('#hudMic', 'warn', settings.mic ? '無麥克風' : '麥克風關');
    }
    video.srcObject = new MediaStream(stream.getVideoTracks());
    await video.play().catch(() => {});
    msg.hidden = true;
    cam.lastFrameAt = 0;
    setupTorch(stream.getVideoTracks()[0]);
    cam.raf = requestAnimationFrame(frameLoop);
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    msg.innerHTML =
      `<div>${denied ? '相機權限被拒絕' : '無法開啟鏡頭'}</div><div class="small" style="color:#ddd">${
        denied ? '請到瀏覽器或系統設定允許相機，或改用下方的手動觀察。' : String(e.name || e)
      }</div>`;
    $('#btnManualTimer').hidden = false;
    $('#btnStartObs').disabled = true;
    setChip('#hudReady', 'bad', '沒有鏡頭');
  }
}

function setupTorch(track) {
  cam.torchTrack = null;
  cam.torchOn = false;
  const btn = $('#btnTorch');
  btn.hidden = true;
  btn.classList.remove('on');
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      cam.torchTrack = track;
      btn.hidden = false;
    }
  } catch (e) {
    /* ignore */
  }
}
async function setTorch(on) {
  if (!cam.torchTrack) return false;
  try {
    await cam.torchTrack.applyConstraints({ advanced: [{ torch: !!on }] });
    cam.torchOn = !!on;
    $('#btnTorch').classList.toggle('on', cam.torchOn);
    return true;
  } catch (e) {
    return false;
  }
}

function stopCamera() {
  cancelAnimationFrame(cam.raf);
  cam.raf = 0;
  if (cam.torchOn) setTorch(false);
  if (cam.stream) {
    cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
  }
  stopMic();
  cam.observing = false;
  cam.torchTrack = null;
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
    setChip('#hudMic', 'ok', '麥克風開');
    return true;
  } catch (e) {
    setChip('#hudMic', 'warn', '麥克風關');
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

  if (cam.analyserNode) {
    cam.analyserNode.getFloatTimeDomainData(cam.timeData);
    cam.gasp.pushLevel(rmsOf(cam.timeData), now);
  }

  cam.frames++;
  if (now - cam.fpsAt > 1000) {
    cam.fps = cam.frames / ((now - cam.fpsAt) / 1000);
    cam.frames = 0;
    cam.fpsAt = now;
    setChip('#hudFps', cam.fps >= 12 ? 'ok' : cam.fps >= 8 ? 'warn' : 'bad', `${cam.fps.toFixed(0)} fps`);
  }

  updateReadiness(sample, now);
  drawOverlay(now, sample);

  if (cam.observing) {
    const elapsed = now - cam.obsStart;
    const remain = Math.max(0, cam.obsDuration - elapsed);
    $('#liveText').textContent = `觀察中… ${Math.ceil(remain / 1000)} 秒`;
    $('#liveSub').textContent = sample.shaking ? '⚠️ 手機晃動，請拿穩' : '請保持手機穩定，看著胸口';
    if (now - cam.lastLiveAt > 500) {
      cam.lastLiveAt = now;
      const m = cam.analyzer.getMetrics();
      const lb = $('#liveBreaths');
      if (m.ok && m.durationSec >= 2) {
        cam.liveBreaths = m.breaths;
        $('#liveBreathsText').textContent = m.breaths ? `偵測到起伏 ${m.breaths} 次` : '尚未偵測到起伏';
        lb.classList.toggle('active', m.breaths > 0);
      }
    }
    if (elapsed >= cam.obsDuration) finishObservation(now);
  }
}

function updateReadiness(sample, now) {
  if (!sample) return;
  let state = 'ok';
  let text = '拿穩了，可以開始';
  if (sample.bright < 20) {
    state = 'bad';
    text = '太暗';
    if (!cam.darkSince) cam.darkSince = now;
    if (settings.torch && cam.torchTrack && !cam.torchOn && now - cam.darkSince > 800) {
      cam.darkSince = now + 5000; // 避免重複嘗試
      setTorch(true).then((ok) => ok && toast('太暗，已自動打開手電筒'));
    }
  } else {
    cam.darkSince = 0;
    if (sample.contrast < 4) {
      state = 'warn';
      text = '缺乏細節，對準衣服紋理';
    } else if (sample.shaking) {
      state = 'warn';
      text = '請拿穩';
    }
  }
  if (state + text !== cam.readyState) {
    cam.readyState = state + text;
    setChip('#hudReady', state, text);
  }
}

function drawOverlay(now, sample) {
  const c = $('#overlay');
  const wrap = $('#camWrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (!W || !H) return;
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // ROI：四角括號 + 外圍微暗
  const r = DEFAULT_ROI;
  const x = r.x * W;
  const y = r.y * H;
  const w = r.w * W;
  const h = r.h * H;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, W, y);
  ctx.fillRect(0, y + h, W, H - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, W - x - w, h);
  const L = Math.min(w, h) * 0.18;
  ctx.strokeStyle = cam.observing ? '#ffffff' : 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * L);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * L, cy);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(cam.observing ? '看著胸口，手機拿穩' : '對準胸口／上腹', x + w / 2, y - 10);
  ctx.textAlign = 'left';

  // 即時波形
  const s = cam.analyzer.samples;
  if (s.length > 5) {
    const t0 = now - 8000;
    const pts = s.filter((v) => v.t >= t0);
    if (pts.length > 2) {
      const vals = pts.map((v) => v.cumDy);
      const sorted = vals.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      const amp = Math.max(1, Math.max(...vals.map((v) => Math.abs(v - med))));
      const baseY = H - 30;
      const scale = 22 / amp;
      ctx.beginPath();
      pts.forEach((v, i) => {
        const px = 10 + ((v.t - t0) / 8000) * (W - 70);
        const py = baseY - (v.cumDy - med) * scale;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.strokeStyle = '#ffeb3b';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '12px sans-serif';
      ctx.fillText('胸口起伏', 10, H - 8);
    }
  }

  // 倒數環
  if (cam.observing) {
    const frac = Math.min(1, (now - cam.obsStart) / cam.obsDuration);
    const cx = W - 40;
    const cy = 82;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 24, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#ff5252';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.ceil((cam.obsDuration - (now - cam.obsStart)) / 1000)), cx, cy + 6);
    ctx.textAlign = 'left';
  }
}

async function beginObservation() {
  if (!cam.stream) return;
  const btn = $('#btnStartObs');
  btn.disabled = true;
  btn.innerHTML = `${icon('timer')}觀察中…`;
  $('#camGuide').hidden = true;
  $('#liveStatus').hidden = false;
  $('#liveBreathsText').textContent = '偵測起伏中';
  $('#liveBreaths').classList.remove('active');
  haptic(20);
  voice.speak('開始觀察十秒。手機拿穩，看著胸口。', { rate: 1.1 });
  await startMic();
  cam.analyzer.reset();
  cam.gasp.reset();
  cam.extended = false;
  cam.obsDuration = 10000;
  cam.obsStart = performance.now();
  cam.lastLiveAt = 0;
  cam.liveBreaths = 0;
  cam.observing = true;
}

async function finishObservation(now) {
  if (cam.finishing) return;
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
    voice.speak('疑似有呼吸，再觀察五秒。', { rate: 1.1 });
    return;
  }
  cam.observing = false;
  haptic(result.recommendCPR ? [60, 40, 60] : 40);
  lastResult = { ...result, at: Date.now(), practice: cam.practice, manual: false };
  navigate('result');
}

function startManualTimer() {
  $('#camGuide').hidden = true;
  $('#liveStatus').hidden = false;
  $('#liveBreaths').hidden = true;
  $('#btnManualTimer').hidden = true;
  let remain = 10;
  $('#liveText').textContent = `手動觀察 ${remain} 秒`;
  $('#liveSub').textContent = '看胸口有沒有規律起伏、聽有沒有正常呼吸聲';
  voice.speak('看胸口有沒有規律起伏，聽有沒有呼吸聲，十秒。', { rate: 1.1 });
  cam.manualTimer = setInterval(() => {
    remain--;
    if (remain > 0) {
      $('#liveText').textContent = `手動觀察 ${remain} 秒`;
      return;
    }
    clearInterval(cam.manualTimer);
    cam.manualTimer = null;
    $('#liveText').textContent = '10 秒到了：有「規律」的呼吸嗎？';
    $('#liveSub').textContent = '不確定就選右邊';
    const foot = $('#breathActions');
    foot.innerHTML = '';
    const yes = document.createElement('button');
    yes.className = 'btn btn-success btn-xl';
    yes.innerHTML = `${icon('check')}有規律呼吸`;
    yes.onclick = () => {
      lastResult = manualResult('normal');
      navigate('result');
    };
    const no = document.createElement('button');
    no.className = 'btn btn-primary btn-xl';
    no.innerHTML = `${icon('alert')}沒有／只有喘息／不確定 → CPR`;
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
    reasons: ['手動觀察（未使用鏡頭判讀）'],
    motion: null,
    audio: null,
    manual: true,
    at: Date.now(),
  };
}

function resetBreathFooter() {
  const foot = $('#breathActions');
  foot.innerHTML = '';
  const start = document.createElement('button');
  start.className = 'btn btn-primary btn-xl';
  start.id = 'btnStartObs';
  start.innerHTML = `${icon('camera')}開始 10 秒觀察`;
  start.onclick = beginObservation;
  const skip = document.createElement('button');
  skip.className = 'btn btn-danger-outline';
  skip.id = 'btnSkipCPR';
  skip.innerHTML = `${icon('alert')}呼吸不正常／不確定 → 立即 CPR`;
  skip.onclick = () => {
    lastResult = manualResult('unknown');
    startCprFromGesture('call2');
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
    $('#breathTitle').innerHTML = cam.practice
      ? '練習模式<small>對自己或朋友試試看</small>'
      : '檢查呼吸<small>步驟 2／3　觀察 10 秒</small>';
    resetBreathFooter();
    $('#camGuide').hidden = false;
    $('#liveStatus').hidden = true;
    $('#liveBreaths').hidden = false;
    setChip('#hudReady', '', '準備中');
    setChip('#hudMic', '', settings.mic ? '麥克風' : '麥克風關');
    setChip('#hudFps', '', '— fps');
    cam.readyState = '';
    requestWakeLock();
    startCamera();
    if (cam.practice) toast('練習模式：把框對準自己的胸口，正常呼吸、憋氣各試一次', 4000);
    else {
      warmLocation();
      voice.speak('把方框對準胸口，手機拿穩後按開始觀察。', { rate: 1.1, dedupeMs: 5000 });
    }
  },
  leave() {
    stopCamera();
    releaseWakeLock();
  },
};

/* ============================== 結果 ============================== */
function drawResultWave(series) {
  const c = $('#resultWave');
  const dpr = window.devicePixelRatio || 1;
  const W = (c.width = Math.max(1, c.clientWidth) * dpr);
  const H = (c.height = 76 * dpr);
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
    const py = H / 2 - (v / amp) * (H / 2 - 8 * dpr);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#d32f2f';
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#666';
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.fillText('觀察期間的胸口起伏', 8 * dpr, 14 * dpr);
}

function startCprFromGesture(step = 'c') {
  metro.ensureContext();
  voice.unlock();
  cprAutoStart = step === 'c';
  navigate(`cpr?step=${step}`);
}

screens.result = {
  enter() {
    const r = lastResult;
    if (!r) {
      navigate('check-breath');
      return;
    }
    const v = r.verdict;
    const card = $('#verdictCard');
    card.className = 'verdict ' + (v === 'normal' ? 'ok' : v === 'unknown' ? 'unknown' : 'cpr');
    $('#verdictIcon').innerHTML = icon(v === 'normal' ? 'check' : v === 'unknown' ? 'info' : 'alert');
    $('#verdictKicker').textContent = r.practice ? '練習模式' : r.manual ? '手動觀察' : `鏡頭判讀 ${r.motion?.durationSec ? r.motion.durationSec.toFixed(0) + ' 秒' : ''}`;
    $('#verdictTitle').textContent = r.label || labelOf(v);
    const body = {
      agonal: '這種喘息不是正常呼吸，代表心臟可能已經停止。不用再確認，現在就做：',
      none: '沒有偵測到呼吸。現在就做：',
      unknown: '無法確定，就當作沒有呼吸。對有心跳的人做 CPR 傷害很小，不做才危險。現在就做：',
      normal: '病患沒有反應但有呼吸。現在就做：',
    }[v];
    $('#verdictBody').textContent = body;
    const steps = r.recommendCPR
      ? ['撥打 119，開擴音放旁邊。', '請旁人去拿 AED。', '開始壓胸：用力壓、快快壓，不要停。']
      : ['撥打 119。', '讓他側躺（復甦姿勢），避免嘔吐物嗆到。', '每分鐘看一次胸口；呼吸一停或變成喘息，立刻開始 CPR。'];
    $('#nextSteps').innerHTML = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    $('#verdictReasons').innerHTML = (r.reasons || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    const m = r.motion;
    const chips = [];
    if (m && m.ok) {
      chips.push(`起伏 ${m.breaths} 次／${m.durationSec.toFixed(0)} 秒`);
      if (m.breaths) chips.push(`約 ${m.rate.toFixed(0)} 次/分`);
      chips.push(`影像品質 ${(m.quality * 100).toFixed(0)}%`);
      if (settings.debug) {
        chips.push(`規律 ${(m.regularity * 100).toFixed(0)}%`);
        chips.push(`活動比 ${(m.activeFrac * 100).toFixed(0)}%`);
        chips.push(`訊號 ${m.signalName} snr ${m.snr.toFixed(1)}`);
        chips.push(`抖動 ${m.jitter?.toFixed(2)} px`);
        chips.push(`${m.fps.toFixed(0)} fps`);
      }
    }
    if (r.audio) chips.push(`喘息聲 ${r.audio.bursts} 次${r.audio.noisy ? '（噪音大）' : ''}`);
    if (r.confidence) chips.push(`系統信心 ${(r.confidence * 100).toFixed(0)}%`);
    $('#verdictMetrics').innerHTML = chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('');
    drawResultWave(m && m.series);

    const actions = $('#resultActions');
    actions.innerHTML = '';
    const call = document.createElement('a');
    call.className = 'btn btn-call btn-xl';
    call.href = 'tel:119';
    call.innerHTML = `${icon('phone')}撥打 119（開擴音）`;
    if (r.recommendCPR) {
      const go = document.createElement('button');
      go.className = 'btn btn-primary btn-xl';
      go.innerHTML = `${icon('hand')}開始壓胸（節拍引導）`;
      go.onclick = () => startCprFromGesture('c');
      const redo = document.createElement('button');
      redo.className = 'btn btn-ghost';
      redo.textContent = '重新檢查';
      redo.onclick = () => navigate('check-breath' + (r.practice ? '?practice=1' : ''));
      actions.append(call, go, redo);
      voice.speak('沒有正常呼吸。立刻撥打一一九，然後開始壓胸。', { rate: 1.05 });
      announce('沒有正常呼吸，請撥打 119 並開始 CPR');
    } else {
      const redo = document.createElement('button');
      redo.className = 'btn btn-outline btn-xl';
      redo.innerHTML = `${icon('refresh')}再檢查一次呼吸`;
      redo.onclick = () => navigate('check-breath' + (r.practice ? '?practice=1' : ''));
      const go = document.createElement('button');
      go.className = 'btn btn-ghost';
      go.textContent = '情況變了 → 開始 CPR';
      go.onclick = () => startCprFromGesture('c');
      actions.append(call, redo, go);
      voice.speak('偵測到規律呼吸。撥打一一九，讓他側躺，持續觀察。', { rate: 1.05 });
      announce('偵測到規律呼吸，請撥打 119 並持續觀察');
    }
    if (!r.practice) fillLocation($('#locBody'));
    else $('#locBody').textContent = '練習模式不定位。';

    // 有規律呼吸：每 60 秒提醒再看一次胸口
    clearInterval(recheckTimer);
    const rc = $('#recheckTimer');
    rc.hidden = true;
    rc.classList.remove('due');
    if (!r.recommendCPR && !r.practice) {
      let left = 60;
      rc.hidden = false;
      rc.lastElementChild.textContent = `下次檢查呼吸：${left} 秒後`;
      recheckTimer = setInterval(() => {
        left--;
        if (left > 0) {
          rc.lastElementChild.textContent = `下次檢查呼吸：${left} 秒後`;
          return;
        }
        rc.classList.add('due');
        rc.lastElementChild.textContent = '一分鐘到了：再看一次胸口有沒有起伏';
        voice.speak('一分鐘了，再看一次胸口有沒有起伏。沒有就開始壓胸。', { rate: 1.05 });
        haptic([60, 40, 60]);
        left = 60;
        setTimeout(() => rc.classList.remove('due'), 8000);
      }, 1000);
    }
  },
  leave() {
    clearInterval(recheckTimer);
  },
};
let recheckTimer = null;

/* ============================== CPR 引導 ============================== */
const metro = new Metronome({ bpm: settings.bpm, accentEvery: 30, vibrate: settings.vibrate, sound: true, onBeat });
let cprAutoStart = false;
const cpr = {
  startedAt: 0,
  timer: null,
  cycle: 0,
  inCycle: 0,
  total: 0,
  breathPause: null,
  swapStartedAt: 0,
  swapDue: false,
  lastCue: 0,
  muted: false,
  vent: settings.vent,
  shocks: 0,
  aedUsed: false,
  homeTapAt: 0,
};

function onBeat({ count, accent }) {
  const ring = $('#metroRing');
  const echo = $('#metroEcho');
  ring.classList.remove('beat', 'accent', 'paused');
  void ring.offsetWidth;
  ring.classList.add('beat');
  if (accent) ring.classList.add('accent');
  echo.classList.remove('go');
  void echo.offsetWidth;
  echo.classList.add('go');
  setTimeout(() => ring.classList.remove('beat', 'accent'), 100);

  cpr.total++;
  cpr.inCycle = ((count - 1) % 30) + 1;
  $('#metroCount').textContent = String(cpr.inCycle);
  $('#metroCount').classList.remove('text');
  $('#metroLabel').textContent = '壓';
  $('#statTotal').textContent = String(cpr.total);

  if (cpr.inCycle === 30) {
    cpr.cycle++;
    $('#statCycles').textContent = String(cpr.cycle);
    if (cpr.vent) {
      metro.stop();
      $('#metroRing').classList.add('paused');
      $('#metroCycle').textContent = '吹 2 口氣（每口 1 秒），然後繼續壓';
      $('#metroCount').textContent = '吹氣';
      $('#metroCount').classList.add('text');
      $('#metroLabel').textContent = '2 口';
      if (!cpr.muted) voice.speak('吹兩口氣。', { rate: 1.1 });
      cpr.breathPause = setTimeout(() => {
        if (current !== 'cpr') return;
        metro.start();
        $('#metroCycle').textContent = `第 ${cpr.cycle + 1} 組`;
        if (!cpr.muted) voice.speak('繼續壓。', { rate: 1.1 });
      }, 4000);
    } else {
      $('#metroCycle').textContent = '持續壓，不要停';
    }
  }
  const elapsed = Date.now() - cpr.startedAt;
  if (elapsed - cpr.lastCue >= 30000 && cpr.inCycle === 10) {
    cpr.lastCue = elapsed;
    if (!cpr.muted) voice.speak('用力壓、快快壓、讓胸口回彈。', { rate: 1.1, dedupeMs: 20000 });
  }
}

function tickCpr() {
  if (!cpr.startedAt) return;
  $('#cprTimer').textContent = fmtTime(Date.now() - cpr.startedAt);
  $('#cprTimerSub').textContent = cpr.total ? `已壓 ${cpr.total} 下` : 'CPR 計時';
  // 換手倒數（節拍進行中才計）
  if (metro.running && cpr.swapStartedAt) {
    const left = 120000 - (Date.now() - cpr.swapStartedAt);
    if (left <= 0) {
      cpr.swapStartedAt = Date.now();
      $('#swapTimer').textContent = '2:00';
      $('#statSwap').classList.add('alert');
      if (!cpr.muted) voice.speak('兩分鐘了。如果有人可以換手，換手。AED 到了就用。', { rate: 1.05 });
      toast('⏱ 兩分鐘：可換手，確認 AED 是否到了', 4000);
      haptic([80, 60, 80]);
      setTimeout(() => $('#statSwap').classList.remove('alert'), 6000);
    } else {
      const s = Math.ceil(left / 1000);
      $('#swapTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
  }
}

function startMetro() {
  metro.sound = !cpr.muted;
  metro.vibrate = settings.vibrate;
  metro.start();
  if (!cpr.swapStartedAt) cpr.swapStartedAt = Date.now();
  $('#btnMetro').innerHTML = `${icon('pause')}暫停`;
  $('#metroRing').classList.remove('paused');
  $('#metroCycle').textContent = cpr.vent ? `第 ${cpr.cycle + 1} 組（30 下後吹 2 口）` : '持續壓，不要停';
  if (!cpr.muted) voice.speak('開始壓胸。跟著節拍：用力壓、快快壓。', { rate: 1.1 });
}
function stopMetro(label = '已暫停：中斷不要超過 10 秒') {
  metro.stop();
  clearTimeout(cpr.breathPause);
  $('#btnMetro').innerHTML = `${icon('play')}繼續節拍`;
  $('#metroRing').classList.add('paused');
  $('#metroCycle').textContent = label;
  $('#metroLabel').textContent = '暫停';
}
function toggleMetro() {
  if (metro.running) stopMetro();
  else startMetro();
}

function setStep(step) {
  const order = ['call1', 'call2', 'c', 'a', 'b', 'd'];
  const idx = order.indexOf(step);
  $$('#stepTabs button').forEach((b) => {
    const i = order.indexOf(b.dataset.step);
    b.classList.toggle('active', b.dataset.step === step);
    b.classList.toggle('done', idx >= 0 && i < idx && i < 2);
  });
  $$('.step-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === step));
  window.scrollTo(0, 0);
  if (step === 'call2') {
    fillLocation($('#locBodyCpr'));
    if (!cpr.muted) voice.speak('撥打一一九，開擴音。請旁人去拿 AED。', { rate: 1.05, dedupeMs: 8000 });
  }
  if (step === 'd') cpr.aedUsed = true;
  if (step === 'end') {
    const mins = cpr.startedAt ? fmtTime(Date.now() - cpr.startedAt) : '—';
    $('#endSummary').innerHTML = `本次紀錄：CPR 共 <b>${mins}</b>，壓胸約 <b>${cpr.total}</b> 下${cpr.aedUsed ? '，已使用 AED' : ''}。`;
  }
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

function resetCpr() {
  metro.stop();
  clearTimeout(cpr.breathPause);
  clearInterval(cpr.timer);
  Object.assign(cpr, { startedAt: 0, timer: null, cycle: 0, inCycle: 0, total: 0, swapStartedAt: 0, lastCue: 0, shocks: 0, aedUsed: false });
  voice.cancel();
}

screens.cpr = {
  enter(params) {
    requestWakeLock();
    if (!cpr.startedAt) cpr.startedAt = Date.now();
    if (!cpr.timer) cpr.timer = setInterval(tickCpr, 500);
    cpr.vent = settings.vent;
    $('#ventToggle').checked = cpr.vent;
    updateBpm(settings.bpm);
    $('#statTotal').textContent = String(cpr.total);
    $('#statCycles').textContent = String(cpr.cycle);
    setStep(params.step || 'call1');
    $('#btnMetro').innerHTML = metro.running ? `${icon('pause')}暫停` : `${icon('play')}${cpr.total ? '繼續節拍' : '開始節拍'}`;
    if (cprAutoStart && !metro.running) {
      cprAutoStart = false;
      startMetro();
    }
    tickCpr();
  },
  leave(next) {
    if (next === 'home' || next === 'intro') resetCpr();
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
    status.textContent = '載入地圖與 AED 資料…';
    await waitLeaflet();
    if (!ensureMap($('#map'))) {
      $('#map').innerHTML = '<div class="map-fallback">地圖元件載入失敗（可能離線）。下方清單仍可使用，或撥 119 詢問最近的 AED。</div>';
    }
    const d = await loadAED();
    const locate = async () => {
      status.textContent = '定位中…';
      try {
        const pos = await getPosition();
        lastPos = { ...pos, at: Date.now() };
        const near = nearest(d.items, pos.lat, pos.lng, 20, 5);
        renderMap(pos, near);
        list.innerHTML = near.length
          ? near
              .map((a) => {
                const walkMin = Math.max(1, Math.round((a.km * 1000) / 80));
                return (
                  `<li><div class="aed-name">${escapeHtml(a.name)}</div>` +
                  `<div class="aed-dist">${fmtKm(a.km)}<small>步行約 ${walkMin} 分</small></div>` +
                  `<div class="aed-addr">${escapeHtml(a.place || '')} ${escapeHtml(a.addr || '')}</div>` +
                  (a.hours ? `<div class="aed-hours">${escapeHtml(a.hours)}</div>` : '') +
                  `<a class="btn btn-call btn-sm aed-nav" href="${navUrl(a.lat, a.lng)}" target="_blank" rel="noopener">${icon('nav')}導航</a></li>`
                );
              })
              .join('')
          : '<li>5 公里內沒有資料。請撥 119 詢問最近的 AED。</li>';
        status.textContent = d.sample ? '⚠️ 範例資料（非真實 AED 位置）' : `最近 ${near.length} 台（5 公里內）・資料 ${d.updated || ''}`;
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
function syncSeg(id, value) {
  $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));
}
screens.settings = {
  enter() {
    $('#setBpm').value = String(settings.bpm);
    $('#setBpmOut').textContent = String(settings.bpm);
    $('#setVoice').checked = settings.voice;
    $('#setVibrate').checked = settings.vibrate;
    $('#setVent').checked = settings.vent;
    $('#setMic').checked = settings.mic;
    $('#setTorch').checked = settings.torch;
    $('#setDebug').checked = settings.debug;
    syncSeg('segTheme', settings.theme);
    syncSeg('segText', settings.textScale);
    $('#setVersion').textContent = APP_VERSION;
    const ms = modelState();
    $('#setModel').textContent = ms.available ? '已載入 TF.js 模型' : ms.error ? `載入失敗：${ms.error}` : '未載入（啟發式判斷）';
  },
};

function bindSettings() {
  $('#setBpm').addEventListener('input', (e) => updateBpm(Number(e.target.value)));
  const bindChk = (id, key, after) =>
    $(id).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveSettings();
      if (after) after();
    });
  bindChk('#setVoice', 'voice', () => voice.setEnabled(settings.voice));
  bindChk('#setVibrate', 'vibrate', () => (metro.vibrate = settings.vibrate));
  bindChk('#setVent', 'vent');
  bindChk('#setMic', 'mic');
  bindChk('#setTorch', 'torch');
  bindChk('#setDebug', 'debug');
  $('#segTheme').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.theme = b.dataset.v;
    saveSettings();
    applyAppearance();
    syncSeg('segTheme', settings.theme);
  });
  $('#segText').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.textScale = Number(b.dataset.v);
    saveSettings();
    applyAppearance();
    syncSeg('segText', settings.textScale);
  });
  $('#btnIntroAgain').addEventListener('click', () => navigate('intro?again=1'));
  $('#btnReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS, { onboarded: true });
    saveSettings();
    applyAppearance();
    screens.settings.enter();
    toast('已重設');
  });
}

function bindIntro() {
  $('#btnIntroNext').addEventListener('click', () => {
    if (intro.slide < 2) return introShow(intro.slide + 1);
    if (!$('#chkAgree').checked) {
      toast('請先勾選「我了解…」再開始');
      $('#chkAgree').focus();
      return;
    }
    finishIntro();
  });
  $('#btnIntroSkip').addEventListener('click', () => finishIntro('home'));
  $('#btnIntroEmergency').addEventListener('click', () => finishIntro('check-respond'));
  $('#btnGrantPerms').addEventListener('click', grantPerms);
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
    $('#btnMute').innerHTML = icon(cpr.muted ? 'mute' : 'vol');
    if (cpr.muted) voice.cancel();
    toast(cpr.muted ? '已靜音（節拍與語音）' : '已開啟聲音');
  });
  $('#btnCprHome').addEventListener('click', () => {
    if (!metro.running || Date.now() - cpr.homeTapAt < 3000) {
      navigate('home');
      return;
    }
    cpr.homeTapAt = Date.now();
    toast('節拍進行中：再按一次才會回首頁並停止');
  });
  $('#btnToEnd').addEventListener('click', () => {
    stopMetro('已停止');
    setStep('end');
  });
  $('#btnAedPause').addEventListener('click', () => {
    stopMetro('AED 分析中：所有人不要碰病患');
    if (!cpr.muted) voice.speak('AED 分析中，所有人離開，不要碰病患。', { rate: 1.05 });
  });
  $('#btnAedResume').addEventListener('click', () => {
    cpr.shocks++;
    metro.ensureContext();
    setStep('c');
    startMetro();
  });
  $('#btnCprFinish').addEventListener('click', () => navigate('home'));
  $$('#stepTabs button').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.step)));
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-step-next]');
    if (n) setStep(n.dataset.stepNext);
  });
  $('#btnTorch').addEventListener('click', () => setTorch(!cam.torchOn));
  $('#btnFlip').addEventListener('click', () => {
    if (cam.observing) return toast('觀察中無法切換鏡頭');
    cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
    stopCamera();
    cam.analyzer.reset();
    startCamera();
  });
}

/* ============================== Service worker 更新 ============================== */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      const offer = (worker) => {
        const bar = $('#updateBar');
        bar.hidden = false;
        $('#btnUpdate').onclick = () => {
          bar.hidden = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        };
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });
      // 每次回到前景檢查更新
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

/* ============================== 啟動 ============================== */
function init() {
  applyAppearance();
  voice.init();
  voice.setEnabled(settings.voice);
  bindSettings();
  bindIntro();
  bindCpr();
  setupServiceWorker();
  loadModel().then((ok) => {
    if (ok) toast('AI 模型已載入');
  });
  showScreen();
  window.addEventListener('resize', () => {
    if (current === 'result' && lastResult) drawResultWave(lastResult.motion && lastResult.motion.series);
  });
}

init();

// 測試／除錯用
window.__cpr = {
  settings,
  cam,
  metro,
  decide,
  cpr,
  get lastResult() {
    return lastResult;
  },
  set lastResult(v) {
    lastResult = v;
  },
};
