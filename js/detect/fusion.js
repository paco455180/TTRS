/**
 * fusion.js — 把影像、聲音、AI 模型的結果融合成一個判定
 *
 * 判定類別：
 *   'normal'  偵測到規律呼吸
 *   'none'    觀察期間沒有偵測到呼吸動作
 *   'agonal'  疑似瀕死呼吸（稀疏、不規則的喘息）
 *   'unknown' 訊號品質不足，無法判斷
 *
 * 安全原則（依 AHA / 台灣民眾版 CPR 指引）：
 *   只要不是「明確的規律呼吸」，一律建議撥打 119 並開始 CPR。
 *   也就是說 'none' / 'agonal' / 'unknown' 都會 recommendCPR = true。
 */

export const DEFAULT_THRESHOLDS = {
  minObservationSec: 8, // 至少觀察秒數才允許判定（指引：檢查呼吸不超過 10 秒）
  extendedObservationSec: 14, // 呼吸慢但疑似規律時，最多延長到此秒數再下結論
  minQuality: 0.35, // 低於此品質 → unknown
  normalRateMin: 8, // 正常呼吸每分鐘下限（成人靜息 12–20；放寬到 8）
  normalRateMax: 40, // 上限
  normalMinBreaths: 3, // 判定「規律呼吸」至少需要的呼吸次數
  normalRegularityMin: 0.55, // 間隔規律性（1 - CV）
  normalAmpCVMax: 0.9, // 振幅變異
  normalMaxGapSec: 7.5, // 規律呼吸中最長允許的無呼吸間隔
  normalActiveFracMin: 0.45, // 正常呼吸是連續的波形（活動比例高）；短促喘息 + 長時間平坦則很低
  agonalGapSec: 5, // 呼吸間隔超過此秒數 → 有瀕死呼吸的特徵
};

/**
 * @param {object} input
 * @param {object} input.motion  MotionAnalyzer.getMetrics() 的結果
 * @param {object} [input.audio] GaspDetector.getMetrics() 的結果
 * @param {object} [input.model] {available, pAgonal, pNormal, pNone, confidence}
 * @param {object} [input.thresholds]
 */
export function decide({ motion, audio, model, thresholds = {} }) {
  const T = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reasons = [];
  let verdict = 'unknown';
  let confidence = 0.3;

  if (!motion || !motion.ok || motion.durationSec < T.minObservationSec) {
    reasons.push('觀察時間不足');
    return finish('unknown', 0.2, reasons, motion, audio, model);
  }

  let extend = false; // 建議再多觀察幾秒（僅在「疑似規律但次數不足」時）

  if (motion.quality < T.minQuality) {
    reasons.push(qualityReason(motion));
    verdict = 'unknown';
    confidence = 0.3;
  } else {
    const { rate, regularity, ampCV, maxGapSec, breaths, durationSec } = motion;
    const rateOk = rate >= T.normalRateMin && rate <= T.normalRateMax;
    const shapeOk = ampCV <= T.normalAmpCVMax && maxGapSec <= T.normalMaxGapSec && motion.activeFrac >= T.normalActiveFracMin;

    if (breaths >= T.normalMinBreaths && rateOk && regularity >= T.normalRegularityMin && shapeOk) {
      verdict = 'normal';
      confidence = 0.55 + 0.35 * Math.min(1, (regularity - T.normalRegularityMin) / 0.35) * Math.min(1, motion.quality);
      reasons.push(`偵測到規律起伏：約 ${rate.toFixed(0)} 次/分`);
    } else if (breaths === 2 && rateOk && shapeOk) {
      // 呼吸較慢：10 秒內只看到 2 次，型態像正常呼吸 → 延長觀察；已延長過則以較低信心判為規律呼吸
      if (durationSec < T.extendedObservationSec) {
        verdict = 'unknown';
        extend = true;
        confidence = 0.4;
        reasons.push('疑似有規律起伏但次數不足，再觀察幾秒');
      } else {
        verdict = 'normal';
        confidence = 0.5 * Math.min(1, motion.quality);
        reasons.push(`偵測到緩慢但規律的起伏：約 ${rate.toFixed(0)} 次/分`);
      }
    } else if (breaths === 0) {
      verdict = 'none';
      confidence = 0.5 + 0.4 * Math.min(1, motion.quality);
      reasons.push('觀察期間沒有偵測到胸腹起伏');
    } else if (breaths === 1 && !(motion.activeFrac < 0.35 && motion.snr >= 6)) {
      // 只有一次緩慢的起伏：多半是殘留的手震／漂移，而不是喘息
      verdict = 'none';
      confidence = 0.45 + 0.3 * Math.min(1, motion.quality);
      reasons.push('觀察期間幾乎沒有胸腹起伏');
    } else {
      verdict = 'agonal';
      confidence = 0.5 + 0.3 * Math.min(1, motion.quality);
      if (breaths === 1) reasons.push('只偵測到 1 次短促起伏');
      if (maxGapSec >= T.agonalGapSec) reasons.push(`起伏之間曾間隔 ${maxGapSec.toFixed(1)} 秒`);
      if (breaths >= 3 && regularity < T.normalRegularityMin) reasons.push('起伏不規則');
      if (breaths >= 2 && motion.activeFrac < T.normalActiveFracMin) reasons.push('起伏短促、其餘時間胸口靜止（喘息樣）');
      if (ampCV > T.normalAmpCVMax) reasons.push('起伏大小忽大忽小');
      if (rate > T.normalRateMax) reasons.push('起伏過快或畫面雜訊過多');
      if (!reasons.length) reasons.push('起伏型態不像正常呼吸');
    }
  }

  // 聲音輔助
  if (audio && audio.windowSec >= 5) {
    if (audio.gaspLike) {
      reasons.push(`聽到 ${audio.bursts} 次間歇性喘息／鼾聲`);
      if (verdict === 'none' || verdict === 'unknown') {
        verdict = 'agonal';
        confidence = Math.max(confidence, 0.6);
      } else if (verdict === 'agonal') {
        confidence = Math.min(0.95, confidence + 0.15);
      } else if (verdict === 'normal') {
        // 影像說正常但聲音像喘息：降低信心並提醒再確認
        confidence = Math.min(confidence, 0.5);
        reasons.push('聲音與影像不一致，請再確認');
      }
    } else if (audio.noisy) {
      reasons.push('環境噪音大，聲音判斷略過');
    }
  }

  // AI 模型（若已載入）
  if (model && model.available && model.confidence >= 0.7) {
    const top = Object.entries({ agonal: model.pAgonal, normal: model.pNormal, none: model.pNone }).sort(
      (a, b) => b[1] - a[1]
    )[0];
    if (top && top[0] !== verdict) {
      // 模型只能把「正常」往「需要 CPR」的方向推，或在 unknown 時給答案；
      // 不允許模型把「無呼吸／瀕死呼吸」改成「正常」（安全優先）。
      if (verdict === 'unknown' || (verdict === 'normal' && top[0] !== 'normal')) {
        verdict = top[0];
        confidence = model.confidence;
        reasons.push(`AI 模型判定：${labelOf(top[0])}`);
      }
    } else if (top) {
      confidence = Math.min(0.97, Math.max(confidence, model.confidence));
      reasons.push('AI 模型結果一致');
    }
  }

  return finish(verdict, confidence, reasons, motion, audio, model, extend);
}

function finish(verdict, confidence, reasons, motion, audio, model, extend = false) {
  return {
    verdict,
    label: labelOf(verdict),
    confidence: Math.round(Math.min(0.99, Math.max(0, confidence)) * 100) / 100,
    recommendCPR: verdict !== 'normal',
    extend: extend && verdict === 'unknown',
    reasons,
    motion,
    audio,
    model,
  };
}

function qualityReason(m) {
  if (m.fps < 8) return '影像更新太慢';
  if (m.shakeFrac > 0.4) return '鏡頭晃動太大';
  if (m.bright < 15) return '畫面太暗';
  if (m.bright > 245) return '畫面過曝';
  if (m.contrast < 4) return '畫面缺乏細節（請對準衣物或皮膚紋理）';
  return '影像品質不足';
}

export function labelOf(v) {
  return {
    normal: '偵測到規律呼吸',
    none: '沒有呼吸',
    agonal: '疑似瀕死呼吸',
    unknown: '無法判斷',
  }[v] || v;
}
