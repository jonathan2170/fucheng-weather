# 欄位對照（A4；規格 4.2 `WeatherSnapshot`、6.1、風險 6、待驗證 1）

> ⚠ **尚未以真實授權碼實測。** 下列資料集代碼與要素名稱依氣象署公開文件整理，測試用的是依此結構合成的回應。
> 授權碼到位後須逐項實測，並把結果寫回本檔與規格「待驗證 1」。對不上時的保險機制：回應內縣市名稱必須等於預期、
> 每個要素必須存在，否則該縣市不發布（見「失敗處理」），所以對照錯誤只會造成「不發布」，不會發出錯的資料。

## 資料來源
- 開放資料平臺 `https://opendata.cwa.gov.tw/api/v1/rest/datastore/{資料集代碼}?format=JSON`，授權碼放 `Authorization` 標頭。
- 每縣市兩個資料集：**逐三小時（未來三天）**取氣溫、體感、濕度、風速、降雨機率、天氣現象；**未來一週**只取紫外線指數（規格 3.4：一週預報含紫外線）。
- 縣市代碼 → 資料集代碼見 `config.ts` 的 `COUNTY_DATASETS`（22 縣市，奇數＝三天、偶數＝一週的規律需實測確認）。
- 結構（新版 JSON）：`records.Locations[0].LocationsName`（縣市）、`.Location[].LocationName`（鄉鎮）、`.WeatherElement[].ElementName`、`.Time[]`（瞬時值 `DataTime`；區間值 `StartTime`／`EndTime`）、`.ElementValue[0].<鍵>`。

## 要素 → 縣市檔欄位
時段（臺灣時間，兩端含；規格 6.1）：**全日** 0–24 時、**白天** 7–19 時、**外出** 7–22 時。區間值只要與視窗有重疊就算。

| 縣市檔欄位 | 單位 | 來源要素（ElementName／值的鍵） | 彙整方式 | 缺值時 |
|---|---|---|---|---|
| `tempMinDay`／`tempMaxDay` | °C | 溫度／`Temperature` | 全日最低／最高 | **必填**：整個鄉鎮的該日不輸出 |
| `tempMinDaytime`／`tempMaxDaytime` | °C | 溫度 | 白天最低／最高 | 必填：該日不輸出 |
| `tempMinOuting`／`tempMaxOuting` | °C | 溫度 | 外出最低／最高 | 省略（App 不判斷大溫差） |
| `apparentMinDaytime`／`apparentMaxDaytime` | °C | 體感溫度／`ApparentTemperature` | 白天最低／最高 | 省略（App 以同時段氣溫代替，6.7） |
| `apparentMinOuting` | °C | 體感溫度 | 外出最低 | 省略（同上） |
| `rainProbDaytimeMax` | % | 3小時降雨機率／`ProbabilityOfPrecipitation` | 白天最大 | 省略（降雨旗標不觸發） |
| `humidityMax` | % | 相對濕度／`RelativeHumidity` | 全日最大 | 省略 |
| `windSpeedMax` | m/s | 風速／`WindSpeed` | 全日最大 | 省略 |
| `uvIndex` | 指數 | 紫外線指數／`UVIndex`（**一週版**） | 全日最大 | 省略 |
| `weatherText` | 文字 | 天氣現象／`Weather` | 白天最常出現者（同數取最早）；白天沒有就取全日 | **必填**：該日不輸出 |

- 單位原樣照收，不換算（風速本來就是 m/s）；小數保留。
- 檔頭：`format: "fucheng-weather/1"`（或 `fucheng-weather/2`，見下）、`countyCode`（內政部行政區代碼）、`generatedAt`（本次執行時間，UTC ISO）、`source: "cwa"`、`towns[]`（`regionId` ＝ `regions-data.json` 的 `id`，以 `cwaLocationName` 對上 `LocationName`）。
- 輸出經 `parseCountyFileText` 驗證（白名單欄位、數值範圍），鍵順序固定、同輸入同位元組。
- `generatedAt` 是**抓取時間**，不是氣象署的發布時間（回應沒有可靠的發布時間欄位待確認）；氣象署若沒更新，資料看起來會「新」但其實沒變——待實測後評估要不要改用回應內的發布時間。

## 缺值與不完整資料
- 時間點的值是 `"-"`、空字串或 `null` → 該點略過；視窗內全部缺 → 欄位省略。其他非數字內容（例如「暫無資料」）→ 格式錯誤，縣市不發布。
- 超出合理範圍（例如 -99 哨兵值）→ 解析器拒絕，縣市不發布，**不**當缺值處理。
- 今天與最後一天可能只涵蓋部分時段：白天（7–19 時）溫度時間點少於 3 個的日期，該日不輸出（不拿傍晚氣溫當白天高低溫）。**今天因此不輸出時，逐列沿用上一版（目前對外的檔案，讀不到或壞掉視為沒有）同一鄉鎮的今天那一列**：上一版的列只有在白天點數足夠時才會輸出，所以沿用的一定是足量算出的整日彙整；該列多一個選填欄位 `rowGeneratedAt`（該列自己的產生時間；上一版該列已有就沿用，否則為上一版檔案的 `generatedAt`，所以連續沿用也不會被洗新）。明後天照常用新資料刷新，檔案的 `generatedAt` 是本次產生時間。上一版沒有今天的列（例如當天第一次執行就已過午）才不含今天。格式版本：`fucheng-weather/1`（不含 `rowGeneratedAt`，預設輸出）與 `fucheng-weather/2`（同欄位、允許選填的 `rowGeneratedAt`，沒有時以檔案 `generatedAt` 為準）；App 兩者都收，版本 1 的檔案含 `rowGeneratedAt` 會被拒絕（與舊版 App 一致）。**發布端預設輸出版本 1，此時不逐列沿用（今天白天點數不足就省略今天，由新版 App 在本機保留舊的今天列）；環境變數 `WEATHER_FILE_FORMAT=2` 才輸出版本 2 並逐列沿用**，必須等 App 已部署支援版本 2 的版本之後才可設（MIGRATION.md 第 7 節）。App 端 `snapshot.generatedAt` 取該列的 `rowGeneratedAt`，新鮮度（更新於／過期、降雨加分）依該列自己的時間判斷；`WeatherService.save` 也做同樣的逐列保留（新檔沒有今天那一列、鎖內舊快取有時，保留舊的今天列）。只有在「鄉鎮在檔內、檔內有晚於今天的日期、檔案 `generatedAt` 的臺灣日期就是今天、但沒有今天那一列」時，App 才回 `today_ended`（畫面「今天的預報時段已過」，離線時先講離線）；過期的檔或鄉鎮不在檔內回 `not_in_file`。其餘日期只用有資料的時間點（今天的全日最低可能不含已過去的凌晨）。區間值（降雨機率、天氣現象）與時段為嚴格重疊：結束於 07:00、開始於 19:00 的區間不算白天。
- 新鮮度（`stale`）：generatedAt 是抓取時間，所以看回應自己的時間點，**逐鄉鎮**檢查且只計入有值（非 `"-"`）的點——任一鄉鎮的逐三小時版最晚溫度時間點不到執行時間後 36 小時、或一週版最晚的紫外線時間點不到 36 小時，整縣市不發布。不看最早的時間點（氣象署是否保留已過時段待實測）。門檻為估計值。
- 非預期的程式錯誤（非 `PublisherError`）在 status.json 標 `internal`，不冒充氣象署結構改變。
- 鄉鎮對照表必須涵蓋資料集對照表的全部縣市，否則整批不執行（結束碼 2）；執行中的寫入錯誤回結束碼 1。
- 一個鄉鎮至少要有 2 天可用預報（`MIN_DAYS_PER_TOWN`），最多輸出 7 天。
- 對照表有、回應沒有的鄉鎮 → 縣市不發布；回應有、對照表沒有 → 只在執行記錄提醒（行政區異動的訊號）。

## 失敗處理（fail closed，以縣市為單位）
| 類別（`status.json` 的 `error`） | 情況 | 重試 |
|---|---|---|
| `network` | 連線失敗、逾時（20 秒） | 最多 3 次（間隔 2、5 秒） |
| `http` | 非 2xx | 429、5xx 重試；401／403／404 不重試 |
| `format` | 不是 JSON、`success` 不是 true、要素或值的鍵消失（欄位改名）、時間沒有時區、非數字內容、回應過大 | 否 |
| `mismatch` | 縣市名稱對不上（資料集代碼錯）、缺鄉鎮 | 否 |
| `range` | 數值超出範圍、檔案不符 App 端格式 | 否 |
| `coverage` | 某鄉鎮可用天數少於 2、或沒有任何有值的溫度時間點 | 否 |
| `size` | 壓縮後 ≥ 50,000 位元組 | 否 |
| `write` | 寫檔失敗 | 否 |
| `config`（不進 status） | 授權碼缺／格式不符、資料集對照表不全 | 整批不執行，結束碼 2 |

任何一種失敗：該縣市檔案不動；`status.json` 記 `ok:false` 與上一版 `generatedAt`；整體結束碼 1。

## 氣候統計（任務 A6／0-09；C-B0027-001 地面測站月平均資料）

> ⚠ **回應結構尚未以真實授權碼實測。** 下列鍵名是依公開文件推測，集中在 `config.ts` 的 `CLIMATE_FIELDS`；測試用的是依此結構合成的回應（`tests/weather-publisher/climate-fixtures.ts`）。實測後只需改 `CLIMATE_FIELDS` 與本節。結構不符一律 fail closed（保留上一版），不會發出錯的資料。

- 資料集：`C-B0027-001`（每 10 年更新；政府資料開放授權條款－第 1 版）。請求與預報相同：授權碼只放 `Authorization` 標頭，重試、逾時、回應大小上限共用 `fetchDataset`。
- 輸出：`{輸出資料夾}/v1/climate-normals.json`（`https://weather.fuchengone.com/v1/climate-normals.json`），格式 `fucheng-climate-normals/1`：`generatedAt`、`source`（來源、授權、標示文字）、`period`（統計期間）、`stations[]`（`id`、`name`、`lat`、`lon`、`months[12]`：`avgTemp`、`avgHigh`、`avgLow`、`precip`）。
- 重抓規則：檔案不存在、讀不回來、`generatedAt` 在未來、或產生超過 7 天才抓；否則不連網。抓失敗保留上一版（位元組不變），不寫 `status.json`，只在執行記錄與結束碼（1）反映。
- 欄位對照（推測）：`records.data.surfaceObs.DataPeriod.{StartYear,EndYear}` → `period`；`…location[].station.{StationID,StationName,StationLatitude,StationLongitude}` → 測站；`…stationObsStatistics.AirTemperature.monthly[].{Month,Mean,MeanMaximum,MeanMinimum}` → `avgTemp`／`avgHigh`／`avgLow`（**須是「日最高／最低的月平均」，不是極值**；實測時務必確認）；`…Precipitation.monthly[].Accumulation` → `precip`（毫米）。
- 缺值（`"-"`、空字串、`X`、`-99` 以下）：該測站只要有一個月缺值就整站略過，不補洞；全部測站都略過 → `coverage` 失敗。要素整個消失（欄位改名）→ `format` 失敗。數值或座標超出合理範圍、未通過 App 端解析器 → `range` 失敗。
- 沒有「降雨日數」：月平均資料只有降水量。App 端 `rainDays` 一律 0，雨天相關建議維持關閉（保守預設）。
