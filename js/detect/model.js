/**
 * model.js — AI 模型接口（TensorFlow.js）
 *
 * 目前 repo 內沒有訓練好的模型（需要標註過的瀕死呼吸資料集，見 docs/AI_MODEL_PLAN.md）。
 * 這個模組定義了接口：
 *   - 若 ./model/model.json 存在，會動態載入 TF.js 並用它推論；
 *   - 否則 available = false，fusion.js 會只用啟發式（影像＋聲音）判斷。
 *
 * 模型輸入規格（與訓練腳本 tools/train/ 對應）：
 *   audio: log-mel 頻譜圖，64 個 mel 頻帶 × 96 個時間格（約 3 秒，16 kHz，hop 512）
 *   motion: 20 Hz 的胸口位移序列，長度 200（10 秒），z-score 正規化
 * 模型輸出：softmax [agonal, normal, none]
 */

const MODEL_URL = './model/model.json';
const TFJS_URLS = ['./vendor/tf.min.js', 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.min.js'];

let state = {
  available: false,
  loading: null,
  model: null,
  error: null,
  meta: null,
};

export function modelState() {
  return { available: state.available, error: state.error, meta: state.meta };
}

async function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('load fail ' + url));
    document.head.appendChild(s);
  });
}

/** 嘗試載入模型；不存在時安靜地回傳 false。 */
export async function loadModel() {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const head = await fetch(MODEL_URL, { method: 'HEAD', cache: 'no-store' });
      if (!head.ok) {
        state.available = false;
        return false;
      }
      if (!globalThis.tf) {
        let ok = false;
        for (const u of TFJS_URLS) {
          try {
            await loadScript(u);
            ok = true;
            break;
          } catch (e) {
            /* try next */
          }
        }
        if (!ok) throw new Error('無法載入 TensorFlow.js');
      }
      state.model = await globalThis.tf.loadLayersModel(MODEL_URL);
      try {
        const metaRes = await fetch('./model/meta.json', { cache: 'no-store' });
        if (metaRes.ok) state.meta = await metaRes.json();
      } catch (e) {
        /* optional */
      }
      state.available = true;
      return true;
    } catch (e) {
      state.error = String(e.message || e);
      state.available = false;
      return false;
    }
  })();
  return state.loading;
}

/**
 * 推論。
 * @param {object} input
 * @param {Float32Array} [input.logMel]  64×96 攤平
 * @param {Float32Array} [input.motionSeries] 長度 200
 * @returns {{available:boolean, pAgonal:number, pNormal:number, pNone:number, confidence:number}}
 */
export async function predict(input) {
  if (!state.available || !state.model) {
    return { available: false, pAgonal: 0, pNormal: 0, pNone: 0, confidence: 0 };
  }
  const tf = globalThis.tf;
  const inputs = [];
  const spec = state.meta?.inputs || ['logMel', 'motionSeries'];
  for (const name of spec) {
    if (name === 'logMel' && input.logMel) inputs.push(tf.tensor(input.logMel, [1, 64, 96, 1]));
    else if (name === 'motionSeries' && input.motionSeries) inputs.push(tf.tensor(input.motionSeries, [1, 200, 1]));
  }
  if (!inputs.length) return { available: true, pAgonal: 0, pNormal: 0, pNone: 0, confidence: 0 };
  const out = state.model.predict(inputs.length === 1 ? inputs[0] : inputs);
  const probs = Array.from(await out.data());
  inputs.forEach((t) => t.dispose());
  out.dispose();
  const [pAgonal = 0, pNormal = 0, pNone = 0] = probs;
  return { available: true, pAgonal, pNormal, pNone, confidence: Math.max(pAgonal, pNormal, pNone) };
}

/**
 * 從 MotionAnalyzer 的序列產生模型輸入（20 Hz、200 點、z-score）。
 */
export function motionSeriesFeature(series) {
  const out = new Float32Array(200);
  if (!series || !series.y || !series.y.length) return out;
  const y = series.y.slice(-200);
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  const sd = Math.sqrt(y.reduce((a, b) => a + (b - m) * (b - m), 0) / y.length) || 1;
  for (let i = 0; i < y.length; i++) out[200 - y.length + i] = (y[i] - m) / sd;
  return out;
}
