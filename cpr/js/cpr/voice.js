/**
 * voice.js — 語音口令（Web Speech API, zh-TW）
 *
 * 語音是「輔助」：節拍聲仍以 WebAudio 為主，語音只在關鍵時刻簡短提示，避免蓋過節拍。
 */

const state = {
  enabled: true,
  voice: null,
  ready: false,
  lastText: '',
  lastAt: 0,
};

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  const prefer = ['zh-TW', 'zh_TW', 'zh-Hant', 'cmn-Hant-TW'];
  for (const p of prefer) {
    const v = voices.find((x) => (x.lang || '').replace('_', '-').toLowerCase() === p.toLowerCase());
    if (v) return v;
  }
  return voices.find((x) => (x.lang || '').toLowerCase().startsWith('zh')) || null;
}

export const voice = {
  init() {
    if (!('speechSynthesis' in window)) return false;
    state.voice = pickVoice();
    speechSynthesis.onvoiceschanged = () => {
      state.voice = pickVoice();
    };
    state.ready = true;
    return true;
  },
  setEnabled(on) {
    state.enabled = !!on;
    if (!on) this.cancel();
  },
  get enabled() {
    return state.enabled;
  },
  /**
   * @param {string} text
   * @param {object} opts
   * @param {boolean} opts.interrupt 取消目前正在說的
   * @param {number} opts.rate 語速
   * @param {number} opts.dedupeMs 相同句子在此毫秒內不重複
   */
  speak(text, opts = {}) {
    if (!state.enabled || !state.ready) return;
    const now = Date.now();
    if (opts.dedupeMs && state.lastText === text && now - state.lastAt < opts.dedupeMs) return;
    state.lastText = text;
    state.lastAt = now;
    try {
      if (opts.interrupt !== false) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      if (state.voice) u.voice = state.voice;
      u.rate = opts.rate ?? 1.05;
      u.pitch = 1;
      u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) {
      /* ignore */
    }
  },
  /** iOS 需要在使用者手勢內先說過一次才會解鎖；在點擊事件內呼叫 */
  unlock() {
    if (!state.ready) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) {
      /* ignore */
    }
  },
  cancel() {
    try {
      speechSynthesis.cancel();
    } catch (e) {
      /* ignore */
    }
  },
};
