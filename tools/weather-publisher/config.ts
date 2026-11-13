// 天氣發布排程的常數與資料集對照（任務 A4；規格 3.4「發布與託管方式」、風險 6、待驗證 1、0-05）
//
// 本資料夾是「尚未啟用」的原型：不被 App 引用、不屬於 `npm run build`，等授權碼與網域（A5）到位後搬到獨立儲存庫（見 MIGRATION.md）。

import type { CwaElementSpec } from './cwa.ts';

/** 中央氣象署開放資料 API 的固定位址；授權碼只放在 Authorization 標頭，不進網址、不進記錄 */
export const CWA_API_BASE = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/';

/** 授權碼只從這個環境變數讀（GitHub Actions 的 secret 也用同名） */
export const ENV_API_KEY = 'CWA_AUTHORIZATION';
/** 輸出資料夾；預設 ./out。縣市檔寫在 {輸出資料夾}/v1/{countyCode}.json（同 src/weather/config.ts 的 countyFileUrl） */
export const ENV_OUT_DIR = 'WEATHER_OUT_DIR';
/** 鄉鎮對照表路徑；預設為本 repo 的 src/weather/regions-data.json */
export const ENV_REGIONS_FILE = 'WEATHER_REGIONS_FILE';

/** 輸出格式版本：預設 1（不含 rowGeneratedAt，舊版 App 讀得懂）；App 已部署支援版本 2 的版本後，才設為 2 以啟用逐列沿用（MIGRATION.md 第 7 節） */
export const ENV_FILE_FORMAT = 'WEATHER_FILE_FORMAT';

export const OUTPUT_SUBDIR = 'v1';
export const STATUS_FILE = 'status.json';
export const STATUS_FORMAT = 'fucheng-weather-status/1';

/** 單一縣市檔壓縮後上限（0-05 驗收：小於五十千位元組）；超過視為異常，不發布 */
export const MAX_GZIP_BYTES = 50_000;
/** 每個鄉鎮至少要有幾天可用預報；少於這個數字視為資料不完整（例如整個時段缺值） */
export const MIN_DAYS_PER_TOWN = 2;
/** 白天（7–19 時）至少要有幾個溫度時間點才輸出該日；不足（例如傍晚才執行的今天）該日不輸出，避免殘餘時段冒充白天高低溫；今天因此不輸出時，逐列沿用上一版的今天列並帶 rowGeneratedAt；沒有可沿用的列才不含今天（App 顯示 today_ended），見 build.ts */
export const MIN_DAYTIME_POINTS = 3;
/**
 * 新鮮度（規格 3.4：generatedAt 是抓取時間，要靠回應自己的時間點確認氣象署沒有停更）：
 * 逐鄉鎮只看「最晚的有值時間點」，不看最早的——氣象署是否保留當天已過的時段尚未實測（待驗證 1），看最早點會在其中一種情況下誤擋。
 * 逐三小時版約涵蓋未來三天，停更 N 小時後最晚點只剩約 72−N 小時，所以門檻取 36 小時（可偵測約 1 天以上的停更）；一週版（最晚時間點是第七天的紫外線區間起點）也用同一個門檻。
 * 門檻是依資料集形狀估的，實測後調整。
 */
export const MIN_FORECAST_LEAD_MS = 36 * 3_600_000;

/** 縣市檔最多保留幾天（逐三小時資料集約三天） */
export const MAX_DAYS_PER_TOWN = 7;

export const REQUEST_TIMEOUT_MS = 20_000;
/** 單一回應大小上限（字元），擋異常大的回應 */
export const MAX_RESPONSE_CHARS = 8_000_000;
/** 每個請求最多嘗試次數（網路錯誤、429、5xx 才重試；401／403／404 不重試） */
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [2_000, 5_000] as const;
/** 連續請求之間的間隔，避免短時間打滿流量限制（待驗證 1：實際限制以氣象署公告為準） */
export const PAUSE_BETWEEN_REQUESTS_MS = 300;

/** 時段定義（規格 6.1）：臺灣時間，小時；兩端含 */
export const WINDOWS = {
  daytime: [7, 19],
  outing: [7, 22],
} as const;

/**
 * 逐三小時預報（F-D0047-xxx 三天版）要用的要素。名稱與值的鍵依氣象署新版 JSON（Locations／Location／WeatherElement）。
 * 全部屬於「必須存在」的要素：整個要素消失代表欄位改名（風險 6），整個縣市不發布；單一時間點的值是 "-" 才算缺值。
 * ⚠ 欄位名稱依公開文件整理，尚未以真實授權碼連網實測（待驗證 1）；實測後在 FIELD-MAP.md 更新。
 */
export const FORECAST_3H_ELEMENTS = {
  temperature: { name: '溫度', key: 'Temperature' },
  apparent: { name: '體感溫度', key: 'ApparentTemperature' },
  humidity: { name: '相對濕度', key: 'RelativeHumidity' },
  windSpeed: { name: '風速', key: 'WindSpeed' },
  rainProb: { name: '3小時降雨機率', key: 'ProbabilityOfPrecipitation' },
  weather: { name: '天氣現象', key: 'Weather' },
} as const satisfies Record<string, CwaElementSpec>;

/** 一週預報（F-D0047-xxx 一週版）只取紫外線指數（規格 3.4：一週預報含紫外線指數） */
export const FORECAST_WEEK_ELEMENTS = {
  uvIndex: { name: '紫外線指數', key: 'UVIndex' },
} as const satisfies Record<string, CwaElementSpec>;

export interface CountyDatasets {
  countyName: string;
  /** 鄉鎮天氣預報—逐三小時（未來三天） */
  forecast3h: string;
  /** 鄉鎮天氣預報—未來一週 */
  week: string;
}

/**
 * 縣市代碼（內政部行政區代碼，同 regions-data.json）→ 氣象署資料集。
 * ⚠ 資料集代碼依公開文件整理，尚未實測（待驗證 1）。保險機制：回應內的縣市名稱必須等於 countyName，對不上就整個縣市不發布，
 * 因此代碼錯誤只會「不發布」，不會發出別縣市的資料。
 */
export const COUNTY_DATASETS: Readonly<Record<string, CountyDatasets>> = {
  '10002': { countyName: '宜蘭縣', forecast3h: 'F-D0047-001', week: 'F-D0047-003' },
  '68000': { countyName: '桃園市', forecast3h: 'F-D0047-005', week: 'F-D0047-007' },
  '10004': { countyName: '新竹縣', forecast3h: 'F-D0047-009', week: 'F-D0047-011' },
  '10005': { countyName: '苗栗縣', forecast3h: 'F-D0047-013', week: 'F-D0047-015' },
  '10007': { countyName: '彰化縣', forecast3h: 'F-D0047-017', week: 'F-D0047-019' },
  '10008': { countyName: '南投縣', forecast3h: 'F-D0047-021', week: 'F-D0047-023' },
  '10009': { countyName: '雲林縣', forecast3h: 'F-D0047-025', week: 'F-D0047-027' },
  '10010': { countyName: '嘉義縣', forecast3h: 'F-D0047-029', week: 'F-D0047-031' },
  '10013': { countyName: '屏東縣', forecast3h: 'F-D0047-033', week: 'F-D0047-035' },
  '10014': { countyName: '臺東縣', forecast3h: 'F-D0047-037', week: 'F-D0047-039' },
  '10015': { countyName: '花蓮縣', forecast3h: 'F-D0047-041', week: 'F-D0047-043' },
  '10016': { countyName: '澎湖縣', forecast3h: 'F-D0047-045', week: 'F-D0047-047' },
  '10017': { countyName: '基隆市', forecast3h: 'F-D0047-049', week: 'F-D0047-051' },
  '10018': { countyName: '新竹市', forecast3h: 'F-D0047-053', week: 'F-D0047-055' },
  '10020': { countyName: '嘉義市', forecast3h: 'F-D0047-057', week: 'F-D0047-059' },
  '63000': { countyName: '臺北市', forecast3h: 'F-D0047-061', week: 'F-D0047-063' },
  '64000': { countyName: '高雄市', forecast3h: 'F-D0047-065', week: 'F-D0047-067' },
  '65000': { countyName: '新北市', forecast3h: 'F-D0047-069', week: 'F-D0047-071' },
  '66000': { countyName: '臺中市', forecast3h: 'F-D0047-073', week: 'F-D0047-075' },
  '67000': { countyName: '臺南市', forecast3h: 'F-D0047-077', week: 'F-D0047-079' },
  '09007': { countyName: '連江縣', forecast3h: 'F-D0047-081', week: 'F-D0047-083' },
  '09020': { countyName: '金門縣', forecast3h: 'F-D0047-085', week: 'F-D0047-087' },
};
