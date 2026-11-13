// 天氣模組常數（任務 1-10；規格 3.4、5.3、5.8）
//
// 天氣檔來源只能是 0-05 的獨立天氣儲存庫（weather.自家網域）。內容安全政策的 connect-src 只允許網站本身與這個來源；
// 須與 public/_headers、scripts/csp-policy.mjs 的 OWN_DOMAIN 一致（tests/weather-domain.test.ts 比對）。

/** 獨立天氣儲存庫的來源（規格 3.2「天氣檔託管（weather.自家網域）」；正式網域 weather.fuchengone.com） */
export const WEATHER_ORIGIN = 'https://weather.fuchengone.com';

/** 縣市檔路徑：只含縣市代碼，不含鄉鎮（託管端只知道下載了哪個縣市檔，規格 3.4、5.3） */
export const countyFileUrl = (countyCode: string): string => `${WEATHER_ORIGIN}/v1/${encodeURIComponent(countyCode)}.json`;

/** 縣市檔格式代號（暫定，待 0-05 欄位對照表定稿後同步；見 county-file.ts） */
export const COUNTY_FILE_FORMAT = 'fucheng-weather/1';
/**
 * 版本 2：與版本 1 相同，只多一個選填的逐列欄位 rowGeneratedAt。App 同時接受 1 與 2；
 * 版本 1 的檔案不得含 rowGeneratedAt（與舊版 App 的白名單一致）。發布端要等 App 已部署新版才輸出 2（見發布端的 MIGRATION.md）。
 */
export const COUNTY_FILE_FORMAT_V2 = 'fucheng-weather/2';
export type CountyFileFormat = typeof COUNTY_FILE_FORMAT | typeof COUNTY_FILE_FORMAT_V2;
export const ACCEPTED_COUNTY_FILE_FORMATS: readonly CountyFileFormat[] = [COUNTY_FILE_FORMAT, COUNTY_FILE_FORMAT_V2];

/** 單一縣市檔解壓縮後的大小上限（0-05 驗收為壓縮後小於 50 KB；此處擋異常大檔） */
export const MAX_COUNTY_FILE_CHARS = 512 * 1024;

const HOUR = 60 * 60 * 1000;

/** 產生時間超過三小時：顯示「天氣資料更新於某時」（3.4） */
export const AGING_AFTER_MS = 3 * HOUR;
/** 產生時間超過二十四小時：顯示「天氣資料已過期」並停用降雨機率加分（3.4） */
export const EXPIRED_AFTER_MS = 24 * HOUR;
/** 快取在此時間內下載過就不重新下載（排程每小時更新一次，3.4） */
export const REFETCH_AFTER_MS = 30 * 60 * 1000;
/** 天氣快取保存七天（5.8；以下載時間 fetchedAt 起算） */
export const CACHE_RETENTION_MS = 7 * 24 * HOUR;

/** 定位換算：最近與次近兩個鄉鎮中心點距離差在兩公里以內時列出兩個選項（3.4、1-10） */
export const AMBIGUOUS_WITHIN_KM = 2;
/** 定位換算：離最近鄉鎮中心點超過此距離視為不在服務範圍（例如出國），改為手動選擇 */
export const OUT_OF_RANGE_KM = 60;

/**
 * 資料來源標示（規格 3.3「中央氣象署開放資料平臺：依政府資料開放授權條款，須標示出處」）。
 * 天氣摘要在任何狀態（正常、更新較久、過期、離線）都須顯示。
 */
export const WEATHER_ATTRIBUTION = '天氣資料來源：中央氣象署（依政府資料開放授權條款－第 1 版提供）';

/** 臺灣時間（UTC+8，無日光節約時間）；用於決定「今天」與顯示更新時間 */
export const TAIPEI_OFFSET_MS = 8 * HOUR;
