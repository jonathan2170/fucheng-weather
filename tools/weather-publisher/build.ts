// 組出單一縣市檔（任務 A4；格式見 src/weather/county-file.ts 的 fucheng-weather/1）
//
// 組完後一定再用 App 端同一個解析器（parseCountyFileText）讀回一次：App 讀不懂的檔案不發布。

import { gzipSync } from 'node:zlib';
import type { Region } from '../../src/data/types.ts';
import { COUNTY_FILE_FORMAT, COUNTY_FILE_FORMAT_V2, type CountyFileFormat } from '../../src/weather/config.ts';
import { WeatherFileError, parseCountyFileText, type CountyFile, type DayForecast } from '../../src/weather/county-file.ts';
import { aggregateTown, taipeiDate, PublisherError, readDataset, type ElementPoints } from './cwa.ts';
import { COUNTY_DATASETS, FORECAST_3H_ELEMENTS, FORECAST_WEEK_ELEMENTS, MAX_DAYS_PER_TOWN, MAX_GZIP_BYTES, MIN_DAYS_PER_TOWN, MIN_FORECAST_LEAD_MS, type CountyDatasets } from './config.ts';

export interface CountyJob extends CountyDatasets {
  countyCode: string;
  /** 該縣市全部鄉鎮，順序即輸出順序 */
  regions: Region[];
}

/** 由鄉鎮對照表與資料集對照表組出工作清單；兩邊的縣市必須完全一致（鄉鎮對照表缺縣市、資料集對照表缺縣市）或縣市名稱不一致時丟錯（設定錯誤，整批不執行） */
export function buildJobs(regions: readonly Region[], table: Readonly<Record<string, CountyDatasets>> = COUNTY_DATASETS): CountyJob[] {
  const missing = Object.keys(table).filter((code) => !regions.some((r) => r.countyCode === code));
  if (missing.length > 0) throw new PublisherError('config', `鄉鎮對照表缺少縣市：${missing.join('、')}（對照表可能是舊檔或被截斷）`);
  const byCounty = new Map<string, Region[]>();
  for (const region of regions) byCounty.set(region.countyCode, [...(byCounty.get(region.countyCode) ?? []), region]);
  return [...byCounty.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([countyCode, list]) => {
      const datasets = table[countyCode];
      if (!datasets) throw new PublisherError('config', `資料集對照表沒有縣市 ${countyCode}`);
      if (list.some((r) => r.countyName !== datasets.countyName)) throw new PublisherError('config', `縣市 ${countyCode} 的名稱與資料集對照表不一致`);
      return { countyCode, ...datasets, regions: list };
    });
}

export interface BuiltCounty {
  text: string;
  file: CountyFile;
  gzipBytes: number;
  /** 回應內有、對照表沒有的鄉鎮名稱（只提醒，不影響發布） */
  unknownTowns: string[];
}

/** 回應本身的新舊：逐鄉鎮檢查（只看對照表裡有的鄉鎮；回應多出來的只提醒），只計入有值（非 "-"）的時間點（理由與門檻見 config.ts）；任一鄉鎮的最晚時間點不足就整縣市不發布，不被其他鄉鎮蓋過 */
function assertFresh(datasets: { forecast: Map<string, ElementPoints>; week: Map<string, ElementPoints> }, now: Date, known: ReadonlySet<string>): void {
  const limit = now.getTime() + MIN_FORECAST_LEAD_MS;
  const latest = (el: ElementPoints, key: string): number | undefined => {
    const times = (el.get(key) ?? []).filter((p) => p.raw !== null).map((p) => p.start);
    return times.length === 0 ? undefined : Math.max(...times);
  };
  for (const [town, el] of datasets.forecast) {
    if (!known.has(town)) continue;
    const t = latest(el, 'temperature');
    if (t === undefined) throw new PublisherError('coverage', `鄉鎮 ${town} 沒有任何有值的溫度時間點`);
    if (t < limit) throw new PublisherError('stale', `鄉鎮 ${town} 的逐三小時預報涵蓋時間不足，資料可能停更、已過期或被截斷`);
  }
  // 紫外線是選填欄位：沒有任何有值的時間點只是不輸出 uvIndex；有時間點卻太早才視為停更
  for (const [town, el] of datasets.week) {
    if (!known.has(town)) continue;
    const t = latest(el, 'uvIndex');
    if (t !== undefined && t < limit) throw new PublisherError('stale', `鄉鎮 ${town} 的一週預報涵蓋時間不足，資料可能停更、已過期或被截斷`);
  }
}

export function buildCountyFile(
  job: CountyJob,
  forecastPayload: unknown,
  weekPayload: unknown,
  now: Date,
  maxGzipBytes: number = MAX_GZIP_BYTES,
  /** 目前對外的上一版縣市檔（已通過解析）；只用來逐列沿用「今天」那一列 */
  previous?: CountyFile,
  /** 輸出格式：預設版本 1（不沿用、不輸出 rowGeneratedAt）；版本 2 才逐列沿用今天的列 */
  format: CountyFileFormat = COUNTY_FILE_FORMAT,
): BuiltCounty {
  const forecast = readDataset(forecastPayload, job.countyName, FORECAST_3H_ELEMENTS);
  const week = readDataset(weekPayload, job.countyName, FORECAST_WEEK_ELEMENTS);
  const known = new Set(job.regions.map((r) => r.cwaLocationName));
  assertFresh({ forecast, week }, now, known);
  const unknownTowns = [...forecast.keys()].filter((name) => !known.has(name)).sort();

  // 逐列沿用：今天白天的時間點不足（例如下午才執行、氣象署已丟掉過去的時段）時 aggregateTown 不輸出今天。
  // 此時沿用上一版同一鄉鎮的今天那一列（上一版的列只有在白天點數足夠時才會輸出，所以一定是足量算出來的），
  // 並帶上該列自己的產生時間 rowGeneratedAt（上一版該列已有就沿用，否則是上一版檔案的 generatedAt）。
  // 只有輸出版本 2 時才沿用（版本 1 沒有 rowGeneratedAt，沿用會讓舊列冒充新鮮；版本 1 時今天直接省略，由新版 App 在本機保留舊的今天列）。
  // 明後天照常用新資料刷新，檔案的 generatedAt 是這次的時間。上一版沒有今天的列時（例如當天第一次就已過午）才不含今天，App 顯示 today_ended。
  const today = taipeiDate(now.getTime());
  const towns = job.regions.map((region) => {
    const name = region.cwaLocationName;
    const f = forecast.get(name);
    const w = week.get(name);
    if (!f || !w) throw new PublisherError('mismatch', `回應缺鄉鎮 ${region.id}（${f ? '一週版' : '逐三小時版'}）`);
    const rows: DayForecast[] = aggregateTown(f, w, region.id);
    if (format === COUNTY_FILE_FORMAT_V2 && !rows.some((d) => d.date === today)) {
      const old = previous?.towns.find((t) => t.regionId === region.id)?.days.find((d) => d.date === today);
      if (old) rows.push({ ...old, rowGeneratedAt: old.rowGeneratedAt ?? previous!.generatedAt });
    }
    const days = rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, MAX_DAYS_PER_TOWN);
    if (days.length < MIN_DAYS_PER_TOWN) throw new PublisherError('coverage', `鄉鎮 ${region.id} 只有 ${days.length} 天可用預報`);
    return { regionId: region.id, days };
  });

  // 鍵的順序固定，同樣的輸入一定產生同樣的位元組
  const text = `${JSON.stringify({
    format,
    countyCode: job.countyCode,
    generatedAt: now.toISOString(),
    source: 'cwa',
    towns,
  })}\n`;

  let file: CountyFile;
  try {
    file = parseCountyFileText(text, job.countyCode);
  } catch (error) {
    if (error instanceof WeatherFileError) throw new PublisherError('range', error.message);
    throw error;
  }
  const gzipBytes = gzipSync(text).length;
  if (gzipBytes >= maxGzipBytes) throw new PublisherError('size', `壓縮後 ${gzipBytes} 位元組，超過上限 ${maxGzipBytes}`);
  return { text, file, gzipBytes, unknownTowns };
}
