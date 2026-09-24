# 呼救 CPR — 瀕死呼吸辨識與 CPR 引導 PWA

> 有人倒下、叫不醒？打開 app、把鏡頭對準胸口 10 秒，app 協助判斷「有沒有正常呼吸」，
> 然後一鍵撥 119、跟著節拍壓胸、找最近的 AED。

這是一個 **可安裝的網頁 app（PWA）**：不用上架也能用手機瀏覽器打開，之後可用 Capacitor 包成 iOS / Android app 上架。
所有影像與聲音都 **在手機上即時分析，不上傳、不儲存**。

---

## 功能

| 模組 | 內容 |
| --- | --- |
| 叫：確認反應 | 拍肩呼喊指引，兩鍵分流（有反應／沒反應） |
| 檢查呼吸（鏡頭） | 鏡頭對準胸口／上腹，10 秒內分析起伏的**頻率、規律性、型態**；手震補償；畫質不足會提示 |
| 麥克風輔助 | 偵測間歇性的喘息／鼾聲爆發（瀕死呼吸的聲音特徵），作為輔助證據 |
| 引導式比對 | 「瀕死呼吸長什麼樣子」動畫與描述，讓民眾一邊看一邊比對；沒有鏡頭也能用 10 秒手動計時 |
| AI 模型接口 | `model/model.json` 存在時自動載入 TensorFlow.js 模型推論（訓練計畫見 `docs/AI_MODEL_PLAN.md`） |
| 判讀結果 | 四種結果：規律呼吸／沒有呼吸／疑似瀕死呼吸／無法判斷。**除了「規律呼吸」以外一律建議 119 + CPR** |
| CPR 引導 | 叫叫CABD 分頁；100–120 下/分節拍器（聲音＋震動＋畫面脈動）；語音口令；30:2 模式；每 2 分鐘換手提醒；計時；螢幕常亮 |
| 一鍵 119 | 每個畫面右上角都有；結果頁與求救頁顯示 GPS 座標與最近 AED，方便告訴接線員 |
| AED 地圖 | Leaflet + OpenStreetMap；衛福部 AED 開放資料（每日更新）；最近 20 台清單與導航連結 |
| 離線 | Service worker 快取 app 殼層，急救現場沒網路也能開（地圖圖磚除外） |

## v0.2 新增（2026-09）

- 全新視覺：設計系統（淺色／深色／自動、三段字體大小）、SVG 圖示與插畫（拍肩、鏡頭定位、手位、AED 貼片、復甦姿勢）、步驟進度條、畫面轉場。
- 首次使用導覽：三頁說明 + **一次預先允許相機／麥克風／定位**（緊急時不再跳權限視窗）+ 免責確認；導覽頁有「現在就有人倒下 → 直接開始」。
- 鏡頭檢查：四角括號取景框、穩定度／亮度／細節即時提示、**太暗自動開手電筒**（可手動切換）、前後鏡頭切換（練習用）、觀察中即時顯示「偵測到起伏 N 次」、倒數環。
- 結果頁：判讀 → 三步驟該做什麼；「規律呼吸」時每 60 秒語音提醒再看胸口。
- CPR：節拍脈衝動畫、已壓次數／組數、**換手倒數 2:00**、AED 分析暫停／繼續、結束流程（復甦姿勢 / 救護接手摘要）、回首頁需連按兩次防誤觸。
- AED：步行時間估計、開放時間。
- 離線：service worker 更新提示（有新版本 → 一鍵更新）；全域錯誤提示；語音貫穿流程（可靜音）。

## 安全設計原則

1. **寧可多做 CPR**。判讀邏輯（`js/detect/fusion.js`）只有在「明確、連續、規律的起伏」時才回報「規律呼吸」；其他一律建議 CPR。
2. **AI 不能推翻「需要 CPR」**。模型只能把「正常」改成「需要 CPR」或在無法判斷時給答案，不能反向。
3. **永遠有人工出口**。鏡頭畫面下方永遠有「呼吸不正常／不確定 → 立即 CPR」，不用等 10 秒。
4. **不取代 119**。所有畫面都能一鍵撥打 119，並提醒開擴音、照接線員指示。
5. 判讀依據 2025 AHA 成人 BLS 指引與台灣民眾版 CPR：無反應 + 無呼吸或只有喘息 → 視為心跳停止；檢查呼吸不超過 10 秒；壓胸 100–120 下/分、深 5–6 公分。

---

## 快速開始

鏡頭與麥克風需要 **HTTPS 或 localhost**。

```bash
# 1. 本機預覽（電腦）
python3 -m http.server 8080     # 或 npm run serve
# 開 http://localhost:8080

# 2. 手機實測（三選一）
#   a. 部署到任何靜態主機：GitHub Pages / Netlify / Vercel / Cloudflare Pages（都是 HTTPS）
#   b. 用 ngrok / cloudflared 把本機 8080 打成 HTTPS 網址
#   c. Android：chrome://flags → "Insecure origins treated as secure" 加入 http://<你的電腦IP>:8080

# 3. 手機瀏覽器開啟 → 「加入主畫面」即成為 app
```

**手把手的上網／手機安裝步驟（GitHub Pages、Netlify）見 `docs/DEPLOY.md`。** 專案已附 `.github/workflows/pages.yml`：推上 GitHub 後會自動部署到 GitHub Pages，並每天自動更新 AED 資料。

### 改版時
- 改任何檔案後把 `sw.js` 的 `VERSION` 一起改（例如 `cpr-v0.1.1`），舊快取才會被清掉。
- `js/app.js` 的 `APP_VERSION` 顯示在設定頁。

### 更新 AED 資料

```bash
python3 tools/fetch_aed.py            # 下載衛福部開放資料 → data/aed.json（約 1–3 MB）
# 官方欄位若改名：python3 tools/fetch_aed.py --map name=場所名稱,lat=緯度,lng=經度
```

沒有 `data/aed.json` 時 app 會用 `data/aed.sample.json`（範例資料，畫面會標示）。建議用 CI（GitHub Actions 每日排程）自動更新後部署。

### 測試

```bash
npm test                 # 單元測試：合成影像 → 呼吸辨識 → 判讀（20 個案例）
npm run e2e:video        # 產生假鏡頭影片（需要 numpy）
npm run e2e              # Playwright + Chromium 假鏡頭端對端測試（需要 playwright）
```

`tests/` 內含合成的「規律呼吸／沒有呼吸／稀疏喘息／手震／太暗」等情境，改演算法後先跑這些。

---

## 專案結構

```
index.html                app 殼層（所有畫面）
css/app.css
js/app.js                 路由、鏡頭流程、結果、CPR 引導、AED、設定
js/detect/signal.js       訊號處理工具（位移估計、峰值、去趨勢…）
js/detect/motion.js       鏡頭：胸口起伏分析（可在 Node 測試）
js/detect/audio.js        麥克風：喘息聲爆發偵測
js/detect/fusion.js       判讀融合與門檻（安全原則在這裡）
js/detect/model.js        TensorFlow.js 模型接口
js/cpr/metronome.js       WebAudio 節拍器
js/cpr/voice.js           語音口令（Web Speech API）
js/aed/aed.js             AED 資料載入、距離、地圖
data/aed.sample.json      範例 AED 資料
manifest.webmanifest, sw.js, icons/
tools/fetch_aed.py        下載並轉換 AED 開放資料
tools/make_icons.py       產生圖示
tools/train/              AI 模型訓練腳本（Keras → TF.js）
tests/                    單元測試、合成資料、Playwright 端對端測試
docs/ALGORITHM.md         呼吸辨識演算法與門檻說明
docs/AI_MODEL_PLAN.md     AI 模型：資料收集、標註、訓練、驗證、上線
docs/REGULATORY.md        醫療器材法規、免責、隱私、上架注意事項
docs/ROADMAP.md           上架前待辦與臨床驗證計畫
docs/DEPLOY.md            部署到 GitHub Pages／Netlify、手機安裝步驟
.github/workflows/        GitHub Actions：自動部署 + 每日更新 AED 資料
```

---

## 上架（App Store / Google Play）

PWA 可直接用瀏覽器安裝；要上架請用 **Capacitor** 包裝：

```bash
npm i -D @capacitor/core @capacitor/cli
npx cap init "呼救CPR" tw.your.org.cpr --web-dir .
npx cap add ios && npx cap add android
npx cap sync
```

- iOS：`Info.plist` 需加 `NSCameraUsageDescription`、`NSMicrophoneUsageDescription`、`NSLocationWhenInUseUsageDescription`（說明用途：「用鏡頭判斷胸口起伏、偵測喘息聲、顯示附近 AED」）。
- Android：`AndroidManifest.xml` 加 `CAMERA`、`RECORD_AUDIO`、`ACCESS_FINE_LOCATION`、`VIBRATE`、`CALL_PHONE`（`tel:` 連結不需 CALL_PHONE）。
- 商店類別：「醫療」或「健康與健身」。審核常要求：免責聲明、隱私政策網址、說明 app 不做診斷。詳見 `docs/REGULATORY.md`。
- 上架前務必完成 `docs/ROADMAP.md` 的真人驗證（假人＋志願者＋急診／消防端合作）。

---

## 已知限制（v0.2）

- 鏡頭分析需要看得到胸口／上腹的起伏：厚外套、極暗環境、手機劇烈晃動時會回報「無法判斷」（仍建議 CPR）。
- 呼吸很慢（每分鐘 < 10 次）時 10 秒內只看到 2 次起伏，app 會自動延長到 15 秒再判定。
- 聲音偵測是啟發式的，吵雜環境會自動略過；正式產品應以訓練好的模型取代（見 AI 計畫）。
- 目前沒有訓練好的 AI 模型：需要標註過的瀕死呼吸影音資料（例如與消防局 119 錄音合作）。
- AED 地圖需要網路（OpenStreetMap 圖磚）；AED 清單離線可用（若已快取 `data/aed.json`）。
- 介面目前只有繁體中文。

## 授權與致謝

- 程式碼：MIT。
- 指引：American Heart Association 2025 Guidelines for CPR and ECC；內政部消防署民眾版 CPR。
- AED 資料：衛生福利部公共場所 AED 急救資訊網（政府資料開放授權）。
- 地圖：© OpenStreetMap 貢獻者（正式上線請改用有 SLA 的圖磚服務，如 MapTiler／Mapbox）。
