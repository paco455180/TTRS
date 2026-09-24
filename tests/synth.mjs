/**
 * synth.mjs — 產生合成的胸口起伏影像序列（Node 測試用）
 *
 * 影像 = 背景紋理（可整體晃動 g(t)）+ ROI 內的胸口紋理（額外位移 d(t)）+ 感測器雜訊
 * 紋理以 1/8 像素的垂直解析度預先生成，因此能模擬次像素位移。
 */

const SUB = 8;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑的隨機紋理：寬 w、高 h*SUB */
function makeTexture(w, h, rng, { blur = 6, contrast = 40, base = 110 } = {}) {
  const H = h * SUB;
  const raw = new Float32Array(w * H);
  for (let i = 0; i < raw.length; i++) raw[i] = rng() - 0.5;
  // 分離式 box blur（水平 blur，垂直 blur*SUB）
  const tmp = new Float32Array(w * H);
  const out = new Float32Array(w * H);
  const bx = blur;
  const by = blur * SUB;
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = -bx; x <= bx; x++) s += raw[y * w + ((x + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * bx + 1);
      s += raw[y * w + ((x + bx + 1) % w)] - raw[y * w + ((x - bx + w) % w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -by; y <= by; y++) s += tmp[((y + H) % H) * w + x];
    for (let y = 0; y < H; y++) {
      out[y * w + x] = s / (2 * by + 1);
      s += tmp[((y + by + 1) % H) * w + x] - tmp[((y - by + H) % H) * w + x];
    }
  }
  // 正規化到指定對比
  let m = 0;
  for (let i = 0; i < out.length; i++) m += out[i];
  m /= out.length;
  let v = 0;
  for (let i = 0; i < out.length; i++) v += (out[i] - m) * (out[i] - m);
  const sd = Math.sqrt(v / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = base + ((out[i] - m) / sd) * contrast;
  return out;
}

/**
 * @param {object} o
 * @param {number} o.w
 * @param {number} o.h
 * @param {number} o.fps
 * @param {number} o.seconds
 * @param {(t:number)=>number} o.chest  胸口位移（像素，正=向下）
 * @param {(t:number)=>number} o.expand 胸口擴張（像素，下半往下、上半往上）
 * @param {(t:number)=>number} o.shake  全域晃動（像素）
 * @param {object} o.roi 比例 {x,y,w,h}
 * @param {number} o.noise 感測器雜訊 σ
 * @param {number} o.brightness 整體亮度基準
 * @param {number} o.contrast 紋理對比
 * @param {number} o.jitter 幀時間抖動比例
 */
export function* synthFrames(o) {
  const {
    w = 320,
    h = 240,
    fps = 15,
    seconds = 12,
    chest = () => 0,
    expand = () => 0,
    shake = () => 0,
    roi = { x: 0.18, y: 0.28, w: 0.64, h: 0.44 },
    noise = 2,
    brightness = 110,
    contrast = 35,
    jitter = 0.1,
    seed = 42,
  } = o;
  const rng = mulberry32(seed);
  const bg = makeTexture(w, h, rng, { contrast, base: brightness });
  const ch = makeTexture(w, h, rng, { contrast, base: brightness, blur: 4 });
  const x0 = Math.round(roi.x * w);
  const y0 = Math.round(roi.y * h);
  const x1 = Math.round((roi.x + roi.w) * w);
  const y1 = Math.round((roi.y + roi.h) * h);
  const midY = (y0 + y1) / 2;
  const H = h * SUB;
  const n = Math.round(seconds * fps);
  let t = 0;
  for (let f = 0; f < n; f++) {
    const g = shake(t);
    const d = chest(t);
    const e = expand(t);
    const frame = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const inRoiY = y >= y0 && y < y1;
      for (let x = 0; x < w; x++) {
        let v;
        if (inRoiY && x >= x0 && x < x1) {
          // 上半往上、下半往下的擴張
          const ex = e * ((y - midY) / ((y1 - y0) / 2));
          const sy = y - g - d - ex;
          const iy = Math.round(sy * SUB);
          v = ch[(((iy % H) + H) % H) * w + x];
        } else {
          const sy = y - g;
          const iy = Math.round(sy * SUB);
          v = bg[(((iy % H) + H) % H) * w + x];
        }
        // 高斯雜訊（Box–Muller 簡化：兩個均勻數的和）
        v += (rng() + rng() - 1) * noise * 1.7;
        frame[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    yield { gray: frame, tMs: t * 1000 };
    t += (1 / fps) * (1 + (rng() - 0.5) * 2 * jitter);
  }
}

/** 高斯脈衝（模擬單次喘息的胸口動作） */
export function pulse(t, center, width, amp) {
  const z = (t - center) / width;
  return amp * Math.exp(-0.5 * z * z);
}

export { mulberry32 };
