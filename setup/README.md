# setup/

`github-workflow-pages.yml` 是 GitHub Actions 的自動部署設定，正確位置應該在 `.github/workflows/pages.yml`
（zip 版本裡已經放好；寫到電腦時 `.github` 資料夾被安全機制擋下，所以先放在這裡）。

三選一：
1. 在檔案總管把它移到 `cpr-guardian\.github\workflows\pages.yml`（自己建立 `.github` 與 `workflows` 兩層資料夾），再整個上傳 GitHub。
2. 上傳到 GitHub 後，到儲存庫的 **Actions** 分頁 → **set up a workflow yourself** → 把這個檔案內容貼上 → 檔名改成 `pages.yml` → **Commit changes**。
3. 不用自動部署：Settings → Pages → Source 選「Deploy from a branch」→ main / (root)。這樣也能上線，只是 AED 資料不會每天自動更新。
