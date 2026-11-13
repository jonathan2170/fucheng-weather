# 搬家與上線清單（A4；依 #105 A4／A5、規格 3.1、3.4、5.3、0-05、0-08）

前提：方綸取得氣象署授權碼、決定託管與網域（A5）。以下每一項都**尚未做**；本 PR 不啟用任何排程、不建任何儲存庫、不碰 `.github/workflows`。

## 0. 先實測（需要授權碼）
- [ ] 以真實授權碼在本機跑一次，逐項核對 `FIELD-MAP.md`：資料集代碼、`LocationsName`／`LocationName` 用字（臺／台）、要素名稱與值的鍵、`"-"` 缺值寫法、紫外線是否涵蓋所有縣市、已過時段是否保留、是否有回應內發布時間。
- [ ] 確認流量限制與單次呼叫量（每小時 44 次請求）；必要時調整 `PAUSE_BETWEEN_REQUESTS_MS`。
- [ ] 實測結果寫回規格「待驗證 1」與 `FIELD-MAP.md`；對不上的地方改 `config.ts`／`cwa.ts` 並補測試。
- [ ] 確認氣象署「政府資料開放授權條款」標示文字（`src/weather/config.ts` 的 `WEATHER_ATTRIBUTION`）。

## 1. 新儲存庫（獨立於本 repo，避免天氣更新觸發網站建置，規格 3.4）
- [ ] 建立天氣儲存庫（名稱由方綸定），啟用 GitHub Pages（規格 3.2：免費方案條款待驗證 3；若不可用，改其他靜態託管並同步修改本清單）。
- [ ] 複製進新儲存庫：`tools/weather-publisher/*`、`src/weather/county-file.ts`、`src/weather/config.ts`（`build.ts` 以它們驗證輸出；兩份要與 App 同步，建議在新儲存庫加一個測試固定其雜湊或與本 repo 對照）、`src/data/types.ts` 中的 `Region`、`src/weather/regions-data.json`（以 `WEATHER_REGIONS_FILE` 指定路徑）、`tests/weather-publisher/*` 與 `tests/weather-fixtures.ts` 的 `REGIONS`。
- [ ] 決定 TypeScript 執行方式（例如在新儲存庫加 `tsx` 為 devDependency，或先編譯）；本 repo 的程式用不帶副檔名的 import，直接用 `node` 執行不會成功。
- [ ] 鄉鎮對照表有異動時（`scripts/build-regions.mjs`，A3）兩邊同步更新。

## 2. 授權碼與 Actions secret
- [ ] 在新儲存庫設定 Actions secret，名稱固定為 **`CWA_AUTHORIZATION`**（與程式讀的環境變數同名）。只放在新儲存庫；本 repo、測試、文件、PR 都不放。
- [ ] 工作流程只在 `env:` 把 secret 傳給 publish 步驟，不 `echo`、不開 debug 記錄；fork／PR 觸發的流程不得取得 secret。

## 3. 排程（新儲存庫的 `.github/workflows/`；本 repo 的 Claude 不能改 workflows，也不該在此建立）
範本（供方綸或有權限者建立，尚未建立）：
```yaml
on:
  schedule: [{ cron: '17 * * * *' }]   # 每小時一次，避開整點壅塞（GitHub 排程可能延遲）
  workflow_dispatch: {}
concurrency: { group: weather-publish, cancel-in-progress: false }   # 同時只跑一個，避免兩次執行互相覆蓋 v1/
permissions: { contents: write }       # 只用來推送輸出；不開其他權限
jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<固定 SHA>        # 以 commit SHA 固定，不用浮動標籤
        with: { ref: <發布分支> }                  # 先取回上一版，失敗時才保留得住
      - uses: actions/setup-node@<固定 SHA>
        with: { node-version: 22 }
      - run: npm ci
      - run: <執行 cli.ts>                         # env: CWA_AUTHORIZATION: ${{ secrets.CWA_AUTHORIZATION }}, WEATHER_OUT_DIR: ./site
      - run: <提交並推送 site/ 的變更>              # 步驟前一個步驟失敗（結束碼 1）時仍要提交成功縣市的檔與 status.json（用 if: always() 並保留失敗結果）
```
- [ ] **上一版必須在工作目錄裡**：輸出資料夾要先含目前發布的內容（從發布分支 checkout），程式只覆蓋成功的縣市檔；若輸出資料夾是空的，失敗縣市就會「沒有檔案」而不是「保留上一版」。
- [ ] 結束碼 1 時工作流程要標為失敗（讓平台寄通知），但仍須提交成功部分；規格要求「連續兩次失敗寄信給維護者」——GitHub 預設只在失敗時通知，需確認通知設定，或在工作流程中用上一次執行結果判斷連續性。
- [ ] 同一次提交只含 `v1/*.json`；不觸發網站儲存庫的建置（兩個儲存庫之間沒有觸發關係）。
- [ ] 評估發布分支的歷史膨脹（每小時一次提交）：定期把歷史壓平，或用 Pages artifact 部署而不提交。

## 4. 子網域與 DNS（A5，方綸 2026-11-13 已決定：App `life.fuchengone.com`、天氣 `weather.fuchengone.com`）
- [ ] 天氣用 `weather.fuchengone.com`：在 Cloudflare 建另一個 Pages 專案（Git 整合或直接上傳 `out/` 內容）或 R2 公開儲存貯體，並綁定此自訂網域；啟用 HTTPS。
- [ ] 路徑：程式輸出 `{WEATHER_OUT_DIR}/v1/{countyCode}.json` 與 `v1/status.json`（輸出資料夾的內容就是網站根目錄），App 讀 `https://weather.fuchengone.com/v1/{countyCode}.json`（`src/weather/config.ts` 的 `countyFileUrl`）。注意規格 3.1 圖示寫 `/weather/v1/…`，程式實作（1-10）是 `/v1/…`；以實作為準，若要改規格圖示由方綸決定。
- [ ] 託管平台設定：不開訪客分析；縣市檔回應標頭的快取時間不超過幾分鐘（避免掩蓋每小時更新）；跨來源讀取（CORS）只允許 `https://life.fuchengone.com`（規格 3.3「跨來源請求限制待驗證」）。
- [ ] 把託管者名稱、可能的處理地區與紀錄保存政策寫入隱私說明（0-08、規格 3.1、5.2 第 8 點）。

## 5. 本 repo（App）的網域代入——A5 已完成
已代入正式網域（不再有保留網域占位）：
- [x] `public/_headers`：CSP 的 `connect-src 'self' https://weather.fuchengone.com`（App 本身 `life.fuchengone.com` 由 `'self'` 涵蓋；不用萬用字元）
- [x] `scripts/csp-policy.mjs`：`OWN_DOMAIN = 'fuchengone.com'`
- [x] `src/weather/config.ts`：`WEATHER_ORIGIN`
- [x] 測試與 e2e 的來源字串；`tests/weather-domain.test.ts` 檢查三處一致，且 repo 內不得再出現舊占位網域。
- [ ] 方綸在 Cloudflare 完成自訂網域後，跑 `npm run check`（含 `check:csp`、e2e），確認 CSP 只允許網站本身與天氣來源兩個。
- [ ] 不新增任何其他外送機制；App 只做 GET 縣市檔，不帶查詢參數、不帶內容（1-25 驗收 3 的規則）。

## 6. 上線驗收（規格 0-05）
- [ ] 22 縣市檔每小時更新成功，且不觸發網站重新建置。
- [ ] 單一縣市檔壓縮後小於 50 KB（程式已擋）。
- [ ] 檔內含 `generatedAt` 與白天、外出、全日三個時段的氣溫最高最低。
- [ ] 刻意讓一次執行失敗（例如暫時換錯的授權碼）：舊檔保留、`status.json` 標 `ok:false`、維護者收到通知。
- [ ] 記錄欄位對照表與缺漏情形（本資料夾 `FIELD-MAP.md` 實測後定稿）。

## 7. 格式版本與部署順序（`fucheng-weather/1` → `/2`）
`rowGeneratedAt`（逐列沿用今天的列）只存在於 `fucheng-weather/2`；舊版 App 的白名單會拒絕不認得的格式與欄位。順序必須是：
1. 先部署含本 PR 的 App（同時接受版本 1 與 2，PWA 使用者更新到新版）。
2. 確認使用者大多已更新（舊版 App 遇到版本 2 的檔會判定格式錯誤、改顯示最後一次快取）。
3. 才在天氣儲存庫的排程設定 `WEATHER_FILE_FORMAT=2`（預設為 1，不設就不含 `rowGeneratedAt`）。
- [ ] 設為 2 之前，發布端輸出版本 1：今天白天點數不足時省略今天；新版 App 會在本機鎖內保留舊的今天列，所以已更新的使用者不受影響。
- [ ] 要退回時把 `WEATHER_FILE_FORMAT` 改回 1 即可（下一次執行覆寫為版本 1；App 仍可讀版本 2 的舊檔）。
