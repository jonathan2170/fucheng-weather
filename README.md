# fucheng-weather

富程優活（`life.fuchengone.com`）的天氣資料來源：每小時抓中央氣象署鄉鎮預報，每個縣市產生一個靜態檔，
由 GitHub Pages 以 `https://weather.fuchengone.com/v1/{縣市代碼}.json` 對外提供；`v1/status.json` 標示每個縣市最近一次是否成功。

- 程式來自 `jonathan2170/fucheng-life` 的 `tools/weather-publisher`（規格、欄位對照、失敗處理都在那邊；見 `SYNC.md`）。
  這裡只把相對 import 補上 `.ts` 副檔名，讓 Node 22 內建的型別剝除直接執行，**沒有任何 npm 依賴**。
- 授權碼只放在 Actions secret `CWA_AUTHORIZATION`；程式只放在 `Authorization` 標頭，所有錯誤文字先遮蔽。
- 失敗以縣市為單位 fail closed：抓不到或格式不對的縣市保留上一版，不輸出半個檔。
- 資料來源：交通部中央氣象署（政府資料開放授權條款）。

本機試跑（需要授權碼；不要把授權碼寫進任何檔案）：
```sh
CWA_AUTHORIZATION=… WEATHER_OUT_DIR=./site node --experimental-strip-types tools/weather-publisher/cli.ts
```
