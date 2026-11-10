# 無礙智瞳｜公開網頁展示

公開版可在一個瀏覽器分頁輪流操作 A 回報、B 路線提醒和治理端。回報是當次展示資料，重新整理後清空。相機及語音功能依瀏覽器和權限而異。測試流程可以使用內建示範畫面及大按鈕。

選擇真實照片、影片或開啟鏡頭後，上方會自動掃描。首次使用需下載模型，綠色標示模型找到的人行道，黃色表示疑似藍綠色人行標線。影格在瀏覽器內分析，掃描結果是畫面判讀，通行淨寬仍需以校正資料驗證。街景模型在騎樓等場景可能辨識不到足夠證據。[SegFormer 模型](https://huggingface.co/Xenova/segformer-b0-finetuned-cityscapes-512-1024)

鏡頭模式以一般手動輪椅 90 公分為原型門檻。固定手機，在平坦路面用跨整個人行道的已量測矩形完成四點校正，再確認量測條件。連續三個新掃描影格顯示空間不足後會詢問是否回報，使用者同意後才送出。疑似標線、遮擋或其他證據不足的情況會保留「無法確認」。移動支架或換到不同坡度、寬度的路面時須重新確認校正。

## 從 VS Code 發布

1. 如果你目前開的是含企畫書與討論稿的共用工作區，請另開其中的 `github-release` 資料夾。首次需要產生它時，在共用工作區執行 `python tools/export_github.py`。這是一個獨立的 Git repo，包含程式、測試與部署設定。
2. 在 VS Code 開啟 **Source Control（原始檔控制）**，確認資料夾是 `github-release`，暫存並提交檔案。按 **Publish Branch / Publish to GitHub**，登入後選 **Public repository**。若已建成私人 repo，可在 GitHub 的 **Settings → General → Danger Zone → Change repository visibility** 設為公開。
3. 在 GitHub repo 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。第一次上傳若早於 Pages 設定，至 **Actions → Test and publish demo → Run workflow**，選 `main` 再執行一次。
4. 工作流程成功後，到 **Settings → Pages** 按 **Visit site**。每次推送到 `main` 都會先跑測試，通過才重新部署。

[VS Code 發布至 GitHub](https://code.visualstudio.com/docs/sourcecontrol/github) · [設定 GitHub Pages 發布來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 網站開啟後怎麼驗收

1. 在「鏡頭判斷」選「紙箱在中間」，看到通行空間不足，再按「回報」。
2. 切到「路線提醒」，選 A 動線，按「出發前檢查」，再按「檢查並切換替代路線」。選單應切換至 B 動線，並顯示最近走查時間。
3. 切到「治理端」，依序按「現地確認」、「已排除」。
4. 回到「路線提醒」，選回 A 動線再檢查。已排除事件不再觸發提醒。
5. 另試「紙箱靠邊」與「行人擋住視線」，應分別顯示有候選動線與無法確認。自備照片或暫停影片需先做四點校正，再標可用地面及障礙。畫面中沒有足夠的地面證據時會顯示無法確認。

## 本機共享測試

需要兩個瀏覽器或手機共用事件時，在可信任的同一個 Wi-Fi 上執行 `python web-prototype/server.py --host 0.0.0.0`，以畫面列出的網址連線。這個原型伺服器供區網展示。以本機終端執行 `node --test web-prototype/tests/*.test.mjs` 可以重跑單元測試。
