# 天氣發布排程（A4；規格 3.4「發布與託管方式」、風險 6、任務 0-05 的程式部分）

每小時抓中央氣象署鄉鎮預報 → 轉成「一個縣市一個靜態檔」→ 發布到獨立的天氣儲存庫。
**現在只是準備好的程式與文件**：沒有啟用任何排程、沒有授權碼、不連網（測試全用合成回應）、App 不引用它、不屬於 `npm run build`。
等方綸取得授權碼並決定網域（A5）後，依 [MIGRATION.md](./MIGRATION.md) 搬到獨立儲存庫。

| 檔案 | 內容 |
|---|---|
| `config.ts` | 常數、時段定義、要素名稱、縣市 → 資料集代碼對照 |
| `cwa.ts` | 回應 → 每鄉鎮每日彙整（純轉換）；結構不符一律丟 `PublisherError` |
| `build.ts` | 組出單一縣市檔，並用 App 端解析器（`src/weather/county-file.ts`）讀回驗證 |
| `publish.ts` | 抓取（逾時、重試）、原子寫入、`status.json`、fail closed |
| `cli.ts` | 進入點；環境變數與結束碼見檔頭 |
| `FIELD-MAP.md` | 欄位對照、單位、缺值、失敗處理 |
| `MIGRATION.md` | 搬家與上線清單 |

## 設計重點
- **Fail closed（以縣市為單位）**：抓不到、回應結構變了、縣市名稱對不上、數值超出合理範圍、壓縮後超過 50 KB，任何一項都讓**該縣市檔案完全不動**——保留上一版，其 `generatedAt` 照舊，App 依規格 3.4 自行顯示「更新於」或「已過期」。不會輸出半個檔，也不會用部分資料補洞。
- **標示時間**：每次執行更新 `v1/status.json`（`checkedAt`、每縣市 `ok`、目前對外檔案的 `generatedAt`、失敗類別）。結束碼 1 表示有縣市保留了上一版，供排程平台的失敗通知使用。
- **授權碼**：只讀環境變數 `CWA_AUTHORIZATION`；只放在 `Authorization` 標頭（不進網址）；所有錯誤文字先遮蔽；`status.json` 只含失敗類別，不含錯誤內文。本資料夾與 `tests/weather-publisher` 都沒有金鑰（`publish.test.ts` 有掃描；比對規則是對授權碼格式的猜測，待驗證 1）。
- **App 端不變**：沒有新增任何外送機制；`src` 不引用本資料夾、也不含氣象署網址（同測試掃描）。

## 本機執行（授權碼到位後；目前不要跑）
```sh
CWA_AUTHORIZATION=<授權碼> WEATHER_OUT_DIR=./out npx tsx tools/weather-publisher/cli.ts
```
本 repo 沒有 `tsx`（不新增依賴），也沒有真實授權碼，所以**這條指令沒有在本 repo 實跑過**；進入點的行為由測試以注入的假 `fetch` 驗證。搬到新儲存庫時由該儲存庫決定如何執行 TypeScript（見 MIGRATION.md）。

## 輸出位置與網址
輸出資料夾（`WEATHER_OUT_DIR`，預設 `./out`）的內容就是 `https://weather.fuchengone.com/` 的網站根目錄：`out/v1/{countyCode}.json`、`out/v1/status.json` 對應 `https://weather.fuchengone.com/v1/…`。託管設定見 MIGRATION.md 第 4 節。

## 測試
`npx vitest run tests/weather-publisher`：聚合與時段邊界、缺值、欄位改名、縣市名稱不符、-99 哨兵值、大小上限、fail closed（保留上一版）、部分縣市失敗、重試、授權碼不外洩、CLI 結束碼。
