# 把 app 放上網、用手機打開（部署指南）

鏡頭與麥克風只能在 **HTTPS 網址** 或 **localhost** 使用，所以要讓手機能用，最簡單的方法就是放到一個免費的靜態網站空間。
以下三種方法都不用寫程式，選一種即可。

---

## 方法 A：GitHub Pages（推薦，免費、有網址、之後可自動更新 AED 資料）

### A-1. 建立 GitHub 帳號與儲存庫
1. 到 https://github.com 註冊／登入。
2. 右上角「+」→ **New repository**。
3. Repository name 填 `cpr-guardian`（或任何名字），選 **Public**，其他不用勾，按 **Create repository**。

### A-2. 上傳專案（網頁拖曳，不用裝 git）
1. 在新儲存庫頁面點 **uploading an existing file**（或 Add file → Upload files）。
2. 用檔案總管打開 `Documents\cpr-guardian`，**全選裡面所有東西**（Ctrl+A，包含 `.github`、`.gitignore` 這些點開頭的檔案），拖進瀏覽器的上傳區。
   - 資料夾會連同結構一起上傳；如果瀏覽器不讓你拖資料夾，改用方法 A-2'（GitHub Desktop）。
3. 等進度條跑完，下方 Commit changes 按 **Commit changes**。

### A-2'. 或用 GitHub Desktop（圖形介面）
1. 下載安裝 https://desktop.github.com ，登入。
2. File → **Add local repository** → 選 `Documents\cpr-guardian`；它會說這不是 git 儲存庫，點 **create a repository** → Create。
3. 左下角 Summary 隨便填（例如 `first commit`）→ **Commit to main**。
4. 上方 **Publish repository** → 取消勾選「Keep this code private」→ Publish。

> 注意：自動部署需要 `.github/workflows/pages.yml` 這個檔案。如果你的資料夾裡沒有 `.github`（只有 `setup/github-workflow-pages.yml`），
> 請看 `setup/README.md`：把它搬到 `.github\workflows\pages.yml`，或上傳後在 GitHub 的 Actions 分頁貼上內容建立。

### A-3. 開啟 GitHub Pages
1. 儲存庫頁面 → **Settings** → 左側 **Pages**。
2. Build and deployment → Source 選 **GitHub Actions**（不是 Deploy from a branch）。
3. 回到 **Actions** 分頁，會看到「Deploy to GitHub Pages」在跑（第一次可能要先按 **I understand my workflows, go ahead and enable them**；若沒有自動跑，點左側該 workflow → **Run workflow**）。
4. 大約 1–2 分鐘後，Settings → Pages 上方會出現網址：
   `https://<你的帳號>.github.io/cpr-guardian/`

這個流程還會 **每天凌晨自動下載衛福部最新 AED 資料** 並重新部署，你不用自己跑 Python。

### A-4. 之後改程式
- 網頁版：到檔案頁面按鉛筆圖示編輯 → Commit，幾分鐘後網站自動更新。
- GitHub Desktop：改完檔案 → Commit → Push origin。
- 記得同步改 `sw.js` 的 `VERSION`（例如 `cpr-v0.1.1`），手機上的舊快取才會更新。

---

## 方法 B：Netlify Drop（最快，拖一下就有網址）
1. 到 https://app.netlify.com/drop （需要免費帳號）。
2. 把整個 `cpr-guardian` 資料夾拖進去。
3. 幾秒後得到 `https://xxxx.netlify.app` 網址，手機直接打開。
4. 缺點：AED 資料不會自動更新（會用範例資料），要更新就自己再拖一次。

## 方法 C：Cloudflare Pages / Vercel
- 都支援「連結 GitHub 儲存庫 → 自動部署」，做完方法 A-2 後在它們的網站選這個 repo 即可，Framework 選 **None**、Build command 留空、Output directory 填 `/`（或 `.`）。

---

## 手機安裝成 app
- **iPhone**：Safari 打開網址 → 分享按鈕 → **加入主畫面**。第一次開鏡頭時允許相機、麥克風、定位。
- **Android**：Chrome 打開網址 → 右上角 ⋮ → **安裝應用程式**（或「加到主畫面」）。

## 在電腦上先看看（不上網）
Windows 若有安裝 Python：在 `cpr-guardian` 資料夾按住 Shift 右鍵 → 「在此處開啟 PowerShell」→ 輸入
`python -m http.server 8080` → 瀏覽器開 http://localhost:8080 。
沒有 Python 可用 VS Code 的 **Live Server** 擴充套件（右下角 Go Live）。

## 常見問題
- **鏡頭打不開**：確認網址是 https 開頭；瀏覽器網址列左邊的鎖頭 → 權限 → 相機／麥克風設為允許。
- **改了程式手機沒變**：`sw.js` 的 `VERSION` 沒改，或手機瀏覽器仍在用舊快取；改 VERSION 後重新整理兩次。
- **AED 地圖顯示「範例資料」**：表示 `data/aed.json` 不存在；用方法 A 的自動流程，或在電腦執行 `python tools/fetch_aed.py` 後重新上傳。
- **GitHub Actions 失敗**：點進 Actions 的紅色 ✗ 看哪一步錯；最常見是 Pages 的 Source 沒選 GitHub Actions。
