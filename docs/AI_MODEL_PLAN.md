# AI 模型計畫：瀕死呼吸辨識

目標：用一個小型模型（可在手機瀏覽器以 TensorFlow.js 推論、< 5 MB、< 100 ms）把「聲音 + 胸口起伏」分成
**agonal（瀕死呼吸）／normal（正常呼吸）／none（沒有呼吸）**，取代目前的啟發式規則，並保留 `fusion.js` 的安全原則（模型不能推翻「需要 CPR」）。

## 1. 為什麼先做聲音模型

- 華盛頓大學團隊（Chan et al., *npj Digital Medicine* 2019）用 **911 報案電話錄音中的瀕死呼吸片段**（162 通電話、236 段）訓練分類器（VGGish 特徵 + SVM），在智慧音箱／手機上做到 **敏感度 97.2%、特異度 99.5%**，距離 3 公尺內仍可用。這證明聲音特徵足以辨識瀕死呼吸。
- 該資料集因涉及 911 錄音隱私 **不公開**；台灣需要自己建資料集，最可行的來源是 **消防局 119 報案錄音**（同樣需要 IRB 與去識別化）。
- 影像端（胸口起伏）目前沒有公開的瀕死呼吸影片資料集；先以規則法為主，模型當第二階段。

## 2. 資料收集

| 類別 | 來源 | 預估量 | 備註 |
| --- | --- | --- | --- |
| agonal（正樣本） | 119 報案錄音（與消防局／衛生局合作，IRB 核准）；急診／ICU 監視錄影（需病患家屬同意）；醫學教育影片（需授權） | ≥ 200 段、每段 3–10 秒 | 由急診醫師標註「瀕死呼吸／非瀕死呼吸」，兩人以上一致才採用 |
| normal | 志願者正常呼吸（躺姿、各種衣物、距離 30–100 cm、室內外噪音） | ≥ 2,000 段 | 用本 app 的「練習模式」錄製（需加錄製功能與同意書） |
| none | 志願者憋氣；CPR 假人；空景 | ≥ 1,000 段 | |
| 負樣本（噪音） | 說話、哭喊、交通、風聲、鼾聲（睡眠打鼾 ≠ 瀕死呼吸，要特別收） | ≥ 2,000 段 | 降低誤報最關鍵 |

資料增強（沿用 UW 的作法）：不同距離重播錄音、加入環境噪音（SNR 0–20 dB）、不同手機麥克風、時間伸縮 ±10%、音量 ±6 dB。

## 3. 特徵與模型

### 聲音分支
- 16 kHz 單聲道 → log-mel 頻譜圖：64 mel、hop 512（約 32 ms）、3 秒視窗 → 64×96。
- 模型：小型 CNN（4 層 depthwise-separable conv + global pooling）或蒸餾後的 YAMNet；輸出 3 類 softmax。
- 也可先用 YAMNet 嵌入（1024-d）+ 邏輯迴歸做基線。

### 影像分支
- `motion.js` 的 20 Hz 位移序列（10 秒 = 200 點，z-score）。
- 模型：1-D CNN 或 GRU，輸出 3 類。訓練資料可先用合成訊號（`tests/synth.mjs` 的產生器）預訓練，再用真人資料微調。

### 融合
- 晚期融合（各分支機率加權）或把兩分支嵌入串接後接全連接層。
- `model/meta.json` 描述輸入順序，例如 `{"inputs": ["logMel", "motionSeries"]}`；只有一個分支時也能用。

## 4. 訓練流程（`tools/train/`）

```bash
pip install tensorflow tensorflowjs librosa numpy scikit-learn
python tools/train/train_audio.py --data data/audio --out build/audio_model   # Keras
tensorflowjs_converter --input_format keras build/audio_model/model.h5 model/  # → model/model.json + 權重
```

`tools/train/train_audio.py` 是可執行的範本（資料夾結構 `data/audio/{agonal,normal,none,noise}/*.wav`），含 log-mel 前處理、增強、訓練、混淆矩陣輸出。

## 5. 評估標準（上線門檻）

- **敏感度優先**：對 agonal + none 合併（= 需要 CPR）的敏感度 ≥ 98%（漏掉一個心跳停止的代價遠高於多做一次 CPR）。
- 特異度（正常呼吸被判成需要 CPR）≥ 90% 即可接受；因為即使誤判，使用者仍會撥 119、接線員會再確認。
- 打鼾、哭喊、說話等負樣本的誤報率 < 2%。
- 以「人」為單位切分訓練／驗證／測試集，避免同一人資料洩漏。
- 手機端延遲 < 100 ms（TF.js WebGL backend，iPhone 11 / 中階 Android 實測）。

### app 端待實作
- `js/detect/model.js` 目前只會把 `motionSeries`（影像分支）送進模型；瀏覽器端的 log-mel 擷取（AudioWorklet 收音 → STFT → mel 濾波器）尚未實作，
  訓練聲音模型後需補上，並與 `tools/train/train_audio.py` 的前處理參數（16 kHz、n_fft 2048、hop 512、64 mel、fmin 50、fmax 6000）完全一致。

## 6. 上線與監控

- 模型放在 `model/`（`model.json` + `group1-shard*.bin` + `meta.json`），`sw.js` 會快取。
- App 端記錄（僅在使用者同意下）匿名的判讀結果與特徵摘要，用於後續改善；**不記錄原始影音**。
- 每次改模型都要重跑 `tests/` 的合成案例，並在 `docs/ROADMAP.md` 的真人測試集上重新驗證。

## 7. 倫理與法規
- 119 錄音與臨床影像屬敏感個資：需 IRB、去識別化、資料使用契約；訓練後的模型不含可識別資訊。
- 模型一旦用於「協助判斷是否心跳停止」，在台灣可能被視為醫療器材軟體（見 `docs/REGULATORY.md`）；建議在設計初期即諮詢食藥署「智慧醫療器材專案辦公室」。
